import { watch } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { AnswerBody, AskBody, CreateWishBody, GatewayEvent, JsonObject, PageView, SendMessageBody, ToolInfo } from "@qdd/shared";
import { runAsk } from "../agent/ask.js";
import type { ChatFn } from "../agent/llm.js";
import type { LoadedConfig } from "../config.js";
import type { DataSources } from "../datasource/registry.js";
import { refreshDatasets } from "../datasets/refresh.js";
import { pageCsp } from "../guard.js";
import { BadRequest, Conflict, NotFound, SessionHub } from "../sessions.js";
import { readPages, readStyle, resetStyle, toScriptJson, writeAtomic, writeStyle } from "../web/site.js";
import { Auth } from "./auth.js";
import { handleMcp } from "./mcp-endpoint.js";
import { buildComputeScript, SDK_JS } from "./sdk.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};
const MAX_BODY = 1024 * 1024;
const MAX_STATE = 64 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Gateway {
  url: string;
  hub: SessionHub;
  close(): Promise<void>;
}

export interface GatewayOptions {
  token: string;
  /** 延迟创建，缺少 API key 时只影响需要 agent 的接口。 */
  chat: () => ChatFn;
}

/**
 * 本地网关：harness 对前端团队的唯一出口。
 * 不承载业务逻辑——只做鉴权、转发数据工具、驱动 agent、托管生成的静态页面。
 */
export async function startGateway(loaded: LoadedConfig, sources: DataSources, options: GatewayOptions): Promise<Gateway> {
  const { config, paths } = loaded;
  const auth = new Auth(options.token);
  const hub = new SessionHub(loaded, sources, options.chat);
  const csp = pageCsp(config.cdnAllowlist, config.gateway.corsOrigins);
  const globalClients = new Set<ServerResponse>();
  const computeJs = await buildComputeScript();
  await mkdir(paths.state, { recursive: true });

  const broadcast = (event: GatewayEvent) => {
    for (const c of globalClients) c.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  hub.onMeta((session) => broadcast({ type: "session_updated", session }));

  const server = createServer((req, res) => {
    route(req, res).catch((error: Error) => {
      const status = error instanceof HttpError ? error.status : error instanceof NotFound ? 404 : error instanceof Conflict ? 409 : error instanceof BadRequest ? 400 : 500;
      if (res.headersSent) {
        res.end();
        return;
      }
      json(res, status, { error: error.message });
    });
  });

  function cors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (origin && config.gateway.corsOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-QDD-Page, X-QDD-Page-Token");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    }
  }

  function requireAdmin(req: IncomingMessage, url: URL): void {
    if (!auth.isAdmin(req, url)) throw new HttpError(401, "缺少或错误的网关 token");
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://gateway");
    const p = url.pathname;
    const m = req.method ?? "GET";
    cors(req, res);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (m === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    if (p === "/health") return json(res, 200, { status: "ok" });
    if (p === "/sdk/qdd.js") return send(res, 200, MIME[".js"]!, SDK_JS);
    if (p === "/sdk/compute.js") return send(res, 200, MIME[".js"]!, computeJs);
    if (p.startsWith("/assets/")) return serveFile(res, path.join(paths.site, "assets"), p.slice("/assets/".length));
    if (p.startsWith("/pages/")) return servePage(req, res, url);

    if (p === "/mcp") {
      requireAdmin(req, url);
      if (m === "DELETE") return void res.writeHead(200).end();
      if (m !== "POST") throw new HttpError(405, "MCP 端点只接受 POST");
      const reply = await handleMcp(sources, (await readJson(req)) as Parameters<typeof handleMcp>[1]);
      if (!reply) return void res.writeHead(202).end();
      return json(res, 200, reply);
    }

    // ---------------------------------------------------------------- 页面运行时 + 前端共用
    const tool = /^\/api\/tools\/([^/]+)$/.exec(p);
    if (tool && m === "POST") {
      const name = decodeURIComponent(tool[1]!);
      const target = sources.get(name);
      if (!target) throw new HttpError(404, `未知数据工具 ${name}`);
      if (!auth.isAdmin(req, url)) {
        const slug = auth.pageOf(req);
        const page = slug ? (await readPages(paths)).find((x) => x.slug === slug) : undefined;
        if (!page) throw new HttpError(401, "缺少或错误的页面 token");
        if (!page.tools.includes(name)) throw new HttpError(403, `页面 ${slug} 未声明工具 ${name}`);
      }
      // 写入类工具只能经由 agent + 店长授权执行，不开放直接调用。
      if (target.mutating) throw new HttpError(403, `${name} 是写入类工具，只能在许愿会话中经授权执行`);
      return json(res, 200, { result: await target.call(((await readJson(req)) ?? {}) as JsonObject) });
    }

    if (p === "/api/ask" && m === "POST") {
      if (!auth.isAdmin(req, url)) {
        const slug = auth.pageOf(req);
        const page = slug ? (await readPages(paths)).find((x) => x.slug === slug) : undefined;
        if (!page) throw new HttpError(401, "缺少或错误的页面 token");
        if (!page.useAgent) throw new HttpError(403, `页面 ${slug} 未声明使用 agent`);
      }
      const body = (await readJson(req)) as AskBody;
      if (typeof body?.question !== "string" || !body.question.trim()) throw new HttpError(400, "question 不能为空");
      const chat = options.chat();
      const stream = openSse(req, res);
      const controller = new AbortController();
      req.on("close", () => controller.abort());
      try {
        const text = await runAsk(sources, chat, body.question, body.context, (name) => stream({ type: "tool", name }), controller.signal);
        stream({ type: "answer", text });
      } catch (error) {
        stream({ type: "error", message: (error as Error).message });
      }
      res.end();
      return;
    }

    const pageState = /^\/api\/state\/([a-z0-9][a-z0-9-]{0,63})$/.exec(p);
    if (pageState) {
      const slug = pageState[1]!;
      if (!auth.isAdmin(req, url) && auth.pageOf(req) !== slug) throw new HttpError(401, "只能读写本页面的状态");
      if (!(await readPages(paths)).some((x) => x.slug === slug)) throw new HttpError(404, `页面 ${slug} 不存在`);
      const file = path.join(paths.state, `${slug}.json`);
      if (m === "GET") {
        const state = await readFile(file, "utf8").then((t) => JSON.parse(t) as unknown, () => ({}));
        return json(res, 200, { state });
      }
      if (m === "PUT") {
        const text = await readBody(req);
        if (text.length > MAX_STATE) throw new HttpError(413, "页面状态不能超过 64KB");
        let state: unknown;
        try {
          state = JSON.parse(text);
        } catch {
          throw new HttpError(400, "页面状态必须是 JSON");
        }
        if (!state || typeof state !== "object" || Array.isArray(state)) throw new HttpError(400, "页面状态必须是 JSON 对象");
        await writeAtomic(file, JSON.stringify(state));
        return json(res, 200, { state });
      }
    }

    // ---------------------------------------------------------------- 以下仅前端（网关 token）
    if (!p.startsWith("/api/")) throw new HttpError(404, "Not Found");
    requireAdmin(req, url);

    if (p === "/api/events" && m === "GET") {
      openSse(req, res);
      globalClients.add(res);
      req.on("close", () => globalClients.delete(res));
      return;
    }
    if (p === "/api/tools" && m === "GET") {
      const list: ToolInfo[] = sources.tools.map(({ name, description, inputSchema, source, mutating }) => ({ name, description, inputSchema, source, mutating }));
      return json(res, 200, list);
    }
    if (p === "/api/pages" && m === "GET") {
      const pages: PageView[] = (await readPages(paths)).map((x) => ({
        ...x,
        url: `/pages/${x.slug}/?page_token=${auth.pageToken(x.slug)}`,
      }));
      return json(res, 200, pages.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    }
    if (p === "/api/style") {
      if (m === "GET") return send(res, 200, "text/plain; charset=utf-8", await readStyle(paths));
      if (m === "PUT") {
        const text = await readBody(req);
        if (!text.trim()) throw new HttpError(400, "风格提示词不能为空");
        await writeStyle(paths, text);
        return send(res, 200, "text/plain; charset=utf-8", text);
      }
      if (m === "DELETE") {
        await resetStyle(paths);
        return send(res, 200, "text/plain; charset=utf-8", await readStyle(paths));
      }
    }
    if (p === "/api/wishes" && m === "POST") {
      const body = (await readJson(req)) as CreateWishBody;
      if (typeof body?.wish !== "string" || !body.wish.trim()) throw new HttpError(400, "wish 不能为空");
      if (body.slug !== undefined && !(await readPages(paths)).some((x) => x.slug === body.slug)) {
        throw new HttpError(404, `页面 ${body.slug} 不存在`);
      }
      return json(res, 201, await hub.create(body.wish.trim(), body.slug));
    }
    if (p === "/api/sessions" && m === "GET") return json(res, 200, await hub.list());
    if (p === "/api/metrics" && m === "GET") return json(res, 200, await sources.metrics());
    if (p === "/api/datasets" && m === "GET") return json(res, 200, await sources.datasets.list());
    if (p === "/api/datasets/refresh" && m === "POST") {
      const body = (await readJson(req)) as { datasets?: string[] } | undefined;
      return json(res, 200, await refreshDatasets(sources, body?.datasets));
    }

    const session = /^\/api\/sessions\/([^/]+)(\/.*)?$/.exec(p);
    if (session) {
      const id = session[1]!;
      const sub = session[2] ?? "";
      if (sub === "" && m === "GET") return json(res, 200, await hub.detail(id));
      if (sub === "/events" && m === "GET") {
        // 先回放历史事件，再推送实时事件；since=N 跳过前 N 条。
        const detail = await hub.detail(id);
        const stream = openSse(req, res);
        const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
        for (const e of detail.events.slice(since)) stream(e);
        const off = hub.subscribe(id, stream);
        req.on("close", off);
        return;
      }
      if (sub === "/messages" && m === "POST") {
        const body = (await readJson(req)) as SendMessageBody;
        if (typeof body?.text !== "string" || !body.text.trim()) throw new HttpError(400, "text 不能为空");
        return json(res, 202, await hub.send(id, body.text.trim()));
      }
      if (sub === "/cancel" && m === "POST") {
        hub.cancel(id);
        return json(res, 202, await hub.meta(id));
      }
      const question = /^\/questions\/([^/]+)$/.exec(sub);
      if (question && m === "POST") {
        const body = (await readJson(req)) as AnswerBody | undefined;
        if (!body?.answers || typeof body.answers !== "object" || Array.isArray(body.answers)) throw new HttpError(400, "answers 必须是对象");
        hub.answer(id, question[1]!, body.answers);
        return json(res, 200, { ok: true });
      }
      const approval = /^\/approvals\/([^/]+)$/.exec(sub);
      if (approval && m === "POST") {
        const body = (await readJson(req)) as { approved?: unknown };
        if (typeof body?.approved !== "boolean") throw new HttpError(400, "approved 必须是布尔值");
        hub.approve(id, approval[1]!, body.approved);
        return json(res, 200, { ok: true });
      }
    }
    throw new HttpError(404, "Not Found");
  }

  async function servePage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const [, , slug = "", ...rest] = url.pathname.split("/");
    if (!SLUG_RE.test(slug)) throw new HttpError(404, "Not Found");
    const expected = auth.pageToken(slug);
    const query = url.searchParams.get("page_token");
    if (query !== null) {
      if (query !== expected) throw new HttpError(401, "页面 token 错误");
      // 首次带 token 进入：写入路径级 cookie 后跳转到干净地址，后续子资源凭 cookie 访问。
      res.setHeader("Set-Cookie", `${auth.pageCookieName(slug)}=${expected}; Path=/pages/${slug}/; HttpOnly; SameSite=Lax`);
      url.searchParams.delete("page_token");
      res.writeHead(302, { Location: url.pathname + url.search }).end();
      return;
    }
    if (auth.pageCookie(req, slug) !== expected && !auth.isAdmin(req, url)) throw new HttpError(401, "需要页面 token");

    const rel = rest.join("/") || "index.html";
    const file = await resolveFile(path.join(paths.pages, slug), rel);
    if (!file) throw new HttpError(404, "Not Found");
    const ext = path.extname(file).toLowerCase();
    if (ext !== ".html") return send(res, 200, MIME[ext] ?? "application/octet-stream", await readFile(file));

    const boot =
      `<script>window.QDD_PAGE=${toScriptJson({ slug, token: expected, metrics: await sources.metrics() })};</script>` +
      `<script src="/sdk/compute.js"></script><script src="/sdk/qdd.js"></script>`;
    const html = await readFile(file, "utf8");
    const head = /<head[^>]*>/i.exec(html);
    let out = head ? html.replace(head[0], head[0] + boot) : boot + html;
    const entry = (await readPages(paths)).find((x) => x.slug === slug);
    const banner = gapBanner(entry);
    if (banner) out = /<body[^>]*>/i.test(out) ? out.replace(/<body[^>]*>/i, (m) => m + banner) : out + banner;
    res.setHeader("Content-Security-Policy", csp);
    send(res, 200, MIME[".html"]!, out);
  }

  async function serveFile(res: ServerResponse, root: string, rel: string): Promise<void> {
    const file = await resolveFile(root, rel);
    if (!file) throw new HttpError(404, "Not Found");
    send(res, 200, MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream", await readFile(file));
  }

  // 后台增量刷新数据集
  let refreshing = false;
  const refreshTimer =
    config.datasets.refreshIntervalSec > 0
      ? setInterval(() => {
          if (refreshing) return;
          refreshing = true;
          refreshDatasets(sources)
            .then((results) => {
              for (const r of results) if (r.error) console.warn(`数据集 ${r.dataset} 刷新失败：${r.error}`);
            })
            .finally(() => (refreshing = false));
        }, config.datasets.refreshIntervalSec * 1000)
      : undefined;

  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(paths.site, (_event, name) => {
    if (name !== "pages.json") return;
    clearTimeout(timer);
    timer = setTimeout(() => broadcast({ type: "pages_changed" }), 150);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.gateway.port, config.gateway.host, () => resolve());
  });
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : config.gateway.port;
  const host = config.gateway.host.includes(":") ? `[${config.gateway.host}]` : config.gateway.host;

  return {
    url: `http://${host}:${port}`,
    hub,
    close: () =>
      new Promise((resolve) => {
        watcher.close();
        clearTimeout(timer);
        clearInterval(refreshTimer);
        for (const c of globalClients) c.end();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

const GAP_LABEL: Record<string, string> = { missing_data: "缺数据", estimate: "估测", unsupported: "暂不支持", permission: "需授权" };

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** harness 注入的能力缺口/口径复核横幅：页面代码无法移除其内容声明。 */
function gapBanner(page: { gaps: { kind: string; item: string; reason: string; suggestion?: string }[]; stale: string | null } | undefined): string {
  if (!page || (!page.gaps.length && !page.stale)) return "";
  const items = page.gaps
    .map((g) => `<li><b>[${GAP_LABEL[g.kind] ?? g.kind}] ${escapeHtml(g.item)}</b>：${escapeHtml(g.reason)}${g.suggestion ? `（${escapeHtml(g.suggestion)}）` : ""}</li>`)
    .join("");
  const stale = page.stale ? `<li><b>[口径变更]</b> ${escapeHtml(page.stale)}</li>` : "";
  return `<aside data-qdd-gaps style="all:initial;display:block;font:13px/1.6 system-ui,sans-serif;background:#fff7e6;color:#613400;border-bottom:1px solid #ffd591;padding:8px 16px"><b style="font-weight:600">能力缺口说明</b><ul style="margin:4px 0 0;padding-left:20px">${stale}${items}</ul></aside>`;
}

/** 在 root 内解析相对路径，拒绝越界与隐藏文件。 */
async function resolveFile(root: string, rel: string): Promise<string | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return undefined;
  }
  let file = path.join(root, path.normalize(decoded));
  if (!file.startsWith(root + path.sep) && file !== root) return undefined;
  if (path.relative(root, file).split(path.sep).some((s) => s.startsWith("."))) return undefined;
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
    await stat(file);
    return file;
  } catch {
    return undefined;
  }
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { "Content-Type": type }).end(body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(body));
}

function openSse(req: IncomingMessage, res: ServerResponse): (data: unknown) => void {
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive" });
  res.write(": connected\n\n");
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => clearInterval(ping));
  return (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "请求体过大");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const text = await readBody(req);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON");
  }
}

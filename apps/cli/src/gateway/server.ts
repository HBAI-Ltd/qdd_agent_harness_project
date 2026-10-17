import { watch } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { AnswerBody, AskBody, SelectModelBody, BrowserStreamEvent, CreateWishBody, GatewayEvent, HarnessConfig, JsonObject, Overview, PageView, RecordInput, SendMessageBody, ToolInfo } from "@qdd/shared";
import { runAsk } from "../agent/ask.js";
import { chatOptions } from "../agent/chat-options.js";
import type { ChatFn } from "../agent/llm.js";
import { AttachmentError, MAX_ATTACHMENT_BYTES } from "../attachments.js";
import { hasModel, modelCatalog, resolveModel, type LoadedConfig } from "../config.js";
import type { DataSources } from "../datasource/registry.js";
import { addRecords, defineRecord, listRecordSets, parseRecordDefinition, queryRecords, RECORD_PREFIX, updateRecord, voidRecord } from "../datasets/records.js";
import { refreshDatasets } from "../datasets/refresh.js";
import { pageCsp } from "../guard.js";
import { BadRequest, Conflict, NotFound, SessionHub } from "../sessions.js";
import { pinPage, readPages, readPins, readStyle, unpinPage, resetStyle, toScriptJson, writeAtomic, writeStyle } from "../web/site.js";
import { Auth } from "./auth.js";
import { handleMcp } from "./mcp-endpoint.js";
import { buildComputeScript, SDK_JS } from "./sdk.js";
import { CameraLogin } from "../workbench/cameras.js";
import { CONNECTOR_CATALOG, type McpConnectorInfo } from "../workbench/connectors.js";
import { openWorkbench, type Workbench } from "../workbench/index.js";
import { Scheduler } from "../workbench/scheduler.js";
import { InvalidInput, Missing, parseSkillInput } from "../workbench/skills.js";

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
  scheduler: Scheduler;
  workbench: Workbench;
  close(): Promise<void>;
}

export interface GatewayOptions {
  token: string;
  /** 延迟创建，缺少 API key 时只影响需要 agent 的接口。 */
  chat: (llm: HarnessConfig["llm"]) => ChatFn;
  /** 缺省时按工作区创建（测试可注入假的飞书客户端） */
  workbench?: Workbench;
  /** 为 false 时不自动运行定时任务（测试用） */
  scheduler?: boolean;
}

/**
 * 本地网关：harness 对前端团队的唯一出口。
 * 不承载业务逻辑——只做鉴权、转发数据工具、驱动 agent、托管生成的静态页面。
 */
export async function startGateway(loaded: LoadedConfig, sources: DataSources, options: GatewayOptions): Promise<Gateway> {
  const { config, paths } = loaded;
  const auth = new Auth(options.token);
  const workbench = options.workbench ?? (await openWorkbench(loaded));
  const hub = new SessionHub(loaded, sources, options.chat, workbench);
  const scheduler = new Scheduler(loaded, hub, workbench);
  workbench.scheduler = scheduler;
  const csp = pageCsp(config.cdnAllowlist, config.gateway.corsOrigins);
  const globalClients = new Set<ServerResponse>();
  const computeJs = await buildComputeScript();
  await mkdir(paths.state, { recursive: true });

  const broadcast = (event: GatewayEvent) => {
    for (const c of globalClients) c.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  hub.onMeta((session) => broadcast(session.origin?.kind === "schedule"
    ? { type: "schedules_changed" }
    : { type: "session_updated", session }));
  hub.onPending(() => broadcast({ type: "pending_changed" }));
  // 页面的 kind 由定时任务推导，任务变化时页面列表也需刷新
  scheduler.onChange(() => {
    broadcast({ type: "schedules_changed" });
    broadcast({ type: "pages_changed" });
  });
  if (options.scheduler !== false) scheduler.start();

  const cameras = new CameraLogin(config);
  const mcpInfo = (): McpConnectorInfo[] =>
    Object.entries(config.mcpServers).map(([name, server]) => ({
      name,
      allowWrite: server.allowWrite === true,
      error: sources.warnings.find((w) => w.startsWith(`MCP 服务 ${name} 接入失败`)),
    }));

  async function overview(): Promise<Overview> {
    const [sessions, pages, skills, schedules, connectors, pending] = await Promise.all([
      hub.list(),
      readPages(paths),
      workbench.skills.list(),
      scheduler.list(),
      workbench.connectors.list(mcpInfo()),
      hub.pending(),
    ]);
    const count = (status: string) => sessions.filter((x) => x.status === status).length;
    const next = schedules
      .filter((x) => x.enabled && x.nextRunAt)
      .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))[0];
    return {
      sessions: {
        total: sessions.length,
        running: count("running"),
        waiting: count("waiting"),
        error: count("error"),
        active: sessions.filter((x) => x.status === "running" || x.status === "waiting").map(({ id, title, status }) => ({ id, title, status })),
      },
      pages: { total: pages.length, stale: pages.filter((x) => x.stale).length },
      skills: { total: skills.length },
      schedules: { total: schedules.length, enabled: schedules.filter((x) => x.enabled).length, next: next ? { id: next.id, name: next.name, at: next.nextRunAt! } : null },
      connectors: { total: connectors.length, connected: connectors.filter((x) => x.status === "connected").length },
      pending,
    };
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error: Error) => {
      const tagged = (error as { status?: unknown }).status;
      const status = error instanceof HttpError ? error.status : typeof tagged === "number" ? tagged : error.name === "ZodError" ? 400 : error instanceof NotFound || error instanceof Missing ? 404 : error instanceof Conflict ? 409 : error instanceof BadRequest || error instanceof InvalidInput || error instanceof AttachmentError ? 400 : 500;
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
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-QDD-Page, X-QDD-Page-Token, X-File-Name");
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
      const chat = options.chat(resolveModel(config.llm));
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

    // 记录数据集：页面只能读写自己声明的记录；结构定义仅前端或 agent（经店长授权）
    const recordRoute = /^\/api\/records(?:\/([^/]+)(?:\/([^/]+))?)?$/.exec(p);
    if (recordRoute) {
      const name = recordRoute[1] ? decodeURIComponent(recordRoute[1]) : undefined;
      const id = recordRoute[2] ? decodeURIComponent(recordRoute[2]) : undefined;
      let actor = "@admin";
      if (!auth.isAdmin(req, url)) {
        const slug = auth.pageOf(req);
        const page = slug ? (await readPages(paths)).find((x) => x.slug === slug) : undefined;
        if (!page) throw new HttpError(401, "缺少或错误的页面 token");
        if (!name || !(page.records ?? []).includes(name)) throw new HttpError(403, `页面 ${slug} 未声明记录 ${name ?? ""}`);
        actor = page.slug;
      }
      const store = sources.datasets;
      if (!name) {
        if (m === "GET") {
          return json(res, 200, (await listRecordSets(store)).map((x) => ({ name: x.name.slice(RECORD_PREFIX.length), description: x.description, schema: x.record, rowCount: x.rowCount, watermark: x.watermark, updatedAt: x.updatedAt })));
        }
        if (m === "POST") {
          const manifest = await defineRecord(store, parseRecordDefinition(await readJson(req)));
          return json(res, 201, { name: manifest.name.slice(RECORD_PREFIX.length), schema: manifest.record });
        }
      } else if (!id) {
        if (m === "GET") {
          const limit = url.searchParams.get("limit");
          return json(res, 200, await queryRecords(store, name, { from: url.searchParams.get("from") ?? undefined, to: url.searchParams.get("to") ?? undefined, limit: limit ? Number(limit) : undefined }));
        }
        if (m === "POST") {
          const body = (await readJson(req)) as RecordInput | RecordInput[];
          return json(res, 201, { rows: await addRecords(store, name, Array.isArray(body) ? body : [body], actor) });
        }
      } else {
        if (m === "PUT") return json(res, 200, { row: await updateRecord(store, name, id, ((await readJson(req)) ?? {}) as RecordInput, actor) });
        if (m === "DELETE") {
          await voidRecord(store, name, id, actor);
          return json(res, 200, { ok: true });
        }
      }
      throw new HttpError(405, "不支持的方法");
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
      const [entries, pins, schedules] = await Promise.all([readPages(paths), readPins(paths), scheduler.list()]);
      const pinOrder = new Map(pins.map((x, i) => [x.slug, { index: i, at: x.pinnedAt }]));
      const pages: PageView[] = entries.map((x) => {
        const using = schedules.filter((s) => s.slug === x.slug).map(({ id, name, enabled }) => ({ id, name, enabled }));
        return {
          ...x,
          url: `/pages/${x.slug}/?page_token=${auth.pageToken(x.slug)}`,
          kind: using.length ? "scheduled" : "once",
          schedules: using,
          pinnedAt: pinOrder.get(x.slug)?.at ?? null,
        };
      });
      const rank = (x: PageView) => pinOrder.get(x.slug)?.index ?? Infinity;
      return json(res, 200, pages.sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt)));
    }
    const pin = /^\/api\/pages\/([^/]+)\/pin$/.exec(p);
    if (pin && (m === "PUT" || m === "DELETE")) {
      const slug = decodeURIComponent(pin[1]!);
      if (m === "PUT" && !(await readPages(paths)).some((x) => x.slug === slug)) throw new HttpError(404, "页面不存在");
      const pins = await (m === "PUT" ? pinPage(paths, slug) : unpinPage(paths, slug));
      broadcast({ type: "pages_changed" });
      return json(res, 200, { slug, pinnedAt: pins.find((x) => x.slug === slug)?.pinnedAt ?? null });
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
    if (p === "/api/chat/options" && m === "GET") return json(res, 200, chatOptions(config.llm));
    if (p === "/api/models" && m === "GET") return json(res, 200, modelCatalog(config.llm));
    if (p === "/api/attachments" && m === "POST") {
      // 原始字节上传，文件名（文件夹上传时为相对路径）经 X-File-Name 以 URI 编码传递
      const header = req.headers["x-file-name"];
      if (typeof header !== "string" || !header) throw new HttpError(400, "缺少 X-File-Name");
      let name: string;
      try {
        name = decodeURIComponent(header);
      } catch {
        throw new HttpError(400, "X-File-Name 编码不合法");
      }
      const bytes = await readBuffer(req, MAX_ATTACHMENT_BYTES);
      return json(res, 201, await hub.attachments.save(name, bytes, req.headers["content-type"]));
    }
    const attachment = /^\/api\/attachments\/([^/]+)$/.exec(p);
    if (attachment && m === "GET") {
      const { ref, bytes } = await hub.attachments.bytes(attachment[1]!);
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(ref.name)}`);
      res.writeHead(200, { "Content-Type": ref.mime, "Content-Length": bytes.length }).end(bytes);
      return;
    }
    if (p === "/api/wishes" && m === "POST") {
      const body = (await readJson(req)) as CreateWishBody;
      if (typeof body?.wish !== "string" || !body.wish.trim()) throw new HttpError(400, "wish 不能为空");
      if (body.slug !== undefined && !(await readPages(paths)).some((x) => x.slug === body.slug)) {
        throw new HttpError(404, `页面 ${body.slug} 不存在`);
      }
      if (body.skillId !== undefined && typeof body.skillId !== "string") throw new HttpError(400, "skillId 必须是字符串");
      const model = checkModel(body.model);
      const attachments = await hub.attachments.resolve(body.attachments);
      return json(res, 201, await hub.create(body.wish.trim(), {
        slug: body.slug,
        skillId: body.skillId,
        attachments,
        ...(model !== undefined ? { model } : {}),
        ...(body.reasoningEffort !== undefined ? { reasoningEffort: body.reasoningEffort } : {}),
      }));
    }

    // ---------------------------------------------------------------- 工作台
    if (p === "/api/overview" && m === "GET") return json(res, 200, await overview());
    if (p === "/api/pending" && m === "GET") return json(res, 200, await hub.pending());

    if (p === "/api/skills") {
      if (m === "GET") return json(res, 200, await workbench.skills.list());
      if (m === "POST") {
        const skill = await workbench.skills.create(parseSkillInput(await readJson(req)), "user");
        broadcast({ type: "skills_changed" });
        return json(res, 201, skill);
      }
    }
    const skill = /^\/api\/skills\/([^/]+)$/.exec(p);
    if (skill) {
      const id = decodeURIComponent(skill[1]!);
      if (m === "GET") return json(res, 200, await workbench.skills.get(id));
      if (m === "PUT") {
        const updated = await workbench.skills.update(id, parseSkillInput(await readJson(req)));
        broadcast({ type: "skills_changed" });
        return json(res, 200, updated);
      }
      if (m === "DELETE") {
        const using = (await scheduler.list()).filter((x) => x.skillId === id);
        if (using.length) throw new HttpError(409, `技能被定时任务使用中：${using.map((x) => x.name).join("、")}`);
        await workbench.skills.remove(id);
        broadcast({ type: "skills_changed" });
        return json(res, 200, { ok: true });
      }
    }

    if (p === "/api/schedules") {
      if (m === "GET") return json(res, 200, await scheduler.list());
      if (m === "POST") return json(res, 201, await scheduler.create(await readJson(req)));
    }
    const schedule = /^\/api\/schedules\/([^/]+)(\/run)?$/.exec(p);
    if (schedule) {
      const id = decodeURIComponent(schedule[1]!);
      if (schedule[2]) {
        if (m === "POST") return json(res, 202, { sessionId: await scheduler.runNow(id) });
      } else {
        if (m === "GET") return json(res, 200, await scheduler.get(id));
        if (m === "PUT") return json(res, 200, await scheduler.update(id, await readJson(req)));
        if (m === "DELETE") {
          await scheduler.remove(id);
          return json(res, 200, { ok: true });
        }
      }
    }

    // ---------------------------------------------------------------- 浏览器实时画面与人工接管
    const browserRoute = /^\/api\/browser\/([^/]+)(\/stream|\/input)?$/.exec(p);
    if (browserRoute) {
      const browser = workbench.browser;
      if (!browser) throw new HttpError(404, "浏览器工具未启用");
      const id = decodeURIComponent(browserRoute[1]!);
      const sub = browserRoute[2];
      if (!sub && m === "GET") {
        const state = browser.state(id);
        if (!state) throw new HttpError(404, "浏览器会话不存在或已关闭");
        return json(res, 200, state);
      }
      if (!sub && m === "DELETE") {
        const body = (await readJson(req)) as { sessionId?: unknown } | undefined;
        if (typeof body?.sessionId !== "string" || !body.sessionId.trim()) throw new HttpError(400, "sessionId 不能为空");
        await hub.meta(body.sessionId);
        const state = await browser.closeBrowser(body.sessionId, id);
        await hub.recordBrowserState(body.sessionId, state);
        return json(res, 200, state);
      }
      if (sub === "/stream" && m === "GET") {
        const stream = openSse(req, res);
        // 背压：写缓冲未清空时只保留最新一帧，drain 后补发
        let pendingFrame: BrowserStreamEvent | undefined;
        res.on("drain", () => {
          if (pendingFrame) {
            const frame = pendingFrame;
            pendingFrame = undefined;
            stream(frame);
          }
        });
        const listener = (event: BrowserStreamEvent) => {
          if (event.type === "frame" && res.writableNeedDrain) pendingFrame = event;
          else stream(event);
          if (event.type === "closed") res.end();
        };
        let off: () => void;
        try {
          off = browser.runtime.subscribe(browser.cwd, id, listener);
        } catch (error) {
          if (!browser.state(id)) stream({ type: "closed", sessionId: id });
          else stream({ type: "error", message: (error as Error).message });
          res.end();
          return;
        }
        req.on("close", off);
        return;
      }
      if (sub === "/input" && m === "POST") {
        const body = (await readJson(req)) as ({ tabId?: unknown } & Record<string, unknown>) | undefined;
        if (!body || typeof body.tabId !== "string") throw new HttpError(400, "tabId 不能为空");
        const { tabId, ...input } = body;
        return json(res, 200, await browser.runtime.input(browser.cwd, id, tabId, input));
      }
    }

    if (p === "/api/connectors") {
      if (m === "GET") return json(res, 200, { catalog: CONNECTOR_CATALOG, connectors: await workbench.connectors.list(mcpInfo()) });
      if (m === "POST") {
        const installed = await workbench.connectors.install(await readJson(req));
        broadcast({ type: "connectors_changed" });
        return json(res, 201, installed);
      }
    }
    if (p === "/api/cameras" && m === "GET") return json(res, 200, await cameras.status());
    const camera = /^\/api\/cameras\/(haik|tysl)\/(send-code|login|login-start|login-complete)$/.exec(p);
    if (camera && m === "POST") {
      const [, provider, step] = camera;
      const body = step === "login-start" ? undefined : await readJson(req);
      const result =
        provider === "haik" && step === "send-code" ? await cameras.haikSendCode(body)
        : provider === "haik" && step === "login" ? await cameras.haikLogin(body)
        : provider === "tysl" && step === "login-start" ? await cameras.tyslStart()
        : provider === "tysl" && step === "login-complete" ? await cameras.tyslComplete(body)
        : undefined;
      if (!result) throw new HttpError(404, "不支持的登录步骤");
      if (step === "login" || step === "login-complete") broadcast({ type: "connectors_changed" });
      return json(res, 200, result);
    }
    const connector = /^\/api\/connectors\/([^/]+)(\/verify|\/test)?$/.exec(p);
    if (connector) {
      const id = decodeURIComponent(connector[1]!);
      const action = connector[2];
      if (action === "/verify" && m === "POST") {
        const view = await workbench.connectors.verify(id);
        broadcast({ type: "connectors_changed" });
        return json(res, 200, view);
      }
      if (action === "/test" && m === "POST") {
        const body = (await readJson(req)) as { text?: unknown } | undefined;
        const text = typeof body?.text === "string" && body.text.trim() ? body.text.trim().slice(0, 500) : "【钱多多】这是一条测试消息。";
        await workbench.connectors.send(id, text);
        return json(res, 200, { ok: true });
      }
      if (!action) {
        if (m === "GET") return json(res, 200, await workbench.connectors.get(id));
        if (m === "PUT") {
          const view = await workbench.connectors.update(id, await readJson(req));
          broadcast({ type: "connectors_changed" });
          return json(res, 200, view);
        }
        if (m === "DELETE") {
          const using = (await scheduler.list()).filter((x) => x.notify?.connectorId === id);
          if (using.length) throw new HttpError(409, `连接器被定时任务使用中：${using.map((x) => x.name).join("、")}`);
          await workbench.connectors.remove(id);
          broadcast({ type: "connectors_changed" });
          return json(res, 200, { ok: true });
        }
      }
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
        const model = checkModel(body.model);
        const attachments = await hub.attachments.resolve(body.attachments);
        return json(res, 202, await hub.send(id, body.text.trim(), {
          attachments,
          ...(model !== undefined ? { model } : {}),
          ...(body.reasoningEffort !== undefined ? { reasoningEffort: body.reasoningEffort } : {}),
        }));
      }
      if (sub === "/model" && m === "PUT") {
        const body = (await readJson(req)) as SelectModelBody | undefined;
        const model = checkModel(body?.model);
        if (!model) throw new HttpError(400, "model 不能为空");
        return json(res, 200, await hub.selectModel(id, model));
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

  function checkModel(model: unknown): string | undefined {
    if (model === undefined || model === null || model === "") return undefined;
    if (typeof model !== "string" || !hasModel(config.llm, model)) throw new HttpError(400, `模型 ${String(model)} 不存在`);
    return model;
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
      `<script>window.QDD_PAGE=${toScriptJson({ slug, token: expected, metrics: await sources.metrics(), hostOrigins: pageHostOrigins(req, config.gateway.corsOrigins) })};</script>` +
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
    scheduler,
    workbench,
    close: () =>
      new Promise((resolve) => {
        watcher.close();
        scheduler.stop();
        void workbench.browser?.close();
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

/** 模板仅允许配置的前端源和实际网关源建立主界面通信。 */
function pageHostOrigins(req: IncomingMessage, configured: string[]): string[] {
  const origins = new Set<string>();
  for (const value of configured) {
    try {
      const url = new URL(value);
      if (/^https?:$/.test(url.protocol) && url.origin === value) origins.add(url.origin);
    } catch { /* 配置中的通配符、opaque 源与非 URL 不参与通信。 */ }
  }
  const requestHost = req.headers.host;
  if (requestHost && !/[\s/@\\?#]/.test(requestHost)) {
    try {
      const url = new URL(`http://${requestHost}`);
      if (url.host && !url.username && !url.password) origins.add(url.origin);
    } catch { /* 无效 Host 不扩大通信范围。 */ }
  }
  return [...origins];
}

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

async function readBuffer(req: IncomingMessage, limit = MAX_BODY): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "请求体过大");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return (await readBuffer(req)).toString("utf8");
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

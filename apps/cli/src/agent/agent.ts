import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonObject, MetricCatalog, PageEntry } from "@qdd/shared";
import type { LoadedConfig } from "../config.js";
import type { Authorizer, DataSources, DataTool } from "../datasource/registry.js";
import { updateMetrics } from "../datasets/metrics.js";
import { checkFile, checkPath, DATA_DIR } from "../guard.js";
import { readPages, readStyle, readTheme, toScriptJson, upsertPage } from "../web/site.js";
import type { ChatFn, ChatMessage, LlmTool } from "./llm.js";
import { listSessionMetas, readArtifact, readSessionDigest, recall } from "./memory.js";
import { systemPrompt } from "./prompt.js";

export interface AgentEvent {
  kind: "say" | "tool" | "ok" | "warn";
  text: string;
}

export interface WishRequest {
  wish: string;
  sessionId: string;
  /** 指定已有页面则在其基础上修改。 */
  slug?: string | undefined;
  /** 续聊：同一会话之前的消息（不含 system）。 */
  history?: ChatMessage[] | undefined;
}

export interface WishHooks {
  onEvent(event: AgentEvent): void;
  authorize: Authorizer;
  signal?: AbortSignal | undefined;
}

export interface WishResult {
  /** 本轮未发布（例如只是回答追问）时为 undefined。 */
  page: PageEntry | undefined;
  files: string[];
  /** 完整对话（不含 system），用于下次续聊。 */
  messages: ChatMessage[];
  /** 本轮结论（发布摘要或回复内容），作为会话摘要供跨会话检索。 */
  summary: string;
}

const EXPLORE_LIMIT = 12_000;
const SNAPSHOT_MAX_BYTES = 5 * 1024 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NAME_RE = /^[a-z0-9_-]{1,40}$/;

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…（已截断，共 ${s.length} 字符）` : s);

function newSlug(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `p${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function listFiles(dir: string, base = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path.join(dir, base), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else out.push(rel);
  }
  return out;
}

const object = (properties: JsonObject, required: string[] = []): JsonObject => ({ type: "object", properties, required });

const HARNESS_TOOLS: LlmTool[] = [
  {
    type: "function",
    function: {
      name: "snapshot_data",
      description: "调用一个只读数据工具，并把完整结果保存为页面数据 data/<name>.js（window.QDD_DATA[name]）。返回数据结构预览。",
      parameters: object(
        {
          name: { type: "string", description: "数据集名，小写字母/数字/-/_" },
          tool: { type: "string", description: "数据工具名，如 store__sales_summary" },
          arguments: { type: "object", description: "传给数据工具的参数" },
        },
        ["name", "tool"],
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "写入当前页面目录下的静态文件（会经过零后端守卫审查）。",
      parameters: object({ path: { type: "string", description: "相对页面目录，如 index.html" }, content: { type: "string" } }, ["path", "content"]),
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取当前页面目录下的文件（含尚未发布的草稿）。",
      parameters: object({ path: { type: "string" } }, ["path"]),
    },
  },
  {
    type: "function",
    function: { name: "list_files", description: "列出当前页面目录下的文件。", parameters: object({}) },
  },
  {
    type: "function",
    function: {
      name: "reply",
      description: "不修改页面、只回答店长的问题时使用，结束本轮。",
      parameters: object({ text: { type: "string" } }, ["text"]),
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "完成并发布页面。",
      parameters: object(
        {
          title: { type: "string" },
          summary: { type: "string" },
          tools: { type: "array", items: { type: "string" }, description: "页面运行时通过 qdd.tool() 直接调用的只读数据工具" },
          useAgent: { type: "boolean", description: "页面运行时是否需要通过 qdd.ask() 调用 agent" },
          metrics: { type: "array", items: { type: "string" }, description: "页面展示的指标（口径变更时据此提示复核）" },
        },
        ["title", "summary", "tools", "useAgent"],
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "recall",
      description: "检索以往的页面和会话（标题、愿望、结论摘要），用于延续之前的分析、避免重复建设。",
      parameters: object({ query: { type: "string" } }, ["query"]),
    },
  },
  {
    type: "function",
    function: {
      name: "read_session",
      description: "读取某个以往会话的要点（店长消息、回复、发布结果）。",
      parameters: object({ id: { type: "string" } }, ["id"]),
    },
  },
  {
    type: "function",
    function: {
      name: "read_artifact",
      description: "读取某个已有页面的元信息（指标、数据集版本、文件列表）。要看文件内容需在该页面的会话里修改。",
      parameters: object({ slug: { type: "string" } }, ["slug"]),
    },
  },
  {
    type: "function",
    function: {
      name: "propose_metric_change",
      description: "提议新增或修改指标口径（需店长授权）。授权后所有使用该指标的页面会被标记待复核。",
      parameters: object(
        {
          changes: { type: "object", description: "{ 指标名: MetricDef }" },
          reason: { type: "string" },
        },
        ["changes", "reason"],
      ),
    },
  },
];

/** 从工具参数中收集引用的数据集与指标。 */
function collectRefs(args: JsonObject, datasets: Set<string>, metrics: Set<string>): void {
  if (typeof args.dataset === "string") datasets.add(args.dataset);
  for (const list of [args.join, args.keymap]) {
    if (Array.isArray(list)) for (const j of list) if (typeof (j as JsonObject)?.dataset === "string") datasets.add((j as JsonObject).dataset as string);
  }
  if (Array.isArray(args.metrics)) for (const m of args.metrics) if (typeof m === "string") metrics.add(m);
}

export async function runWish(
  { config, paths }: LoadedConfig,
  sources: DataSources,
  chat: ChatFn,
  request: WishRequest,
  hooks: WishHooks,
): Promise<WishResult> {
  const pages = await readPages(paths);
  const updating = request.slug ? pages.find((p) => p.slug === request.slug) : undefined;
  const history = request.history ?? [];
  if (request.slug && (!updating || !SLUG_RE.test(request.slug))) throw new Error(`页面 ${request.slug} 不存在`);
  const slug = updating?.slug ?? newSlug();
  const pageDir = path.join(paths.pages, slug);
  /** 乐观锁：发布时页面版本必须仍是开始时的版本。 */
  let baseVersion = updating?.version ?? 0;
  const usedDatasets = new Set<string>();
  const usedMetrics = new Set<string>();

  /** 草稿区：所有写入先进这里，finish 审查通过后才原子发布。 */
  const staged = new Map<string, string>();
  let existing = updating ? await listFiles(pageDir) : [];

  const tools: LlmTool[] = [
    ...sources.tools.map((t): LlmTool => ({
      type: "function",
      function: { name: t.name, description: `${t.mutating ? "[写入·需授权] " : ""}${t.description}`, parameters: t.inputSchema },
    })),
    ...HARNESS_TOOLS,
  ];

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: systemPrompt({
        slug,
        style: await readStyle(paths),
        theme: await readTheme(paths),
        cdnAllowlist: config.cdnAllowlist,
        pages,
        updating,
        metrics: await sources.metrics(),
        datasets: await sources.datasets.list(),
        sessions: (await listSessionMetas(paths)).filter((s) => s.id !== request.sessionId && s.summary).slice(0, 5),
      }),
    },
    ...history,
    { role: "user", content: request.wish },
  ];
  const conversation = () => messages.slice(1);

  async function snapshot(args: JsonObject): Promise<string> {
    const name = String(args.name ?? "");
    const toolName = String(args.tool ?? "");
    if (!NAME_RE.test(name)) throw new Error("数据集名只能包含小写字母、数字、-、_");
    const tool = sources.get(toolName);
    if (!tool) throw new Error(`未知数据工具 ${toolName}`);
    if (tool.mutating) throw new Error("快照只能使用只读数据工具");
    const toolArgs = (args.arguments as JsonObject | undefined) ?? {};
    collectRefs(toolArgs, usedDatasets, usedMetrics);
    const data = await tool.call(toolArgs);
    const js = `window.QDD_DATA = window.QDD_DATA || {};\nwindow.QDD_DATA[${JSON.stringify(name)}] = ${toScriptJson(data)};\n`;
    if (js.length > SNAPSHOT_MAX_BYTES) throw new Error("快照超过 5MB，请改用汇总工具或缩小日期范围");
    staged.set(`${DATA_DIR}/${name}.js`, js);
    hooks.onEvent({ kind: "tool", text: `快照 ${name} ← ${toolName}（${(js.length / 1024).toFixed(1)} KB）` });
    const preview = Array.isArray(data)
      ? { type: "array", length: data.length, sample: data.slice(0, 3) }
      : data;
    return `已保存 data/${name}.js，页面中用 <script src="./data/${name}.js"></script> 引入，读取 window.QDD_DATA[${JSON.stringify(name)}]。\n预览：${truncate(JSON.stringify(preview), 3000)}`;
  }

  async function commit(): Promise<void> {
    const tag = `${Date.now()}-${process.pid}`;
    const staging = path.join(paths.pages, `.staging-${slug}-${tag}`);
    if (updating) await cp(pageDir, staging, { recursive: true });
    else await mkdir(staging, { recursive: true });
    for (const [rel, content] of staged) {
      const file = path.join(staging, rel);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, "utf8");
    }
    if (updating) {
      const trash = path.join(paths.pages, `.trash-${slug}-${tag}`);
      await rename(pageDir, trash);
      await rename(staging, pageDir);
      await rm(trash, { recursive: true, force: true });
    } else {
      await rename(staging, pageDir);
    }
  }

  async function finish(args: JsonObject): Promise<WishResult | string> {
    const files = [...new Set([...existing, ...staged.keys()])];
    if (!files.includes("index.html")) return "错误：缺少入口 index.html";
    const pageTools = Array.isArray(args.tools) ? [...new Set(args.tools.map(String))] : [];
    const problems: string[] = [];
    for (const name of pageTools) {
      const tool = sources.get(name);
      if (!tool) problems.push(`tools：未知数据工具 ${name}`);
      else if (tool.mutating) problems.push(`tools：${name} 是写入类工具，页面不能直接调用`);
    }
    for (const [rel, content] of staged) {
      if (rel.startsWith(`${DATA_DIR}/`)) continue;
      const { violations } = checkFile(rel, content, config.cdnAllowlist);
      if (violations.length) problems.push(`${rel}：${violations.join("；")}`);
    }
    if (problems.length) return `守卫拒绝发布：\n${problems.join("\n")}`;

    const current = (await readPages(paths)).find((p) => p.slug === slug);
    if ((current?.version ?? 0) !== baseVersion) {
      // 其它会话在此期间发布了新版本：同步基线，要求 agent 重新读取后再改
      baseVersion = current?.version ?? 0;
      existing = await listFiles(pageDir);
      return `发布冲突：页面已被其它会话更新到版本 ${baseVersion}。请用 list_files / read_file 查看最新内容，合并你的修改后再次 finish。`;
    }
    for (const m of Array.isArray(args.metrics) ? args.metrics : []) if (typeof m === "string") usedMetrics.add(m);
    const versions: Record<string, string> = {};
    for (const d of usedDatasets) {
      const m = await sources.datasets.get(d);
      if (m) versions[d] = m.version;
    }

    await commit();
    const now = new Date().toISOString();
    const page: PageEntry = {
      slug,
      title: String(args.title ?? "未命名页面").slice(0, 40),
      wish: updating ? `${updating.wish} → ${request.wish}` : request.wish,
      summary: String(args.summary ?? ""),
      tools: pageTools,
      useAgent: args.useAgent === true,
      metrics: [...usedMetrics].sort(),
      datasets: versions,
      version: baseVersion + 1,
      stale: null,
      sessionId: request.sessionId,
      createdAt: updating?.createdAt ?? now,
      updatedAt: now,
    };
    await upsertPage(paths, page);
    return { page, files, messages: [], summary: page.summary };
  }

  async function dispatch(name: string, args: JsonObject): Promise<string | WishResult> {
    switch (name) {
      case "snapshot_data":
        return snapshot(args);
      case "write_file": {
        const content = typeof args.content === "string" ? args.content : "";
        const { path: rel, violations } = checkFile(String(args.path ?? ""), content, config.cdnAllowlist);
        if (violations.length) {
          hooks.onEvent({ kind: "warn", text: `守卫拒绝 ${rel}：${violations.join("；")}` });
          return `守卫拒绝写入 ${rel}：\n- ${violations.join("\n- ")}\n请修改后重新写入。`;
        }
        staged.set(rel, content);
        hooks.onEvent({ kind: "tool", text: `写入 ${rel}（${(content.length / 1024).toFixed(1)} KB）` });
        return `已写入草稿 ${rel}`;
      }
      case "read_file": {
        const { path: rel, violations } = checkPath(String(args.path ?? ""));
        if (violations.some((v) => v.startsWith("禁止写出") || v.startsWith("路径"))) return "错误：只能读取当前页面目录";
        const draft = staged.get(rel);
        if (draft !== undefined) return truncate(draft, 40_000);
        try {
          return truncate(await readFile(path.join(pageDir, rel), "utf8"), 40_000);
        } catch {
          return `错误：文件 ${rel} 不存在`;
        }
      }
      case "list_files":
        return JSON.stringify([...new Set([...existing, ...staged.keys()])].sort());
      case "finish":
        return finish(args);
      case "reply": {
        const text = String(args.text ?? "");
        hooks.onEvent({ kind: "say", text });
        return { page: undefined, files: [], messages: [], summary: text.slice(0, 200) };
      }
      case "recall":
        return JSON.stringify(await recall(paths, String(args.query ?? "")));
      case "read_session":
        return readSessionDigest(paths, String(args.id ?? ""));
      case "read_artifact":
        return JSON.stringify(await readArtifact(paths, String(args.slug ?? "")));
      case "propose_metric_change": {
        const changes = args.changes as MetricCatalog | undefined;
        const reason = String(args.reason ?? "");
        if (!changes || typeof changes !== "object" || !Object.keys(changes).length) throw new Error("changes 不能为空");
        const pseudo: DataTool = {
          name: "propose_metric_change",
          description: "修改指标口径",
          inputSchema: {},
          source: "harness",
          mutating: true,
          preauthorized: false,
          call: async () => undefined,
        };
        if (!(await hooks.authorize(pseudo, args))) throw new Error("店长未授权修改指标口径，不得绕过。");
        const affected = await updateMetrics(paths, changes, reason);
        hooks.onEvent({ kind: "tool", text: `指标口径已更新：${Object.keys(changes).join("、")}` });
        return `已更新。受影响页面（已标记待复核）：${affected.join(", ") || "无"}`;
      }
      default: {
        collectRefs(args, usedDatasets, usedMetrics);
        hooks.onEvent({ kind: "tool", text: `查询 ${name} ${truncate(JSON.stringify(args), 120)}` });
        const result = await sources.call(name, args, hooks.authorize);
        return truncate(JSON.stringify(result), EXPLORE_LIMIT);
      }
    }
  }

  let idle = 0;
  for (let step = 0; step < config.llm.maxSteps; step++) {
    hooks.signal?.throwIfAborted();
    const reply = await chat(messages, tools, hooks.signal);
    messages.push(reply);
    if (reply.content?.trim()) hooks.onEvent({ kind: "say", text: reply.content.trim() });

    if (!reply.tool_calls?.length) {
      if (++idle > 2) throw new Error("agent 未调用 finish 就停止了");
      messages.push({ role: "user", content: "请继续使用工具完成页面，完成后必须调用 finish。" });
      continue;
    }
    idle = 0;

    let done: WishResult | undefined;
    for (const call of reply.tool_calls) {
      let output: string;
      try {
        const args = call.function.arguments ? (JSON.parse(call.function.arguments) as JsonObject) : {};
        const result = await dispatch(call.function.name, args);
        if (typeof result === "string") output = result;
        else {
          done = result;
          output = result.page ? "已发布" : "已回复";
        }
      } catch (error) {
        output = `错误：${(error as Error).message}`;
        hooks.onEvent({ kind: "warn", text: `${call.function.name} 失败：${(error as Error).message}` });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: output });
    }
    if (done) {
      if (done.page) hooks.onEvent({ kind: "ok", text: `已发布「${done.page.title}」` });
      return { ...done, messages: conversation() };
    }
  }
  throw new Error(`超过最大步数 ${config.llm.maxSteps}，页面未发布`);
}

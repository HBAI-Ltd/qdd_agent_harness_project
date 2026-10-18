import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { AttachmentRef, HarnessConfig, ModelCatalog, PageView, SessionDetail, SessionMeta } from "@qdd/shared";
import { runWish } from "./agent/agent.js";
import { runAsk } from "./agent/ask.js";
import type { ChatFn, ChatMessage } from "./agent/llm.js";
import { loadConfig, type LoadedConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { refreshDatasets } from "./datasets/refresh.js";
import { readAll } from "./datasets/store.js";
import { startGateway, type Gateway } from "./gateway/server.js";
import { checkFile } from "./guard.js";
import { SessionHub } from "./sessions.js";
import { ensureWorkspace, readPages, upsertPage } from "./web/site.js";

const CDN = ["cdn.jsdelivr.net"];
const TOKEN = "test-gateway-token-0123456789";

describe("guard", () => {
  test("允许白名单在线包、SDK 调用与纯前端计算", () => {
    const html = `<link rel="stylesheet" href="../../assets/theme.css">
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>
<script src="./data/sales.js"></script>
<script>qdd.data("sales", "store__sales_summary", { groupBy: "day" }).then(rows => rows.filter(r => r.revenue > 0));</script>`;
    assert.deepEqual(checkFile("index.html", html, CDN).violations, []);
  });

  for (const [name, content] of [
    ["fetch", "fetch('/api/orders')"],
    ["xhr", "new XMLHttpRequest()"],
    ["websocket", "new WebSocket('ws://x')"],
    ["sql", "const q = 'SELECT name, price FROM products'"],
    ["sql 引擎", '<script src="https://cdn.jsdelivr.net/npm/sql.js@1/dist/sql-wasm.js"></script>'],
    ["云后端", "import { createClient } from '@supabase/supabase-js'"],
    ["表单提交", '<form action="/save" method="post">'],
    ["非白名单 CDN", '<script src="https://evil.example.com/x.js"></script>'],
    ["eval", "eval('1')"],
    ["移除缺口说明", "document.querySelector('[data-qdd-gaps]').remove()"],
  ]) {
    test(`拒绝 ${name}`, () => assert.notDeepEqual(checkFile("index.html", content!, CDN).violations, []));
  }

  test("拒绝越权路径与后端文件", () => {
    for (const p of ["../other/index.html", "/etc/passwd", "data/sales.js", "server.ts", "schema.sql", ".env", "a\\b.html"]) {
      assert.notDeepEqual(checkFile(p, "", CDN).violations, [], p);
    }
  });
});

/** 以 SSE 响应的远程 MCP 服务，要求 Bearer 鉴权，带一个写入类工具。 */
function startFakeSseMcp(): Promise<{ url: string; server: Server; calls: string[] }> {
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer secret") return void res.writeHead(401).end();
    if (req.method === "DELETE") return void res.writeHead(200).end();
    let body = "";
    for await (const c of req) body += c;
    const msg = JSON.parse(body) as { id?: number; method: string; params?: { name?: string } };
    if (msg.id === undefined) return void res.writeHead(202).end();
    let result: unknown;
    if (msg.method === "initialize") {
      res.setHeader("Mcp-Session-Id", "s1");
      result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } };
    } else if (msg.method === "tools/list") {
      result = {
        tools: [
          { name: "get_weather", description: "天气", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
          { name: "update_price", description: "改价", inputSchema: { type: "object" } },
          { name: "list_sales", description: "外部销售（支持 since 增量）", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
        ],
      };
    } else {
      const name = String(msg.params?.name);
      calls.push(name);
      const since = (msg.params as { arguments?: { since?: string } } | undefined)?.arguments?.since;
      const sales = [
        { id: "e1", time: "2026-10-15 10:00", code: "E-1", revenue: 5 },
        { id: "e2", time: "2026-10-16 11:00", code: "E-2", revenue: 7 },
      ].filter((r) => !since || r.time > since);
      result = { content: [{ type: "text", text: JSON.stringify(name === "list_sales" ? { rows: sales } : { ok: true }) }] };
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n\n`);
    res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const a = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${a.port}/mcp`, server, calls });
    }),
  );
}

let n = 0;
const call = (name: string, args: object): ChatMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: `c${n++}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

describe("session cancellation", () => {
  let loaded: LoadedConfig;
  let sources: DataSources;

  before(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qdd-cancel-"));
    loaded = await loadConfig(root);
    await ensureWorkspace(loaded.paths);
    sources = await DataSources.open(loaded);
  });

  after(async () => { await sources.close(); });

  async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 2000;
    for (;;) {
      const value = await read();
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw new Error("等待取消状态超时");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  for (const kind of ["question", "approval"] as const) {
    test(`cancelling a waiting ${kind} releases only that conversation and permits a follow-up`, async (t) => {
      let writes = 0;
      const tool = {
        name: `cancel_test__write_${kind}`, description: "测试写入", inputSchema: { type: "object" },
        source: "test", mutating: true, preauthorized: false,
        call: async () => { writes++; return "已写入"; },
      };
      sources.tools.push(tool);
      t.after(() => { sources.tools.splice(sources.tools.indexOf(tool), 1); });
      let calls = 0;
      const chat: ChatFn = async (messages) => {
        calls++;
        if (messages.some((message) => message.role === "tool") || messages.filter((message) => message.role === "user").length > 1) {
          return call("reply", { text: "已继续完成", gaps: [] });
        }
        return kind === "question"
          ? call("clarify", { questions: [{ id: "scope", question: "选择范围", options: [{ label: "近期" }, { label: "全部" }] }] })
          : call(tool.name, {});
      };
      const hub = new SessionHub(loaded, sources, () => chat);
      const statuses: { id: string; status: SessionMeta["status"] }[] = [];
      hub.onMeta((meta) => { statuses.push({ id: meta.id, status: meta.status }); });
      t.after(async () => {
        for (const pending of await hub.pending()) {
          if (pending.kind === "question") hub.answer(pending.sessionId, pending.requestId, {});
          else hub.approve(pending.sessionId, pending.requestId, false);
        }
      });
      const cancelled = await hub.create("需要停止的对话");
      const retained = await hub.create("需要保留的对话");
      const pending = await until(async () => {
        const entries = await hub.pending();
        return entries.length === 2 && (await hub.meta(cancelled.id)).status === "waiting"
          && (await hub.meta(retained.id)).status === "waiting" ? entries : undefined;
      });
      const own = pending.find((entry) => entry.sessionId === cancelled.id)!;
      const other = pending.find((entry) => entry.sessionId === retained.id)!;
      const callsBeforeCancel = calls;
      hub.cancel(cancelled.id);
      const final = await until(async () => {
        const detail = await hub.detail(cancelled.id);
        return detail.status === "error" && statuses.some((entry) => entry.id === cancelled.id && entry.status === "error")
          ? detail : undefined;
      });
      assert.equal(hub.isRunning(cancelled.id), false);
      assert.ok(final.events.some((event) => event.type === "error" && event.message === "已取消"));
      const history = JSON.parse(await readFile(path.join(loaded.paths.sessions, `${cancelled.id}.messages.json`), "utf8")) as ChatMessage[];
      for (const toolCall of history.flatMap((message) => message.tool_calls ?? [])) {
        assert.ok(history.some((message) => message.role === "tool" && message.tool_call_id === toolCall.id), "Cancelled history must retain a result for every tool call");
      }
      assert.equal(calls, callsBeforeCancel, "Cancellation must not call the model again");
      assert.equal(writes, 0, "Cancelled authorization must not execute the write");
      assert.deepEqual((await hub.pending()).map((entry) => entry.requestId), [other.requestId]);
      assert.equal((await hub.meta(retained.id)).status, "waiting");
      if (kind === "question") {
        assert.ok(final.events.some((event) => event.type === "question_answered" && event.requestId === own.requestId && event.answers === null));
        assert.throws(() => hub.answer(cancelled.id, own.requestId, {}));
        hub.answer(retained.id, other.requestId, { scope: ["近期"] });
      } else {
        assert.ok(final.events.some((event) => event.type === "approval_resolved" && event.requestId === own.requestId && event.approved === false));
        assert.throws(() => hub.approve(cancelled.id, own.requestId, true));
        hub.approve(retained.id, other.requestId, true);
      }
      await until(async () => (await hub.meta(retained.id)).status === "idle" ? true : undefined);
      await hub.send(cancelled.id, "继续对话");
      await until(async () => (await hub.meta(cancelled.id)).status === "idle" ? true : undefined);
      assert.equal(writes, kind === "approval" ? 1 : 0);
    });
  }

  test("cancellation skips later tools in the same model response", async (t) => {
    const chat: ChatFn = async () => {
      const question = call("clarify", { questions: [{ id: "scope", question: "选择范围", options: [{ label: "近期" }, { label: "全部" }] }] });
      const later = call("reply", { text: "这条回复应被停止", gaps: [] });
      return { ...question, tool_calls: [...question.tool_calls!, ...later.tool_calls!] };
    };
    const hub = new SessionHub(loaded, sources, () => chat);
    const created = await hub.create("同批工具停止");
    t.after(async () => {
      for (const pending of await hub.pending()) if (pending.kind === "question") hub.answer(created.id, pending.requestId, {});
    });
    await until(async () => (await hub.meta(created.id)).status === "waiting" ? true : undefined);
    hub.cancel(created.id);
    const final = await until(async () => {
      const detail = await hub.detail(created.id);
      return detail.status === "error" ? detail : undefined;
    });
    assert.ok(final.events.some((event) => event.type === "error" && event.message === "已取消"));
    assert.equal(final.events.some((event) => event.type === "say" && event.text === "这条回复应被停止"), false);
    const history = JSON.parse(await readFile(path.join(loaded.paths.sessions, `${created.id}.messages.json`), "utf8")) as ChatMessage[];
    assert.equal(history.filter((message) => message.role === "tool").length, 2);
    assert.ok(history.filter((message) => message.role === "tool").every((message) => message.content === "已取消，工具未完成。"));
    assert.deepEqual(await hub.pending(), []);
  });
});

describe("gateway", () => {
  let root: string;
  let base: LoadedConfig;
  let selfGateway: Gateway;
  let selfSources: DataSources;
  let gateway: Gateway;
  let sources: DataSources;
  let fake: Awaited<ReturnType<typeof startFakeSseMcp>>;
  const script: ChatMessage[] = [];
  const seen: ChatMessage[][] = [];
  const chat: ChatFn = async (messages) => {
    seen.push(structuredClone(messages));
    return script.shift() ?? { role: "assistant", content: "（脚本结束）" };
  };
  const api = (p: string, init: RequestInit = {}) =>
    fetch(gateway.url + p, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...init.headers } });

  before(async () => {
    process.env.FAKE_MCP_TOKEN = "secret";
    root = await mkdtemp(path.join(tmpdir(), "qdd-"));
    await writeFile(path.join(root, "harness.config.json"), JSON.stringify({ gateway: { port: 0 }, llm: { clarify: "auto" } }));
    base = await loadConfig(root);
    await ensureWorkspace(base.paths);
    fake = await startFakeSseMcp();

    // 第一个网关只提供 /mcp（JSON 响应），供第二个网关作为远程 MCP 接入。
    selfSources = await DataSources.open(base);
    // Production workspaces start empty; regression data belongs only to this fixture.
    await selfSources.datasets.define({
      name: "order_items", description: "Gateway regression fixture", kind: "fact", key: ["orderId", "sku"], timeField: "time",
      fields: { orderId: "string", sku: "string", time: "string", date: "string", category: "string", channel: "string", revenue: "number", grossProfit: "number", qty: "number" },
    });
    await selfSources.datasets.append("order_items", Array.from({ length: 200 }, (_, index) => ({
      orderId: `fixture-${index}`, sku: `SKU${String(index).padStart(3, "0")}`,
      time: "2026-10-15 09:00", date: "2026-10-15", category: index % 2 ? "食品" : "饮料",
      channel: index % 2 ? "外卖" : "门店", revenue: index % 2 ? 200 : 100, grossProfit: index % 2 ? 20 : 50, qty: 10,
    })));
    selfGateway = await startGateway(base, selfSources, { token: TOKEN, chat: () => chat });

    process.env.SELF_TOKEN = TOKEN;
    const loaded: LoadedConfig = {
      ...base,
      config: {
        ...base.config,
        mcpServers: {
          self: { url: `${selfGateway.url}/mcp`, bearerTokenEnv: "SELF_TOKEN" },
          fake: { url: fake.url, bearerTokenEnv: "FAKE_MCP_TOKEN" },
        },
      },
    };
    sources = await DataSources.open(loaded);
    gateway = await startGateway(loaded, sources, { token: TOKEN, chat: () => chat });
  });

  after(async () => {
    await gateway.close();
    await selfGateway.close();
    await sources.close();
    await selfSources.close();
    fake.server.close();
    fake.server.closeAllConnections();
  });

  test("接入 HTTP MCP（JSON 与 SSE 响应、Bearer 鉴权）", async () => {
    assert.deepEqual(sources.warnings, []);
    const local = await sources.call("store__sales_summary", { groupBy: "category" }, async () => false);
    const remote = await sources.call("mcp__self__sales_summary", { groupBy: "category" }, async () => false);
    assert.deepEqual(remote, local);
    assert.equal(sources.get("mcp__fake__get_weather")?.mutating, false);
    assert.equal(sources.get("mcp__fake__update_price")?.mutating, true);
  });

  test("没有网关 token 一律拒绝", async () => {
    for (const p of ["/api/pages", "/api/sessions", "/api/style", "/api/tools"]) {
      assert.equal((await fetch(gateway.url + p)).status, 401, p);
    }
    assert.equal((await fetch(`${gateway.url}/mcp`, { method: "POST", body: "{}" })).status, 401);
  });

  test("gateway health and unknown routes retain their status codes", async () => {
    const health = await fetch(`${gateway.url}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    assert.equal((await api("/api/not-a-route")).status, 404);
  });

  test("许愿会话：授权写入、守卫拦截、发布、续聊", async () => {
    script.push(
      call("store__get_store_info", {}),
      call("mcp__fake__update_price", { sku: "SKU001", price: 2.5 }),
      call("snapshot_data", { name: "cat", tool: "store__aggregate", arguments: { dataset: "order_items", groupBy: ["category"], metrics: ["revenue", "grossMargin"] } }),
      call("write_file", { path: "index.html", content: "<script>fetch('/api')</script>" }),
      call("write_file", {
        path: "index.html",
        content: '<html><head><link rel="stylesheet" href="../../assets/theme.css"></head><body><script src="./data/cat.js"></script><script>qdd.data("cat", "store__sales_summary", { groupBy: "category" })</script></body></html>',
      }),
      call("finish", { title: "品类销售", summary: "饮料品类毛利最高", tools: ["store__sales_summary"], useAgent: false, metrics: ["revenue"], gaps: [] }),
    );
    const created = (await (await api("/api/wishes", { method: "POST", body: JSON.stringify({ wish: "看看各品类" }) })).json()) as SessionMeta;
    assert.equal(created.status, "running");

    // 等待授权请求并批准
    let detail: SessionDetail;
    for (;;) {
      detail = (await (await api(`/api/sessions/${created.id}`)).json()) as SessionDetail;
      const pending = detail.events.find((e) => e.type === "approval_required");
      if (pending?.type === "approval_required") {
        const r = await api(`/api/sessions/${created.id}/approvals/${pending.requestId}`, { method: "POST", body: JSON.stringify({ approved: true }) });
        assert.equal(r.status, 200);
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    while (detail.status === "running" || detail.status === "waiting") {
      await new Promise((r) => setTimeout(r, 20));
      detail = (await (await api(`/api/sessions/${created.id}`)).json()) as SessionDetail;
    }
    assert.equal(detail.status, "idle", JSON.stringify(detail.events));
    assert.deepEqual(fake.calls, ["update_price"]);
    assert.ok(detail.events.some((e) => e.type === "warn" && e.text.includes("守卫拒绝")));
    const published = detail.events.find((e) => e.type === "published");
    assert.ok(published?.type === "published");
    assert.equal(detail.slug, published.page.slug);
    assert.equal(published.page.version, 1);
    assert.deepEqual(published.page.metrics, ["grossMargin", "revenue"]);
    assert.equal(published.page.datasets.order_items, (await sources.datasets.get("order_items"))!.version);
    assert.equal(detail.summary, "饮料品类毛利最高");

    // 续聊：上一轮的完整对话会带给模型
    script.push(call("reply", { text: "饮料毛利最高", gaps: [] }));
    assert.equal((await api(`/api/sessions/${created.id}/messages`, { method: "POST", body: JSON.stringify({ text: "哪个品类毛利最高？" }) })).status, 202);
    const final = await gateway.hub.wait(created.id);
    assert.equal(final.status, "idle");
    const lastPrompt = seen.at(-1)!;
    assert.ok(lastPrompt.some((m) => m.role === "user" && String(m.content).startsWith("看看各品类")));
    assert.ok(lastPrompt.some((m) => m.role === "tool" && m.content === "已发布"));
    const after = (await (await api(`/api/sessions/${created.id}`)).json()) as SessionDetail;
    assert.ok(after.events.some((e) => e.type === "say" && e.text === "饮料毛利最高"));
  });

  test("页面：页面 token 访问、直连声明过的工具、拒绝越权", async () => {
    const [page] = (await (await api("/api/pages")).json()) as PageView[];
    assert.ok(page);
    assert.equal((await fetch(`${gateway.url}/pages/${page.slug}/`)).status, 401);

    const enter = await fetch(gateway.url + page.url, { redirect: "manual" });
    assert.equal(enter.status, 302);
    const cookie = enter.headers.get("set-cookie")!.split(";")[0]!;
    const html = await fetch(`${gateway.url}/pages/${page.slug}/`, { headers: { cookie } });
    assert.equal(html.status, 200);
    const policy = (html.headers.get("content-security-policy") ?? "").split("; ");
    assert.ok(policy.includes(`connect-src ${gateway.url}/api/`));
    assert.ok(policy.includes("form-action 'none'"));
    assert.ok(policy.includes("frame-src 'none'"));
    const body = await html.text();
    assert.match(body, /window\.QDD_PAGE=.*<script src="\/sdk\/qdd\.js">/);
    const pageToken = /"token":"([^"]+)"/.exec(body)![1]!;

    const asPage = (p: string, payload: object) =>
      fetch(gateway.url + p, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-QDD-Page": page.slug, "X-QDD-Page-Token": pageToken },
        body: JSON.stringify(payload),
      });
    const ok = await asPage("/api/tools/store__sales_summary", { groupBy: "channel" });
    assert.equal(ok.status, 200);
    assert.ok(Array.isArray(((await ok.json()) as { result: unknown }).result));
    assert.equal((await asPage("/api/tools/store__query_orders", {})).status, 403);
    assert.equal((await asPage("/api/ask", { question: "x" })).status, 403);
    assert.equal((await asPage("/api/sessions", {})).status, 401);
    assert.equal((await api("/api/tools/mcp__fake__update_price", { method: "POST", body: "{}" })).status, 403);
  });

  test("页面注入共享计算引擎与指标口径；页面状态按页面隔离", async () => {
    const [page] = (await (await api("/api/pages")).json()) as PageView[];
    const compute = await fetch(`${gateway.url}/sdk/compute.js`);
    assert.match(await compute.text(), /window\.__qddCompute = Object\.freeze\(\{[^}]*aggregate/);
    const enter = await fetch(gateway.url + page!.url, { redirect: "manual" });
    const cookie = enter.headers.get("set-cookie")!.split(";")[0]!;
    const html = await (await fetch(`${gateway.url}/pages/${page!.slug}/`, { headers: { cookie } })).text();
    assert.match(html, /"grossMargin":\{"label":"毛利率"/);
    const pageToken = /"token":"([^"]+)"/.exec(html)![1]!;

    const headers = { "Content-Type": "application/json", "X-QDD-Page": page!.slug, "X-QDD-Page-Token": pageToken };
    const put = await fetch(`${gateway.url}/api/state/${page!.slug}`, { method: "PUT", headers, body: JSON.stringify({ priceUp: 0.05 }) });
    assert.equal(put.status, 200);
    assert.deepEqual(((await (await api(`/api/state/${page!.slug}`)).json()) as { state: unknown }).state, { priceUp: 0.05 });
    await upsertPage(base.paths, { ...page!, slug: "other-page" });
    assert.equal((await fetch(`${gateway.url}/api/state/other-page`, { headers })).status, 401);
    assert.equal((await fetch(`${gateway.url}/api/state/${page!.slug}`, { method: "PUT", headers, body: "[1]" })).status, 400);
  });

  test("跨会话：新会话的提示词带上以往摘要，recall 能检索到页面", async () => {
    script.push(call("recall", { query: "品类毛利" }), call("reply", { text: "之前做过品类分析", gaps: [] }));
    const created = (await (await api("/api/wishes", { method: "POST", body: JSON.stringify({ wish: "上次的品类结论是什么" }) })).json()) as SessionMeta;
    await gateway.hub.wait(created.id);
    const prompt = seen.at(-2)![0]!.content!;
    assert.match(prompt, /最近的其它会话[\s\S]*饮料毛利最高/); // 会话摘要取最近一轮
    const recallResult = seen.at(-1)!.at(-1)!.content!;
    assert.match(recallResult, /"kind":"page".*"title":"品类销售"/);
  });

  test("并发修改同一页面：网关拒绝第二个会话；发布时版本冲突要求重读", async () => {
    const [page] = (await (await api("/api/pages")).json()) as PageView[];
    // 1) 运行中的会话占用页面时，另一个会话不能修改它
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    script.push(call("reply", { text: "ok", gaps: [] }));
    const blocking: ChatFn = async (m, t) => {
      await gate;
      return chat(m, t);
    };
    const hub = gateway.hub as unknown as { chat: () => ChatFn };
    const original = hub.chat;
    hub.chat = () => blocking;
    const first = (await (await api("/api/wishes", { method: "POST", body: JSON.stringify({ wish: "改一下", slug: page!.slug }) })).json()) as SessionMeta;
    const second = await api("/api/wishes", { method: "POST", body: JSON.stringify({ wish: "我也改", slug: page!.slug }) });
    assert.equal(second.status, 409);
    release();
    await gateway.hub.wait(first.id);
    hub.chat = original;

    // 2) 乐观锁：草稿期间页面被别处发布，finish 被拒绝，重试后版本 +2
    const html = '<html><head></head><body><link rel="stylesheet" href="../../assets/theme.css"></body></html>';
    let bumped = false;
    const racing: ChatFn = async (messages) => {
      const last = messages.at(-1)!;
      if (last.role === "user") return call("write_file", { path: "index.html", content: html });
      if (!bumped) {
        bumped = true;
        const current = (await readPages(base.paths)).find((p) => p.slug === page!.slug)!;
        await upsertPage(base.paths, { ...current, version: current.version + 1 });
        return call("finish", { title: "t", summary: "s", tools: [], useAgent: false, gaps: [] });
      }
      assert.match(String(last.content), /发布冲突/);
      return call("finish", { title: "t", summary: "s", tools: [], useAgent: false });
    };
    const before = (await readPages(base.paths)).find((p) => p.slug === page!.slug)!.version;
    const result = await runWish(base, sources, racing, { wish: "调整", slug: page!.slug, sessionId: first.id }, { onEvent: () => {}, authorize: async () => false });
    assert.equal(result.page?.version, before + 2);
    assert.deepEqual(result.page?.gaps, []);
  });

  test("gaps 由 harness 生成：工具不要求、忽略模型输入、数字核验结果仍展示", async () => {
    const hooks = { onEvent: () => {}, authorize: async () => false };
    for (const args of [
      { text: "已完成" },
      { text: "已完成", gaps: [{ kind: "missing_data", item: "客流量", reason: "模型声明" }] },
      { text: "已完成", gaps: "无效声明" },
    ]) {
      const chat: ChatFn = async (_messages, tools) => {
        for (const name of ["reply", "finish"]) {
          const schema = tools.find((t) => t.function.name === name)!.function.parameters;
          assert.equal(Object.hasOwn(schema.properties as object, "gaps"), false);
          assert.equal((schema.required as string[]).includes("gaps"), false);
        }
        return call("reply", args);
      };
      const result = await runWish(base, sources, chat, { wish: "打个招呼", sessionId: "gaps-reply" }, hooks);
      assert.deepEqual(result.gaps, []);
    }

    for (const name of ["reply", "finish"]) {
      let attempts = 0;
      const text = "销售额 ¥987,654,321.00";
      const chat: ChatFn = async (messages) => {
        if (name === "finish" && messages.at(-1)!.role === "user") {
          return call("write_file", { path: "index.html", content: "<html><head></head><body>核验提示</body></html>" });
        }
        attempts++;
        // 旧会话即使仍提交 gaps，也不能覆盖 harness 的核验结果。
        return call(name, name === "reply" ? { text } : {
          title: "核验提示", summary: text, tools: [], useAgent: false,
          gaps: [{ kind: "missing_data", item: "客流量", reason: "模型声明" }],
        });
      };
      const result = await runWish(base, sources, chat, { wish: "检查结论", sessionId: `gaps-${name}` }, hooks);
      assert.equal(attempts, 3);
      assert.equal(result.gaps.length, 1);
      assert.equal(result.gaps[0]?.kind, "estimate");
      assert.equal(result.gaps[0]?.item, "结论中部分数字未能核验");
      if (name === "reply") continue;
      assert.deepEqual(result.page?.gaps, result.gaps);
      const view = ((await (await api("/api/pages")).json()) as PageView[]).find((p) => p.slug === result.page!.slug)!;
      const enter = await fetch(gateway.url + view.url, { redirect: "manual" });
      const served = await (await fetch(`${gateway.url}/pages/${view.slug}/`, { headers: { cookie: enter.headers.get("set-cookie")!.split(";")[0]! } })).text();
      assert.match(served, /<body[^>]*><aside data-qdd-gaps[^>]*>.*结论中部分数字未能核验/);
    }
  });

  test("数据集增量刷新（远程 MCP + 编号映射，可重复执行）", async () => {
    const store = sources.datasets;
    await store.define({ name: "keymap/erp", description: "ERP 编号", kind: "dimension", key: ["from"], fields: { from: "string", to: "string" } });
    await store.replace("keymap/erp", [{ from: "E-1", to: "SKU001" }, { from: "E-2", to: "SKU002" }]);
    await store.define({
      name: "erp_sales", description: "ERP 销售", kind: "fact", key: ["id"], timeField: "time",
      fields: { id: "string", time: "string", code: "string", revenue: "number" },
      source: { tool: "mcp__fake__list_sales", sinceArg: "since", rowsField: "rows", keymap: { code: "keymap/erp" } },
    });
    const [first] = await refreshDatasets(sources, ["erp_sales"]);
    assert.equal(first?.added, 2, JSON.stringify(first));
    assert.equal(first?.watermark, "2026-10-16 11:00");
    const [again] = await refreshDatasets(sources, ["erp_sales"]);
    assert.equal(again?.added, 0); // 带水位线只取增量
    assert.deepEqual((await readAll(store, "erp_sales")).map((r) => r.code).sort(), ["SKU001", "SKU002"]);
    const listed = (await (await api("/api/datasets")).json()) as { name: string }[];
    assert.ok(listed.some((d) => d.name === "erp_sales"));
  });

  test("引导式提问：等待店长回答、校验候选项、答案回到模型", async () => {
    script.push(
      call("clarify", {
        questions: [
          { id: "range", header: "时间范围", question: "「最近」指多久？", options: [{ label: "近 30 天（推荐）" }, { label: "近 7 天" }], allowOther: false },
          { id: "focus", header: "关注点", question: "想先看哪些？", multiSelect: true, options: [{ label: "品类" }, { label: "时段" }, { label: "渠道" }] },
        ],
      }),
      call("reply", { text: "好的", gaps: [] }),
    );
    const created = (await (await api("/api/wishes", { method: "POST", body: JSON.stringify({ wish: "最近生意咋样 帮我看看" }) })).json()) as SessionMeta;
    let detail: SessionDetail;
    let asked: Extract<SessionDetail["events"][number], { type: "question_required" }> | undefined;
    for (;;) {
      detail = (await (await api(`/api/sessions/${created.id}`)).json()) as SessionDetail;
      asked = detail.events.find((e) => e.type === "question_required") as typeof asked;
      if (asked && detail.status === "waiting") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(asked.round, 1);
    assert.equal(asked.questions[1]!.multiSelect, true);
    const answer = (answers: object) => api(`/api/sessions/${created.id}/questions/${asked!.requestId}`, { method: "POST", body: JSON.stringify({ answers }) });
    assert.equal((await answer({ range: ["近 30 天（推荐）", "近 7 天"] })).status, 400); // 单选
    assert.equal((await answer({ range: ["半年"] })).status, 400); // 不允许自填
    assert.equal((await answer({ range: ["近 7 天"], focus: ["品类", "按商品看"] })).status, 200); // 允许自填
    const final = await gateway.hub.wait(created.id);
    assert.equal(final.status, "idle");
    const toolResult = seen.at(-1)!.at(-1)!.content!;
    assert.match(toolResult, /【时间范围】.*\n→ 近 7 天/);
    assert.match(toolResult, /【关注点】.*\n→ 品类、按商品看/);
  });

  test("对齐门槛：新许愿未 clarify 不能写页面", async () => {
    const strict: LoadedConfig = { ...base, config: { ...base.config, llm: { ...base.config.llm, clarify: "required" } } };
    const outputs: string[] = [];
    const steps = [
      call("write_file", { path: "index.html", content: "<p>x</p>" }),
      call("clarify", { questions: [{ question: "按近 30 天看可以吗？", options: [{ label: "就这样（推荐）" }, { label: "需要调整" }] }] }),
      call("write_file", { path: "index.html", content: "<p>x</p>" }),
      call("reply", { text: "完成", gaps: [] }),
    ];
    const scripted: ChatFn = async (messages) => {
      const last = messages.at(-1)!;
      if (last.role === "tool") outputs.push(String(last.content));
      return steps.shift()!;
    };
    await runWish(strict, sources, scripted, { wish: "看看生意", sessionId: "00000000-0000-0000-0000-000000000000" }, {
      onEvent: () => {},
      authorize: async () => false,
      clarify: async (qs) => ({ [qs[0]!.id]: ["就这样（推荐）"] }),
    });
    assert.match(outputs[0]!, /请先调用 clarify/);
    assert.match(outputs[1]!, /→ 就这样（推荐）/);
    assert.match(outputs[2]!, /已写入草稿/);
  });

  test("truncated write_file leaves the draft intact and recovers with smaller files", async () => {
    const original = "<p>original</p>";
    const truncated = call("write_file", { path: "index.html", content: "partial" });
    truncated.finishReason = "length";
    truncated.tool_calls!.push(...call("reply", { text: "must not finish", gaps: [] }).tool_calls!);
    const invalid = call("write_file", {});
    invalid.tool_calls![0]!.function.arguments = '{"path":"index.html","content":"' + "x".repeat(24436);
    const steps = [
      call("write_file", { path: "index.html", content: original }),
      truncated,
      call("read_file", { path: "index.html" }),
      invalid,
      call("write_file", { path: "style.css", content: "p { color: navy; }" }),
      call("write_file", { path: "index.html", content: '<link rel="stylesheet" href="./style.css"><p>recovered</p>' }),
      call("finish", { title: "Recovered", summary: "完成", tools: [], useAgent: false, gaps: [] }),
    ];
    const outputs: string[] = [];
    const errors: string[] = [];
    const scripted: ChatFn = async (messages) => {
      const last = messages.at(-1)!;
      if (last.role === "tool") outputs.push(last.content ?? "");
      assert.ok(steps.length, "agent should finish within the scripted recovery");
      return steps.shift()!;
    };
    const result = await runWish(base, sources, scripted, {
      wish: "创建页面",
      sessionId: "00000000-0000-0000-0000-000000000002",
    }, {
      authorize: async () => false,
      onEvent: (event) => {
        if (event.kind === "tool_call" && event.tool.status === "error") errors.push(event.tool.result ?? "");
      },
    });
    assert.match(outputs[1]!, /finish_reason=length/);
    assert.equal(outputs[2], original);
    assert.match(outputs[3]!, /JSON.*工具未执行.*拆成较小文件/);
    assert.equal(errors.length, 3, "all calls in a truncated response must be blocked");
    assert.ok(result.page);
    assert.match(await readFile(path.join(base.paths.pages, result.page.slug, "index.html"), "utf8"), /recovered/);
    assert.equal(await readFile(path.join(base.paths.pages, result.page.slug, "style.css"), "utf8"), "p { color: navy; }");
  });

  test("runtime ask blocks truncated calls before executing a valid retry", async (t) => {
    let executions = 0;
    const tool = {
      name: "test__stream_read",
      description: "read-only stream test",
      inputSchema: { type: "object" },
      source: "test",
      mutating: false,
      preauthorized: false,
      call: async () => { executions++; return { ok: true }; },
    };
    sources.tools.push(tool);
    t.after(() => { sources.tools.splice(sources.tools.indexOf(tool), 1); });
    const truncated = call(tool.name, {});
    truncated.finishReason = "length";
    const steps: ChatMessage[] = [truncated, call(tool.name, {}), { role: "assistant", content: "done" }];
    let requests = 0;
    const chat: ChatFn = async (messages) => {
      if (++requests === 2) {
        assert.equal(executions, 0);
        assert.match(messages.at(-1)!.content!, /finish_reason=length/);
      }
      assert.ok(steps.length);
      return steps.shift()!;
    };
    assert.equal(await runAsk(sources, chat, "check", undefined, () => {}), "done");
    assert.equal(executions, 1);
  });

  test("回归：重复调用拦截、结论数字核验、页面工具以代码为准、失败保留对话", async () => {
    const outputs: string[] = [];
    const steps: ChatMessage[] = [
      call("store__aggregate", { dataset: "order_items", groupBy: ["sku", "channel"], metrics: ["revenue"], time: { field: "date", bucket: "day" } }),
      call("store__aggregate", { dataset: "order_items", groupBy: ["sku", "channel"], metrics: ["revenue"], time: { field: "date", bucket: "day" } }),
      call("store__aggregate", { dataset: "order_items", metrics: ["revenue", "grossMargin"] }),
      call("write_file", { path: "index.html", content: '<script>qdd.tool("store__aggregate", {})</script>' }),
      call("finish", { title: "t", summary: "全店销售额 ¥9,548.90", tools: ["store__get_inventory"], useAgent: false, gaps: [] }),
    ];
    const scripted: ChatFn = async (messages) => {
      const last = messages.at(-1)!;
      if (last.role === "tool") outputs.push(String(last.content));
      if (steps.length) return steps.shift()!;
      // 用工具结果里的真实总额改正
      const total = JSON.parse(outputs[2]!) as { revenue: number; grossMargin: number }[];
      const revenue = total[0]!.revenue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const margin = (total[0]!.grossMargin * 100).toFixed(2);
      return call("finish", { title: "t", summary: `全店销售额 ¥${revenue}，毛利率 ${margin}%，推演提价后可达 ¥99,999.00`, tools: ["store__get_inventory"], useAgent: false, gaps: [] });
    };
    const result = await runWish(base, sources, scripted, { wish: "看看", sessionId: "00000000-0000-0000-0000-000000000001" }, { onEvent: () => {}, authorize: async () => false });
    assert.match(outputs[0]!, /"truncated":true.*"rows":\d+/); // 大结果给摘要而非截断
    assert.match(outputs[1]!, /^重复调用/);
    assert.match(outputs[4]!, /¥9,548\.90：在本次工具结果中找不到出处/);
    assert.deepEqual(result.page?.tools, ["store__aggregate"]); // 未使用的移除、使用的补上

    // 模型请求失败也保留对话，可续聊
    let requests = 0;
    const failing: ChatFn = async () => {
      if (++requests > 3) throw new Error("模型请求失败");
      return call("store__get_store_info", {});
    };
    const hub = new SessionHub(base, sources, () => failing);
    const meta = await hub.create("随便看看");
    const end = await hub.wait(meta.id);
    assert.equal(end.status, "error");
    const saved = JSON.parse(await readFile(path.join(base.paths.sessions, `${meta.id}.messages.json`), "utf8")) as ChatMessage[];
    assert.ok(saved.length >= 4);
  });

  test("熔断：换着花样写错参数的循环会暂停探索；快照名自动规范化", async () => {
    let n = 0;
    const seenTools: string[][] = [];
    const outputs: string[] = [];
    const scripted: ChatFn = async (messages, tools) => {
      seenTools.push(tools.map((t) => t.function.name));
      const last = messages.at(-1)!;
      if (last.role === "tool") outputs.push(String(last.content));
      n++;
      if (n <= 4) return call("store__aggregate", { dataset: "order_items", metrics: ["revenue"], [`metrics_extra${n}`]: ["x"] });
      if (n === 5) return call("snapshot_data", { name: "Sales 30D!", tool: "store__aggregate", arguments: { dataset: "order_items", metrics: ["revenue"] } });
      return call("reply", { text: "好", gaps: [] });
    };
    await runWish(base, sources, scripted, { wish: "看看", sessionId: "00000000-0000-0000-0000-000000000002" }, { onEvent: () => {}, authorize: async () => false });
    assert.match(outputs[0]!, /未知参数 metrics_extra1/);
    assert.ok(seenTools[2]!.includes("store__aggregate"), "熔断前仍可探索");
    assert.ok(!seenTools[3]!.includes("store__aggregate"), "连续 3 步全部报错后移除探索工具");
    assert.ok(seenTools[3]!.includes("snapshot_data"));
    assert.ok(outputs.some((o) => o.startsWith("探索已暂停")), "模型无视工具列表硬调也会被挡");
    assert.match(outputs.at(-1)!, /已保存 data\/sales_30d\.js/);
  });

  test("熔断：换参数反复查询但结果不变时拦截（真实场景回归）", async () => {
    const outputs: string[] = [];
    let i = 0;
    const scripted: ChatFn = async (messages) => {
      const last = messages.at(-1)!;
      if (last.role === "tool") outputs.push(String(last.content));
      // 每次多加一个不影响结果的过滤条件
      if (i < 4) return call("store__aggregate", { dataset: "order_items", metrics: ["revenue"], filter: Array.from({ length: ++i }, () => ["revenue", ">", -1]) });
      return call("reply", { text: "好", gaps: [] });
    };
    await runWish(base, sources, scripted, { wish: "看看", sessionId: "00000000-0000-0000-0000-000000000003" }, { onEvent: () => {}, authorize: async () => false });
    assert.doesNotMatch(outputs[1]!, /^重复调用/);
    assert.match(outputs[2]!, /^重复调用：你已连续 3 次修改参数调用 store__aggregate（order_items），结果完全相同/);
  });

  test("回归：等待店长回答时停止执行，会话立即结束", async () => {
    const asking: ChatFn = async (messages) => {
      if (messages.at(-1)!.role === "tool") return call("reply", { text: "不该执行到这里", gaps: [] });
      return call("clarify", { questions: [{ id: "q", header: "范围", question: "看哪个范围？", options: [{ label: "30 天（推荐）" }, { label: "7 天" }] }] });
    };
    const hub = new (gateway.hub.constructor as new (...a: unknown[]) => typeof gateway.hub)(base, sources, () => asking);
    const meta = await hub.create("看看");
    for (let i = 0; i < 100 && (await hub.meta(meta.id)).status !== "waiting"; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal((await hub.meta(meta.id)).status, "waiting");
    hub.cancel(meta.id);
    const end = await Promise.race([hub.wait(meta.id), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("取消后会话仍未结束")), 3000))]);
    assert.equal(end.status, "error");
    const detail = await hub.detail(meta.id);
    assert.equal(detail.events.filter((e) => e.type === "error").at(-1)?.type === "error" && (detail.events.filter((e) => e.type === "error").at(-1) as { message: string }).message, "已取消");
  });

  test("附件：任意扩展名与文件夹路径，模型按需读取；切换模型下一轮生效", async () => {
    const catalog = (await (await api("/api/models")).json()) as ModelCatalog;
    assert.equal(catalog.default, catalog.models[0]!.id);

    const upload = (name: string, body: string | Uint8Array) =>
      api("/api/attachments", { method: "POST", body, headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(name) } });
    assert.equal((await upload("../escape.txt", "x")).status, 400);
    const csv = (await (await upload("报表/9月/销售.csv", "日期,销售额\n2026-09-01,1200\n")).json()) as AttachmentRef;
    assert.equal(csv.path, "报表/9月/销售.csv");
    assert.equal(csv.mime, "text/csv");
    const bin = (await (await upload("模型.blend", new Uint8Array([0, 1, 2, 255]))).json()) as AttachmentRef;
    assert.equal((await (await api(`/api/attachments/${csv.id}`)).text()), "日期,销售额\n2026-09-01,1200\n");

    const models: string[] = [];
    const hub = gateway.hub as unknown as { chat: (llm: HarnessConfig["llm"]) => ChatFn };
    const original = hub.chat;
    hub.chat = (llm) => {
      models.push(llm.model);
      return chat;
    };
    try {
      script.push(call("read_attachment", { id: csv.id }), call("read_attachment", { id: bin.id }), call("reply", { text: "9 月 1 日销售额 1200", gaps: [] }));
      const unknown = await api("/api/wishes", { method: "POST", body: JSON.stringify({ wish: "看看", model: "nope" }) });
      assert.equal(unknown.status, 400);
      const meta = (await (await api("/api/wishes", { method: "POST", body: JSON.stringify({ wish: "看看附件", attachments: [csv.id, bin.id], model: catalog.default }) })).json()) as SessionMeta;
      await gateway.hub.wait(meta.id);
      const turn = seen.at(-1)!;
      assert.match(String(turn.find((m) => m.role === "user")?.content), new RegExp(`id=${csv.id}`));
      const results = turn.filter((m) => m.role === "tool").map((m) => String(m.content));
      assert.ok(results.some((r) => r.includes("2026-09-01,1200")));
      assert.ok(results.some((r) => r.includes("二进制")));
      const detail = (await (await api(`/api/sessions/${meta.id}`)).json()) as SessionDetail;
      const user = detail.events.find((e) => e.type === "user");
      assert.deepEqual(user?.type === "user" ? user.attachments?.map((a) => a.path) : [], ["报表/9月/销售.csv", "模型.blend"]);
      assert.equal(detail.model, catalog.default);

      assert.equal((await api(`/api/sessions/${meta.id}/model`, { method: "PUT", body: JSON.stringify({ model: "nope" }) })).status, 400);
      const switched = (await (await api(`/api/sessions/${meta.id}/model`, { method: "PUT", body: JSON.stringify({ model: catalog.default }) })).json()) as SessionMeta;
      assert.equal(switched.model, catalog.default);
      script.push(call("reply", { text: "好的", gaps: [] }));
      await api(`/api/sessions/${meta.id}/messages`, { method: "POST", body: JSON.stringify({ text: "继续" }) });
      await gateway.hub.wait(meta.id);
      assert.deepEqual(models, [catalog.models[0]!.model, catalog.models[0]!.model]);
    } finally {
      hub.chat = original;
    }
  });

  test("风格提示词接口", async () => {
    assert.equal((await api("/api/style", { method: "PUT", body: "# 新风格" })).status, 200);
    assert.equal(await (await api("/api/style")).text(), "# 新风格");
    assert.match(await (await api("/api/style", { method: "DELETE" })).text(), /页面风格提示词/);
  });
});

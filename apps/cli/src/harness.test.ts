import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { PageView, SessionDetail, SessionMeta } from "@qdd/shared";
import { runWish } from "./agent/agent.js";
import type { ChatFn, ChatMessage } from "./agent/llm.js";
import { loadConfig, type LoadedConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { refreshDatasets } from "./datasets/refresh.js";
import { readAll } from "./datasets/store.js";
import { startGateway, type Gateway } from "./gateway/server.js";
import { checkFile } from "./guard.js";
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
    await writeFile(path.join(root, "harness.config.json"), JSON.stringify({ gateway: { port: 0 } }));
    base = await loadConfig(root);
    await ensureWorkspace(base.paths);
    fake = await startFakeSseMcp();

    // 第一个网关只提供 /mcp（JSON 响应），供第二个网关作为远程 MCP 接入。
    selfSources = await DataSources.open(base);
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

  test("许愿会话：授权写入、守卫拦截、发布、续聊", async () => {
    script.push(
      call("store__get_store_info", {}),
      call("mcp__fake__update_price", { sku: "SKU001", price: 2.5 }),
      call("snapshot_data", { name: "cat", tool: "store__aggregate", arguments: { dataset: "order_items", groupBy: ["category"], metrics: ["revenue", "grossMargin"] } }),
      call("write_file", { path: "index.html", content: "<script>fetch('/api')</script>" }),
      call("write_file", {
        path: "index.html",
        content: '<html><head><link rel="stylesheet" href="../../assets/theme.css"></head><body><script src="./data/cat.js"></script></body></html>',
      }),
      call("finish", { title: "品类销售", summary: "饮料品类毛利最高", tools: ["store__sales_summary"], useAgent: false, metrics: ["revenue"] }),
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
    while (detail.status === "running") {
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
    script.push(call("reply", { text: "饮料毛利最高" }));
    assert.equal((await api(`/api/sessions/${created.id}/messages`, { method: "POST", body: JSON.stringify({ text: "哪个品类毛利最高？" }) })).status, 202);
    const final = await gateway.hub.wait(created.id);
    assert.equal(final.status, "idle");
    const lastPrompt = seen.at(-1)!;
    assert.ok(lastPrompt.some((m) => m.role === "user" && m.content === "看看各品类"));
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
    assert.match(html.headers.get("content-security-policy") ?? "", /connect-src 'self'.*form-action 'none'/);
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
    script.push(call("recall", { query: "品类毛利" }), call("reply", { text: "之前做过品类分析" }));
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
    script.push(call("reply", { text: "ok" }));
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
        return call("finish", { title: "t", summary: "s", tools: [], useAgent: false });
      }
      assert.match(String(last.content), /发布冲突/);
      return call("finish", { title: "t", summary: "s", tools: [], useAgent: false });
    };
    const before = (await readPages(base.paths)).find((p) => p.slug === page!.slug)!.version;
    const result = await runWish(base, sources, racing, { wish: "调整", slug: page!.slug, sessionId: first.id }, { onEvent: () => {}, authorize: async () => false });
    assert.equal(result.page?.version, before + 2);
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

  test("风格提示词接口", async () => {
    assert.equal((await api("/api/style", { method: "PUT", body: "# 新风格" })).status, 200);
    assert.equal(await (await api("/api/style")).text(), "# 新风格");
    assert.match(await (await api("/api/style", { method: "DELETE" })).text(), /页面风格提示词/);
  });
});

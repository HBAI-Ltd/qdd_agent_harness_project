import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { PageEntry } from "@qdd/shared";
import type { ChatFn } from "./agent/llm.js";
import { runAsk } from "./agent/ask.js";
import { loadConfig, type LoadedConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { JsonlDatasetStore, readAll } from "./datasets/store.js";
import { addRecords, defineRecord, parseRecordDefinition, queryRecords, updateRecord, voidRecord } from "./datasets/records.js";
import { Auth, resolveGatewayToken } from "./gateway/auth.js";
import { startGateway, type Gateway } from "./gateway/server.js";
import { checkPath } from "./guard.js";
import { ensureWorkspace, readPages, updatePages, upsertPage, writeAtomic } from "./web/site.js";

const TOKEN = "adversarial-gateway-token-0123456789";
const SLUG = "least-privilege";
const FORBIDDEN = "mcp__private__salary";

describe("gateway adversarial requests", () => {
  let root: string;
  let loaded: LoadedConfig;
  let sources: DataSources;
  let gateway: Gateway;
  let privateCalls = 0;
  let offeredTools: string[] = [];
  const auth = new Auth(TOKEN);
  const pageHeaders = { "X-QDD-Page": SLUG, "X-QDD-Page-Token": auth.pageToken(SLUG) };
  const chat: ChatFn = async (messages, tools) => {
    offeredTools = tools.map((tool) => tool.function.name);
    if (!messages.some((message) => message.role === "tool")) return {
      role: "assistant", content: null,
      tool_calls: [{ id: "private-call", type: "function", function: { name: FORBIDDEN, arguments: "{}" } }],
    };
    return { role: "assistant", content: "完成" };
  };
  const api = (route: string, init: RequestInit = {}) => fetch(gateway.url + route, {
    ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers },
  });

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "qdd-gateway-adversarial-"));
    loaded = await loadConfig(root);
    loaded.config.gateway.host = "127.0.0.1";
    loaded.config.gateway.port = 0;
    loaded.config.datasets.refreshIntervalSec = 0;
    await ensureWorkspace(loaded.paths);
    sources = await DataSources.open(loaded);
    sources.tools.push({
      name: FORBIDDEN, description: "Private salary data", inputSchema: { type: "object" },
      source: "test", mutating: false, preauthorized: false,
      call: async () => { privateCalls++; return { secret: "payroll" }; },
    });
    const now = new Date().toISOString();
    const entry: PageEntry = {
      slug: SLUG, title: "权限测试", wish: "测试", summary: "测试", tools: ["store__store_info"],
      useAgent: true, records: [], metrics: [], datasets: {}, version: 1, stale: null,
      gaps: [], sessionId: "test", createdAt: now, updatedAt: now,
    };
    await mkdir(path.join(loaded.paths.pages, SLUG), { recursive: true });
    await writeFile(path.join(loaded.paths.pages, SLUG, "index.html"), "<html><head></head><body>page</body></html>");
    await writeFile(path.join(loaded.paths.pages, SLUG, "drawing.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await upsertPage(loaded.paths, entry);
    gateway = await startGateway(loaded, sources, { token: TOKEN, chat: () => chat, scheduler: false });
  });

  after(async () => {
    await gateway?.close();
    await sources?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("page ask cannot execute a read-only tool outside its declared tools", async () => {
    const before = privateCalls;
    const response = await fetch(gateway.url + "/api/ask", { method: "POST", headers: pageHeaders, body: JSON.stringify({ question: "调用私密工具" }) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /answer/);
    assert.equal(privateCalls, before);
    assert.ok(!offeredTools.includes(FORBIDDEN));
  });

  test("admin ask retains read-only tool access", async () => {
    const before = privateCalls;
    const response = await api("/api/ask", { method: "POST", body: JSON.stringify({ question: "管理员查询" }) });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(privateCalls, before + 1);
  });

  test("page tokens cannot access admin endpoints, other page state, or undeclared tools", async () => {
    for (const route of ["/api/sessions", "/api/skills", "/api/datasets", "/api/overview", "/api/state/another"]) {
      assert.equal((await fetch(gateway.url + route, { headers: pageHeaders })).status, 401, route);
    }
    assert.equal((await fetch(gateway.url + `/api/tools/${FORBIDDEN}`, { method: "POST", headers: pageHeaders, body: "{}" })).status, 403);
  });

  test("query admin token is read-only for GET authentication", async () => {
    assert.equal((await fetch(gateway.url + `/api/style?access_token=${TOKEN}`, { method: "PUT", body: "changed" })).status, 401);
    assert.equal((await fetch(gateway.url + `/api/style?access_token=${TOKEN}`)).status, 200);
  });

  for (const route of ["/api/tools/%FF", "/api/records/%FF", "/api/skills/%FF", "/api/schedules/%FF", "/api/connectors/%FF", "/api/pages/%FF/pin"]) {
    test(`malformed encoded route returns 400: ${route}`, async () => {
      const method = route.startsWith("/api/tools/") ? "POST" : route.endsWith("/pin") ? "PUT" : "GET";
      assert.equal((await api(route, { method })).status, 400);
    });
  }

  test("MCP rejects malformed protocol envelopes without server errors", async () => {
    for (const raw of [null, [], {}, 3, { jsonrpc: "1.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: {}, method: "ping" }, { jsonrpc: "2.0", id: 1, method: "ping", params: [] }]) {
      const response = await api("/mcp", { method: "POST", body: JSON.stringify(raw) });
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { error: { code: number } }).error.code, -32600);
    }
  });

  test("MCP responds to null ids and accepts valid notifications", async () => {
    const response = await api("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { jsonrpc: "2.0", id: null, result: {} });
    assert.equal((await api("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).status, 202);
  });

  test("tool endpoints reject primitive/array/null argument bodies", async () => {
    for (const raw of [null, [], "text", 3, true]) {
      assert.equal((await api(`/api/tools/${FORBIDDEN}`, { method: "POST", body: JSON.stringify(raw) })).status, 400);
    }
    assert.equal((await api("/api/datasets/refresh", { method: "POST", body: '{"datasets":123}' })).status, 400);
  });

  test("oversized body produces HTTP 413 and subsequent requests succeed", async () => {
    assert.equal((await api("/api/style", { method: "PUT", body: "x".repeat(1024 * 1024 + 20) })).status, 413);
    assert.equal((await fetch(gateway.url + "/health")).status, 200);
  });

  test("concurrent state writes all succeed and leave complete JSON", async () => {
    const responses = await Promise.all(Array.from({ length: 30 }, (_, index) => api(`/api/state/${SLUG}`, { method: "PUT", body: JSON.stringify({ index, value: "x".repeat(3000) }) })));
    assert.deepEqual(responses.map((response) => response.status), Array(30).fill(200));
    const state = JSON.parse(await readFile(path.join(loaded.paths.state, `${SLUG}.json`), "utf8")) as { index: number; value: string };
    assert.ok(state.index >= 0 && state.index < 30);
    assert.equal(state.value.length, 3000);
    assert.ok((await readdir(loaded.paths.state)).every((name) => !name.endsWith(".tmp")));
  });

  test("page state size limit counts UTF-8 bytes", async () => {
    assert.equal((await api(`/api/state/${SLUG}`, { method: "PUT", body: JSON.stringify({ text: "中".repeat(24_000) }) })).status, 413);
  });

  test("SVG pages carry the same browser network and form restrictions as HTML", async () => {
    const response = await api(`/pages/${SLUG}/drawing.svg`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy") ?? "", /form-action 'none'/);
    assert.ok(response.headers.get("content-security-policy")?.includes(`connect-src ${gateway.url}/api/`));
  });

  test("static serving rejects directory junctions escaping assets and page roots", async () => {
    const outside = path.join(root, "private");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.json"), '{"secret":"must-not-leak"}');
    await symlink(outside, path.join(loaded.paths.site, "assets", "escape"), "junction");
    await symlink(outside, path.join(loaded.paths.pages, SLUG, "escape"), "junction");
    await symlink(outside, path.join(loaded.paths.pages, "escape-root"), "junction");
    await symlink(path.join(loaded.paths.pages, SLUG), path.join(loaded.paths.pages, "sibling-root"), "junction");
    for (const route of ["/assets/escape/secret.json", `/pages/${SLUG}/escape/secret.json`, "/pages/escape-root/secret.json", "/pages/sibling-root/index.html"]) {
      assert.equal((await api(route)).status, 404, route);
    }
  });
});

describe("filesystem adversarial inputs", () => {
  test("atomic writes do not share temporary files under concurrency", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qdd-atomic-adversarial-"));
    try {
      const file = path.join(root, "state.json");
      await Promise.all(Array.from({ length: 40 }, (_, index) => writeAtomic(file, JSON.stringify({ index }))));
      assert.ok(Number.isInteger((JSON.parse(await readFile(file, "utf8")) as { index: number }).index));
      assert.deepEqual(await readdir(root), ["state.json"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("guard rejects Windows snapshot aliases, alternate streams, and device paths", () => {
    for (const value of ["DATA/sales.js", "Data/sales.js", "file.html:payload.js", "a:payload.html", "aux.html", "NUL/index.html", "data /sales.js", "dir./index.html", "foo\u0001.html"]) {
      assert.ok(checkPath(value).violations.length > 0, value);
    }
    assert.deepEqual(checkPath("charts/sales.html").violations, []);
  });

  test("dataset timestamps cannot traverse partition directories or silently normalize invalid dates", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qdd-dataset-adversarial-"));
    try {
      const store = new JsonlDatasetStore(root);
      await store.define({ name: "events", description: "events", kind: "fact", fields: { id: "string", time: "string" }, key: ["id"], timeField: "time" });
      for (const time of ["../../evil", "..\\..\\evil", "2026-02-30 10:00", "2026-13-01", "nonsense"]) {
        await assert.rejects(store.append("events", [{ id: "bad", time }]), /YYYY-MM-DD/);
      }
      await store.append("events", [{ id: "ok", time: "2026-10-17 10:00" }]);
      assert.equal((await readAll(store, "events")).length, 1);
      assert.deepEqual(await readdir(root), ["events"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("concurrent first gateway startups share the persisted token", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qdd-token-adversarial-"));
    try {
      const loaded = await loadConfig(root);
      await ensureWorkspace(loaded.paths);
      const results = await Promise.all(Array.from({ length: 30 }, () => resolveGatewayToken(loaded)));
      const token = (await readFile(loaded.paths.token, "utf8")).trim();
      assert.ok(token.length >= 16);
      assert.ok(results.every((result) => result.token === token));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("concurrent page publication preserves every manifest entry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qdd-pages-adversarial-"));
    try {
      const loaded = await loadConfig(root);
      await ensureWorkspace(loaded.paths);
      const now = new Date().toISOString();
      await Promise.all(Array.from({ length: 25 }, (_, index) => upsertPage(loaded.paths, {
        slug: `page-${index}`, title: "test", wish: "test", summary: "test", tools: [], useAgent: false,
        metrics: [], datasets: {}, version: 1, stale: null, gaps: [], sessionId: "test", createdAt: now, updatedAt: now,
      })));
      assert.equal((await readPages(loaded.paths)).length, 25);
      await Promise.all([
        updatePages(loaded.paths, (pages) => pages.map((page) => ({ ...page, stale: "review required" }))),
        upsertPage(loaded.paths, { ...(await readPages(loaded.paths))[0]!, slug: "another-page" }),
      ]);
      assert.equal((await readPages(loaded.paths)).length, 26);
      assert.equal((await readPages(loaded.paths)).filter((page) => page.stale).length, 25);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("page ask cancellation boundaries", () => {
  let root: string;
  let sources: DataSources;
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "qdd-ask-adversarial-"));
    const loaded = await loadConfig(root);
    await ensureWorkspace(loaded.paths);
    sources = await DataSources.open(loaded);
  });
  after(async () => {
    await sources?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("pre-cancelled ask never starts the model", async () => {
    const controller = new AbortController();
    controller.abort();
    let chats = 0;
    await assert.rejects(runAsk(sources, async () => { chats++; return { role: "assistant", content: "late" }; }, "test", undefined, () => undefined, controller.signal), { name: "AbortError" });
    assert.equal(chats, 0);
  });

  test("cancellation during model execution discards returned tool calls", async () => {
    const controller = new AbortController();
    let calls = 0;
    const name = "test__cancel_during_chat";
    sources.tools.push({ name, description: "test", inputSchema: {}, source: "test", mutating: false, preauthorized: false, call: async () => { calls++; return {}; } });
    await assert.rejects(runAsk(sources, async () => {
      controller.abort();
      return { role: "assistant", content: null, tool_calls: [{ id: "late", type: "function", function: { name, arguments: "{}" } }] };
    }, "test", undefined, () => undefined, controller.signal), { name: "AbortError" });
    assert.equal(calls, 0);
  });

  test("cancellation during the first tool prevents later tools and model retries", async () => {
    const controller = new AbortController();
    let later = 0;
    let chats = 0;
    for (const [name, execute] of [
      ["test__first", async () => { controller.abort(); return {}; }],
      ["test__later", async () => { later++; return {}; }],
    ] as const) sources.tools.push({ name, description: "test", inputSchema: {}, source: "test", mutating: false, preauthorized: false, call: execute });
    await assert.rejects(runAsk(sources, async () => {
      chats++;
      return { role: "assistant", content: null, tool_calls: ["test__first", "test__later"].map((name) => ({ id: name, type: "function" as const, function: { name, arguments: "{}" } })) };
    }, "test", undefined, () => undefined, controller.signal), { name: "AbortError" });
    assert.equal(later, 0);
    assert.equal(chats, 1);
  });
});

test("MCP tools without a read-only declaration cannot bypass write authorization by choosing a neutral name", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qdd-mcp-adversarial-"));
  let executions = 0;
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += String(chunk);
    const message = JSON.parse(text) as { id?: number; method: string };
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    const tools = [
      { name: "charge_card", description: "opaque side effect", inputSchema: { type: "object" } },
      { name: "declared_read", description: "readonly", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "conflicting", description: "unsafe", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: true } },
      { name: "update_price", description: "misleading read-only hint", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    ];
    const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" } }
      : message.method === "tools/list" ? { tools }
      : (executions++, { content: [{ type: "text", text: "{}" }] });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let sources: DataSources | undefined;
  try {
    const loaded = await loadConfig(root);
    await ensureWorkspace(loaded.paths);
    const port = (server.address() as { port: number }).port;
    loaded.config.mcpServers = { adversary: { url: `http://127.0.0.1:${port}` } };
    sources = await DataSources.open(loaded);
    assert.deepEqual(sources.warnings, []);
    assert.equal(sources.get("mcp__adversary__charge_card")?.mutating, true);
    assert.equal(sources.get("mcp__adversary__conflicting")?.mutating, true);
    assert.equal(sources.get("mcp__adversary__update_price")?.mutating, true);
    assert.equal(sources.get("mcp__adversary__declared_read")?.mutating, false);
    await assert.rejects(sources.call("mcp__adversary__charge_card", {}, async () => false), /未授权/);
    assert.equal(executions, 0);
    await sources.call("mcp__adversary__declared_read", {}, async () => { throw new Error("read-only must not request write permission"); });
    assert.equal(executions, 1);
    await sources.call("mcp__adversary__charge_card", {}, async () => true);
    assert.equal(executions, 2);
  } finally {
    await sources?.close();
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    await rm(root, { recursive: true, force: true });
  }
});

test("record write and range validation reject invalid dates, non-object patches and non-finite limits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qdd-record-adversarial-"));
  try {
    const store = new JsonlDatasetStore(root);
    await defineRecord(store, parseRecordDefinition({ name: "checks", label: "checks", fields: [{ name: "qty", type: "number" }] }));
    for (const time of ["2026-02-30 10:00", "2026-13-01 10:00", "2026-10-17 25:00", "2026-10-17 10:60"]) {
      await assert.rejects(addRecords(store, "checks", [{ qty: 1, time }], "test"), /有效日期/);
    }
    const [row] = await addRecords(store, "checks", [{ qty: 1 }], "test");
    await assert.rejects(updateRecord(store, "checks", String(row!.id), null as never, "test"), /JSON 对象/);
    for (const limit of [NaN, Infinity, -1, 0, 0.5]) await assert.rejects(queryRecords(store, "checks", { limit }), /正整数/);
    await assert.rejects(queryRecords(store, "checks", { from: "2026-10-17", to: "2026-10-01" }), /from 不能晚于 to/);
    await assert.rejects(queryRecords(store, "checks", { from: "2026-02-30" }), /有效日期/);
    assert.equal((await queryRecords(store, "checks")).total, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("record changes across store instances preserve separate fields and cannot resurrect a voided record", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qdd-record-race-adversarial-"));
  try {
    const first = new JsonlDatasetStore(root);
    const second = new JsonlDatasetStore(root);
    await defineRecord(first, parseRecordDefinition({ name: "checks", label: "checks", fields: [{ name: "qty", type: "number" }, { name: "note", type: "string" }] }));
    const [record] = await addRecords(first, "checks", [{ qty: 1, note: "original" }], "test");
    const id = String(record!.id);
    await Promise.all([
      updateRecord(first, "checks", id, { qty: 2 }, "first"),
      updateRecord(second, "checks", id, { note: "corrected" }, "second"),
    ]);
    const [changed] = (await queryRecords(first, "checks")).rows;
    assert.equal(changed!.qty, 2);
    assert.equal(changed!.note, "corrected");
    const results = await Promise.allSettled([
      voidRecord(first, "checks", id, "first"),
      updateRecord(second, "checks", id, { qty: 3 }, "second"),
    ]);
    assert.equal(results[0]!.status, "fulfilled");
    assert.equal((await queryRecords(first, "checks")).total, 0);
    await assert.rejects(updateRecord(second, "checks", id, { qty: 4 }, "second"), /已作废/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

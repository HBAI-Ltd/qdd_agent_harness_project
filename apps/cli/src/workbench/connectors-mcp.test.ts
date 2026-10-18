import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { loadConfig } from "../config.js";
import { CONNECTOR_CATALOG } from "./connectors.js";
import { openWorkbench } from "./index.js";
import { loadInstalledMcpServers, LOCAL_MCP_PROVIDERS, localMcpServer } from "./local-mcp.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "qdd-connector-mcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const loaded = await loadConfig(root);
  await mkdir(loaded.paths.workspace, { recursive: true });
  return { loaded, store: (await openWorkbench(loaded)).connectors };
}

function mockMcp(t: TestContext) {
  const requests: { method: string; url: string; authorization: string | null }[] = [];
  let fails = false;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) as { id?: number; method: string } : undefined;
    const method = body?.method ?? init.method ?? "GET";
    requests.push({ method, url: String(url), authorization: new Headers(init.headers).get("Authorization") });
    if (fails) throw new Error("模拟服务不可访问");
    if (body?.id === undefined) return new Response(null, { status: 202 });
    const result = method === "tools/list" ? { tools: (String(url).includes(":8792/") ? ["android_screenshot", "android_control"] : ["account_status"]).map((name) => ({ name, description: "服务工具", inputSchema: { type: "object" } })) } : {};
    return Response.json({ jsonrpc: "2.0", id: body.id, result }, { headers: { "mcp-session-id": "synthetic-session" } });
  });
  return { requests, fail: () => { fails = true; } };
}

test("收银和摄像头目录开放厂商选择；服务已配置、已启动时仍不会自动安装", async (t) => {
  const { loaded, store } = await fixture(t);
  const mock = mockMcp(t);
  const configured = Object.fromEntries(Object.entries(LOCAL_MCP_PROVIDERS).map(([name, provider]) => [name, { url: provider.url }]));
  configured.custom = { url: "http://custom.example/mcp" };
  assert.deepEqual(await loadInstalledMcpServers(loaded.paths, configured), { custom: configured.custom });
  assert.deepEqual(await store.list(Object.keys(LOCAL_MCP_PROVIDERS).map((name) => ({ name, allowWrite: false }))), []);
  assert.equal(mock.requests.length, 0);
  assert.deepEqual(CONNECTOR_CATALOG.find((entry) => entry.type === "pos")?.providers, [{ id: "shouqianba", name: "收钱吧" }]);
  const camera = CONNECTOR_CATALOG.find((entry) => entry.type === "camera")!;
  assert.equal(camera.available, true);
  assert.deepEqual(camera.modes, ["mcp"]);
  assert.deepEqual(camera.providers?.map((provider) => provider.id), ["haik", "tysl", "ezviz"]);
});

test("用户选择后才握手、列工具并保存；五种本地服务均可安装，收钱吧密钥只用于本地认证", async (t) => {
  const { loaded, store } = await fixture(t);
  const mock = mockMcp(t);
  const tokenFile = localMcpServer("shouqianba", loaded.paths.root).bearerTokenFile!;
  assert(path.isAbsolute(tokenFile));
  await mkdir(path.dirname(tokenFile), { recursive: true });
  await writeFile(tokenFile, "synthetic-connector-key");
  for (const [provider, metadata] of Object.entries(LOCAL_MCP_PROVIDERS)) {
    const view = await store.install({ type: metadata.type, mode: "mcp", provider });
    assert.equal(view.id, `mcp:${provider}`);
    assert.equal(view.origin, "installed");
    assert.equal(view.type, metadata.type);
    assert.equal(view.name, metadata.name);
    assert.equal(view.permission, metadata.type === "pos" ? "read" : "confirm");
    assert.deepEqual(view.config, { mode: "mcp", provider, consoleUrl: metadata.consoleUrl });
    assert(view.lastVerifiedAt);
    assert.match(view.detail, provider === "android" ? /2 个工具/ : /1 个工具/);
  }
  assert.equal((await store.list(Object.keys(LOCAL_MCP_PROVIDERS).map((name) => ({ name, allowWrite: false })))).length, 5);
  assert.deepEqual(mock.requests.map((request) => request.method), Array.from({ length: 5 }, () => ["initialize", "notifications/initialized", "tools/list", "DELETE"]).flat());
  assert(mock.requests.filter((request) => request.url === LOCAL_MCP_PROVIDERS.shouqianba.url).every((request) => request.authorization === "Bearer synthetic-connector-key"));
  assert.doesNotMatch(await readFile(loaded.paths.connectors, "utf8"), /synthetic-connector-key/);
  assert.deepEqual(Object.keys(await loadInstalledMcpServers(loaded.paths)).sort(), Object.keys(LOCAL_MCP_PROVIDERS).sort());
  const reopened = (await openWorkbench(loaded)).connectors;
  assert.equal((await reopened.list()).length, 5);
});

test("非法厂商、类型、模式与自定义权限在请求服务前拒绝；安装失败不保存", async (t) => {
  const { store } = await fixture(t);
  const mock = mockMcp(t);
  for (const input of [
    { type: "phone", mode: "mcp", provider: "haik" },
    { type: "camera", mode: "mcp", provider: "android" },
    { type: "phone", mode: "mcp", provider: "android", permission: "auto" },
    { type: "camera", mode: "mcp", provider: "shouqianba" },
    { type: "pos", mode: "mcp", provider: "haik" },
    { type: "camera", mode: "mcp", provider: "unknown" },
    { type: "camera", mode: "qrcode", provider: "haik" },
    { type: "camera", mode: "mcp", provider: "haik", permission: "auto" },
    { type: "camera", mode: "mcp", provider: "haik", appSecret: "irrelevant" },
  ]) await assert.rejects(store.install(input));
  assert.equal(mock.requests.length, 0);
  mock.fail();
  await assert.rejects(store.install({ type: "camera", mode: "mcp", provider: "haik" }), /连接失败/);
  assert.deepEqual(await store.list(), []);
});

test("phone rejects an unrelated MCP endpoint instead of installing a camera service", async (t) => {
  const { loaded } = await fixture(t);
  mockMcp(t);
  loaded.config.mcpServers.android = { url: "http://127.0.0.1:8790/mcp", allowWrite: true };
  const store = (await openWorkbench(loaded)).connectors;
  await assert.rejects(store.install({ type: "phone", mode: "mcp", provider: "android" }), /不是兼容的 Android/);
  assert.deepEqual(await store.list(), []);
  assert.equal(localMcpServer("android", loaded.paths.root, loaded.config.mcpServers.android).allowWrite, false);
});

test("重复或并发安装同一厂商仅保存一次，MCP 仅能改名且不能作为飞书通知使用", async (t) => {
  const { loaded, store } = await fixture(t);
  const mock = mockMcp(t);
  const input = { type: "camera", mode: "mcp", provider: "haik" };
  const results = await Promise.allSettled([store.install(input), store.install(input)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(mock.requests.filter((request) => request.method === "initialize").length, 1);
  assert.equal((await store.update("mcp:haik", { name: "  店门口  " })).name, "店门口");
  for (const update of [{ permission: "auto" }, { permission: "read" }, { receiveId: "oc_store" }, { provider: "ezviz" }, { appSecret: "secret" }]) {
    await assert.rejects(store.update("mcp:haik", update), /只能修改名称/);
  }
  await assert.rejects(store.send("mcp:haik", "测试"), /不支持推送/);
  await assert.rejects(store.describe("mcp:haik"), /不能作为消息通知/);
  assert.equal((await store.get("mcp:haik")).permission, "confirm");
  assert.equal(mock.requests.length, 4);
  await store.remove("mcp:haik");
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await loadInstalledMcpServers(loaded.paths), {});
});

test("重新验证与运行时故障均显示错误，不调用任何厂商业务工具", async (t) => {
  const { store } = await fixture(t);
  const mock = mockMcp(t);
  await store.install({ type: "camera", mode: "mcp", provider: "tysl" });
  const list = await store.list([{ name: "tysl", allowWrite: false, error: "运行时连接失败" }]);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.status, "error");
  assert.equal(list[0]?.detail, "运行时连接失败");
  assert.equal((await store.get("mcp:tysl")).status, "connected");
  mock.fail();
  const result = await store.verify("mcp:tysl");
  assert.equal(result.status, "error");
  assert.match(result.detail, /模拟服务不可访问/);
  assert.equal(mock.requests.some((request) => request.method === "tools/call"), false);
});

test("仅合法且已安装的厂商加入数据源，地址和鉴权可配置但操作仍需确认", async (t) => {
  const { loaded } = await fixture(t);
  await writeFile(loaded.paths.connectors, JSON.stringify({ connectors: [
    { id: "mcp:haik", type: "camera", mode: "mcp", provider: "haik" },
    { id: "mcp:tysl", type: "pos", mode: "mcp", provider: "tysl" },
    { id: "unexpected-id", type: "camera", mode: "mcp", provider: "ezviz" },
    { id: "mcp:unknown", type: "camera", mode: "mcp", provider: "unknown" },
    { id: "feishu", type: "feishu", mode: "app" },
  ] }));
  const configured = {
    haik: { url: "http://localhost:18787/mcp", allowWrite: true },
    tysl: { url: "http://localhost:18790/mcp" },
    custom: { url: "http://localhost:18000/mcp", allowWrite: true },
  };
  assert.deepEqual(await loadInstalledMcpServers(loaded.paths, configured), {
    custom: configured.custom,
    haik: { url: configured.haik.url, allowWrite: false },
  });
  assert.deepEqual(localMcpServer("shouqianba", loaded.paths.root, { url: "http://localhost:18788/mcp", bearerTokenEnv: "SQB_TEST_TOKEN" }), {
    url: "http://localhost:18788/mcp", bearerTokenEnv: "SQB_TEST_TOKEN", allowWrite: false,
  });
});

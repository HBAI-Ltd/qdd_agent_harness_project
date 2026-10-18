import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Bundle the client adapter in memory; every request below uses a local fetch
// fixture, so connector verification never contacts a real messaging account.
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("../src/api/connectors.ts", import.meta.url))],
  bundle: true, write: false, format: "esm", platform: "node", target: "node24",
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const originalFetch = globalThis.fetch;
const base = "http://127.0.0.1:5173";
const token = "fixture-gateway-token";
const connector = {
  id: "feishu/门店", type: "feishu", name: "门店通知", origin: "installed", permission: "confirm",
  status: "connected", detail: "已向群机器人发送测试消息", config: { mode: "webhook", webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/****only", signSecret: true },
  lastVerifiedAt: "2026-10-17T00:00:00.000Z", createdAt: "2026-10-17T00:00:00.000Z",
};
afterEach(() => { globalThis.fetch = originalFetch; });

function fixture(payload, status = 200) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  };
  return calls;
}

test("catalog and installed connector reads retain origins, auth and caller cancellation", async () => {
  const payload = {
    catalog: [{ type: "feishu", available: true, modes: ["webhook", "app"] }, { type: "camera", available: false, modes: ["qrcode"] }],
    connectors: [{ ...connector, id: "store", origin: "builtin" }, { ...connector, id: "mcp:erp", origin: "mcp" }, connector],
  };
  const calls = fixture(payload);
  const signal = new AbortController().signal;
  assert.deepEqual(await api.listConnectors(`${base}/`, ` ${token} `, signal), payload);
  await api.getConnector(base, token, connector.id, signal);
  assert.deepEqual(calls.map((call) => call.url), [base + "/api/connectors", base + "/api/connectors/feishu%2F%E9%97%A8%E5%BA%97"]);
  for (const call of calls) {
    assert.equal(new Headers(call.init.headers).get("Authorization"), `Bearer ${token}`);
    assert.equal(call.init.signal, signal);
    assert.equal(call.url.includes(token), false);
  }
});

test("webhook and app installation preserve distinct credentials and permissions in JSON only", async () => {
  const calls = fixture(connector, 201);
  const webhook = { type: "feishu", mode: "webhook", name: "通知群", permission: "confirm", webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/fixture-only", signSecret: "fixture-signature" };
  const app = { type: "feishu", mode: "app", permission: "read", appId: "cli_fixture", appSecret: "fixture-app-secret", receiveId: "oc_fixture", receiveIdType: "chat_id" };
  assert.deepEqual(await api.installConnector(base, token, webhook), connector);
  await api.installConnector(base, token, app);
  assert.deepEqual(calls.map((call) => JSON.parse(call.init.body)), [webhook, app]);
  for (const call of calls) {
    assert.equal(call.url, base + "/api/connectors");
    assert.equal(call.init.method, "POST");
    assert.equal(new Headers(call.init.headers).get("Content-Type"), "application/json");
    assert.equal(call.url.includes("fixture-signature"), false);
    assert.equal(call.url.includes("fixture-app-secret"), false);
  }
});

test("local MCP installation sends only the selected platform and preserves managed console metadata", async () => {
  const managed = { ...connector, id: "mcp:ezviz", type: "camera", config: { mode: "mcp", provider: "ezviz", consoleUrl: "http://127.0.0.1:8791/" } };
  const calls = fixture(managed, 201);
  const signal = new AbortController().signal;
  const camera = { type: "camera", mode: "mcp", provider: "ezviz" };
  const pos = { type: "pos", mode: "mcp", provider: "shouqianba", name: "门店收银" };
  assert.deepEqual(await api.installConnector(base, token, camera, signal), managed);
  await api.installConnector(base, token, pos, signal);
  assert.deepEqual(calls.map((call) => JSON.parse(call.init.body)), [camera, pos]);
  assert.ok(calls.every((call) => call.url === base + "/api/connectors" && call.init.method === "POST" && call.init.signal === signal));
});

test("editing app recipients pairs receiveId and receiveIdType and never sends stored credentials", async () => {
  const calls = fixture(connector);
  const signal = new AbortController().signal;
  const update = { name: "新通知群", permission: "auto", receiveId: "user@example.test", receiveIdType: "email" };
  await api.updateConnector(base, token, connector.id, update, signal);
  await api.updateConnector(base, token, connector.id, { receiveId: "", receiveIdType: "chat_id" }, signal);
  assert.deepEqual(JSON.parse(calls[0].init.body), update);
  assert.deepEqual(JSON.parse(calls[1].init.body), { receiveId: "", receiveIdType: "chat_id" });
  for (const call of calls) {
    assert.equal(call.init.method, "PUT");
    assert.equal(call.init.signal, signal);
    assert.equal(call.url, base + "/api/connectors/feishu%2F%E9%97%A8%E5%BA%97");
    assert.equal("appSecret" in JSON.parse(call.init.body), false);
    assert.equal("webhookUrl" in JSON.parse(call.init.body), false);
  }
});

test("verify returns the backend status even when HTTP200 records a failed verification", async () => {
  const failure = { ...connector, status: "error", detail: "机器人不在群中" };
  const calls = fixture(failure);
  const signal = new AbortController().signal;
  assert.deepEqual(await api.verifyConnector(base, token, connector.id, signal), failure);
  assert.equal(calls[0].url, base + "/api/connectors/feishu%2F%E9%97%A8%E5%BA%97/verify");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.signal, signal);
});

test("manual test messages and delete use documented routes and propagate cancellation", async () => {
  const calls = fixture({ ok: true });
  const signal = new AbortController().signal;
  await api.testConnector(base, token, connector.id, "仅用于本地假请求的测试消息", signal);
  assert.deepEqual(await api.deleteConnector(base, token, connector.id, signal), { ok: true });
  assert.equal(calls[0].url, base + "/api/connectors/feishu%2F%E9%97%A8%E5%BA%97/test");
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: "仅用于本地假请求的测试消息" });
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[1].init.method, "DELETE");
  assert.equal(calls[1].init.body, undefined);
  assert.ok(calls.every((call) => call.init.signal === signal));
});

test("installation validation and schedule-use conflicts surface the backend error and HTTP status", async () => {
  fixture({ error: "消息不含机器人设置的关键词" }, 400);
  await assert.rejects(api.installConnector(base, token, { type: "feishu", mode: "webhook", webhookUrl: "fixture" }), (error) => {
    assert.equal(error.name, "GatewayError");
    assert.equal(error.status, 400);
    assert.equal(error.message, "消息不含机器人设置的关键词");
    return true;
  });
  fixture({ error: "连接器被定时任务使用中：经营日报" }, 409);
  await assert.rejects(api.deleteConnector(base, token, connector.id), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.message, "连接器被定时任务使用中：经营日报");
    return true;
  });
});

test("aborted mutation requests reject without masking cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = async (_url, init) => {
    init.signal.throwIfAborted();
    throw new Error("The aborted request must not continue");
  };
  await assert.rejects(api.verifyConnector(base, token, connector.id, controller.signal), { name: "AbortError" });
});

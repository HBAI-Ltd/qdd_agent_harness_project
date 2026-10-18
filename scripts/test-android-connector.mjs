import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFixture } from "../apps/android-mcp/dist/fixtures/stdio-server.js";
import { startHttpMcp } from "../apps/android-mcp/dist/http.js";
import { loadConfig } from "../apps/cli/dist/config.js";
import { DataSources } from "../apps/cli/dist/datasource/registry.js";
import { startGateway } from "../apps/cli/dist/gateway/server.js";
import { ensureWorkspace } from "../apps/cli/dist/web/site.js";

// Real Android HTTP/MCP server and gateway, synthetic phone frames and HID only.
const parent = path.resolve(tmpdir());
const root = await mkdtemp(path.join(parent, "qdd-android-connector-"));
const fixture = createFixture();
let android;
let sources;
let gateway;
try {
  android = await startHttpMcp(fixture.tools, { port: 0 });
  const loaded = await loadConfig(root);
  loaded.config.gateway.port = 0;
  loaded.config.mcpServers.android = { url: android.url, allowWrite: true };
  await ensureWorkspace(loaded.paths);
  sources = await DataSources.open(loaded);
  const token = "offline-android-connector-token";
  gateway = await startGateway(loaded, sources, {
    token, scheduler: false,
    chat: () => async () => ({ role: "assistant", content: "offline fixture" }),
  });
  const api = (route, init = {}) => fetch(gateway.url + route, {
    ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const health = await api("/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");
  assert.equal((await api("/unknown-android-test-route")).status, 404);
  const installed = await api("/api/connectors", {
    method: "POST", body: JSON.stringify({ type: "phone", mode: "mcp", provider: "android" }),
  });
  assert.equal(installed.status, 201, await installed.clone().text());
  assert.equal(fixture.adb.captures.length, 0, "Installation must not capture or control the phone");
  assert.equal(fixture.bridge.records.length, 0);
  assert.ok(sources.tools.filter((tool) => tool.source === "mcp:android").length >= 22);
  const images = [];
  await sources.call("mcp__android__android_screenshot", {}, async () => {
    throw new Error("Read-only screenshot must not request approval");
  }, (batch) => images.push(...batch));
  assert.equal(images.length, 1, "Real MCP image content must reach the assistant image receiver");
  assert.equal(fixture.adb.captures.length, 1);
  const before = fixture.bridge.records.length;
  await assert.rejects(sources.call("mcp__android__android_control", { action: "tap", x: 1, y: 1 }, async () => false), /未授权/);
  assert.equal(fixture.bridge.records.length, before, "Denied input must not send any HID report");
  assert.equal((await api("/api/connectors/mcp%3Aandroid/verify", { method: "POST", body: "{}" })).status, 200);
  assert.equal((await api("/api/connectors/mcp%3Aandroid", { method: "DELETE" })).status, 200);
  assert.ok(sources.tools.every((tool) => tool.source !== "mcp:android"));
  console.log("Android connector: real MCP handshake, image delivery, input denial, verify, uninstall and health checks passed.");
} finally {
  await gateway?.close();
  await sources?.close();
  await android?.close();
  assert.equal(path.dirname(path.resolve(root)), parent);
  assert.ok(path.basename(root).startsWith("qdd-android-connector-"));
  await rm(root, { recursive: true, force: true });
}

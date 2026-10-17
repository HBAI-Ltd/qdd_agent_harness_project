import assert from "node:assert/strict";
import { test } from "node:test";
import { createFixture } from "./fixtures/stdio-server.js";
import { startHttpMcp } from "./http.js";

test("an idle MCP SSE connection sends neutral keepalive comments without opening HID", { timeout: 5000 }, async (context) => {
  const fixture = createFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  const abort = new AbortController();
  context.after(async () => { abort.abort(); await listener.close(); });
  const initialized = await fetch(listener.url, { method: "POST", headers: {
    "Content-Type": "application/json", Accept: "application/json, text/event-stream",
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "idle-connection-test", version: "1" },
  } }) });
  assert.equal(initialized.status, 200);
  const sessionId = initialized.headers.get("mcp-session-id"); assert.ok(sessionId);
  await initialized.body?.cancel();
  const notification = await fetch(listener.url, { method: "POST", headers: {
    "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": sessionId,
  }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(notification.status, 202); await notification.body?.cancel();
  const stream = await fetch(listener.url, { headers: { Accept: "text/event-stream", "Mcp-Session-Id": sessionId }, signal: abort.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  const deadline = setTimeout(() => abort.abort(), 3500);
  try {
    assert.match(new TextDecoder().decode((await reader.read()).value), /^: qdd-connected\n\n$/u);
    assert.deepEqual(fixture.bridge.records, [], "The connection keepalive must never become a device heartbeat or input action.");
  } finally { clearTimeout(deadline); abort.abort(); await reader.cancel().catch(() => {}); }
});

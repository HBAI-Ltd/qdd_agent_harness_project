import assert from "node:assert/strict";
import { request } from "node:http";
import { createConnection, createServer as createTcpServer } from "node:net";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { readPngDimensions } from "./adb.js";
import { createFixture, fixturePng } from "./fixtures/stdio-server.js";
import { startHttpMcp } from "./http.js";
import { JPEG_FIXTURE } from "./fixtures/jpeg.js";
import type { InputController } from "./input.js";
import type { ScreenCapture } from "./screen.js";
import { ScreenError } from "./screen.js";
import { lanUrls, privateAuthority } from "./lan.js";


async function responseStatus(url: string, options: { method?: string; headers?: Record<string, string>; body?: string; path?: string } = {}): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const outgoing = request(url, { method: options.method ?? "POST", headers: options.headers ?? {},
      ...(options.path === undefined ? {} : { path: options.path }) }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
      response.once("error", reject);
    });
    outgoing.once("error", reject);
    outgoing.end(options.body);
  });
}

function jsonResult(raw: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const result = CallToolResultSchema.parse(raw);
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  const text = result.content.find((entry) => entry.type === "text");
  assert.ok(text && text.type === "text");
  return JSON.parse(text.text) as Record<string, unknown>;
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), message);
}

async function waitForClosedSession(url: string, sessionId: string): Promise<void> {
  const deadline = Date.now() + 2000;
  let status = 0;
  do {
    status = await responseStatus(url, { headers: { "mcp-session-id": sessionId,
      "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "closed-session-check", method: "tools/list", params: {} }) });
    if (status === 404) return;
    await delay(5);
  } while (Date.now() < deadline);
  assert.equal(status, 404, "Closed SDK session must leave the server's session map.");
}

function nextInputStateRead(input: InputController): Promise<void> {
  const getter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "state")?.get;
  assert.ok(getter);
  return new Promise<void>((resolve) => {
    // This public armed-state read marks the HTTP handler's initial guard, so
    // the test does not rely on a sleep to guess when half a body has arrived.
    Object.defineProperty(input, "state", { configurable: true, get() {
      Reflect.deleteProperty(input, "state");
      const state = getter.call(input);
      resolve();
      return state;
    } });
  });
}

function slowReport(url: string, sessionId: string, report: string) {
  const split = Math.floor(report.length / 2);
  let outgoing!: ReturnType<typeof request>;
  const completed = new Promise<number>((resolve, reject) => {
    outgoing = request(url, { method: "POST", headers: {
      "Mcp-Session-Id": sessionId, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(report)),
    } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
      response.once("error", reject);
    });
    outgoing.setTimeout(2000, () => outgoing.destroy(new Error("Slow report test timed out.")));
    outgoing.once("error", reject);
    outgoing.write(report.slice(0, split));
  });
  void completed.catch(() => {});
  return { completed, finish: () => outgoing.end(report.slice(split)), abort: () => outgoing.destroy(new Error("Test aborted old report.")) };
}

function livePointerFixture() {
  const fixture = createFixture();
  const frame: ScreenCapture = { serial: "11111111-1111-4111-8111-111111111111", width: 100, height: 200,
    png: fixturePng(100, 200), capturedAt: "2026-10-17T04:00:00.000Z", mimeType: "image/png",
    source: "screen-app", sourceFrameId: "pointer-frame", frameAgeMs: 0, rotation: 0 };
  fixture.adb.capture = async () => { fixture.adb.captures.push(frame.serial); return { ...frame }; };
  const report = { kind: "pointer", x: 0, y: 0, width: frame.width, height: frame.height,
    rotation: 0, deviceSerial: frame.serial, buttons: 0, wheel: 0 };
  return { ...fixture, frame, report };
}

test("HTTP LAN listener needs no credentials and rejects external Host or Origin", async (context) => {
  const fixture = createFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  context.after(async () => { await listener.close(); });
  assert.equal(privateAuthority(new URL(listener.url).host), true);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.equal(await responseStatus(listener.url, { body }), 400);
  assert.equal(await responseStatus(listener.url, { headers: { Host: "attacker.example" }, body }), 403);
  assert.equal(await responseStatus(listener.url, { headers: { Origin: "https://attacker.example" }, body }), 403);
  assert.equal(await responseStatus(listener.url, { headers: { Origin: "null" }, body }), 403);
  assert.deepEqual(fixture.bridge.records, []);
  assert.deepEqual(fixture.adb.captures, []);
});

test("real private-LAN HTTP, CORS preflight and official MCP SDK access share the service without a token", async (context) => {
  const fixture = createFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  const base = lanUrls(Number(new URL(listener.url).port))[0]!;
  const origin = new URL(base).origin;
  const client = new Client({ name: "lan-http-acceptance", version: "1" });
  context.after(async () => { await client.close(); await listener.close(); });
  const health = await fetch(`${base}health`, { headers: { Origin: origin }, signal: AbortSignal.timeout(2000) });
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("access-control-allow-origin"), origin);
  const state = await health.json() as { operatorUrl: string; mcpUrl: string; lanUrls: string[] };
  assert.equal(state.operatorUrl, base); assert.equal(state.mcpUrl, `${base}mcp`); assert.ok(state.lanUrls.includes(base));
  const preflight = await fetch(`${base}mcp`, { method: "OPTIONS", headers: { Origin: origin,
    "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,mcp-session-id" } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /mcp-session-id/iu);
  assert.match(health.headers.get("access-control-expose-headers") ?? "", /mcp-session-id/iu);
  const initialized = await fetch(`${base}mcp`, { method: "POST", headers: { Origin: origin,
    "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {},
      clientInfo: { name: "lan-cors-check", version: "1" } },
  }) });
  assert.equal(initialized.status, 200);
  const session = initialized.headers.get("mcp-session-id"); assert.ok(session);
  assert.equal(initialized.headers.get("access-control-allow-origin"), origin);
  assert.match(initialized.headers.get("access-control-expose-headers") ?? "", /mcp-session-id/iu);
  await initialized.body?.cancel();
  assert.equal((await fetch(`${base}mcp`, { method: "DELETE", headers: { Origin: origin, "Mcp-Session-Id": session } })).status, 200);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}mcp`), { requestInit: { headers: { Origin: origin } } }) as unknown as Transport);
  assert.ok((await client.listTools()).tools.some(({ name }) => name === "android_screenshot"));
  const privateViewer = "http://192.168.100.161:5173";
  const crossPrivate = await fetch(`${base}health`, { headers: { Origin: privateViewer } });
  assert.equal(crossPrivate.status, 200); assert.equal(crossPrivate.headers.get("access-control-allow-origin"), privateViewer);
  for (const headers of [{ Host: "8.8.8.8:8790" }, { Origin: "https://public.example" }, { Origin: "null" }]) {
    assert.equal(await responseStatus(`${base}health`, { method: "GET", headers }), 403);
  }
  assert.deepEqual(fixture.bridge.records, []); assert.deepEqual(fixture.adb.captures, []);
});

test("HTTP health, unknown route, method and malformed/oversized body handling", async (context) => {
  const fixture = createFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  context.after(async () => { await listener.close(); });
  const origin = new URL(listener.url).origin;
  const health = await fetch(`${origin}/health`);
  assert.equal(health.status, 200);
  const state = await health.json() as { status: string; name: string; runtimeVersion: number; operatorUrl: string; mcpUrl: string; lanUrls: string[] };
  assert.equal(state.status, "ok"); assert.equal(state.name, "qdd-android-hid"); assert.equal(state.runtimeVersion, 9);
  assert.equal(state.operatorUrl, `${origin}/`); assert.equal(state.mcpUrl, listener.url);
  assert.ok(state.lanUrls.includes(`${origin}/`));
  assert.equal(health.headers.get("cache-control"), "no-store");
  assert.equal(await responseStatus(`${origin}/missing`, { method: "GET" }), 404);
  assert.equal(await responseStatus(listener.url, { method: "GET", headers: {} }), 405);
  assert.equal(await responseStatus(listener.url, { headers: {}, body: "{invalid json" }), 400);
  assert.equal(await responseStatus(listener.url, { headers: {}, body: "x".repeat(1024 * 1024 + 1) }), 400);
  assert.deepEqual(fixture.bridge.records, []);
});

test("official HTTP SDK initializes, returns PNG image and loops raw HID press/release on shared state", async (context) => {
  const fixture = createFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  const transport = new StreamableHTTPClientTransport(new URL(listener.url), {
    requestInit: { headers: { Origin: "http://localhost" } },
  });
  const client = new Client({ name: "offline-http-tests", version: "1.0.0" });
  context.after(async () => { await client.close(); await listener.close(); });
  await client.connect(transport as unknown as Transport);
  assert.equal(client.getServerVersion()?.name, "qdd-android-hid");
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === "android_key_report"));
  const screenshot = CallToolResultSchema.parse(await client.callTool({ name: "android_screenshot", arguments: { deviceSerial: "USB-ONE" } }));
  const metadata = jsonResult(screenshot);
  assert.equal(metadata["deviceSerial"], "USB-ONE");
  const image = screenshot.content.find((entry) => entry.type === "image");
  assert.ok(image && image.type === "image");
  assert.equal(image.mimeType, "image/png");
  const png = Buffer.from(image.data, "base64");
  assert.deepEqual(readPngDimensions(png), { width: 100, height: 200 });
  assert.deepEqual(png, fixture.adb.latestPng);
  assert.equal(fixture.bridge.records.length, 0);
  jsonResult(await client.callTool({ name: "android_hid_arm" }));
  for (const keycode of [4, 0, 5, 0, 0x28, 0]) {
    jsonResult(await client.callTool({ name: "android_key_report", arguments: { modifier: 0, keycode } }));
  }
  assert.deepEqual(fixture.bridge.records.filter(({ op }) => op === "KEY").map(({ args }) => args), [[0, 4], [0, 0], [0, 5], [0, 0], [0, 0x28], [0, 0]]);
  assert.equal(fixture.input.state.armed, true);
  jsonResult(await client.callTool({ name: "android_hid_pause" }));
  assert.equal(fixture.input.state.armed, false);
  assert.deepEqual(fixture.bridge.records.slice(-2).map(({ op }) => op), ["RELEASE", "PAUSE"]);
});

test("HTTP configuration requires a valid port", async () => {
  const { tools } = createFixture();
  await assert.rejects(startHttpMcp(tools, { port: -1 }), /port must be/);
  await assert.rejects(startHttpMcp(tools, { port: 65536 }), /port must be/);
});

for (const [name, host] of [
  ["loopback", "127.0.0.1"],
  ["private LAN interface", new URL(lanUrls(8790)[0]!).hostname],
] as const) {
  test(`a fixed HTTP port rejects a non-HTTP listener on ${name} without stopping it`, async (context) => {
    if (name === "private LAN interface" && host === "localhost") return context.skip("No private LAN interface is available.");
    const fixture = createFixture();
    const sockets = new Set<Socket>();
    let receivedBytes = 0;
    const foreign = createTcpServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("data", (bytes: Buffer) => { receivedBytes += bytes.length; });
    });
    await new Promise<void>((resolve, reject) => { foreign.once("error", reject); foreign.listen(0, host, resolve); });
    context.after(async () => {
      for (const socket of sockets) socket.destroy();
      if (foreign.listening) await new Promise<void>((resolve) => foreign.close(() => resolve()));
    });
    const address = foreign.address();
    assert.ok(address && typeof address === "object");
    let overlapped: Awaited<ReturnType<typeof startHttpMcp>> | undefined;
    try {
      await assert.rejects(async () => { overlapped = await startHttpMcp(fixture.tools, { port: address.port }); },
        (error: unknown) => error instanceof Error && "code" in error && error.code === "EADDRINUSE");
    } finally { await overlapped?.close(); }
    assert.equal(foreign.listening, true, "The unrelated listener must remain running.");
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host, port: address.port });
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", reject);
    });
    assert.equal(receivedBytes, 0, "Port detection must use TCP and send no HTTP or protocol bytes.");
    assert.deepEqual(fixture.adb.captures, []);
    assert.deepEqual(fixture.bridge.records, []);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => foreign.close(() => resolve()));
    const listener = await startHttpMcp(fixture.tools, { port: address.port });
    context.after(async () => { await listener.close(); });
    assert.equal((await fetch(`${new URL(listener.url).origin}/health`)).status, 200,
      "The fixed port becomes available as soon as the foreign listener closes.");
  });
}

test("continuous operator video validates origin and stops on source loss, while a read-only viewer may leave", async (context) => {
  const fixture = createFixture();
  let receive: ((frame: ScreenCapture) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  let subscriptions = 0, unsubscribed = 0;
  const listener = await startHttpMcp(fixture.tools, { port: 0, liveScreen: {
    subscribe(onFrame, onError) {
      subscriptions++; receive = onFrame; fail = onError;
      return () => { unsubscribed++; };
    },
  } });
  context.after(async () => { await listener.close(); });
  const endpoint = `${new URL(listener.url).origin}/screen/events`;
  assert.equal(await responseStatus(endpoint, { method: "GET", headers: { Origin: "https://other.example" } }), 403);
  assert.equal(subscriptions, 0);
  const cancel = new AbortController();
  const response = await fetch(endpoint, { signal: cancel.signal });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(subscriptions, 1);
  const reader = response.body!.getReader();
  const frame: ScreenCapture = { serial: "11111111-1111-4111-8111-111111111111", width: 2, height: 3,
    deviceWidth: 1080, deviceHeight: 1620, previewProfile: "fast",
    png: JPEG_FIXTURE, mimeType: "image/jpeg", source: "screen-app", sourceFrameId: "one", frameAgeMs: 10,
    capturedAt: "2026-10-17T04:00:00.000Z", rotation: 0 };
  receive!(frame);
  const bytes = (await reader.read()).value!;
  const event = new TextDecoder().decode(bytes);
  assert.match(event, /^event: frame\ndata: /u);
  const data = JSON.parse(event.split("data: ")[1]!) as Record<string, unknown>;
  assert.equal(data["sourceFrameId"], "one");
  assert.equal(data["width"], 2); assert.equal(data["height"], 3);
  assert.equal(data["deviceWidth"], 1080); assert.equal(data["deviceHeight"], 1620);
  assert.equal(data["previewProfile"], "fast");
  assert.deepEqual(Buffer.from(String(data["image"]), "base64"), JPEG_FIXTURE);
  await fixture.input.arm(); assert.equal(fixture.input.state.armed, true);
  fail!(new Error("phone video disconnected"));
  await waitUntil(() => !fixture.input.state.armed, "phone source loss must stop HID");
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: unavailable/u);
  await fixture.input.arm();
  cancel.abort();
  await reader.cancel().catch(() => {});
  await waitUntil(() => unsubscribed === 1, "viewer disconnect must release its subscription");
  assert.equal(fixture.input.state.armed, true, "a read-only viewer leaving cannot stop another input owner");
});

test("preview profile settings use a separate bounded endpoint without changing the active input round", async (context) => {
  const fixture = createFixture();
  let profile: "turbo" | "fast" | "standard" | "original" = "standard";
  const selected: string[] = [];
  const listener = await startHttpMcp(fixture.tools, { port: 0, liveScreen: {
    subscribe() { return () => {}; },
    async getPreviewProfile() { return { profile }; },
    async setPreviewProfile(next) { selected.push(next); profile = next; return { profile }; },
  } });
  const transport = new StreamableHTTPClientTransport(new URL(listener.url));
  const owner = new Client({ name: "quality-change-owner", version: "1" });
  context.after(async () => { await owner.close(); await listener.close(); });
  await owner.connect(transport as unknown as Transport);
  jsonResult(await owner.callTool({ name: "android_hid_arm" }));
  const origin = new URL(listener.url).origin;
  const headers = { "Mcp-Session-Id": transport.sessionId! };
  const lease = await fetch(`${origin}/remote/lease`, { method: "POST", headers });
  assert.equal(lease.status, 204); const round = lease.headers.get("x-remote-round");
  const epoch = fixture.input.controlEpoch, reports = fixture.bridge.records.length;
  const endpoint = `${origin}/screen/profile`;
  assert.deepEqual(await (await fetch(endpoint)).json(), { profile: "standard" });
  for (const next of ["turbo", "fast", "standard", "original"]) {
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile: next }) });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { profile: next });
  }
  assert.deepEqual(selected, ["turbo", "fast", "standard", "original"]);
  assert.equal(fixture.input.controlEpoch, epoch); assert.equal(fixture.input.state.armed, true);
  assert.equal(fixture.bridge.records.length, reports, "Changing video quality must send no input report.");
  const renewed = await fetch(`${origin}/remote/lease`, { method: "POST", headers: { ...headers, "X-Remote-Round": round! } });
  assert.equal(renewed.status, 204); assert.equal(renewed.headers.get("x-remote-round"), round);
  assert.equal(await responseStatus(endpoint, { method: "GET", headers: { Origin: "https://other.example" } }), 403);
  assert.equal(await responseStatus(endpoint, { method: "PATCH" }), 405);
  assert.equal(await responseStatus(endpoint, { method: "POST", body: '{"profile":"fast"}' }), 415);
  for (const body of ['null', '[]', '{}', '{"profile":["fast"]}', '{"profile":"unknown"}', '{"profile":"fast","token":"x"}', '{', 'x'.repeat(257)]) {
    assert.equal(await responseStatus(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body }), 400);
  }
  assert.deepEqual(selected, ["turbo", "fast", "standard", "original"]);
});

test("preview profile failures are actionable and do not hide the running operator", async (context) => {
  const fixture = createFixture();
  const unavailable = await startHttpMcp(fixture.tools, { port: 0 });
  const failing = await startHttpMcp(fixture.tools, { port: 0, liveScreen: {
    subscribe() { return () => {}; },
    async getPreviewProfile() { throw new Error("请更新手机投屏 App"); },
    async setPreviewProfile() { throw new Error("手机暂时不可达"); },
  } });
  context.after(async () => { await unavailable.close(); await failing.close(); });
  assert.equal((await fetch(`${new URL(unavailable.url).origin}/screen/profile`)).status, 503);
  const origin = new URL(failing.url).origin;
  const get = await fetch(`${origin}/screen/profile`); assert.equal(get.status, 502);
  assert.match((await get.json() as { error: string }).error, /更新手机/);
  const post = await fetch(`${origin}/screen/profile`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"profile":"fast"}' });
  assert.equal(post.status, 502); assert.match((await post.json() as { error: string }).error, /不可达/);
  assert.equal((await fetch(`${origin}/`)).status, 200);
});

test("remote mouse lease stops held input if browser JS stops renewing and cannot be stolen", async (context) => {
  const fixture = createFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  const ownerTransport = new StreamableHTTPClientTransport(new URL(listener.url));
  const otherTransport = new StreamableHTTPClientTransport(new URL(listener.url));
  const owner = new Client({ name: "remote-owner", version: "1" });
  const other = new Client({ name: "remote-other", version: "1" });
  context.after(async () => { await owner.close(); await other.close(); await listener.close(); });
  await owner.connect(ownerTransport as unknown as Transport); await other.connect(otherTransport as unknown as Transport);
  const endpoint = `${new URL(listener.url).origin}/remote/lease`;
  const inputEndpoint = `${new URL(listener.url).origin}/remote/input`;
  assert.equal(await responseStatus(endpoint, { method: "POST" }), 400);
  const headers = { "Mcp-Session-Id": ownerTransport.sessionId! };
  assert.equal(await responseStatus(inputEndpoint, { method: "POST", headers, body: JSON.stringify({ kind: "mouse", dx: 1, dy: 2, wheel: 0, buttons: 1 }) }), 409);
  assert.equal(await responseStatus(endpoint, { method: "POST", headers }), 409);
  jsonResult(await owner.callTool({ name: "android_hid_arm" }));
  assert.equal(await responseStatus(endpoint, { method: "POST", headers }), 204);
  assert.equal(await responseStatus(inputEndpoint, { method: "POST", headers, body: JSON.stringify({ kind: "mouse", dx: 1, dy: 2, wheel: 0, buttons: 1 }) }), 200);
  assert.equal(await responseStatus(inputEndpoint, { method: "POST", headers, body: JSON.stringify({ kind: "key", modifier: 2, keycode: 4 }) }), 200);
  assert.ok(fixture.bridge.records.some(({ op, args }) => op === "MOVE" && args[0] === 1 && args[3] === 1));
  assert.ok(fixture.bridge.records.some(({ op, args }) => op === "KEY" && args[0] === 2 && args[1] === 4));
  assert.equal(await responseStatus(endpoint, { method: "POST", headers: { "Mcp-Session-Id": otherTransport.sessionId! } }), 409);
  assert.equal(await responseStatus(endpoint, { method: "DELETE", headers: { "Mcp-Session-Id": otherTransport.sessionId! } }), 409);
  await waitUntil(() => !fixture.input.state.armed, "900ms without browser heartbeat must release the held key and pause");
  assert.deepEqual(fixture.bridge.records.slice(-2).map(({ op }) => op), ["RELEASE", "PAUSE"]);
  assert.equal(await responseStatus(endpoint, { method: "POST", headers }), 409);
  jsonResult(await owner.callTool({ name: "android_hid_arm" }));
  assert.equal(await responseStatus(endpoint, { method: "POST", headers }), 204);
  assert.equal(await responseStatus(endpoint, { method: "DELETE", headers }), 204);
  await waitUntil(() => !fixture.input.state.armed, "leaving remote mode must release immediately");
  jsonResult(await owner.callTool({ name: "android_hid_arm" }));
  assert.equal(await responseStatus(endpoint, { method: "POST", headers }), 204);
  assert.equal(await responseStatus(inputEndpoint, { method: "POST", headers, body: JSON.stringify({ kind: "mouse", dx: 128, dy: 0, wheel: 0, buttons: 0 }) }), 400);
  await waitUntil(() => !fixture.input.state.armed, "invalid reports must stop remote control without sending them");
});

test("direct pointer reports match the live phone geometry and return reusable calibrated coordinates", { timeout: 5000 }, async (context) => {
  const fixture = livePointerFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  const transport = new StreamableHTTPClientTransport(new URL(listener.url));
  const client = new Client({ name: "live-pointer", version: "1" });
  context.after(async () => { await client.close(); await listener.close(); });
  await client.connect(transport as unknown as Transport);
  fixture.input.setCalibration(1, 1);
  jsonResult(await client.callTool({ name: "android_hid_arm" }));
  const origin = new URL(listener.url).origin;
  const headers = { "Mcp-Session-Id": transport.sessionId! };
  assert.equal(await responseStatus(`${origin}/remote/lease`, { method: "POST", headers }), 204);
  const point = async (report: Record<string, unknown>) => {
    const response = await fetch(`${origin}/remote/input`, { method: "POST", headers, body: JSON.stringify(report) });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    return await response.json() as { pointer: { x: number; y: number }; calibrated: boolean; armed: boolean };
  };
  await point(fixture.report);
  const homes = fixture.bridge.records.filter(({ op, args }) => op === "MOVE" && args[0] === -127).length;
  assert.equal(homes, 4);
  assert.equal(await responseStatus(`${origin}/remote/lease`, { method: "POST", headers }), 204);
  fixture.frame.sourceFrameId = "a-newer-frame-is-allowed";
  const pressed = await point({ ...fixture.report, x: 8, y: 9, buttons: 1 });
  assert.deepEqual(pressed.pointer, { x: 8, y: 9 });
  assert.equal(pressed.calibrated, true); assert.equal(pressed.armed, true);
  const released = await point({ ...fixture.report, x: 10, y: 11, wheel: 1 });
  assert.deepEqual(released.pointer, { x: 10, y: 11 });
  assert.equal(fixture.bridge.records.filter(({ op, args }) => op === "MOVE" && args[0] === -127).length, homes);
  assert.deepEqual(fixture.bridge.records.slice(-4), [
    { op: "MOVE", args: [8, 9, 0, 0] }, { op: "MOVE", args: [0, 0, 0, 1] },
    { op: "MOVE", args: [2, 2, 0, 1] }, { op: "MOVE", args: [0, 0, 1, 0] },
  ]);
});

test("direct pointer rejects unknown fields, invalid coordinates and mismatched or stale live metadata before movement", { timeout: 5000 }, async (context) => {
  const cases: { name: string; report?: Record<string, unknown>; age?: number; source?: boolean }[] = [
    { name: "unknown key", report: { extra: 1 } }, { name: "missing wheel", report: { wheel: undefined } },
    { name: "fractional x", report: { x: 1.5 } }, { name: "outside x", report: { x: 100 } },
    { name: "width changed", report: { width: 101 } }, { name: "rotation changed", report: { rotation: 1 } },
    { name: "other device", report: { deviceSerial: "22222222-2222-4222-8222-222222222222" } },
    { name: "invalid UUID", report: { deviceSerial: "USB-ONE" } }, { name: "held mask", report: { buttons: 8 } },
    { name: "stale frame", age: 3001 }, { name: "negative frame age", age: -1 },
    { name: "not a screen App frame", source: false },
  ];
  for (const entry of cases) await context.test(entry.name, async (subcontext) => {
    const fixture = livePointerFixture();
    if (entry.age !== undefined) fixture.frame.frameAgeMs = entry.age;
    if (entry.source === false) fixture.adb.capture = async () => {
      const { source: ignoredSource, ...frame } = fixture.frame;
      return frame;
    };
    const listener = await startHttpMcp(fixture.tools, { port: 0 });
    const transport = new StreamableHTTPClientTransport(new URL(listener.url));
    const client = new Client({ name: "invalid-live-pointer", version: "1" });
    subcontext.after(async () => { await client.close(); await listener.close(); });
    await client.connect(transport as unknown as Transport);
    fixture.input.setCalibration(1, 1);
    jsonResult(await client.callTool({ name: "android_hid_arm" }));
    const origin = new URL(listener.url).origin;
    const headers = { "Mcp-Session-Id": transport.sessionId! };
    assert.equal(await responseStatus(`${origin}/remote/lease`, { method: "POST", headers }), 204);
    assert.equal(await responseStatus(`${origin}/remote/input`, { headers, body: JSON.stringify({ ...fixture.report, ...entry.report }) }), 400);
    assert.equal(fixture.bridge.records.filter(({ op }) => op === "MOVE").length, 0);
    assert.equal(fixture.input.state.armed, false);
  });
});

for (const mode of ["frame", "capture-failure"] as const) {
  test(`pointer ${mode} arriving after a new lease cannot execute or pause its control`, { timeout: 5000 }, async (context) => {
    const fixture = livePointerFixture();
    let entered!: () => void, release!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const ready = new Promise<void>((resolve) => { release = resolve; });
    fixture.adb.capture = async () => {
      entered(); await ready;
      if (mode === "capture-failure") throw new Error("Old capture failed.");
      return { ...fixture.frame };
    };
    const listener = await startHttpMcp(fixture.tools, { port: 0 });
    const transport = new StreamableHTTPClientTransport(new URL(listener.url));
    const client = new Client({ name: "delayed-pointer-frame", version: "1" });
    context.after(async () => { release(); await client.close(); await listener.close(); });
    await client.connect(transport as unknown as Transport);
    fixture.input.setCalibration(1, 1);
    jsonResult(await client.callTool({ name: "android_hid_arm" }));
    const origin = new URL(listener.url).origin;
    const headers = { "Mcp-Session-Id": transport.sessionId! };
    assert.equal(await responseStatus(`${origin}/remote/lease`, { method: "POST", headers }), 204);
    const old = responseStatus(`${origin}/remote/input`, { headers, body: JSON.stringify(fixture.report) });
    await reading;
    jsonResult(await client.callTool({ name: "android_hid_pause" }));
    jsonResult(await client.callTool({ name: "android_hid_arm" }));
    assert.equal(await responseStatus(`${origin}/remote/lease`, { method: "POST", headers }), 204);
    const before = fixture.bridge.records.length;
    release();
    assert.equal(await old, 409);
    assert.equal(fixture.input.state.armed, true);
    assert.equal(fixture.bridge.records.length, before);
    assert.equal(fixture.bridge.records.filter(({ op }) => op === "MOVE").length, 0);
  });
}

test("queued pointer input rechecks frame age before sending any position reports", { timeout: 5000 }, async (context) => {
  const fixture = livePointerFixture();
  fixture.frame.frameAgeMs = 2950;
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  const transport = new StreamableHTTPClientTransport(new URL(listener.url));
  const client = new Client({ name: "queued-stale-pointer", version: "1" });
  context.after(async () => { await client.close(); await listener.close(); });
  await client.connect(transport as unknown as Transport);
  fixture.input.setCalibration(1, 1);
  jsonResult(await client.callTool({ name: "android_hid_arm" }));
  const origin = new URL(listener.url).origin;
  const headers = { "Mcp-Session-Id": transport.sessionId! };
  assert.equal(await responseStatus(`${origin}/remote/lease`, { method: "POST", headers }), 204);
  const blocked = fixture.bridge.blockNext("KEY");
  const key = fixture.input.keyReport(0, 4);
  await blocked.started;
  let entered!: () => void;
  const queued = new Promise<void>((resolve) => { entered = resolve; });
  const pointerTo = fixture.input.pointerTo.bind(fixture.input);
  fixture.input.pointerTo = (...args) => { const result = pointerTo(...args); entered(); return result; };
  const report = responseStatus(`${origin}/remote/input`, { headers, body: JSON.stringify(fixture.report) });
  try {
    await queued; await delay(80); blocked.release(); await key;
    assert.equal(await report, 400);
    assert.equal(fixture.bridge.records.filter(({ op }) => op === "MOVE").length, 0);
    assert.equal(fixture.input.state.armed, false);
  } finally {
    blocked.release(); await Promise.allSettled([key, report]);
  }
});

for (const mode of ["delete", "mcp-pause", "explicit-arm", "physical-stop"] as const) {
  test(`slow remote input cannot cross a ${mode} and re-arm in the same MCP session`, { timeout: 5000 }, async (context) => {
    const fixture = createFixture();
    const listener = await startHttpMcp(fixture.tools, { port: 0 });
    const transport = new StreamableHTTPClientTransport(new URL(listener.url));
    const client = new Client({ name: `slow-remote-${mode}`, version: "1" });
    context.after(async () => { await client.close(); await listener.close(); });
    await client.connect(transport as unknown as Transport);
    const origin = new URL(listener.url).origin;
    const headers = { "Mcp-Session-Id": transport.sessionId! };
    jsonResult(await client.callTool({ name: "android_hid_arm" }));
    assert.equal(await responseStatus(`${origin}/remote/lease`, { method: "POST", headers }), 204);
    const entered = nextInputStateRead(fixture.input);
    const old = slowReport(`${origin}/remote/input`, transport.sessionId!, JSON.stringify({ kind: "mouse", dx: 27, dy: 0, wheel: 0, buttons: 1 }));
    context.after(() => { old.abort(); });
    await entered;
    if (mode === "delete") assert.equal(await responseStatus(`${origin}/remote/lease`, { method: "DELETE", headers }), 204);
    else if (mode === "mcp-pause") jsonResult(await client.callTool({ name: "android_hid_pause" }));
    else if (mode === "physical-stop") {
      const epoch = fixture.input.controlEpoch;
      fixture.bridge.status.armed = false; fixture.bridge.status.locked = true;
      jsonResult(await client.callTool({ name: "android_hid_status" }));
      assert.ok(fixture.input.controlEpoch > epoch, "observing a hardware stop must invalidate awaiting reports");
      fixture.bridge.status.locked = false;
    }
    jsonResult(await client.callTool({ name: "android_hid_arm" }));
    assert.equal(await responseStatus(`${origin}/remote/lease`, { method: "POST", headers }), 204);
    old.finish();
    assert.equal(await old.completed, 409);
    assert.equal(fixture.bridge.records.filter(({ op }) => op === "MOVE").length, 0);
    assert.equal(fixture.input.state.armed, true, "rejecting an old body must leave the new control round running");
    assert.equal(await responseStatus(`${origin}/remote/input`, { headers, body: JSON.stringify({ kind: "mouse", dx: 3, dy: 0, wheel: 0, buttons: 0 }) }), 200);
  });
}

for (const mode of ["malformed", "aborted"] as const) for (const transition of ["delete", "mcp-pause"] as const) {
  test(`an old ${mode} remote body cannot pause a newly acquired lease after ${transition}`, { timeout: 5000 }, async (context) => {
    const fixture = createFixture();
    const listener = await startHttpMcp(fixture.tools, { port: 0 });
    const transport = new StreamableHTTPClientTransport(new URL(listener.url));
    const client = new Client({ name: `old-remote-${mode}`, version: "1" });
    context.after(async () => { await client.close(); await listener.close(); });
    await client.connect(transport as unknown as Transport);
    const origin = new URL(listener.url).origin;
    const headers = { "Mcp-Session-Id": transport.sessionId! };
    jsonResult(await client.callTool({ name: "android_hid_arm" }));
    assert.equal(await responseStatus(`${origin}/remote/lease`, { method: "POST", headers }), 204);
    const entered = nextInputStateRead(fixture.input);
    const old = slowReport(`${origin}/remote/input`, transport.sessionId!, "{invalid remote input}");
    context.after(() => { old.abort(); });
    await entered;
    if (transition === "delete") assert.equal(await responseStatus(`${origin}/remote/lease`, { method: "DELETE", headers }), 204);
    else jsonResult(await client.callTool({ name: "android_hid_pause" }));
    jsonResult(await client.callTool({ name: "android_hid_arm" }));
    assert.equal(await responseStatus(`${origin}/remote/lease`, { method: "POST", headers }), 204);
    const before = fixture.bridge.records.length;
    if (mode === "malformed") {
      old.finish();
      assert.equal(await old.completed, 409);
    } else {
      old.abort();
      await assert.rejects(old.completed, /Test aborted/u);
      // Allow the server to observe TCP close and run both close/catch paths.
      await delay(30);
    }
    assert.equal(fixture.input.state.armed, true);
    assert.equal(fixture.bridge.records.length, before, "old request cleanup must not release or pause new input");
    assert.equal(await responseStatus(`${origin}/remote/input`, { headers, body: JSON.stringify({ kind: "key", modifier: 0, keycode: 0 }) }), 200);
  });
}

test("renewing a remote lease preserves an in-flight report in the same control round", { timeout: 5000 }, async (context) => {
  const fixture = createFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  const transport = new StreamableHTTPClientTransport(new URL(listener.url));
  const client = new Client({ name: "renew-slow-remote", version: "1" });
  context.after(async () => { await client.close(); await listener.close(); });
  await client.connect(transport as unknown as Transport);
  const origin = new URL(listener.url).origin;
  const headers = { "Mcp-Session-Id": transport.sessionId! };
  jsonResult(await client.callTool({ name: "android_hid_arm" }));
  assert.equal(await responseStatus(`${origin}/remote/lease`, { method: "POST", headers }), 204);
  const entered = nextInputStateRead(fixture.input);
  const pending = slowReport(`${origin}/remote/input`, transport.sessionId!, JSON.stringify({ kind: "mouse", dx: 5, dy: 6, wheel: 0, buttons: 0 }));
  context.after(() => { pending.abort(); });
  await entered;
  assert.equal(await responseStatus(`${origin}/remote/lease`, { method: "POST", headers }), 204);
  assert.equal(await responseStatus(`${origin}/remote/lease`, { method: "POST", headers }), 204);
  pending.finish();
  assert.equal(await pending.completed, 200);
  assert.deepEqual(fixture.bridge.records.filter(({ op }) => op === "MOVE").map(({ args }) => args), [[5, 6, 0, 0]]);
  assert.equal(fixture.input.state.armed, true);
});

test("re-arming without renewing the old browser lease rejects its awaiting input and expiry cannot pause the new MCP round", { timeout: 5000 }, async (context) => {
  const fixture = createFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  const transport = new StreamableHTTPClientTransport(new URL(listener.url));
  const client = new Client({ name: "arm-invalidates-remote", version: "1" });
  context.after(async () => { await client.close(); await listener.close(); });
  await client.connect(transport as unknown as Transport);
  const origin = new URL(listener.url).origin;
  const headers = { "Mcp-Session-Id": transport.sessionId! };
  jsonResult(await client.callTool({ name: "android_hid_arm" }));
  assert.equal(await responseStatus(`${origin}/remote/lease`, { method: "POST", headers }), 204);
  const entered = nextInputStateRead(fixture.input);
  const old = slowReport(`${origin}/remote/input`, transport.sessionId!, JSON.stringify({ kind: "mouse", dx: 15, dy: 0, wheel: 0, buttons: 0 }));
  context.after(() => { old.abort(); });
  await entered;
  jsonResult(await client.callTool({ name: "android_hid_arm" }));
  const before = fixture.bridge.records.length;
  old.finish();
  assert.equal(await old.completed, 409);
  await delay(950);
  assert.equal(fixture.input.state.armed, true);
  assert.equal(fixture.bridge.records.length, before);
  assert.equal(await responseStatus(`${origin}/remote/lease`, { method: "POST", headers }), 204);
  assert.equal(await responseStatus(`${origin}/remote/input`, { headers, body: JSON.stringify({ kind: "mouse", dx: 2, dy: 0, wheel: 0, buttons: 0 }) }), 200);
});

test("an old queued remote report cannot execute or pause a new round when its failure arrives late", { timeout: 5000 }, async (context) => {
  const fixture = createFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  const transport = new StreamableHTTPClientTransport(new URL(listener.url));
  const client = new Client({ name: "queued-remote-round", version: "1" });
  context.after(async () => { await client.close(); await listener.close(); });
  await client.connect(transport as unknown as Transport);
  const origin = new URL(listener.url).origin;
  const headers = { "Mcp-Session-Id": transport.sessionId! };
  jsonResult(await client.callTool({ name: "android_hid_arm" }));
  assert.equal(await responseStatus(`${origin}/remote/lease`, { method: "POST", headers }), 204);
  const blocked = fixture.bridge.blockNext("KEY");
  const key = fixture.input.keyReport(0, 4);
  void key.catch(() => {});
  await blocked.started;
  let entered!: () => void, failed!: () => void, release!: () => void;
  const queued = new Promise<void>((resolve) => { entered = resolve; });
  const rejected = new Promise<void>((resolve) => { failed = resolve; });
  const deliverFailure = new Promise<void>((resolve) => { release = resolve; });
  const move = fixture.input.move.bind(fixture.input);
  fixture.input.move = (...args) => {
    const result = move(...args);
    entered();
    return result.catch(async (error: unknown) => { failed(); await deliverFailure; throw error; });
  };
  const old = responseStatus(`${origin}/remote/input`, { headers, body: JSON.stringify({ kind: "mouse", dx: 21, dy: 0, wheel: 0, buttons: 1 }) });
  try {
    await queued;
    jsonResult(await client.callTool({ name: "android_hid_pause" }));
    await rejected;
    jsonResult(await client.callTool({ name: "android_hid_arm" }));
    assert.equal(await responseStatus(`${origin}/remote/lease`, { method: "POST", headers }), 204);
    const before = fixture.bridge.records.length;
    release();
    assert.equal(await old, 409);
    assert.equal(fixture.input.state.armed, true);
    assert.equal(fixture.bridge.records.length, before);
    assert.equal(fixture.bridge.records.filter(({ op }) => op === "MOVE").length, 0);
  } finally {
    release(); blocked.release();
    await Promise.allSettled([key, old]);
  }
});

test("operator assets are served without credentials under a restrictive CSP and traversal is rejected", async (context) => {
  const fixture = createFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  context.after(async () => { await listener.close(); });
  const origin = new URL(listener.url).origin;
  for (const [path, type] of [["/", "text/html"], ["/operator.css", "text/css"], ["/operator.js", "text/javascript"], ["/screen-channel.js", "text/javascript"], ["/remote-channel.js", "text/javascript"]]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("content-type"), `${type}; charset=utf-8`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const csp = response.headers.get("content-security-policy");
    assert.ok(csp);
    const directives = new Map(csp.split(";").map((directive) => {
      const [name, ...values] = directive.trim().split(/\s+/u);
      return [name, values.join(" ")];
    }));
    for (const directive of ["default-src", "script-src", "style-src"]) {
      assert.equal(directives.get(directive), "'self'", directive);
    }
    assert.equal(directives.get("connect-src"), `'self' ws://${new URL(origin).host} wss://${new URL(origin).host}`);
    assert.equal(directives.get("img-src"), "'self' data: blob:");
    assert.equal(directives.get("frame-ancestors"), "'none'");
    assert.equal(directives.get("base-uri"), "'none'");
    assert.equal(directives.get("form-action"), "'none'");
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:|\*/u);
    const bytes = await response.text();
    assert.ok(bytes.length > 0);
    assert.doesNotMatch(bytes, /ANDROID_MCP_TOKEN|token-input/u);
    if (path === "/") {
      assert.match(bytes, /<script\b[^>]*\bsrc="\/operator\.js"[^>]*><\/script>/u);
      assert.match(bytes, /<link\b[^>]*\bhref="\/operator\.css"/u);
      assert.doesNotMatch(bytes, /<style\b|\son[a-z]+\s*=|\sstyle\s*=/iu);
      const scripts = bytes.match(/<script\b[^>]*>[\s\S]*?<\/script>/giu) ?? [];
      assert.ok(scripts.every((script) => /\bsrc="\/(operator|screen-channel|remote-channel)\.js"/u.test(script) && />\s*<\/script>$/u.test(script)));
    }
  }
  for (const path of ["/missing.js", "/assets/operator.js", "/../operator.js", "/%2e%2e/operator.js",
    "/..%2foperator.js", "/operator.js/../operator.html", "/operator.js?unexpected=1", "/src/index.ts"]) {
    assert.equal(await responseStatus(origin, { method: "GET", path }), 404, path);
  }
  assert.deepEqual(fixture.bridge.records, []);
});

test("an aborted raw tools POST stops active and queued HID while SDK SSE stays open without MCP cancellation", async (context) => {
  const fixture = createFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  let sseRequested = false, sseAborted = false;
  const sdkMethods: string[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(listener.url), {
    requestInit: { headers: {} },
    fetch: async (url, init) => {
      if (typeof init?.body === "string") {
        const message = JSON.parse(init.body) as { method?: string };
        if (message.method) sdkMethods.push(message.method);
      }
      const response = await fetch(url, init);
      if (init?.method === "GET" && response.ok) {
        sseRequested = true;
        init.signal?.addEventListener("abort", () => { sseAborted = true; }, { once: true });
      }
      return response;
    },
  });
  const client = new Client({ name: "offline-http-raw-abort", version: "1.0.0" });
  context.after(async () => { await client.close(); await listener.close(); });
  await client.connect(transport as unknown as Transport);
  await waitUntil(() => sseRequested, "SDK session SSE must already be open");
  const sessionId = transport.sessionId; assert.ok(sessionId);
  jsonResult(await client.callTool({ name: "android_hid_arm" }));
  const blocked = fixture.bridge.blockNext("KEY");
  const abort = new AbortController();
  const active = fetch(listener.url, {
    method: "POST", headers: { "mcp-session-id": sessionId,
      "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "raw-aborted-action", method: "tools/call",
      params: { name: "android_type", arguments: { text: "abcdef" } } }), signal: abort.signal,
  });
  const rejected = assert.rejects(active, { name: "AbortError" });
  await blocked.started;
  let entered!: () => void;
  const queuedEntered = new Promise<void>((resolve) => { entered = resolve; });
  const key = fixture.input.key.bind(fixture.input);
  fixture.input.key = (...args) => { const result = key(...args); entered(); return result; };
  const queued = client.callTool({ name: "android_key", arguments: { combo: "enter" } });
  try {
    await queuedEntered;
    abort.abort();
    await rejected;
    await waitUntil(() => !fixture.input.state.armed, "Lost POST response must stop HID without an MCP cancellation message");
    const cancelled = CallToolResultSchema.parse(await queued);
    assert.equal(cancelled.isError, true);
    await waitUntil(() => fixture.bridge.records.at(-1)?.op === "PAUSE", "Lost POST response must complete RELEASE and PAUSE");
    assert.deepEqual(fixture.bridge.records.filter(({ op }) => op === "KEY").map(({ args }) => args), [[0, 4]]);
    assert.deepEqual(fixture.bridge.records.slice(-2).map(({ op }) => op), ["RELEASE", "PAUSE"]);
    assert.equal(sseAborted, false, "The separate SDK SSE connection must remain open");
    assert.equal(sdkMethods.includes("notifications/cancelled"), false);
    assert.ok((await client.listTools()).tools.length > 0, "The initialized SDK session remains usable");
  } finally {
    abort.abort(); blocked.release(); await Promise.allSettled([queued]);
  }
});

test("HTTP SDK cancellation reaches the active HID request and cancels queued input", async (context) => {
  const fixture = createFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  const transport = new StreamableHTTPClientTransport(new URL(listener.url), {
    requestInit: { headers: {} },
  });
  const client = new Client({ name: "offline-http-cancellation", version: "1.0.0" });
  context.after(async () => { await client.close(); await listener.close(); });
  await client.connect(transport as unknown as Transport);
  jsonResult(await client.callTool({ name: "android_hid_arm" }));
  const blocked = fixture.bridge.blockNext("KEY");
  const abort = new AbortController();
  const active = client.callTool({ name: "android_type", arguments: { text: "abcdef" } }, undefined, { signal: abort.signal });
  const rejected = assert.rejects(active);
  await blocked.started;
  const queued = client.callTool({ name: "android_key", arguments: { combo: "enter" } });
  try {
    abort.abort(new Error("HTTP test cancellation"));
    await rejected;
    // The cancel notification is a separate HTTP POST; wait for its observable stop effect.
    await waitUntil(() => !fixture.input.state.armed, "HTTP cancellation must disarm the active input controller");
    const cancelled = CallToolResultSchema.parse(await queued);
    assert.equal(cancelled.isError, true);
    assert.deepEqual(fixture.bridge.records.filter(({ op }) => op === "KEY").map(({ args }) => args), [[0, 4]]);
    assert.ok(fixture.bridge.records.some(({ op }) => op === "RELEASE"));
    assert.ok(fixture.bridge.records.some(({ op }) => op === "PAUSE"));
  } finally {
    blocked.release();
    await Promise.allSettled([queued]);
  }
});

test("SDK session termination pauses HID and rejects subsequent requests with the old session", async (context) => {
  const fixture = createFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  const transport = new StreamableHTTPClientTransport(new URL(listener.url), {
    requestInit: { headers: {} },
  });
  const client = new Client({ name: "offline-http-session-end", version: "1.0.0" });
  context.after(async () => { await client.close(); await listener.close(); });
  await client.connect(transport as unknown as Transport);
  const sessionId = transport.sessionId;
  assert.equal(typeof sessionId, "string");
  assert.ok(sessionId);
  jsonResult(await client.callTool({ name: "android_hid_arm" }));
  assert.equal(fixture.input.state.armed, true);
  await transport.terminateSession();
  await waitUntil(() => !fixture.input.state.armed, "Terminating a session must pause HID");
  assert.equal(await responseStatus(listener.url, {
    headers: { "mcp-session-id": sessionId, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
  }), 404);
  assert.ok(fixture.bridge.records.some(({ op }) => op === "RELEASE"));
  assert.ok(fixture.bridge.records.some(({ op }) => op === "PAUSE"));
});

test("closing the SDK client SSE connection pauses HID", async (context) => {
  const fixture = createFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  let sseRequested = false;
  const transport = new StreamableHTTPClientTransport(new URL(listener.url), {
    requestInit: { headers: {} },
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (init?.method === "GET" && response.ok) sseRequested = true;
      return response;
    },
  });
  const client = new Client({ name: "offline-http-sse-close", version: "1.0.0" });
  context.after(async () => { await client.close(); await listener.close(); });
  await client.connect(transport as unknown as Transport);
  jsonResult(await client.callTool({ name: "android_hid_arm" }));
  await waitUntil(() => sseRequested, "SDK client should open the session SSE stream");
  assert.equal(fixture.input.state.armed, true);
  await client.close();
  await waitUntil(() => !fixture.input.state.armed, "Closing the SSE connection must pause HID");
  assert.ok(fixture.bridge.records.some(({ op }) => op === "RELEASE"));
  assert.ok(fixture.bridge.records.some(({ op }) => op === "PAUSE"));
});

test("closing a screenshot-only SDK SSE session never opens the cold HID bridge", async (context) => {
  const fixture = createFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  let sseRequested = false, stopped = false;
  const stop = fixture.input.stop.bind(fixture.input);
  fixture.input.stop = async () => { const result = await stop(); stopped = true; return result; };
  const transport = new StreamableHTTPClientTransport(new URL(listener.url), {
    requestInit: { headers: {} },
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (init?.method === "GET" && response.ok) sseRequested = true;
      return response;
    },
  });
  const client = new Client({ name: "offline-http-cold-sse-close", version: "1.0.0" });
  context.after(async () => { await client.close(); await listener.close(); });
  await client.connect(transport as unknown as Transport);
  await waitUntil(() => sseRequested, "SDK session SSE must be open before closing it");
  const sessionId = transport.sessionId; assert.ok(sessionId);
  jsonResult(await client.callTool({ name: "android_screenshot" }));
  assert.deepEqual(fixture.bridge.records, []);
  await client.close();
  await waitForClosedSession(listener.url, sessionId);
  assert.equal(stopped, false, "Read-only session cleanup must not touch shared input.");
  assert.deepEqual(fixture.bridge.records, []);
});

test("rejected duplicate and non-SSE GETs cannot close or pause the existing SDK session", async (context) => {
  const fixture = createFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  let sseRequested = false;
  const transport = new StreamableHTTPClientTransport(new URL(listener.url), {
    requestInit: { headers: {} },
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (init?.method === "GET" && response.ok) sseRequested = true;
      return response;
    },
  });
  const client = new Client({ name: "offline-http-rejected-get", version: "1.0.0" });
  context.after(async () => { await client.close(); await listener.close(); });
  await client.connect(transport as unknown as Transport);
  await waitUntil(() => sseRequested, "The original SDK SSE stream must be open");
  const sessionId = transport.sessionId; assert.ok(sessionId);
  jsonResult(await client.callTool({ name: "android_hid_arm" }));
  const before = fixture.bridge.records.length;
  assert.equal(await responseStatus(listener.url, { method: "GET", headers: {
    "mcp-session-id": sessionId, Accept: "text/event-stream",
  } }), 409);
  assert.equal(await responseStatus(listener.url, { method: "GET", headers: {
    "mcp-session-id": sessionId, Accept: "application/json",
  } }), 406);
  assert.equal(fixture.input.state.armed, true);
  assert.equal(fixture.bridge.records.length, before);
  assert.ok((await client.listTools()).tools.length > 0);
  assert.equal(fixture.input.state.armed, true);
});

test("forty SDK initialize/SSE/close cycles release sessions and never exhaust the session limit", async (context) => {
  const fixture = createFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  context.after(async () => { await listener.close(); });
  let stopped = 0;
  const stop = fixture.input.stop.bind(fixture.input);
  fixture.input.stop = async () => { const result = await stop(); stopped += 1; return result; };
  const sessionIds = new Set<string>();
  for (let index = 0; index < 40; index += 1) {
    let sseRequested = false;
    const transport = new StreamableHTTPClientTransport(new URL(listener.url), {
      requestInit: { headers: {} },
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (init?.method === "GET" && response.ok) sseRequested = true;
        return response;
      },
    });
    const client = new Client({ name: `offline-http-reconnect-${index}`, version: "1.0.0" });
    try {
      await client.connect(transport as unknown as Transport);
      await waitUntil(() => sseRequested, `Session ${index + 1} must open a persistent GET`);
      const sessionId = transport.sessionId; assert.ok(sessionId);
      assert.equal(sessionIds.has(sessionId), false);
      sessionIds.add(sessionId);
      jsonResult(await client.callTool({ name: "android_screenshot" }));
      await client.close();
      await waitForClosedSession(listener.url, sessionId);
      assert.equal(stopped, 0, "Read-only session cycles must never stop shared input.");
      assert.equal(await responseStatus(listener.url, {
        headers: { "mcp-session-id": sessionId,
          "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: index, method: "tools/list", params: {} }),
      }), 404, `Closed session ${index + 1} must be removed from the session map`);
    } finally { await client.close(); }
  }
  assert.equal(sessionIds.size, 40);
  assert.deepEqual(fixture.bridge.records, []);
});

test("closing a read-only SDK inspector does not stop the browser session controlling the phone", async (context) => {
  const fixture = createFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  const owner = new Client({ name: "browser-owner", version: "1" });
  const inspector = new Client({ name: "read-only-inspector", version: "1" });
  const ownerTransport = new StreamableHTTPClientTransport(new URL(listener.url));
  const inspectorTransport = new StreamableHTTPClientTransport(new URL(listener.url));
  context.after(async () => { await owner.close(); await inspector.close(); await listener.close(); });
  await owner.connect(ownerTransport as unknown as Transport);
  await inspector.connect(inspectorTransport as unknown as Transport);
  jsonResult(await owner.callTool({ name: "android_hid_arm" }));
  const origin = new URL(listener.url).origin;
  const headers = { "Mcp-Session-Id": ownerTransport.sessionId! };
  assert.equal(await responseStatus(`${origin}/remote/lease`, { headers }), 204);
  jsonResult(await inspector.callTool({ name: "android_screenshot" }));
  jsonResult(await inspector.callTool({ name: "android_hid_status" }));
  const inspectorId = inspectorTransport.sessionId; assert.ok(inspectorId);
  const before = fixture.bridge.records.length;
  await inspector.close();
  await waitForClosedSession(listener.url, inspectorId);
  assert.equal(fixture.input.state.armed, true);
  assert.equal(fixture.bridge.records.length, before, "Inspector close must emit no release/pause reports.");
  assert.equal(await responseStatus(`${origin}/remote/input`, { headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "mouse", dx: 1, dy: 0, wheel: 0, buttons: 0 }) }), 200);
});

for (const caller of ["observer", "owner"] as const) {
  test(`an ${caller} original screenshot failure respects input ownership while shared preview remains fresh`, async (context) => {
    const fixture = livePointerFixture();
    Object.assign(fixture.adb, { preview: async () => ({ ...fixture.frame, capturedAt: new Date().toISOString(), frameAgeMs: 0 }) });
    const listener = await startHttpMcp(fixture.tools, { port: 0 });
    const owner = new Client({ name: "screenshot-input-owner", version: "1" });
    const observer = new Client({ name: "screenshot-read-only-observer", version: "1" });
    const ownerTransport = new StreamableHTTPClientTransport(new URL(listener.url));
    context.after(async () => { await owner.close(); await observer.close(); await listener.close(); });
    await owner.connect(ownerTransport as unknown as Transport);
    await observer.connect(new StreamableHTTPClientTransport(new URL(listener.url)) as unknown as Transport);
    await fixture.tools.readLiveFrame();
    jsonResult(await owner.callTool({ name: "android_hid_arm" }));
    const origin = new URL(listener.url).origin;
    const lease = await fetch(`${origin}/remote/lease`, { method: "POST", headers: { "Mcp-Session-Id": ownerTransport.sessionId! } });
    assert.equal(lease.status, 204);
    const round = lease.headers.get("x-remote-round"); assert.ok(round);
    const headers = { "Mcp-Session-Id": ownerTransport.sessionId!, "X-Remote-Round": round };
    const epoch = fixture.input.controlEpoch, records = fixture.bridge.records.length;
    fixture.adb.capture = async () => { throw new ScreenError("SCREEN_NOT_PROJECTING", "Original capture returned HTTP 503."); };
    const result = CallToolResultSchema.parse(await (caller === "owner" ? owner : observer).callTool({ name: "android_screenshot" }));
    assert.equal(result.isError, true);
    assert.ok(result.content.some((entry) => entry.type === "text" && entry.text.includes("HTTP 503")));
    const preview = await fixture.tools.readLiveFrame();
    assert.equal(preview.source, "screen-app"); assert.ok(preview.frameAgeMs! < 100);
    if (caller === "observer") {
      assert.equal(fixture.input.state.armed, true, "A read-only original-image failure cannot disarm the current input owner.");
      assert.equal(fixture.input.controlEpoch, epoch);
      assert.equal(fixture.bridge.records.length, records, "A read-only failure must not emit RELEASE or PAUSE.");
      assert.equal(await responseStatus(`${origin}/remote/lease`, { headers }), 204, "The owner's existing round must remain valid.");
      assert.equal(await responseStatus(`${origin}/remote/input`, { headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "mouse", dx: 1, dy: 0, wheel: 0, buttons: 0 }) }), 200);
    } else {
      assert.equal(fixture.input.state.armed, false, "The input owner's own failed screenshot must still stop its input.");
      assert.ok(fixture.input.controlEpoch > epoch);
      assert.deepEqual(fixture.bridge.records.slice(records).map(({ op }) => op), ["RELEASE", "PAUSE"]);
      assert.equal(await responseStatus(`${origin}/remote/input`, { headers,
        body: JSON.stringify({ kind: "mouse", dx: 1, dy: 0, wheel: 0, buttons: 0 }) }), 409);
    }
  });
}

test("an old input owner's delayed screenshot failure cannot stop a later MCP input owner", async (context) => {
  const fixture = livePointerFixture();
  Object.assign(fixture.adb, { preview: async () => ({ ...fixture.frame, capturedAt: new Date().toISOString(), frameAgeMs: 0 }) });
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  const older = new Client({ name: "old-screenshot-owner", version: "1" });
  const newer = new Client({ name: "new-screenshot-owner", version: "1" });
  context.after(async () => { await older.close(); await newer.close(); await listener.close(); });
  await older.connect(new StreamableHTTPClientTransport(new URL(listener.url)) as unknown as Transport);
  await newer.connect(new StreamableHTTPClientTransport(new URL(listener.url)) as unknown as Transport);
  await fixture.tools.readLiveFrame();
  jsonResult(await older.callTool({ name: "android_hid_arm" }));
  let reading!: () => void, fail!: () => void;
  const started = new Promise<void>((resolve) => { reading = resolve; });
  const failed = new Promise<never>((_resolve, reject) => { fail = () => reject(new ScreenError("SCREEN_NOT_PROJECTING", "Old original capture returned HTTP 503.")); });
  fixture.adb.capture = async () => { reading(); return failed; };
  const screenshot = older.callTool({ name: "android_screenshot" });
  context.after(() => fail());
  await started;
  jsonResult(await newer.callTool({ name: "android_hid_arm" }));
  const epoch = fixture.input.controlEpoch, records = fixture.bridge.records.length;
  fail();
  const result = CallToolResultSchema.parse(await screenshot);
  assert.equal(result.isError, true);
  assert.equal(fixture.input.state.armed, true);
  assert.equal(fixture.input.controlEpoch, epoch);
  assert.equal(fixture.bridge.records.length, records, "An old capture's late failure must not emit cleanup against the new owner.");
  jsonResult(await newer.callTool({ name: "android_mouse_move", arguments: { dx: 1, dy: 0 } }));
});

test("closing an older MCP input session cannot stop its newer input owner", async (context) => {
  const fixture = createFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  const older = new Client({ name: "old-input-owner", version: "1" });
  const newer = new Client({ name: "new-input-owner", version: "1" });
  const olderTransport = new StreamableHTTPClientTransport(new URL(listener.url));
  const newerTransport = new StreamableHTTPClientTransport(new URL(listener.url));
  context.after(async () => { await older.close(); await newer.close(); await listener.close(); });
  await older.connect(olderTransport as unknown as Transport);
  await newer.connect(newerTransport as unknown as Transport);
  jsonResult(await older.callTool({ name: "android_hid_arm" }));
  jsonResult(await newer.callTool({ name: "android_hid_arm" }));
  const oldId = olderTransport.sessionId, newId = newerTransport.sessionId;
  assert.ok(oldId && newId);
  const before = fixture.bridge.records.length;
  await older.close();
  await waitForClosedSession(listener.url, oldId);
  assert.equal(fixture.input.state.armed, true);
  assert.equal(fixture.bridge.records.length, before);
  jsonResult(await newer.callTool({ name: "android_key", arguments: { combo: "tab" } }));
  await newer.close();
  await waitForClosedSession(listener.url, newId);
  await waitUntil(() => !fixture.input.state.armed, "Closing the actual input owner must still stop input.");
});

test("aborting a read-only tools POST cannot pause another MCP input owner", async (context) => {
  const fixture = createFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  const owner = new Client({ name: "active-input-owner", version: "1" });
  const inspector = new Client({ name: "aborting-inspector", version: "1" });
  const ownerTransport = new StreamableHTTPClientTransport(new URL(listener.url));
  const inspectorTransport = new StreamableHTTPClientTransport(new URL(listener.url));
  context.after(async () => { await owner.close(); await inspector.close(); await listener.close(); });
  await owner.connect(ownerTransport as unknown as Transport);
  await inspector.connect(inspectorTransport as unknown as Transport);
  jsonResult(await owner.callTool({ name: "android_hid_arm" }));
  const blocked = fixture.bridge.blockNext("STATUS");
  context.after(() => blocked.release());
  const abort = new AbortController();
  const pending = fetch(listener.url, { method: "POST", headers: {
    "Mcp-Session-Id": inspectorTransport.sessionId!, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
  }, body: JSON.stringify({ jsonrpc: "2.0", id: "read-only-post", method: "tools/call", params: { name: "android_hid_status" } }),
    signal: abort.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await blocked.started;
  const before = fixture.bridge.records.length;
  abort.abort();
  await rejected;
  await delay(20);
  assert.equal(fixture.input.state.armed, true);
  assert.equal(fixture.bridge.records.length, before, "Read-only transport loss must not generate cleanup reports.");
  blocked.release();
  jsonResult(await owner.callTool({ name: "android_key", arguments: { combo: "enter" } }));
});

test("AI control claims an active browser round and old teardown requests cannot stop the new owner", async (context) => {
  const fixture = createFixture();
  const capture = fixture.adb.capture.bind(fixture.adb);
  let sourceSequence = 0;
  fixture.adb.capture = async (serial) => ({ ...await capture(serial), sourceFrameId: `takeover-${++sourceSequence}`, frameAgeMs: 0 });
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  const browser = new Client({ name: "browser-before-ai", version: "1" });
  const ai = new Client({ name: "ai-takeover", version: "1" });
  const browserTransport = new StreamableHTTPClientTransport(new URL(listener.url));
  const aiTransport = new StreamableHTTPClientTransport(new URL(listener.url));
  context.after(async () => { await browser.close(); await ai.close(); await listener.close(); });
  await browser.connect(browserTransport as unknown as Transport);
  await ai.connect(aiTransport as unknown as Transport);
  const origin = new URL(listener.url).origin;
  const browserId = browserTransport.sessionId; assert.ok(browserId);
  jsonResult(await browser.callTool({ name: "android_hid_arm" }));
  const browserHeaders = { "Mcp-Session-Id": browserId };
  assert.equal(await responseStatus(`${origin}/remote/lease`, { headers: browserHeaders }), 204);
  assert.equal(await responseStatus(`${origin}/remote/input`, { headers: { ...browserHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "key", modifier: 0, keycode: 4 }) }), 200);
  const observation = jsonResult(await ai.callTool({ name: "android_screenshot" }));
  assert.equal(fixture.input.state.armed, true, "AI observation must leave the browser's control untouched.");
  const slowPause = slowReport(listener.url, browserId, JSON.stringify({ jsonrpc: "2.0", id: "late-browser-pause",
    method: "tools/call", params: { name: "android_hid_pause" } }));
  await delay(20);
  const controlled = jsonResult(await ai.callTool({ name: "android_control", arguments: { action: "home", frameId: observation["frameId"] } }));
  assert.equal(controlled["observedAfterAction"], true);
  assert.equal(fixture.input.state.armed, true);
  slowPause.finish();
  assert.equal(await slowPause.completed, 404, "A body accepted before takeover must be rechecked after its old session closes.");
  const before = fixture.bridge.records.length;
  assert.equal(await responseStatus(listener.url, { headers: { ...browserHeaders, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "old-cleanup", method: "tools/call", params: { name: "android_hid_pause" } }) }), 404);
  assert.equal(fixture.bridge.records.length, before);
  assert.equal(await responseStatus(`${origin}/remote/input`, { headers: { ...browserHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "key", modifier: 0, keycode: 0 }) }), 409);
  await delay(950);
  assert.equal(fixture.input.state.armed, true, "The old browser lease expiry must not stop the AI owner.");
  jsonResult(await ai.callTool({ name: "android_home" }));
  assert.deepEqual(fixture.bridge.records.filter(({ op }) => op === "CONSUMER").map(({ args }) => args), [[0x223], [0], [0x223], [0]]);
});

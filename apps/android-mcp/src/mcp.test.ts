import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readPngDimensions } from "./adb.js";
import { createFixture, fixturePng } from "./fixtures/stdio-server.js";
import { JPEG_FIXTURE } from "./fixtures/jpeg.js";
import { AndroidTools, createMcpServer, createMcpSession } from "./mcp.js";
import type { AndroidToolsOptions } from "./mcp.js";
import { startHttpMcp } from "./http.js";
import { ScreenClient, ScreenError } from "./screen.js";
import type { PointerCalibrationState } from "./screen.js";
import { LiveScreenSource } from "./live.js";
import { PNG } from "pngjs";
import { renderTargetPreview as renderTargetPreviewPixels } from "./target-preview.js";

type ToolResponse = Awaited<ReturnType<Client["callTool"]>>;

function jsonResult(raw: ToolResponse | CallToolResult): Record<string, unknown> {
  const result = CallToolResultSchema.parse(raw);
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  const text = result.content.find((entry) => entry.type === "text");
  assert.ok(text && text.type === "text");
  return JSON.parse(text.text) as Record<string, unknown>;
}

function errorResult(raw: ToolResponse | CallToolResult, pattern?: RegExp): void {
  const result = CallToolResultSchema.parse(raw);
  assert.equal(result.isError, true);
  const text = result.content.find((entry) => entry.type === "text");
  assert.ok(text && text.type === "text");
  if (pattern) assert.match(text.text, pattern);
}

async function connected(context: TestContext, fixture = createFixture()) {
  const server = createMcpServer(fixture.tools);
  const client = new Client({ name: "offline-tests", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport as unknown as Transport);
  await client.connect(clientTransport as unknown as Transport);
  context.after(async () => { await client.close(); await server.close(); });
  return { ...fixture, client };
}

test("MCP session ownership follows admitted calls and cannot be claimed by missing arguments", async (context) => {
  const fixture = createFixture();
  const first = createMcpSession(fixture.tools), second = createMcpSession(fixture.tools);
  const clients = [new Client({ name: "owner-a", version: "1" }), new Client({ name: "owner-b", version: "1" })];
  for (const [index, session] of [first, second].entries()) {
    const [caller, receiver] = InMemoryTransport.createLinkedPair();
    await session.server.connect(receiver as unknown as Transport);
    await clients[index]!.connect(caller as unknown as Transport);
  }
  context.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await Promise.allSettled([first.server.close(), second.server.close()]);
  });
  assert.equal(first.ownsInput(), false); assert.equal(second.ownsInput(), false);
  jsonResult(await clients[0]!.callTool({ name: "android_hid_arm" }));
  assert.equal(first.ownsInput(), true); assert.equal(second.ownsInput(), false);
  errorResult(await clients[1]!.callTool({ name: "android_mouse_move", arguments: {} }), /Required/);
  assert.equal(first.ownsInput(), true); assert.equal(second.ownsInput(), false);
  jsonResult(await clients[1]!.callTool({ name: "android_hid_status" }));
  assert.equal(first.ownsInput(), true); assert.equal(second.ownsInput(), false);
  jsonResult(await clients[1]!.callTool({ name: "android_hid_arm" }));
  assert.equal(first.ownsInput(), false); assert.equal(second.ownsInput(), true);
});

test("official SDK initializes, lists tools and gets a real PNG without opening HID", async (context) => {
  const fixture = await connected(context);
  assert.equal(fixture.client.getServerVersion()?.name, "qdd-android-hid");
  assert.match(fixture.client.getInstructions() ?? "", /Never use ADB input/);
  const listed = await fixture.client.listTools();
  assert.ok(listed.tools.some((tool) => tool.name === "android_screenshot" && tool.annotations?.readOnlyHint));
  assert.ok(listed.tools.some((tool) => tool.name === "android_key_report"));
  assert.ok(listed.tools.every((tool) => tool.inputSchema.type === "object"));

  const devices = jsonResult(await fixture.client.callTool({ name: "android_devices" }));
  assert.equal((devices["android"] as unknown[]).length, 2);
  assert.deepEqual(devices["serialPorts"], [{ path: "FIXTURE_PORT", manufacturer: "Offline fixture" }]);
  const screenshot = CallToolResultSchema.parse(await fixture.client.callTool({ name: "android_screenshot", arguments: { deviceSerial: "USB-TWO" } }));
  const metadata = jsonResult(screenshot);
  assert.equal(metadata["deviceSerial"], "USB-TWO");
  assert.equal(metadata["width"], 100);
  assert.equal(metadata["height"], 200);
  assert.equal(metadata["sha256"], createHash("sha256").update(fixture.adb.latestPng).digest("hex"));
  assert.equal(typeof metadata["frameId"], "string");
  const image = screenshot.content.find((entry) => entry.type === "image");
  assert.ok(image && image.type === "image");
  assert.equal(image.mimeType, "image/png");
  const decoded = Buffer.from(image.data, "base64");
  assert.deepEqual(decoded, fixture.adb.latestPng);
  assert.deepEqual(readPngDimensions(decoded), { width: 100, height: 200 });
  assert.deepEqual(fixture.adb.captures, ["USB-TWO"]);
  assert.deepEqual(fixture.bridge.records, []);
});

test("tool calls arm authenticated HID and preserve raw press/release keyboard and navigation reports", async (context) => {
  const { client, bridge, input } = await connected(context);
  const status = jsonResult(await client.callTool({ name: "android_hid_status" }));
  assert.equal(status["connected"], true);
  assert.equal(status["encrypted"], true);
  assert.equal(status["bonded"], true);
  assert.equal(status["locked"], false);
  assert.equal(status["armed"], false);
  jsonResult(await client.callTool({ name: "android_hid_arm" }));
  for (const [modifier, keycode] of [[2, 4], [0, 0], [1, 5], [0, 0]]) {
    jsonResult(await client.callTool({ name: "android_key_report", arguments: { modifier, keycode } }));
  }
  jsonResult(await client.callTool({ name: "android_home" }));
  jsonResult(await client.callTool({ name: "android_back" }));
  assert.deepEqual(bridge.records.filter(({ op }) => op === "KEY").map(({ args }) => args), [[2, 4], [0, 0], [1, 5], [0, 0]]);
  assert.deepEqual(bridge.records.filter(({ op }) => op === "CONSUMER").map(({ args }) => args), [[0x223], [0], [0x224], [0]]);
  assert.equal(input.state.calibrated, false);
  jsonResult(await client.callTool({ name: "android_hid_pause" }));
  assert.equal(input.state.armed, false);
  assert.deepEqual(bridge.records.slice(-2).map(({ op }) => op), ["RELEASE", "PAUSE"]);
});

test("official SDK receives JPEG bytes with image/jpeg and original dimensions without credentials", async (context) => {
  const fixture = createFixture();
  const screen = new ScreenClient({ endpoint: "http://192.168.1.20:8791", fetch: async (url, options) => {
    assert.equal(String(url), "http://192.168.1.20:8791/frame.jpg");
    assert.equal(options?.headers, undefined);
    return new Response(new Uint8Array(JPEG_FIXTURE), { headers: {
      "Content-Type": "image/jpeg", "X-Device-Id": "11111111-1111-4111-8111-111111111111",
      "X-Frame-Id": "real-jpeg-fixture", "X-Frame-Age-Ms": "0", "X-Captured-At": "2026-10-17T00:00:00Z",
    } });
  } });
  const tools = new AndroidTools(screen, fixture.input);
  const { client } = await connected(context, { ...fixture, tools });
  const result = CallToolResultSchema.parse(await client.callTool({ name: "android_screenshot" }));
  const metadata = jsonResult(result);
  assert.equal(metadata["mimeType"], "image/jpeg");
  assert.equal(metadata["width"], 2); assert.equal(metadata["height"], 3);
  const image = result.content.find((item) => item.type === "image");
  assert.ok(image && image.type === "image");
  assert.equal(image.mimeType, "image/jpeg");
  assert.deepEqual(Buffer.from(image.data, "base64"), JPEG_FIXTURE);
  assert.deepEqual(fixture.bridge.records, []);
});

test("fresh frame and explicit calibration bind normalized tap coordinates to the observed screen", async (context) => {
  const { client, bridge, input } = await connected(context);
  errorResult(await client.callTool({ name: "android_tap", arguments: { x: 20, y: 30 } }), /Required/);
  errorResult(await client.callTool({ name: "android_tap", arguments: { frameId: "missing", x: 20, y: 30 } }), /missing or superseded/);
  assert.equal(bridge.records.length, 0);
  const frame = jsonResult(await client.callTool({ name: "android_screenshot" }));
  jsonResult(await client.callTool({ name: "android_hid_arm" }));
  errorResult(await client.callTool({ name: "android_tap", arguments: { frameId: frame["frameId"], x: 20, y: 30 } }), /explicit calibration/);
  assert.equal(bridge.records.some(({ op }) => op === "MOVE"), false);
  jsonResult(await client.callTool({ name: "android_calibrate_pointer", arguments: { frameId: frame["frameId"], scaleX: 1, scaleY: 1 } }));
  jsonResult(await client.callTool({ name: "android_hid_arm" }));
  jsonResult(await client.callTool({ name: "android_tap", arguments: { frameId: frame["frameId"], x: 1000, y: 1000, coordinateSpace: "normalized1000" } }));
  assert.deepEqual(input.state.pointer, { x: 99, y: 199 });
  const reports = bridge.records.filter(({ op }) => op === "MOVE");
  assert.ok(reports.filter(({ args }) => args[0] === -127 && args[1] === -127).length >= 4);
  assert.ok(reports.some(({ args }) => args[3] === 1));
  assert.deepEqual(reports.at(-1)?.args, [0, 0, 0, 0]);
});

test("superseded or expired frames produce no HID input and geometry changes invalidate calibration", async (context) => {
  const fixture = await connected(context);
  const first = jsonResult(await fixture.client.callTool({ name: "android_screenshot" }));
  const second = jsonResult(await fixture.client.callTool({ name: "android_screenshot" }));
  assert.notEqual(first["frameId"], second["frameId"]);
  errorResult(await fixture.client.callTool({ name: "android_tap", arguments: { frameId: first["frameId"], x: 10, y: 20 } }), /superseded/);
  fixture.clock.now += 30_001;
  errorResult(await fixture.client.callTool({ name: "android_calibrate_pointer", arguments: { frameId: second["frameId"], scaleX: 1, scaleY: 1 } }), /expired/);
  assert.equal(fixture.bridge.records.length, 0);
  const third = jsonResult(await fixture.client.callTool({ name: "android_screenshot" }));
  jsonResult(await fixture.client.callTool({ name: "android_calibrate_pointer", arguments: { frameId: third["frameId"], scaleX: 1, scaleY: 1 } }));
  assert.equal(fixture.input.state.calibrated, true);
  fixture.adb.width = 200;
  fixture.adb.height = 100;
  const rotated = jsonResult(await fixture.client.callTool({ name: "android_screenshot" }));
  assert.equal(rotated["width"], 200);
  assert.equal(rotated["height"], 100);
  assert.equal(fixture.input.state.calibrated, false);
  assert.equal(fixture.input.state.pointer, null);
});

test("queued coordinate actions recheck their session frame before any mouse report", async (context) => {
  for (const name of ["android_pointer_home", "android_tap", "android_swipe"]) {
    for (const invalidation of ["superseded", "expired"]) {
      await context.test(`${name}: ${invalidation} while an earlier key report is blocked`, async (subtest) => {
        const { client, bridge, input, clock } = await connected(subtest);
        const frame = jsonResult(await client.callTool({ name: "android_screenshot" }));
        jsonResult(await client.callTool({ name: "android_calibrate_pointer", arguments: { frameId: frame["frameId"], scaleX: 1, scaleY: 1 } }));
        jsonResult(await client.callTool({ name: "android_hid_arm" }));
        const blocked = bridge.blockNext("KEY");
        subtest.after(() => blocked.release());
        const active = client.callTool({ name: "android_key", arguments: { combo: "enter" } });
        await blocked.started;
        const argumentsByTool = name === "android_pointer_home" ? {} : name === "android_tap"
          ? { x: 10, y: 20 } : { x1: 0, y1: 0, x2: 10, y2: 20, durationMs: 50 };
        const queued = client.callTool({ name, arguments: { frameId: frame["frameId"], ...argumentsByTool } });
        await nextTurn();
        if (invalidation === "superseded") {
          const newer = jsonResult(await client.callTool({ name: "android_screenshot" }));
          assert.notEqual(newer["frameId"], frame["frameId"]);
        } else clock.now += 30_001;
        blocked.release();
        jsonResult(await active);
        const result = await queued;
        const mouseReports = bridge.records.filter(({ op }) => op === "MOVE");
        assert.deepEqual(mouseReports, [], `${name} executed mouse reports from a frame ${invalidation} in the queue`);
        errorResult(result, new RegExp(invalidation));
        assert.equal(input.state.armed, false);
        assert.deepEqual(bridge.records.slice(-2).map(({ op }) => op), ["RELEASE", "PAUSE"]);
      });
    }
  }
});

test("queued coordinates keep their own session frame when another session observes the same phone", async (context) => {
  const fixture = createFixture();
  const a = await connected(context, fixture), b = await connected(context, fixture);
  const frameA = jsonResult(await a.client.callTool({ name: "android_screenshot" }));
  jsonResult(await a.client.callTool({ name: "android_calibrate_pointer", arguments: { frameId: frameA["frameId"], scaleX: 1, scaleY: 1 } }));
  jsonResult(await a.client.callTool({ name: "android_hid_arm" }));
  const blocked = fixture.bridge.blockNext("KEY");
  context.after(() => blocked.release());
  const active = a.client.callTool({ name: "android_key", arguments: { combo: "enter" } });
  await blocked.started;
  const queued = a.client.callTool({ name: "android_tap", arguments: { frameId: frameA["frameId"], x: 10, y: 20 } });
  await nextTurn();
  jsonResult(await b.client.callTool({ name: "android_screenshot" }));
  blocked.release();
  jsonResult(await active);
  jsonResult(await queued);
  assert.deepEqual(fixture.input.state.pointer, { x: 10, y: 20 });
  assert.equal(fixture.input.state.armed, true);
});

test("a shared phone epoch change drops queued coordinates before the blocked input completes", async (context) => {
  const fixture = createFixture();
  const a = await connected(context, fixture), b = await connected(context, fixture);
  const frameA = jsonResult(await a.client.callTool({ name: "android_screenshot", arguments: { deviceSerial: "USB-ONE" } }));
  jsonResult(await a.client.callTool({ name: "android_calibrate_pointer", arguments: { frameId: frameA["frameId"], scaleX: 1, scaleY: 1 } }));
  jsonResult(await a.client.callTool({ name: "android_hid_arm" }));
  const blocked = fixture.bridge.blockNext("KEY");
  context.after(() => blocked.release());
  const active = a.client.callTool({ name: "android_key", arguments: { combo: "enter" } });
  await blocked.started;
  const queued = a.client.callTool({ name: "android_tap", arguments: { frameId: frameA["frameId"], x: 10, y: 20 } });
  await nextTurn();
  jsonResult(await b.client.callTool({ name: "android_screenshot", arguments: { deviceSerial: "USB-TWO" } }));
  errorResult(await active, /cancelled/);
  errorResult(await queued, /cancelled/);
  assert.equal(fixture.bridge.records.some(({ op }) => op === "MOVE"), false);
  assert.equal(fixture.input.state.armed, false);
  assert.equal(fixture.input.state.calibrated, false);
  assert.deepEqual(fixture.bridge.records.slice(-2).map(({ op }) => op), ["RELEASE", "PAUSE"]);
});

test("switching equally sized phones pauses HID and resets calibration automatically", async (context) => {
  const { client, bridge, input } = await connected(context);
  const frame = jsonResult(await client.callTool({ name: "android_screenshot", arguments: { deviceSerial: "USB-ONE" } }));
  jsonResult(await client.callTool({ name: "android_calibrate_pointer", arguments: { frameId: frame["frameId"], scaleX: 1, scaleY: 1 } }));
  jsonResult(await client.callTool({ name: "android_hid_arm" }));
  const next = jsonResult(await client.callTool({ name: "android_screenshot", arguments: { deviceSerial: "USB-TWO" } }));
  assert.equal(next["deviceSerial"], "USB-TWO");
  assert.equal(input.state.calibrated, false);
  assert.equal(input.state.armed, false);
  assert.equal(input.state.pointer, null);
  assert.deepEqual(bridge.records.slice(-2).map(({ op }) => op), ["RELEASE", "PAUSE"]);
  errorResult(await client.callTool({ name: "android_tap", arguments: { frameId: frame["frameId"], x: 10, y: 20 } }), /superseded/);
  assert.equal(bridge.records.some(({ op }) => op === "MOVE"), false);
});

test("two SDK sessions retain their own latest frames and share a capture FIFO", async (context) => {
  const fixture = createFixture();
  const capture = fixture.adb.capture.bind(fixture.adb);
  let active = 0, maximumActive = 0;
  let release!: () => void, started!: () => void;
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  const firstReleased = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  fixture.adb.capture = async (serial) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      if (first) { first = false; started(); await firstReleased; }
      return await capture(serial);
    } finally { active -= 1; }
  };
  const a = await connected(context, fixture), b = await connected(context, fixture);
  const captureA = a.client.callTool({ name: "android_screenshot", arguments: { deviceSerial: "USB-ONE" } });
  await firstStarted;
  const captureB = b.client.callTool({ name: "android_screenshot", arguments: { deviceSerial: "USB-ONE" } });
  await nextTurn();
  assert.equal(active, 1);
  release();
  const frameA = jsonResult(await captureA), frameB = jsonResult(await captureB);
  assert.equal(maximumActive, 1);
  assert.notEqual(frameA["frameId"], frameB["frameId"]);
  assert.deepEqual(fixture.bridge.records, []);
  errorResult(await b.client.callTool({ name: "android_calibrate_pointer", arguments: { frameId: frameA["frameId"], scaleX: 1, scaleY: 1 } }), /superseded/);
  jsonResult(await a.client.callTool({ name: "android_calibrate_pointer", arguments: { frameId: frameA["frameId"], scaleX: 1, scaleY: 1 } }));
  jsonResult(await a.client.callTool({ name: "android_hid_arm" }));
  jsonResult(await a.client.callTool({ name: "android_tap", arguments: { frameId: frameA["frameId"], x: 10, y: 20 } }));
  assert.deepEqual(fixture.input.state.pointer, { x: 10, y: 20 });
  jsonResult(await b.client.callTool({ name: "android_calibrate_pointer", arguments: { frameId: frameB["frameId"], scaleX: 1, scaleY: 1 } }));
  const newA = jsonResult(await a.client.callTool({ name: "android_screenshot" }));
  assert.notEqual(newA["frameId"], frameA["frameId"]);
  errorResult(await a.client.callTool({ name: "android_tap", arguments: { frameId: frameA["frameId"], x: 10, y: 20 } }), /superseded/);
  jsonResult(await b.client.callTool({ name: "android_calibrate_pointer", arguments: { frameId: frameB["frameId"], scaleX: 1, scaleY: 1 } }));
});

test("screenshot-only phone and geometry changes keep the unused ESP bridge closed", async (context) => {
  const fixture = createFixture();
  const a = await connected(context, fixture), b = await connected(context, fixture);
  const old = jsonResult(await a.client.callTool({ name: "android_screenshot", arguments: { deviceSerial: "USB-ONE" } }));
  jsonResult(await b.client.callTool({ name: "android_screenshot", arguments: { deviceSerial: "USB-TWO" } }));
  fixture.adb.width = 200; fixture.adb.height = 100;
  jsonResult(await b.client.callTool({ name: "android_screenshot", arguments: { deviceSerial: "USB-TWO" } }));
  errorResult(await a.client.callTool({ name: "android_calibrate_pointer", arguments: { frameId: old["frameId"], scaleX: 1, scaleY: 1 } }), /superseded/);
  assert.deepEqual(fixture.bridge.records, []);
});

test("a phone change invalidates all session frames and returning to the old phone cannot revive them", async (context) => {
  const fixture = createFixture();
  const direct = jsonResult(await fixture.tools.call("android_screenshot", { deviceSerial: "USB-ONE" }));
  const a = await connected(context, fixture), b = await connected(context, fixture);
  const frameA = jsonResult(await a.client.callTool({ name: "android_screenshot", arguments: { deviceSerial: "USB-ONE" } }));
  jsonResult(await a.client.callTool({ name: "android_calibrate_pointer", arguments: { frameId: frameA["frameId"], scaleX: 1, scaleY: 1 } }));
  jsonResult(await a.client.callTool({ name: "android_hid_arm" }));
  jsonResult(await b.client.callTool({ name: "android_screenshot", arguments: { deviceSerial: "USB-TWO" } }));
  assert.equal(fixture.input.state.armed, false);
  assert.equal(fixture.input.state.calibrated, false);
  assert.deepEqual(fixture.bridge.records.slice(-2).map(({ op }) => op), ["RELEASE", "PAUSE"]);
  errorResult(await a.client.callTool({ name: "android_tap", arguments: { frameId: frameA["frameId"], x: 10, y: 20 } }), /superseded/);
  errorResult(await fixture.tools.call("android_calibrate_pointer", { frameId: direct["frameId"], scaleX: 1, scaleY: 1 }), /superseded/);
  jsonResult(await b.client.callTool({ name: "android_screenshot", arguments: { deviceSerial: "USB-ONE" } }));
  errorResult(await a.client.callTool({ name: "android_calibrate_pointer", arguments: { frameId: frameA["frameId"], scaleX: 1, scaleY: 1 } }), /superseded/);
  assert.equal(fixture.bridge.records.some(({ op }) => op === "MOVE"), false);
});

test("180-degree rotation and resolution changes invalidate other sessions' frames and pause HID", async (context) => {
  const fixture = createFixture();
  const capture = fixture.adb.capture.bind(fixture.adb);
  let rotation: 0 | 1 | 2 | 3 = 0;
  fixture.adb.capture = async (serial) => ({ ...await capture(serial), rotation });
  const a = await connected(context, fixture), b = await connected(context, fixture);
  let frameA = jsonResult(await a.client.callTool({ name: "android_screenshot" }));
  jsonResult(await a.client.callTool({ name: "android_calibrate_pointer", arguments: { frameId: frameA["frameId"], scaleX: 1, scaleY: 1 } }));
  jsonResult(await a.client.callTool({ name: "android_hid_arm" }));
  rotation = 2;
  const rotated = jsonResult(await b.client.callTool({ name: "android_screenshot" }));
  assert.equal(rotated["rotation"], 2);
  assert.equal(fixture.input.state.calibrated, false);
  assert.equal(fixture.input.state.armed, false);
  errorResult(await a.client.callTool({ name: "android_tap", arguments: { frameId: frameA["frameId"], x: 10, y: 20 } }), /superseded/);
  frameA = jsonResult(await a.client.callTool({ name: "android_screenshot" }));
  jsonResult(await a.client.callTool({ name: "android_calibrate_pointer", arguments: { frameId: frameA["frameId"], scaleX: 1, scaleY: 1 } }));
  jsonResult(await a.client.callTool({ name: "android_hid_arm" }));
  fixture.adb.width = 200; fixture.adb.height = 100;
  jsonResult(await b.client.callTool({ name: "android_screenshot" }));
  assert.equal(fixture.input.state.calibrated, false);
  assert.equal(fixture.input.state.armed, false);
  errorResult(await a.client.callTool({ name: "android_tap", arguments: { frameId: frameA["frameId"], x: 10, y: 20 } }), /superseded/);
  assert.equal(fixture.bridge.records.some(({ op }) => op === "MOVE"), false);
});

test("direct calls keep their default context and manual rotation also invalidates every old frame", async (context) => {
  const fixture = createFixture();
  const { client } = await connected(context, fixture);
  const first = jsonResult(await fixture.tools.call("android_screenshot"));
  const second = jsonResult(await fixture.tools.call("android_screenshot"));
  errorResult(await fixture.tools.call("android_calibrate_pointer", { frameId: first["frameId"], scaleX: 1, scaleY: 1 }), /superseded/);
  const session = jsonResult(await client.callTool({ name: "android_screenshot" }));
  jsonResult(await fixture.tools.call("android_calibrate_pointer", { frameId: second["frameId"], scaleX: 1, scaleY: 1 }));
  jsonResult(await client.callTool({ name: "android_calibrate_pointer", arguments: { frameId: session["frameId"], scaleX: 1, scaleY: 1, rotation: 2 } }));
  errorResult(await fixture.tools.call("android_calibrate_pointer", { frameId: second["frameId"], scaleX: 1, scaleY: 1 }), /superseded/);
  errorResult(await client.callTool({ name: "android_pointer_home", arguments: { frameId: session["frameId"] } }), /superseded/);
  assert.equal(fixture.input.state.screen.rotation, 2);
  const current = jsonResult(await client.callTool({ name: "android_screenshot" }));
  jsonResult(await client.callTool({ name: "android_calibrate_pointer", arguments: { frameId: current["frameId"], scaleX: 1, scaleY: 1 } }));
  assert.equal(fixture.input.state.calibrated, true);
  assert.equal(fixture.bridge.records.some(({ op }) => op === "MOVE"), false);
});

test("non-ASCII and invalid tool arguments cannot emit a partial action", async (context) => {
  const { client, bridge } = await connected(context);
  jsonResult(await client.callTool({ name: "android_hid_arm" }));
  const before = bridge.records.length;
  errorResult(await client.callTool({ name: "android_type", arguments: { text: "hello中文" } }), /ASCII/);
  errorResult(await client.callTool({ name: "android_mouse_move", arguments: { dx: 0.5, dy: 0 } }), /integer/);
  errorResult(await client.callTool({ name: "android_mouse_click", arguments: { count: 3 } }), /1 or 2/);
  errorResult(await client.callTool({ name: "android_type", arguments: { text: "hello", surprise: true } }), /Unknown/);
  errorResult(await client.callTool({ name: "android_type", arguments: { text: 123 } }), /string/);
  errorResult(await client.callTool({ name: "unknown_tool" }), /Unknown tool/);
  assert.equal(bridge.records.length, before);
  const frame = jsonResult(await client.callTool({ name: "android_screenshot" }));
  errorResult(await client.callTool({ name: "android_tap", arguments: { frameId: frame["frameId"], x: 100, y: 20 } }), /outside/);
  errorResult(await client.callTool({ name: "android_tap", arguments: { frameId: frame["frameId"], x: 1001, y: 20, coordinateSpace: "normalized1000" } }), /0..1000/);
  errorResult(await client.callTool({ name: "android_tap", arguments: { frameId: frame["frameId"], x: 10, y: 20, coordinateSpace: "other" } }), /coordinateSpace/);
  assert.equal(bridge.records.length, before);
});

test("SDK cancellation stops active typing, cancels queued HID actions and pauses the bridge", async (context) => {
  const { client, bridge, input } = await connected(context);
  jsonResult(await client.callTool({ name: "android_hid_arm" }));
  const blocked = bridge.blockNext("KEY");
  const abort = new AbortController();
  const active = client.callTool({ name: "android_type", arguments: { text: "abcdef" } }, undefined, { signal: abort.signal });
  const rejected = assert.rejects(active);
  await blocked.started;
  const queued = client.callTool({ name: "android_key", arguments: { combo: "enter" } });
  await nextTurn();
  abort.abort(new Error("Test cancellation"));
  await rejected;
  errorResult(await queued, /cancelled/);
  jsonResult(await client.callTool({ name: "android_hid_status" }));
  assert.equal(input.state.armed, false);
  assert.deepEqual(bridge.records.filter(({ op }) => op === "KEY").map(({ args }) => args), [[0, 4]]);
  assert.ok(bridge.records.some(({ op }) => op === "RELEASE"));
  assert.ok(bridge.records.some(({ op }) => op === "PAUSE"));
  blocked.release();
});

test("a stopped projection cancels active and queued keyboard input and invalidates every session frame", async (context) => {
  const fixture = createFixture();
  let projecting = true;
  const png = fixturePng(100, 200);
  const screen = new ScreenClient({ endpoint: "http://192.168.1.20:8791",
    fetch: async () => projecting ? new Response(new Uint8Array(png), { headers: {
      "Content-Type": "image/png", "X-Device-Id": "11111111-1111-4111-8111-111111111111",
      "X-Frame-Id": "mock-projection-frame", "X-Frame-Age-Ms": "0", "X-Captured-At": "2026-10-17T00:00:00Z",
    } }) : new Response("projection stopped", { status: 503 }) });
  const tools = new AndroidTools(screen, fixture.input, { now: () => fixture.clock.now });
  const a = await connected(context, { ...fixture, tools }), b = await connected(context, { ...fixture, tools });
  const frameA = jsonResult(await a.client.callTool({ name: "android_screenshot" }));
  jsonResult(await b.client.callTool({ name: "android_screenshot" }));
  jsonResult(await a.client.callTool({ name: "android_hid_arm" }));
  const blocked = fixture.bridge.blockNext("KEY");
  const active = a.client.callTool({ name: "android_type", arguments: { text: "abcdef" } });
  await blocked.started;
  const queued = a.client.callTool({ name: "android_key", arguments: { combo: "enter" } });
  await nextTurn();
  projecting = false;
  // The continuous source reports actual projection loss independently of an
  // observer's original-image request, as the production entry point does.
  await tools.visualLost();
  errorResult(await b.client.callTool({ name: "android_screenshot" }), /开始投屏/);
  errorResult(await active, /cancelled/);
  errorResult(await queued, /cancelled/);
  assert.equal(fixture.input.state.armed, false);
  assert.deepEqual(fixture.bridge.records.filter(({ op }) => op === "KEY").map(({ args }) => args), [[0, 4]]);
  assert.deepEqual(fixture.bridge.records.slice(-2).map(({ op }) => op), ["RELEASE", "PAUSE"]);
  errorResult(await a.client.callTool({ name: "android_calibrate_pointer", arguments: { frameId: frameA["frameId"], scaleX: 1, scaleY: 1 } }), /superseded/);
  projecting = true;
  jsonResult(await b.client.callTool({ name: "android_screenshot" }));
  errorResult(await a.client.callTool({ name: "android_pointer_home", arguments: { frameId: frameA["frameId"] } }), /superseded/);
  blocked.release();
});

test("cold screenshot failures do not open HID and used bridges stop on stale or disconnected screens", async () => {
  for (const error of [new ScreenError("SCREEN_NOT_PROJECTING", "开始投屏"),
    new ScreenError("SCREEN_STALE_FRAME", "画面已过期"), new ScreenError("SCREEN_UNREACHABLE", "连接已断开")]) {
    const fixture = createFixture();
    fixture.adb.capture = async () => { throw error; };
    errorResult(await fixture.tools.call("android_screenshot"), new RegExp(error.message));
    assert.deepEqual(fixture.bridge.records, []);
    jsonResult(await fixture.tools.call("android_hid_arm"));
    errorResult(await fixture.tools.call("android_screenshot"), new RegExp(error.message));
    assert.equal(fixture.input.state.armed, false);
    assert.deepEqual(fixture.bridge.records.slice(-2).map(({ op }) => op), ["RELEASE", "PAUSE"]);
  }
});

test("PC-first STATUS completes through shared projection loss without claiming or releasing input", async () => {
  const fixture = createFixture();
  const blocked = fixture.bridge.blockNext("STATUS");
  const observed = fixture.tools.call("android_hid_status");
  await blocked.started;
  const lost = fixture.tools.visualLost();
  blocked.release();
  assert.equal(jsonResult(await observed)["v"], 1);
  await lost;
  assert.deepEqual(fixture.bridge.records.map(({ op }) => op), ["STATUS"]);
  assert.equal(fixture.input.state.armed, false);
});

test("cancelling a read-only STATUS fork preserves another caller's held input and control round", async () => {
  const fixture = createFixture(), observer = fixture.tools.fork();
  jsonResult(await fixture.tools.call("android_hid_arm"));
  jsonResult(await fixture.tools.call("android_key_report", { modifier: 0, keycode: 4 }));
  const request = fixture.bridge.request.bind(fixture.bridge);
  let started!: () => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  fixture.bridge.request = async (op, args = [], signal) => {
    if (op !== "STATUS") return request(op, args, signal);
    fixture.bridge.records.push({ op, args }); started();
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      if (signal?.aborted) reject(signal.reason);
    });
  };
  const abort = new AbortController(), epoch = fixture.input.controlEpoch;
  const pending = observer.call("android_hid_status", {}, abort.signal);
  await reading;
  const before = fixture.bridge.records.length;
  abort.abort(new Error("Observer cancelled inspection"));
  errorResult(await pending, /Observer cancelled inspection/);
  assert.equal(fixture.input.state.armed, true);
  assert.equal(fixture.input.controlEpoch, epoch);
  assert.equal(fixture.bridge.records.length, before, "The read-only caller must not release or pause the owner's held key.");
  jsonResult(await fixture.tools.call("android_key_report", { modifier: 0, keycode: 0 }));
});

test("a read-only tools fork's failed original capture preserves another caller's input and chosen frame", async () => {
  const fixture = createFixture();
  const observer = fixture.tools.fork();
  const chosen = jsonResult(await fixture.tools.call("android_screenshot"));
  jsonResult(await fixture.tools.call("android_hid_arm"));
  jsonResult(await fixture.tools.call("android_key_report", { modifier: 2, keycode: 4 }));
  const epoch = fixture.input.controlEpoch, records = fixture.bridge.records.length;
  fixture.adb.capture = async () => { throw new ScreenError("SCREEN_NOT_PROJECTING", "Original capture returned HTTP 503."); };
  errorResult(await observer.call("android_screenshot"), /HTTP 503/);
  assert.equal(fixture.input.state.armed, true);
  assert.equal(fixture.input.controlEpoch, epoch);
  assert.equal(fixture.bridge.records.length, records, "Read-only failure must preserve the other caller's held key.");
  jsonResult(await fixture.tools.call("android_calibrate_pointer", { frameId: chosen["frameId"], scaleX: 1, scaleY: 1 }));
});

test("continuous video preserves a chosen MCP snapshot until geometry changes", async () => {
  const fixture = createFixture();
  const chosen = jsonResult(await fixture.tools.call("android_screenshot"));
  const capture = { serial: String(chosen["deviceSerial"]), width: 100, height: 200,
    png: fixture.adb.latestPng, capturedAt: "2026-10-17T04:00:00.000Z", rotation: 0 as const };
  await fixture.tools.observeLive(capture);
  jsonResult(await fixture.tools.call("android_calibrate_pointer", { frameId: chosen["frameId"], scaleX: 1, scaleY: 1 }));
  jsonResult(await fixture.tools.call("android_hid_arm"));
  await fixture.tools.observeLive({ ...capture, rotation: 2 });
  assert.equal(fixture.input.state.armed, false);
  assert.equal(fixture.input.state.calibrated, false);
  errorResult(await fixture.tools.call("android_calibrate_pointer", { frameId: chosen["frameId"], scaleX: 1, scaleY: 1 }), /missing or superseded/u);
});

test("reading an operator live frame leaves every caller's chosen MCP snapshot intact", async () => {
  const fixture = createFixture();
  const second = fixture.tools.fork();
  const firstFrame = jsonResult(await fixture.tools.call("android_screenshot"));
  const secondFrame = jsonResult(await second.call("android_screenshot"));
  const capture = await fixture.tools.readLiveFrame();
  assert.equal(capture.serial, firstFrame["deviceSerial"]);
  jsonResult(await fixture.tools.call("android_calibrate_pointer", { frameId: firstFrame["frameId"], scaleX: 1, scaleY: 1 }));
  jsonResult(await second.call("android_calibrate_pointer", { frameId: secondFrame["frameId"], scaleX: 1, scaleY: 1 }));
  fixture.adb.width = 200; fixture.adb.height = 100;
  await fixture.tools.readLiveFrame();
  errorResult(await fixture.tools.call("android_calibrate_pointer", { frameId: firstFrame["frameId"], scaleX: 1, scaleY: 1 }), /missing or superseded/u);
  errorResult(await second.call("android_calibrate_pointer", { frameId: secondFrame["frameId"], scaleX: 1, scaleY: 1 }), /missing or superseded/u);
});

test("live visual loss invalidates every caller snapshot and stops existing held input", async () => {
  const fixture = createFixture(); const second = fixture.tools.fork();
  const one = jsonResult(await fixture.tools.call("android_screenshot"));
  const two = jsonResult(await second.call("android_screenshot"));
  jsonResult(await fixture.tools.call("android_hid_arm"));
  jsonResult(await fixture.tools.call("android_key_report", { modifier: 2, keycode: 4 }));
  await fixture.tools.visualLost();
  assert.equal(fixture.input.state.armed, false);
  assert.deepEqual(fixture.bridge.records.slice(-2).map(({ op }) => op), ["RELEASE", "PAUSE"]);
  errorResult(await fixture.tools.call("android_calibrate_pointer", { frameId: one["frameId"], scaleX: 1, scaleY: 1 }), /missing or superseded/u);
  errorResult(await second.call("android_calibrate_pointer", { frameId: two["frameId"], scaleX: 1, scaleY: 1 }), /missing or superseded/u);
});

test("official SDK stdio client communicates with a mock-only child process", async (context) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/stdio-server.js", import.meta.url))],
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (data: Buffer) => { stderr += data.toString("utf8"); });
  const client = new Client({ name: "offline-stdio-tests", version: "1.0.0" });
  context.after(async () => { await client.close(); });
  await client.connect(transport as unknown as Transport);
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === "android_screenshot"));
  const screenshot = CallToolResultSchema.parse(await client.callTool({ name: "android_screenshot" }));
  jsonResult(screenshot);
  assert.ok(screenshot.content.some((entry) => entry.type === "image" && entry.mimeType === "image/png"));
  jsonResult(await client.callTool({ name: "android_hid_arm" }));
  jsonResult(await client.callTool({ name: "android_key_report", arguments: { modifier: 0, keycode: 4 } }));
  jsonResult(await client.callTool({ name: "android_key_report", arguments: { modifier: 0, keycode: 0 } }));
  const status = jsonResult(await client.callTool({ name: "android_hid_status" }));
  assert.equal(status["fixture"], true);
  const reports = status["reports"] as { op: string; args: number[] }[];
  assert.deepEqual(reports.filter(({ op }) => op === "KEY").map(({ args }) => args), [[0, 4], [0, 0]]);
  assert.equal(stderr, "");
});

function controlFixture(actionFrameTimeoutMs = 100) {
  const fixture = createFixture();
  const capture = fixture.adb.capture.bind(fixture.adb);
  let frame = 0;
  fixture.adb.capture = async (serial) => ({ ...await capture(serial),
    sourceFrameId: `source-${++frame}`, frameAgeMs: 0,
  });
  const tools = new AndroidTools(fixture.adb, fixture.input, {
    now: () => fixture.clock.now, actionFrameTimeoutMs,
  });
  return { ...fixture, tools };
}

function calibrationFixture(actionFrameTimeoutMs = 100) {
  const fixture = controlFixture(actionFrameTimeoutMs);
  const capture = fixture.adb.capture.bind(fixture.adb);
  let position = 0;
  fixture.adb.capture = async (serial) => {
    const frame = await capture(serial), png = PNG.sync.read(frame.png);
    // Distinct rendered cursor pixels are part of this visible-cursor fixture.
    png.data[((++position % frame.height) * frame.width + 50) * 4] = 255;
    return { ...frame, png: PNG.sync.write(png) };
  };
  const tools = new AndroidTools(fixture.adb, fixture.input, {
    now: () => fixture.clock.now, actionFrameTimeoutMs, calibrationSettleMs: 0,
  });
  return { ...fixture, tools };
}

type TargetRenderer = NonNullable<AndroidToolsOptions["targetPreviewRenderer"]>;
const fakeTargetRenderer: TargetRenderer = async (bytes, _mime, width, height, x, y, signal) => {
  signal?.throwIfAborted();
  return renderTargetPreviewPixels(bytes, _mime, width, height, x, y);
};
function targetPreviewFixture(targetPreviewRenderer: TargetRenderer = fakeTargetRenderer) {
  const fixture = controlFixture();
  return { ...fixture, tools: new AndroidTools(fixture.adb, fixture.input, {
    now: () => fixture.clock.now, actionFrameTimeoutMs: 100, targetPreviewRenderer,
  }) };
}

test("official SDK target preview returns labeled original and zoom images without ARM or calibration", async (context) => {
  const fixture = await connected(context, targetPreviewFixture());
  const spec = (await fixture.client.listTools()).tools.find(({ name }) => name === "android_preview_tap");
  assert.equal(spec?.annotations?.readOnlyHint, true);
  assert.equal(spec?.annotations?.destructiveHint, false);
  assert.match(fixture.client.getInstructions() ?? "", /SIMULATED TARGET/);
  const before = jsonResult(await fixture.client.callTool({ name: "android_screenshot" }));
  const response = CallToolResultSchema.parse(await fixture.client.callTool({ name: "android_preview_tap", arguments: {
    frameId: before["frameId"], x: 90, y: 180,
  } }));
  const metadata = jsonResult(response), images = response.content.filter((item) => item.type === "image");
  assert.equal(images.length, 2);
  assert.deepEqual(images.map(({ mimeType }) => mimeType), ["image/png", "image/png"]);
  assert.deepEqual(readPngDimensions(Buffer.from(images[0]!.data, "base64")), { width: 254, height: 252 });
  assert.deepEqual(readPngDimensions(Buffer.from(images[1]!.data, "base64")), { width: 254, height: 372 });
  assert.notEqual(metadata["frameId"], before["frameId"]);
  assert.notEqual(metadata["sourceFrameId"], before["sourceFrameId"]);
  assert.equal(metadata["simulatedTarget"], true);
  assert.equal(metadata["realMouseMoved"], false); assert.equal(metadata["realClickSent"], false);
  assert.deepEqual(metadata["target"], { x: 90, y: 180, coordinateSpace: "pixels" });
  assert.deepEqual(metadata["annotation"], { coordinateSpace: "originalPhonePixels", label: "PHONE PX: X=90 Y=180",
    original: { width: 254, height: 252, sourceRect: { x: 0, y: 0, width: 100, height: 200 },
      legend: { x: 0, y: 200, width: 254, height: 52 } },
    zoom: { width: 254, height: 372, sourceRect: { x: 0, y: 0, width: 200, height: 320 },
      legend: { x: 0, y: 320, width: 254, height: 52 } } });
  assert.deepEqual(metadata["crop"], { x: 0, y: 40, width: 100, height: 160, scale: 2 });
  assert.deepEqual(metadata["zoomTarget"], { x: 180, y: 280, coordinateSpace: "zoomPixels" });
  assert.equal(metadata["sourceMimeType"], "image/png"); assert.equal(metadata["mimeType"], "image/png");
  const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  assert.equal(metadata["sourceSha256"], digest(fixture.adb.latestPng));
  assert.equal(metadata["sha256"], metadata["sourceSha256"]);
  assert.equal(metadata["annotatedImageSha256"], digest(Buffer.from(images[0]!.data, "base64")));
  assert.notEqual(metadata["annotatedImageSha256"], metadata["sourceSha256"]);
  assert.equal(metadata["zoomImageSha256"], digest(Buffer.from(images[1]!.data, "base64")));
  assert.deepEqual(metadata["tapArguments"], { action: "tap", frameId: metadata["frameId"], x: 90, y: 180, coordinateSpace: "pixels" });
  assert.deepEqual(response.structuredContent, metadata);
  assert.equal(fixture.input.state.armed, false); assert.equal(fixture.input.state.calibrated, false);
  assert.deepEqual(fixture.bridge.records, []);
  errorResult(await fixture.client.callTool({ name: "android_preview_tap", arguments: { frameId: before["frameId"], x: 90, y: 180 } }), /superseded/);
  errorResult(await fixture.client.callTool({ name: "android_control", arguments: metadata["tapArguments"] as Record<string, unknown> }), /explicit calibration/);
  assert.deepEqual(fixture.bridge.records, []);
});

test("target preview and tap share normalized1000 pixel conversion including display edges", async (context) => {
  for (const [x, y, expected] of [[0, 0, [0, 0]], [500, 500, [50, 100]], [1000, 1000, [99, 199]]] as const) {
    await context.test(`${x},${y}`, async () => {
      const fixture = targetPreviewFixture(), frame = jsonResult(await fixture.tools.call("android_screenshot"));
      const result = jsonResult(await fixture.tools.call("android_preview_tap", { frameId: frame["frameId"], x, y, coordinateSpace: "normalized1000" }));
      assert.deepEqual(result["target"], { x: expected[0], y: expected[1], coordinateSpace: "pixels" });
      assert.equal((result["annotation"] as { label: string }).label, `PHONE PX: X=${expected[0]} Y=${expected[1]}`);
      assert.deepEqual(result["tapArguments"], { action: "tap", frameId: result["frameId"], x: expected[0], y: expected[1], coordinateSpace: "pixels" });
      assert.deepEqual(fixture.bridge.records, []);
    });
  }
});

test("target preview production renderer returns actual PNG overlays while retaining the real source frame", async () => {
  const fixture = controlFixture(), frame = jsonResult(await fixture.tools.call("android_screenshot"));
  const response = await fixture.tools.call("android_preview_tap", { frameId: frame["frameId"], x: 50, y: 100 });
  const result = jsonResult(response), images = response.content.filter((item) => item.type === "image");
  assert.equal(images.length, 2);
  assert.deepEqual(readPngDimensions(Buffer.from(images[0]!.data, "base64")), { width: 254, height: 252 });
  assert.notEqual(result["sourceSha256"], result["annotatedImageSha256"]);
  assert.equal(result["sourceSha256"], createHash("sha256").update(fixture.adb.latestPng).digest("hex"));
  assert.equal(result["simulatedTarget"], true); assert.equal(result["realClickSent"], false);
  assert.deepEqual(fixture.bridge.records, []);
  const next = jsonResult(await fixture.tools.call("android_control", { action: "wait", waitMs: 0, frameId: result["frameId"] }));
  assert.equal(next["observedAfterAction"], true); assert.deepEqual(fixture.bridge.records, []);
});

test("target preview rejects missing, expired, malformed and out-of-bounds coordinates before capture or HID", async () => {
  const fixture = targetPreviewFixture(), frame = jsonResult(await fixture.tools.call("android_screenshot"));
  for (const args of [
    { x: -1, y: 10 }, { x: 100, y: 10 }, { x: 1, y: 200 }, { x: 0.5, y: 10 },
    { x: 10, y: 10, coordinateSpace: "zoomPixels" }, { x: 1001, y: 1, coordinateSpace: "normalized1000" },
  ]) errorResult(await fixture.tools.call("android_preview_tap", { frameId: frame["frameId"], ...args }));
  errorResult(await fixture.tools.call("android_preview_tap", { x: 1, y: 2 }), /Required/);
  fixture.clock.now += 30_001;
  errorResult(await fixture.tools.call("android_preview_tap", { frameId: frame["frameId"], x: 1, y: 2 }), /expired/);
  assert.equal(fixture.adb.captures.length, 1); assert.deepEqual(fixture.bridge.records, []);
});

test("read-only target preview preserves another caller's input owner on success and rendering failure", async () => {
  for (const failed of [false, true]) {
    const fixture = targetPreviewFixture(failed ? async () => { throw new Error("Renderer rejected malformed image"); } : fakeTargetRenderer);
    const observer = fixture.tools.fork(), frame = jsonResult(await observer.call("android_screenshot"));
    jsonResult(await fixture.tools.call("android_hid_arm"));
    jsonResult(await fixture.tools.call("android_key_report", { modifier: 2, keycode: 4 }));
    const count = fixture.bridge.records.length;
    const result = await observer.call("android_preview_tap", { frameId: frame["frameId"], x: 10, y: 20 });
    if (failed) errorResult(result, /Renderer rejected/); else jsonResult(result);
    assert.equal(fixture.tools.ownsInput, true); assert.equal(observer.ownsInput, false);
    assert.equal(fixture.input.state.armed, true); assert.equal(fixture.bridge.records.length, count);
    if (failed) jsonResult(await observer.call("android_calibrate_pointer", { frameId: frame["frameId"], scaleX: 1, scaleY: 1 }));
  }
});

test("target preview cancellation cannot pause another owner or publish an unrendered frame", async () => {
  let started!: () => void, release!: () => void;
  const rendering = new Promise<void>((resolve) => { started = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const fixture = targetPreviewFixture(async (...args) => { started(); await wait; return fakeTargetRenderer(...args); });
  const observer = fixture.tools.fork(), frame = jsonResult(await observer.call("android_screenshot"));
  jsonResult(await fixture.tools.call("android_hid_arm"));
  const abort = new AbortController();
  const pending = observer.call("android_preview_tap", { frameId: frame["frameId"], x: 10, y: 20 }, abort.signal);
  await rendering;
  const count = fixture.bridge.records.length;
  abort.abort(new Error("Cancel target preview")); release();
  errorResult(await pending, /Cancel target preview/);
  assert.equal(fixture.tools.ownsInput, true); assert.equal(observer.ownsInput, false);
  assert.equal(fixture.input.state.armed, true); assert.equal(fixture.bridge.records.length, count);
  jsonResult(await observer.call("android_calibrate_pointer", { frameId: frame["frameId"], scaleX: 1, scaleY: 1 }));
});

test("target preview rendering cannot overwrite a newer caller screenshot", async () => {
  let started!: () => void, release!: () => void;
  const rendering = new Promise<void>((resolve) => { started = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const fixture = targetPreviewFixture(async (...args) => { started(); await wait; return fakeTargetRenderer(...args); });
  const frame = jsonResult(await fixture.tools.call("android_screenshot"));
  const pending = fixture.tools.call("android_preview_tap", { frameId: frame["frameId"], x: 10, y: 20 });
  await rendering;
  const latest = jsonResult(await fixture.tools.call("android_screenshot")); release();
  errorResult(await pending, /superseded/);
  jsonResult(await fixture.tools.call("android_calibrate_pointer", { frameId: latest["frameId"], scaleX: 1, scaleY: 1 }));
  assert.deepEqual(fixture.bridge.records, []);
});

test("target preview invalidates rotated or changed physical geometry while preserving ordinary preview failures", async () => {
  const fixture = targetPreviewFixture(), frame = jsonResult(await fixture.tools.call("android_screenshot"));
  jsonResult(await fixture.tools.call("android_calibrate_pointer", { frameId: frame["frameId"], scaleX: 1, scaleY: 1 }));
  jsonResult(await fixture.tools.call("android_hid_arm"));
  const capture = fixture.adb.capture.bind(fixture.adb);
  fixture.adb.capture = async (serial) => ({ ...await capture(serial), rotation: 2 });
  errorResult(await fixture.tools.call("android_preview_tap", { frameId: frame["frameId"], x: 10, y: 20 }), /superseded|geometry/);
  assert.equal(fixture.input.state.calibrated, false); assert.equal(fixture.input.state.armed, false);
  assert.deepEqual(fixture.bridge.records.slice(-2).map(({ op }) => op), ["RELEASE", "PAUSE"]);
  assert.equal(fixture.bridge.records.some(({ op }) => op === "MOVE"), false);
});

test("target preview rejects a scaled image without implicitly opening or stopping input", async () => {
  const fixture = targetPreviewFixture(), frame = jsonResult(await fixture.tools.call("android_screenshot"));
  const capture = fixture.adb.capture.bind(fixture.adb);
  fixture.adb.capture = async (serial) => ({ ...await capture(serial), previewProfile: "fast" as const });
  errorResult(await fixture.tools.call("android_preview_tap", { frameId: frame["frameId"], x: 10, y: 20 }), /original-resolution/);
  assert.deepEqual(fixture.bridge.records, []);
});

test("target preview accounts for rendering age and rejects stale output without stopping the owner", async () => {
  const fixture = targetPreviewFixture(), observer = fixture.tools.fork();
  const frame = jsonResult(await observer.call("android_screenshot"));
  jsonResult(await fixture.tools.call("android_hid_arm"));
  const capture = fixture.adb.capture.bind(fixture.adb);
  fixture.adb.capture = async (serial) => ({ ...await capture(serial), frameAgeMs: 3001 });
  const count = fixture.bridge.records.length;
  errorResult(await observer.call("android_preview_tap", { frameId: frame["frameId"], x: 10, y: 20 }), /stale during rendering/);
  assert.equal(fixture.input.state.armed, true); assert.equal(fixture.tools.ownsInput, true);
  assert.equal(fixture.bridge.records.length, count);
});

async function calibrationProbe(fixture: ReturnType<typeof calibrationFixture>) {
  const frame = jsonResult(await fixture.tools.call("android_screenshot"));
  return jsonResult(await fixture.tools.call("android_pointer_calibration", { phase: "probe", frameId: frame["frameId"] }));
}
const finishCalibration = (probe: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  phase: "finish", probeId: probe["probeId"], frameId: probe["frameId"], startX: 72, startY: 140, endX: 24, endY: 108, ...extra,
});

function actualPointerFixture(change: (state: PointerCalibrationState, moves: number, reads: number) => PointerCalibrationState = (state) => state) {
  const fixture = controlFixture(); let reads = 0;
  const tools = new AndroidTools(fixture.adb, fixture.input, {
    now: () => fixture.clock.now, actionFrameTimeoutMs: 100, calibrationSettleMs: 0,
  });
  Object.assign(fixture.adb, { async getPointerCalibration(): Promise<PointerCalibrationState> {
    const moves = fixture.bridge.records.filter(({ op }) => op === "MOVE").length;
    const point = moves < 2 ? { x: 72, y: 140, sequence: moves + 1, ageMs: 0 } : { x: 24, y: 108, sequence: 3, ageMs: 0 };
    return change({ active: true, deviceId: "USB-ONE", sessionId: "11111111-1111-4111-8111-111111111111",
      width: 100, height: 200, rotation: 0, point }, moves, ++reads);
  } });
  return { ...fixture, tools };
}

test("automatic calibration measures actual mouse events with no visible system cursor and sends no click", async () => {
  const fixture = actualPointerFixture(), frame = jsonResult(await fixture.tools.call("android_screenshot"));
  const result = jsonResult(await fixture.tools.call("android_pointer_calibration", { phase: "auto", frameId: frame["frameId"] }));
  assert.equal(result["measurementSource"], "android-mouse-events"); assert.equal(result["calibrated"], true);
  assert.equal(result["scaleX"], 2); assert.equal(result["scaleY"], 3); assert.equal(result["realClickSent"], false);
  assert.equal(result["sha256"], frame["sha256"], "Actual-event calibration works even when system-cursor screenshots are byte-identical.");
  assert.deepEqual(fixture.bridge.records.filter(({ op }) => op === "MOVE").map(({ args }) => args), [[1, 1, 0, 0], [-96, -96, 0, 0]]);
  assert.equal(fixture.input.state.calibrated, true);
});

test("automatic calibration requires a foreground calibration page and matching geometry before HID", async (context) => {
  for (const [label, change] of [
    ["inactive", (state: PointerCalibrationState) => ({ ...state, active: false, sessionId: null, point: null })],
    ["geometry", (state: PointerCalibrationState) => ({ ...state, width: 101 })],
    ["other phone", (state: PointerCalibrationState) => ({ ...state, deviceId: "different-phone" })],
  ] as const) await context.test(label, async () => {
    const fixture = actualPointerFixture(change), frame = jsonResult(await fixture.tools.call("android_screenshot"));
    errorResult(await fixture.tools.call("android_pointer_calibration", { phase: "auto", frameId: frame["frameId"] }), /foreground|geometry/);
    assert.deepEqual(fixture.bridge.records, []);
  });
});

test("automatic calibration rejects missing endpoint support and irrelevant direction before HID", async () => {
  const fixture = calibrationFixture(), frame = jsonResult(await fixture.tools.call("android_screenshot"));
  errorResult(await fixture.tools.call("android_pointer_calibration", { phase: "auto", frameId: frame["frameId"] }), /Update|open/);
  errorResult(await fixture.tools.call("android_pointer_calibration", { phase: "auto", frameId: frame["frameId"], direction: "up-left" }), /Unexpected/);
  assert.deepEqual(fixture.bridge.records, []);
});

test("automatic calibration rejects stale events, clipped movement and lost focus without replacing scales", async (context) => {
  for (const [label, change] of [
    ["stale", (state: PointerCalibrationState, moves: number) => moves < 1 ? state : ({ ...state, point: { ...state.point!, ageMs: 1001 } })],
    ["clipped", (state: PointerCalibrationState, moves: number) => moves < 2 ? state : ({ ...state, point: { ...state.point!, x: 0 } })],
    ["lost focus", (state: PointerCalibrationState, moves: number) => moves < 2 ? state : ({ ...state, active: false, point: null, sessionId: null })],
    ["new page", (state: PointerCalibrationState, moves: number) => moves < 2 ? state : ({ ...state, sessionId: "22222222-2222-4222-8222-222222222222" })],
  ] as const) await context.test(label, async () => {
    const fixture = actualPointerFixture(change); fixture.input.setCalibration(1.25, 1.5);
    const frame = jsonResult(await fixture.tools.call("android_screenshot"));
    errorResult(await fixture.tools.call("android_pointer_calibration", { phase: "auto", frameId: frame["frameId"] }), /fresh|clipped|foreground|geometry/);
    assert.equal(fixture.input.state.scaleX, 1.25); assert.equal(fixture.input.state.scaleY, 1.5);
    assert.equal(fixture.input.state.armed, false);
    assert.ok(fixture.bridge.records.filter(({ op }) => op === "MOVE").every(({ args }) => args[3] === 0));
  });
});

test("automatic calibration rejects a changed pointer during result image acquisition", async () => {
  const fixture = actualPointerFixture(); fixture.input.setCalibration(1.25, 1.5);
  const frame = jsonResult(await fixture.tools.call("android_screenshot"));
  const capture = fixture.adb.capture.bind(fixture.adb);
  fixture.adb.capture = async (serial) => {
    const value = await capture(serial);
    if (fixture.bridge.records.filter(({ op }) => op === "MOVE").length === 2) {
      Object.assign(fixture.adb, { getPointerCalibration: async () => ({ active: true, deviceId: "USB-ONE",
        sessionId: "11111111-1111-4111-8111-111111111111", width: 100, height: 200, rotation: 0,
        point: { x: 25, y: 108, sequence: 4, ageMs: 0 } }) });
    }
    return value;
  };
  errorResult(await fixture.tools.call("android_pointer_calibration", { phase: "auto", frameId: frame["frameId"] }), /changed|stale/);
  assert.equal(fixture.input.state.scaleX, 1.25); assert.equal(fixture.input.state.armed, false);
});

test("automatic calibration settles before the probe and never moves after focus loss or cancellation during that rest", async (context) => {
  for (const kind of ["focus", "cancel"] as const) await context.test(kind, async () => {
    const fixture = actualPointerFixture(); fixture.input.setCalibration(1.25, 1.5);
    const frame = jsonResult(await fixture.tools.call("android_screenshot")), cancel = new AbortController();
    let warmupAt = 0;
    Object.assign(fixture.adb, { async getPointerCalibration(): Promise<PointerCalibrationState> {
      const moves = fixture.bridge.records.filter(({ op }) => op === "MOVE").length;
      if (moves === 1 && !warmupAt) warmupAt = performance.now();
      const focused = kind !== "focus" || warmupAt === 0 || performance.now() - warmupAt < 200;
      return { active: focused, deviceId: "USB-ONE", sessionId: focused ? "11111111-1111-4111-8111-111111111111" : null,
        width: 100, height: 200, rotation: 0, point: focused ? { x: 72, y: 140, sequence: moves + 1, ageMs: 0 } : null };
    } });
    if (kind === "cancel") setTimeout(() => cancel.abort(new Error("Cancel automatic rest")), 200);
    errorResult(await fixture.tools.call("android_pointer_calibration", { phase: "auto", frameId: frame["frameId"] }, cancel.signal), /foreground|Cancel|cancelled|aborted/);
    assert.equal(fixture.bridge.records.filter(({ op }) => op === "MOVE").length, 1);
    assert.equal(fixture.input.state.scaleX, 1.25); assert.equal(fixture.input.state.armed, false);
  });
});

test("identical calibration images return not measurable with both images and no finish ticket", async () => {
  const fixture = controlFixture(), frame = jsonResult(await fixture.tools.call("android_screenshot"));
  const response = await fixture.tools.call("android_pointer_calibration", { phase: "probe", frameId: frame["frameId"] });
  const result = jsonResult(response);
  assert.equal(result["measurable"], false); assert.equal(result["reason"], "identical_images");
  assert.equal(result["probeId"], undefined); assert.equal(response.content.filter(({ type }) => type === "image").length, 2);
  assert.equal(fixture.input.state.armed, false); assert.equal(fixture.input.state.calibrated, false);
  errorResult(await fixture.tools.call("android_pointer_calibration", finishCalibration(result)), /probeId|pending/);
});

test("an old automatic calibration resting round cannot pause a newer input owner", async () => {
  const fixture = actualPointerFixture(), frame = jsonResult(await fixture.tools.call("android_screenshot"));
  const probing = fixture.tools.call("android_pointer_calibration", { phase: "auto", frameId: frame["frameId"] });
  for (let attempt = 0; attempt < 100 && !fixture.bridge.records.some(({ op }) => op === "MOVE"); attempt++) await nextTurn();
  assert.equal(fixture.bridge.records.filter(({ op }) => op === "MOVE").length, 1);
  const newer = fixture.tools.fork(); jsonResult(await newer.call("android_hid_arm"));
  const count = fixture.bridge.records.length;
  errorResult(await probing, /changed/);
  assert.equal(fixture.input.state.armed, true); assert.equal(newer.ownsInput, true);
  assert.equal(fixture.bridge.records.length, count, "Old cleanup must not send PAUSE into the newer round.");
});

test("pointer calibration returns ordered original images through the official SDK and finishes without more HID", async (context) => {
  const fixture = await connected(context, calibrationFixture());
  const frame = jsonResult(await fixture.client.callTool({ name: "android_screenshot" }));
  const response = CallToolResultSchema.parse(await fixture.client.callTool({ name: "android_pointer_calibration", arguments: {
    phase: "probe", frameId: frame["frameId"],
  } }));
  const probe = jsonResult(response), images = response.content.filter((item) => item.type === "image");
  assert.equal(images.length, 2); assert.deepEqual(probe["imageOrder"], ["before", "after"]);
  assert.notEqual((probe["before"] as Record<string, unknown>)["sourceFrameId"], probe["sourceFrameId"]);
  assert.deepEqual(response.structuredContent, probe);
  for (const image of images) {
    assert.equal(image.mimeType, "image/png");
    assert.deepEqual(readPngDimensions(Buffer.from(image.data, "base64")), { width: 100, height: 200 });
  }
  assert.deepEqual(fixture.bridge.records.map(({ op }) => op), ["RELEASE", "PING", "ARM", "MOVE", "MOVE"]);
  assert.deepEqual(fixture.bridge.records.filter(({ op }) => op === "MOVE").map(({ args }) => args), [[1, 1, 0, 0], [-96, -96, 0, 0]]);
  const beforeFinish = fixture.bridge.records.length;
  const finished = jsonResult(await fixture.client.callTool({ name: "android_pointer_calibration", arguments: finishCalibration(probe) }));
  assert.equal(finished["scaleX"], 2); assert.equal(finished["scaleY"], 3);
  assert.equal(fixture.input.state.calibrated, true); assert.equal(fixture.input.state.pointer, null);
  assert.equal(fixture.bridge.records.length, beforeFinish);
  errorResult(await fixture.client.callTool({ name: "android_pointer_calibration", arguments: finishCalibration(probe) }), /pending calibration probe/);
});

test("pointer calibration validates frame, phase arguments and counts before opening HID", async () => {
  const fixture = calibrationFixture();
  const frame = jsonResult(await fixture.tools.call("android_screenshot"));
  for (const args of [{ counts: 15 }, { counts: 128 }, { counts: 1.5 }, { direction: "left" }, { startX: 1 }]) {
    errorResult(await fixture.tools.call("android_pointer_calibration", { phase: "probe", frameId: frame["frameId"], ...args }));
  }
  fixture.clock.now += 30001;
  errorResult(await fixture.tools.call("android_pointer_calibration", { phase: "probe", frameId: frame["frameId"] }), /expired/);
  errorResult(await fixture.tools.call("android_pointer_calibration", { phase: "probe", frameId: "missing" }));
  assert.deepEqual(fixture.bridge.records, []);
});

test("pointer calibration cannot arm through physical stop or accept a scaled preview as its original image", async () => {
  const locked = calibrationFixture(); locked.bridge.status.locked = true;
  const frame = jsonResult(await locked.tools.call("android_screenshot"));
  errorResult(await locked.tools.call("android_pointer_calibration", { phase: "probe", frameId: frame["frameId"] }), /locked/);
  assert.ok(!locked.bridge.records.some(({ op }) => op === "MOVE"));
  const fixture = calibrationFixture(), capture = fixture.adb.capture.bind(fixture.adb);
  fixture.adb.capture = async (serial) => ({ ...await capture(serial), previewProfile: "fast" as const, deviceWidth: 200, deviceHeight: 400 });
  const preview = jsonResult(await fixture.tools.call("android_screenshot"));
  errorResult(await fixture.tools.call("android_pointer_calibration", { phase: "probe", frameId: preview["frameId"] }), /original-resolution/);
  assert.deepEqual(fixture.bridge.records, []);
});

test("pointer calibration rejects bad observed displacement without replacing old scales or repeating movement", async () => {
  const fixture = calibrationFixture(); fixture.input.setCalibration(1.25, 1.5);
  const probe = await calibrationProbe(fixture), records = fixture.bridge.records.length;
  for (const extra of [{ endX: -1 }, { endX: 0 }, { endX: 65 }, { endY: 135 }, { endX: 90 }, { endY: 160 }]) {
    errorResult(await fixture.tools.call("android_pointer_calibration", finishCalibration(probe, extra)), /inside|small|reversed|edge/);
    assert.equal(fixture.input.state.scaleX, 1.25); assert.equal(fixture.input.state.scaleY, 1.5);
    assert.equal(fixture.bridge.records.length, records);
  }
  jsonResult(await fixture.tools.call("android_pointer_calibration", finishCalibration(probe)));
  assert.equal(fixture.input.state.scaleX, 2);
});

test("pointer calibration permits only read-only screenshot and wait refreshes from its own session", async () => {
  const fixture = calibrationFixture(), probe = await calibrationProbe(fixture);
  const foreign = fixture.tools.fork(), foreignFrame = jsonResult(await foreign.call("android_screenshot"));
  errorResult(await foreign.call("android_pointer_calibration", finishCalibration(probe, { frameId: foreignFrame["frameId"] })), /pending calibration probe/);
  const refreshed = jsonResult(await fixture.tools.call("android_screenshot"));
  const waited = jsonResult(await fixture.tools.call("android_control", { action: "wait", waitMs: 0, frameId: refreshed["frameId"] }));
  const records = fixture.bridge.records.length;
  jsonResult(await fixture.tools.call("android_pointer_calibration", finishCalibration(probe, { frameId: waited["frameId"] })));
  assert.equal(fixture.bridge.records.length, records);
});

test("pointer calibration handles all diagonal directions and uses HID counts per pixel", async (context) => {
  for (const direction of ["up-left", "up-right", "down-left", "down-right"]) await context.test(direction, async () => {
    const fixture = calibrationFixture(), frame = jsonResult(await fixture.tools.call("android_screenshot"));
    const probe = jsonResult(await fixture.tools.call("android_pointer_calibration", { phase: "probe", frameId: frame["frameId"], direction, counts: 48 }));
    const finished = jsonResult(await fixture.tools.call("android_pointer_calibration", finishCalibration(probe, {
      startX: 50, startY: 100, endX: direction.endsWith("left") ? 26 : 74, endY: direction.startsWith("up") ? 68 : 132,
    })));
    assert.equal(finished["scaleX"], 2); assert.equal(finished["scaleY"], 1.5);
  });
});

test("pointer calibration expires and rejects intervening input, control rounds or geometry", async (context) => {
  for (const change of ["expired", "move", "remote", "release", "rearm", "manual", "rotation", "phone", "owner"]) await context.test(change, async () => {
    const fixture = calibrationFixture(), probe = await calibrationProbe(fixture);
    if (change === "expired") fixture.clock.now += 30001;
    if (change === "move") await fixture.input.move(1, 0);
    if (change === "remote") await fixture.input.remoteReport({ kind: "mouse", dx: 1, dy: 0, wheel: 0, buttons: 0 });
    if (change === "release") await fixture.input.releaseAll();
    if (change === "rearm") await fixture.input.arm();
    if (change === "manual") fixture.input.setCalibration(1.1, 1.2);
    if (change === "rotation") fixture.input.setScreen({ width: 100, height: 200, rotation: 1 });
    if (change === "phone") { fixture.adb.serial = "USB-TWO"; await fixture.tools.call("android_screenshot"); }
    if (change === "owner") {
      const foreign = fixture.tools.fork(); jsonResult(await foreign.call("android_hid_arm"));
    }
    const records = fixture.bridge.records.length;
    errorResult(await fixture.tools.call("android_pointer_calibration", finishCalibration(probe)), /expired|changed|superseded/);
    assert.equal(fixture.bridge.records.length, records);
    if (change === "manual") assert.equal(fixture.input.state.scaleX, 1.1);
  });
});

test("pointer calibration detects input inserted during its neutral preparation", async () => {
  const fixture = calibrationFixture(), frame = jsonResult(await fixture.tools.call("android_screenshot"));
  const arm = fixture.input.arm.bind(fixture.input); let inserted = false;
  fixture.input.arm = async (...args) => {
    const result = await arm(...args);
    if (!inserted) { inserted = true; await fixture.input.remoteReport({ kind: "mouse", dx: 2, dy: 0, wheel: 0, buttons: 0 }); }
    return result;
  };
  errorResult(await fixture.tools.call("android_pointer_calibration", { phase: "probe", frameId: frame["frameId"] }), /changed/);
  assert.equal(fixture.bridge.records.filter(({ op }) => op === "MOVE").length, 1);
});

test("pointer calibration rejects a queued warmup if another input dispatches before it", async () => {
  const fixture = calibrationFixture(), frame = jsonResult(await fixture.tools.call("android_screenshot"));
  const move = fixture.input.move.bind(fixture.input); let inserted = false;
  fixture.input.move = (...args) => {
    if (!inserted) { inserted = true; void move(2, 0); }
    return move(...args);
  };
  errorResult(await fixture.tools.call("android_pointer_calibration", { phase: "probe", frameId: frame["frameId"] }), /changed/);
  assert.deepEqual(fixture.bridge.records.filter(({ op }) => op === "MOVE").map(({ args }) => args), [[2, 0, 0, 0]]);
});

test("pointer calibration never publishes a ticket when input changes during image acquisition", async () => {
  const fixture = calibrationFixture(), frame = jsonResult(await fixture.tools.call("android_screenshot"));
  const capture = fixture.adb.capture.bind(fixture.adb); let calls = 0;
  fixture.adb.capture = async (serial) => {
    const captured = await capture(serial);
    if (++calls === 2) await fixture.input.remoteReport({ kind: "mouse", dx: 2, dy: 0, wheel: 0, buttons: 0 });
    return captured;
  };
  const result = await fixture.tools.call("android_pointer_calibration", { phase: "probe", frameId: frame["frameId"] });
  errorResult(result, /changed/);
  assert.equal(result.content.some(({ type }) => type === "image"), false);
  assert.ok(!fixture.bridge.records.some(({ op, args }) => op === "MOVE" && args[0] === -96));
});

test("cancelled calibration finish preserves its ticket and cannot clear another caller's input owner", async () => {
  const fixture = calibrationFixture(), probe = await calibrationProbe(fixture);
  const cancel = new AbortController(); cancel.abort(new Error("Cancel finish before commit"));
  const records = fixture.bridge.records.length;
  errorResult(await fixture.tools.call("android_pointer_calibration", finishCalibration(probe), cancel.signal), /cancelled/);
  assert.equal(fixture.bridge.records.length, records); assert.equal(fixture.input.state.calibrated, false);
  const foreign = fixture.tools.fork(); jsonResult(await foreign.call("android_hid_arm"));
  const afterArm = fixture.bridge.records.length;
  errorResult(await fixture.tools.call("android_pointer_calibration", finishCalibration(probe)), /changed/);
  assert.equal(fixture.bridge.records.length, afterArm); assert.equal(fixture.input.state.armed, true);
});

test("pointer calibration cancellation and a stale result wait cannot stop a newer ARM", async () => {
  const fixture = calibrationFixture(2000), frame = jsonResult(await fixture.tools.call("android_screenshot"));
  const capture = fixture.adb.capture.bind(fixture.adb); let calls = 0, entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  fixture.adb.capture = async (serial) => {
    if (++calls === 2) { entered(); return new Promise(() => {}); }
    return capture(serial);
  };
  const cancel = new AbortController();
  const probing = fixture.tools.call("android_pointer_calibration", { phase: "probe", frameId: frame["frameId"] }, cancel.signal);
  await waiting; await fixture.input.arm(); const records = fixture.bridge.records.length;
  cancel.abort(new Error("Cancel old probe"));
  errorResult(await probing, /Cancel old probe/);
  assert.equal(fixture.input.state.armed, true); assert.equal(fixture.bridge.records.length, records);
});

test("pointer calibration result timeout never replays the measured movement or replaces old scales", async () => {
  const fixture = calibrationFixture(25); fixture.input.setCalibration(1.1, 1.2);
  const frame = jsonResult(await fixture.tools.call("android_screenshot"));
  const capture = fixture.adb.capture.bind(fixture.adb); let calls = 0;
  fixture.adb.capture = async (serial) => ({ ...await capture(serial), sourceFrameId: ++calls < 3 ? `probe-${calls}` : "probe-2" });
  const result = await fixture.tools.call("android_pointer_calibration", { phase: "probe", frameId: frame["frameId"] });
  errorResult(result, /Movement may already have occurred/);
  assert.deepEqual(fixture.bridge.records.filter(({ op, args }) => op === "MOVE" && args[0] === -96).map(({ args }) => args), [[-96, -96, 0, 0]]);
  assert.equal(fixture.input.state.scaleX, 1.1); assert.equal(fixture.input.state.armed, false);
});

test("cancelling a calibration's own pending movement releases input without publishing a probe", async () => {
  const fixture = calibrationFixture(), frame = jsonResult(await fixture.tools.call("android_screenshot"));
  const blocked = fixture.bridge.blockNext("MOVE"), cancel = new AbortController();
  const pending = fixture.tools.call("android_pointer_calibration", { phase: "probe", frameId: frame["frameId"] }, cancel.signal);
  await blocked.started; cancel.abort(new Error("Cancel current calibration"));
  const result = await pending; blocked.release();
  errorResult(result, /Cancel current calibration|cancelled/);
  assert.equal(result.content.some(({ type }) => type === "image"), false);
  assert.equal(fixture.input.state.armed, false);
  assert.equal(fixture.bridge.records.filter(({ op }) => op === "MOVE").length, 1);
});

test("preferred control prepares HID and returns the newer post-action image and structured metadata through HTTP SDK", async (context) => {
  const fixture = controlFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  const client = new Client({ name: "control-http-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(listener.url));
  context.after(async () => { await client.close(); await listener.close(); });
  await client.connect(transport as unknown as Transport);
  assert.ok((await client.listTools()).tools.some((entry) => entry.name === "android_control"));
  assert.match(client.getInstructions() ?? "", /prefer android_control/);
  const before = jsonResult(await client.callTool({ name: "android_screenshot" }));
  assert.deepEqual(fixture.bridge.records, []);
  const result = CallToolResultSchema.parse(await client.callTool({ name: "android_control", arguments: {
    action: "home", frameId: before["frameId"],
  } }));
  const metadata = jsonResult(result);
  assert.equal(metadata["action"], "home");
  assert.equal(metadata["actionCompleted"], true);
  assert.equal(metadata["observedAfterAction"], true);
  assert.notEqual(metadata["frameId"], before["frameId"]);
  assert.notEqual(metadata["sourceFrameId"], before["sourceFrameId"]);
  assert.deepEqual(result.structuredContent, metadata);
  const image = result.content.find((entry) => entry.type === "image");
  assert.ok(image && image.type === "image");
  assert.deepEqual(Buffer.from(image.data, "base64"), fixture.adb.latestPng);
  assert.deepEqual(fixture.bridge.records.map(({ op }) => op), ["PING", "ARM", "CONSUMER", "CONSUMER"]);
  jsonResult(await client.callTool({ name: "android_control", arguments: {
    action: "key", combo: "tab", frameId: metadata["frameId"],
  } }));
  assert.equal(fixture.bridge.records.filter(({ op }) => op === "ARM").length, 1);
});

test("control rejects stale or malformed intent and missing coordinate calibration before enabling hardware", async () => {
  const fixture = controlFixture();
  const frame = jsonResult(await fixture.tools.call("android_screenshot"));
  for (const args of [
    { action: "move", dx: 0.5, dy: 0 }, { action: "click", count: 3 },
    { action: "key", combo: "no_such_key" }, { action: "type", text: "hello中文" },
    { action: "home", dx: 1 }, { action: "tap", x: 10, y: 20 },
    { action: "wait", waitMs: 3001 },
  ]) errorResult(await fixture.tools.call("android_control", { frameId: frame["frameId"], ...args }));
  fixture.clock.now += 30_001;
  errorResult(await fixture.tools.call("android_control", { action: "home", frameId: frame["frameId"] }), /expired/);
  assert.deepEqual(fixture.bridge.records, []);
});

test("control does not bypass the physical emergency stop", async () => {
  const fixture = controlFixture();
  fixture.bridge.status.locked = true;
  const frame = jsonResult(await fixture.tools.call("android_screenshot"));
  const result = await fixture.tools.call("android_control", { action: "back", frameId: frame["frameId"] });
  errorResult(result, /locked/);
  const metadata = result.structuredContent;
  assert.equal(metadata?.["actionStarted"], false);
  assert.equal(metadata?.["actionCompleted"], false);
  assert.ok(!fixture.bridge.records.some(({ op }) => op === "KEY" || op === "CONSUMER" || op === "MOVE"));
});

test("control waits past a newer frame which was actually captured before the completed action", async () => {
  const fixture = controlFixture(1000);
  const original = fixture.adb.capture.bind(fixture.adb);
  let reads = 0;
  fixture.adb.capture = async (serial) => {
    const frame = await original(serial);
    reads += 1;
    if (reads === 3) return { ...frame, sourceFrameId: "old-in-flight-frame", frameAgeMs: 1000 };
    return frame;
  };
  const before = jsonResult(await fixture.tools.call("android_screenshot"));
  const after = jsonResult(await fixture.tools.call("android_control", { action: "move", dx: 1, dy: 0, frameId: before["frameId"] }));
  assert.ok(reads >= 4);
  assert.notEqual(after["sourceFrameId"], "old-in-flight-frame");
  assert.equal(after["observedAfterAction"], true);
});

test("control reports that input already completed when the source only repeats a cached frame", async () => {
  const fixture = controlFixture(45);
  const original = fixture.adb.capture.bind(fixture.adb);
  fixture.adb.capture = async (serial) => ({ ...await original(serial), sourceFrameId: "unchanged-cache", frameAgeMs: 0 });
  const before = jsonResult(await fixture.tools.call("android_screenshot"));
  const result = await fixture.tools.call("android_control", { action: "back", frameId: before["frameId"] });
  errorResult(result, /Do not repeat the action blindly/);
  assert.equal(result.structuredContent?.["actionCompleted"], true);
  assert.equal(result.structuredContent?.["observedAfterAction"], false);
  assert.equal(result.content.some((entry) => entry.type === "image"), false);
  assert.deepEqual(fixture.bridge.records.filter(({ op }) => op === "CONSUMER").map(({ args }) => args), [[0x224], [0]]);
  assert.deepEqual(fixture.bridge.records.slice(-2).map(({ op }) => op), ["RELEASE", "PAUSE"]);
  assert.equal(fixture.input.state.armed, false);
});

test("control wait observes a real new frame without opening HID", async () => {
  const fixture = controlFixture();
  const before = jsonResult(await fixture.tools.call("android_screenshot"));
  const result = jsonResult(await fixture.tools.call("android_control", { action: "wait", waitMs: 0, frameId: before["frameId"] }));
  assert.equal(result["observedAfterAction"], true);
  assert.deepEqual(fixture.bridge.records, []);
});

test("cancelling the action-result wait promptly releases input and never returns an old image", async () => {
  const fixture = controlFixture(2000);
  const original = fixture.adb.capture.bind(fixture.adb);
  let reads = 0, started!: () => void;
  const resultWait = new Promise<void>((resolve) => { started = resolve; });
  fixture.adb.capture = async (serial) => {
    reads += 1;
    if (reads >= 3) { started(); return new Promise(() => {}); }
    return original(serial);
  };
  const before = jsonResult(await fixture.tools.call("android_screenshot"));
  const controller = new AbortController();
  const pending = fixture.tools.call("android_control", { action: "move", dx: 1, dy: 0, frameId: before["frameId"] }, controller.signal);
  await resultWait;
  controller.abort(new Error("Stop waiting"));
  const result = await pending;
  errorResult(result, /Stop waiting/);
  assert.equal(result.structuredContent?.["actionCompleted"], true);
  assert.equal(result.content.some((entry) => entry.type === "image"), false);
  assert.equal(fixture.input.state.armed, false);
  assert.deepEqual(fixture.bridge.records.slice(-2).map(({ op }) => op), ["RELEASE", "PAUSE"]);
});

test("an action-result timeout aborts the original HTTP body so the next MCP screenshot is not queued behind it", async () => {
  const fixture = createFixture();
  const deviceId = "11111111-1111-4111-8111-111111111111";
  let originals = 0, cancelled = false, stalled!: ReadableStreamDefaultController<Uint8Array>;
  const headers = (id: string) => ({ "Content-Type": "image/jpeg", "X-Device-Id": deviceId,
    "X-Frame-Id": id, "X-Frame-Age-Ms": "0", "X-Captured-At": new Date().toISOString(),
    "X-Frame-Width": "2", "X-Frame-Height": "3", "X-Device-Width": "2", "X-Device-Height": "3",
    "X-Preview-Profile": "original", "X-Display-Rotation": "0" });
  const phone = new ScreenClient({ endpoint: "http://192.168.1.20:8791", timeoutMs: 1000, fetch: async (url) => {
    if (String(url).endsWith("/frame.jpg")) {
      const image = ++originals === 2 ? new ReadableStream<Uint8Array>({ start(controller) { stalled = controller; }, cancel() { cancelled = true; } }) : new Uint8Array(JPEG_FIXTURE);
      return new Response(image, { headers: headers(`original-${originals}`) });
    }
    const previewHeaders = { ...headers("preview"), "Content-Length": String(JPEG_FIXTURE.length) };
    const part = Buffer.concat([Buffer.from(`--qdd-frame\r\n${Object.entries(previewHeaders).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`), JPEG_FIXTURE, Buffer.from("\r\n")]);
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(part); } }), { headers: { "Content-Type": "multipart/x-mixed-replace; boundary=qdd-frame" } });
  } });
  const live = new LiveScreenSource(phone);
  const tools = new AndroidTools(live, fixture.input, { actionFrameTimeoutMs: 30, now: () => fixture.clock.now });
  let deadline: NodeJS.Timeout | undefined;
  try {
    const before = jsonResult(await tools.call("android_screenshot"));
    const result = await tools.call("android_control", { action: "move", frameId: before["frameId"], dx: 1, dy: 0 });
    errorResult(result, /Action completed/u);
    assert.equal(result.structuredContent?.["actionCompleted"], true);
    assert.equal(result.content.some(({ type }) => type === "image"), false);
    assert.equal(cancelled, true, "The post-action deadline must cancel the underlying original HTTP read.");
    const next = await Promise.race([tools.call("android_screenshot"), new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error("Next MCP screenshot waited for the cancelled original request.")), 250); })]);
    assert.equal(jsonResult(next)["sourceFrameId"], "original-3");
    assert.equal(fixture.bridge.records.filter(({ op, args }) => op === "MOVE" && args[0] === 1).length, 1, "An unavailable action result must not replay the completed movement.");
  } finally { clearTimeout(deadline); try { stalled.close(); } catch { /* Already cancelled. */ } await live.close(); }
});

test("control keeps calibrated coordinate guards and returns a reusable resulting frame", async () => {
  const fixture = controlFixture(1000);
  const before = jsonResult(await fixture.tools.call("android_screenshot"));
  jsonResult(await fixture.tools.call("android_calibrate_pointer", { frameId: before["frameId"], scaleX: 1, scaleY: 1 }));
  const after = jsonResult(await fixture.tools.call("android_control", { action: "tap", frameId: before["frameId"], x: 10, y: 20 }));
  assert.equal(after["observedAfterAction"], true);
  assert.deepEqual(fixture.input.state.pointer, { x: 10, y: 20 });
  assert.ok(fixture.bridge.records.some(({ op, args }) => op === "MOVE" && args[3] === 1));
  errorResult(await fixture.tools.call("android_control", { action: "tap", frameId: before["frameId"], x: 10, y: 20 }), /superseded/);
  jsonResult(await fixture.tools.call("android_control", { action: "click", frameId: after["frameId"] }));
});

test("control hover returns the real post-movement image without a press before a separate click", async () => {
  const fixture = controlFixture(1000), before = jsonResult(await fixture.tools.call("android_screenshot"));
  jsonResult(await fixture.tools.call("android_calibrate_pointer", { frameId: before["frameId"], scaleX: 1, scaleY: 1 }));
  const response = await fixture.tools.call("android_control", {
    action: "hover", frameId: before["frameId"], x: 500, y: 500, coordinateSpace: "normalized1000",
  });
  const after = jsonResult(response), moves = fixture.bridge.records.filter(({ op }) => op === "MOVE");
  assert.equal(after["action"], "hover"); assert.equal(after["actionCompleted"], true);
  assert.equal(after["observedAfterAction"], true);
  assert.notEqual(after["sourceFrameId"], before["sourceFrameId"]);
  assert.deepEqual(fixture.input.state.pointer, { x: 50, y: 100 });
  assert.ok(moves.length > 0); assert.ok(moves.every(({ args }) => args[2] === 0 && args[3] === 0));
  const image = response.content.find(({ type }) => type === "image");
  assert.ok(image && image.type === "image");
  assert.deepEqual(Buffer.from(image.data, "base64"), fixture.adb.latestPng);
  jsonResult(await fixture.tools.call("android_control", { action: "click", frameId: after["frameId"] }));
  assert.ok(fixture.bridge.records.some(({ op, args }) => op === "MOVE" && args[3] === 1));
});

test("control hover rejects missing calibration or out-of-bounds targets before enabling input", async () => {
  const fixture = controlFixture(), frame = jsonResult(await fixture.tools.call("android_screenshot"));
  errorResult(await fixture.tools.call("android_control", { action: "hover", frameId: frame["frameId"], x: 10, y: 20 }), /explicit calibration/);
  errorResult(await fixture.tools.call("android_control", { action: "hover", frameId: frame["frameId"], x: 100, y: 20 }), /outside/);
  assert.deepEqual(fixture.bridge.records, []);
});

test("queued hover rechecks the caller's frame before sending any movement", async () => {
  const fixture = controlFixture(1000), frame = jsonResult(await fixture.tools.call("android_screenshot"));
  jsonResult(await fixture.tools.call("android_calibrate_pointer", { frameId: frame["frameId"], scaleX: 1, scaleY: 1 }));
  jsonResult(await fixture.tools.call("android_hid_arm"));
  const blocked = fixture.bridge.blockNext("KEY"), key = fixture.input.key("enter");
  await blocked.started;
  const hover = fixture.tools.call("android_control", { action: "hover", frameId: frame["frameId"], x: 10, y: 20 });
  await nextTurn();
  const latest = jsonResult(await fixture.tools.call("android_screenshot"));
  assert.notEqual(latest["frameId"], frame["frameId"]);
  blocked.release(); await key;
  errorResult(await hover, /superseded|cancelled/);
  assert.equal(fixture.bridge.records.some(({ op }) => op === "MOVE"), false);
});

test("hover waiting for its initial frame cannot move or stop a newer ARM", async () => {
  const fixture = controlFixture(1000), frame = jsonResult(await fixture.tools.call("android_screenshot"));
  jsonResult(await fixture.tools.call("android_calibrate_pointer", { frameId: frame["frameId"], scaleX: 1, scaleY: 1 }));
  const capture = fixture.adb.capture.bind(fixture.adb);
  let reading!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { reading = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  fixture.adb.capture = async (serial) => { reading(); await blocked; return capture(serial); };
  const pending = fixture.tools.call("android_control", { action: "hover", x: 10, y: 20, frameId: frame["frameId"] });
  await started; await fixture.input.arm();
  const count = fixture.bridge.records.length; release();
  errorResult(await pending, /control round/);
  assert.equal(fixture.input.state.armed, true); assert.equal(fixture.bridge.records.length, count);
});

test("control serializes separate MCP sessions through each action's resulting observation", async () => {
  const fixture = controlFixture(1000);
  const second = fixture.tools.fork();
  const frameA = jsonResult(await fixture.tools.call("android_screenshot"));
  const frameB = jsonResult(await second.call("android_screenshot"));
  const blocked = fixture.bridge.blockNext("CONSUMER");
  const first = fixture.tools.call("android_control", { action: "home", frameId: frameA["frameId"] });
  await blocked.started;
  const following = second.call("android_control", { action: "key", combo: "enter", frameId: frameB["frameId"] });
  await nextTurn();
  assert.equal(fixture.bridge.records.some(({ op }) => op === "KEY"), false);
  blocked.release();
  const [one, two] = await Promise.all([first, following]);
  assert.equal(jsonResult(one)["observedAfterAction"], true);
  assert.equal(jsonResult(two)["observedAfterAction"], true);
  assert.equal(fixture.bridge.records.filter(({ op }) => op === "ARM").length, 1);
  assert.deepEqual(fixture.bridge.records.filter(({ op }) => op === "KEY").map(({ args }) => args), [[0, 0x28], [0, 0]]);
});

test("control cannot use a result image to revive input after live geometry changed mid-action", async () => {
  const fixture = controlFixture(1000);
  const frame = jsonResult(await fixture.tools.call("android_screenshot"));
  const blocked = fixture.bridge.blockNext("CONSUMER");
  const pending = fixture.tools.call("android_control", { action: "home", frameId: frame["frameId"] });
  await blocked.started;
  await fixture.tools.observeLive({ serial: "USB-ONE", width: 200, height: 100, rotation: 1,
    png: fixturePng(200, 100), capturedAt: "2026-10-17T06:00:00Z" });
  blocked.release();
  const result = await pending;
  errorResult(result, /cancelled/);
  assert.equal(result.content.some((entry) => entry.type === "image"), false);
  assert.equal(fixture.input.state.armed, false);
});

for (const name of ["android_screenshot", "android_control"] as const) {
  test(`cancelling read-only ${name} waiting for a phone frame does not stop another input owner`, async () => {
    const fixture = controlFixture(2000);
    const observer = fixture.tools.fork();
    const frame = jsonResult(await observer.call("android_screenshot"));
    jsonResult(await fixture.tools.call("android_hid_arm"));
    jsonResult(await fixture.tools.call("android_key_report", { modifier: 2, keycode: 4 }));
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    fixture.adb.capture = async () => { started(); return new Promise(() => {}); };
    const abort = new AbortController();
    const pending = observer.call(name, name === "android_control"
      ? { action: "wait", waitMs: 0, frameId: frame["frameId"] } : {}, abort.signal);
    await reading;
    const before = fixture.bridge.records.length;
    abort.abort(new Error("Cancel inspection"));
    errorResult(await pending, /Cancel inspection/);
    assert.equal(fixture.input.state.armed, true);
    assert.equal(fixture.bridge.records.length, before, "Read-only cancellation cannot release another owner's reports.");
  });
}

test("control waiting for its initial live frame cannot act in a newer input round", async () => {
  const fixture = controlFixture(1000);
  const before = jsonResult(await fixture.tools.call("android_screenshot"));
  const capture = fixture.adb.capture.bind(fixture.adb);
  let reading!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { reading = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  fixture.adb.capture = async (serial) => { reading(); await blocked; return capture(serial); };
  const pending = fixture.tools.call("android_control", { action: "move", dx: 1, dy: 0, frameId: before["frameId"] });
  await started;
  await fixture.input.arm();
  const reports = fixture.bridge.records.length;
  release();
  const result = await pending;
  errorResult(result, /control round/);
  assert.equal(result.structuredContent?.["actionStarted"], false);
  assert.equal(result.structuredContent?.["actionCompleted"], false);
  assert.equal(fixture.input.state.armed, true);
  assert.equal(fixture.bridge.records.length, reports, "Expired control cannot execute or stop the new round.");
});

test("control cannot adopt a newer ARM while its own ARM acknowledgement is pending", async () => {
  const fixture = controlFixture(1000);
  const before = jsonResult(await fixture.tools.call("android_screenshot"));
  const blocked = fixture.bridge.blockNext("PING");
  const pending = fixture.tools.call("android_control", { action: "move", dx: 1, dy: 0, frameId: before["frameId"] });
  await blocked.started;
  const newRound = fixture.input.arm();
  blocked.release();
  const [result] = await Promise.all([pending, newRound]);
  errorResult(result, /control round/);
  assert.equal(result.structuredContent?.["actionStarted"], false);
  assert.equal(fixture.input.state.armed, true);
  assert.deepEqual(fixture.bridge.records.map(({ op }) => op), ["PING", "ARM", "PING", "ARM"]);
});

test("cancelling a superseded legacy key call cannot pause or cancel the newer ARM", async () => {
  const fixture = createFixture();
  await fixture.input.arm();
  const blocked = fixture.bridge.blockNext("KEY");
  const controller = new AbortController();
  const previous = fixture.tools.call("android_key_report", { modifier: 0, keycode: 4 }, controller.signal);
  await blocked.started;
  const current = fixture.input.arm();
  controller.abort(new Error("Cancel old legacy call"));
  errorResult(await previous, /cancelled/);
  await current;
  assert.equal(fixture.input.state.armed, true);
  assert.deepEqual(fixture.bridge.records.map(({ op }) => op), ["PING", "ARM", "KEY", "RELEASE", "PAUSE", "PING", "ARM"]);
});

test("a superseded screenshot failure cannot stop or invalidate a newer input round", async () => {
  const fixture = createFixture();
  const observer = fixture.tools.fork();
  const frame = jsonResult(await observer.call("android_screenshot"));
  let reading!: () => void, fail!: () => void;
  const started = new Promise<void>((resolve) => { reading = resolve; });
  const failure = new Promise<never>((_resolve, reject) => { fail = () => reject(new Error("Old capture failed")); });
  fixture.adb.capture = async () => { reading(); return failure; };
  const previous = fixture.tools.call("android_screenshot");
  await started;
  await fixture.input.arm();
  const reports = fixture.bridge.records.length;
  fail();
  errorResult(await previous, /Old capture failed/);
  assert.equal(fixture.input.state.armed, true);
  assert.equal(fixture.bridge.records.length, reports);
  jsonResult(await observer.call("android_calibrate_pointer", { frameId: frame["frameId"], scaleX: 1, scaleY: 1 }));
});

for (const cancel of [false, true]) {
  test(`a superseded control result ${cancel ? "cancellation" : "timeout"} cannot stop or invalidate the newer input round`, async () => {
    const fixture = controlFixture(100);
    const observer = fixture.tools.fork();
    const before = jsonResult(await fixture.tools.call("android_screenshot"));
    const otherFrame = jsonResult(await observer.call("android_screenshot"));
    const capture = fixture.adb.capture.bind(fixture.adb);
    let reads = 0, reading!: () => void;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    fixture.adb.capture = async (serial) => {
      if (++reads === 1) return capture(serial);
      reading();
      return new Promise(() => {});
    };
    const controller = new AbortController();
    const pending = fixture.tools.call("android_control", { action: "move", dx: 1, dy: 0,
      frameId: before["frameId"] }, controller.signal);
    await started;
    await fixture.input.arm();
    const reports = fixture.bridge.records.length;
    if (cancel) controller.abort(new Error("Cancel old result wait"));
    const result = await pending;
    errorResult(result, /Do not repeat the action blindly/);
    assert.equal(result.structuredContent?.["actionCompleted"], true);
    assert.equal(result.structuredContent?.["observedAfterAction"], false);
    assert.equal(fixture.input.state.armed, true);
    assert.equal(fixture.bridge.records.length, reports, "Old result cleanup cannot release the new owner's input.");
    jsonResult(await observer.call("android_calibrate_pointer", { frameId: otherFrame["frameId"], scaleX: 1, scaleY: 1 }));
    jsonResult(await observer.call("android_mouse_move", { dx: 1, dy: 0 }));
  });
}

test("540 preview preserves 1080 MCP coordinates and repeated visual guards never request original images", async (context) => {
  const fixture = createFixture();
  const device = "11111111-1111-4111-8111-111111111111";
  const requests: string[] = [];
  let geometry = { width: 1080, height: 2400, rotation: 0 };
  let originals = 0, stream!: ReadableStreamDefaultController<Uint8Array>, opened!: () => void;
  const streamStarted = new Promise<void>((resolve) => { opened = resolve; });
  const headers = (id: string, profile: string, width: number, height: number) => ({
    "Content-Type": "image/png", "X-Device-Id": device, "X-Frame-Id": id, "X-Frame-Age-Ms": "0",
    "X-Captured-At": "2026-10-17T06:00:00.000Z", "X-Display-Rotation": String(geometry.rotation),
    "X-Frame-Width": String(width), "X-Frame-Height": String(height), "X-Device-Width": String(geometry.width),
    "X-Device-Height": String(geometry.height), "X-Preview-Profile": profile,
  });
  const phone = new ScreenClient({ endpoint: "http://192.168.1.20:8791", deviceId: device, fetch: async (url) => {
    requests.push(String(url));
    if (String(url).endsWith("/frame.jpg")) return new Response(new Uint8Array(fixturePng(geometry.width, geometry.height)), {
      headers: headers(`original-${++originals}`, "original", geometry.width, geometry.height),
    });
    assert.ok(String(url).endsWith("/stream.mjpg"));
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; opened(); } }),
      { headers: { "Content-Type": "multipart/x-mixed-replace; boundary=qdd-frame" } });
  } });
  const source = new LiveScreenSource(phone);
  context.after(async () => { await source.close(); });
  const tools = new AndroidTools(source, fixture.input);
  const send = (id: string, profile: string, width: number, height: number) => {
    const image = fixturePng(width, height);
    const metadata = { ...headers(id, profile, width, height), "Content-Length": String(image.length) };
    stream.enqueue(new Uint8Array(Buffer.concat([Buffer.from(`--qdd-frame\r\n${Object.entries(metadata).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`), image, Buffer.from("\r\n")])));
  };
  const firstPreview = tools.readLiveFrame(); await streamStarted;
  send("preview-first", "fast", 540, 1200);
  const preview = await firstPreview;
  assert.equal(preview.width, 540); assert.equal(preview.deviceWidth, 1080);
  const screenshot = jsonResult(await tools.call("android_screenshot"));
  assert.equal(screenshot["width"], 1080); assert.equal(screenshot["height"], 2400);
  assert.equal(screenshot["previewProfile"], "original");
  jsonResult(await tools.call("android_calibrate_pointer", { frameId: screenshot["frameId"], scaleX: 1, scaleY: 1 }));
  await fixture.input.arm();
  const epoch = fixture.input.controlEpoch, reports = fixture.bridge.records.length;
  const seen = new Set<string>(); source.subscribe((frame) => { seen.add(frame.sourceFrameId); });
  for (const [profile, width, height] of [["turbo", 360, 800], ["standard", 720, 1600], ["fast", 540, 1200]] as const) {
    send(profile, profile, width, height);
    for (let retry = 0; retry < 100 && !seen.has(profile); retry++) await nextTurn();
    assert.ok(seen.has(profile));
    for (let index = 0; index < 20; index++) {
      assert.equal((await tools.readLiveFrame()).previewProfile, profile);
    }
    assert.deepEqual(fixture.input.state.screen, { width: 1080, height: 2400, rotation: 0 });
    assert.equal(fixture.input.state.armed, true); assert.equal(fixture.input.state.calibrated, true);
    assert.equal(fixture.input.controlEpoch, epoch); assert.equal(fixture.bridge.records.length, reports);
  }
  assert.equal(originals, 1, "Sixty mouse visual guards cannot generate original capture requests.");
  assert.equal(requests.filter((url) => url.endsWith("/stream.mjpg")).length, 1);
  jsonResult(await tools.call("android_calibrate_pointer", { frameId: screenshot["frameId"], scaleX: 1, scaleY: 1 }));
  geometry = { width: 2400, height: 1080, rotation: 1 };
  send("rotated", "fast", 1200, 540);
  for (let retry = 0; retry < 100 && !seen.has("rotated"); retry++) await nextTurn();
  assert.ok(seen.has("rotated"));
  await tools.readLiveFrame();
  assert.deepEqual(fixture.input.state.screen, { width: 2400, height: 1080, rotation: 1 });
  assert.equal(fixture.input.state.armed, false); assert.equal(fixture.input.state.calibrated, false);
  errorResult(await tools.call("android_calibrate_pointer", { frameId: screenshot["frameId"], scaleX: 1, scaleY: 1 }), /superseded/);
  const rotated = jsonResult(await tools.call("android_screenshot"));
  assert.equal(rotated["width"], 2400); assert.equal(rotated["height"], 1080);
});

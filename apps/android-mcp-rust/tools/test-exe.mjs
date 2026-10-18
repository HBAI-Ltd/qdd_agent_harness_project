#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  try { return await originalFetch(input, init); }
  catch (error) {
    error.fixtureRequest = { method: init?.method ?? "GET", url: String(input) };
    throw error;
  }
};
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { PNG } from "pngjs";
import { deviceBaseUrl } from "./test-network.mjs";
import { JPEG_FIXTURE } from "../tests/fixtures/jpeg.mjs";
import { prepareAssets } from "./prepare-assets.mjs";
import { bootSettingsHtml } from "./settings-fixture.mjs";
function readPngDimensions(bytes) { assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a"); assert.equal(bytes.toString("ascii", 12, 16), "IHDR"); return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }; }

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const output = process.env.QDD_RUST_OUTPUT_DIR ? resolve(process.env.QDD_RUST_OUTPUT_DIR) : join(appRoot, "build", "windows");
const releaseManifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
const preparedAssets = await prepareAssets(appRoot);
assert.equal(preparedAssets.buildId, releaseManifest.buildId, "EXE identity must match current source/minifier/generated assets.");
const temporary = await mkdtemp(join(output, "smoke-"));
const emptyDirectory = join(temporary, "空目录 # portable");
await mkdir(emptyDirectory);
const executable = join(emptyDirectory, "设备操作台.exe");
await copyFile(join(output, "设备操作台.exe"), executable);
const environment = { ...process.env, PATH: "", Path: "", NODE_PATH: "", LOCALAPPDATA: join(temporary, "用户缓存 #") };
const children = [], clients = [], ownedPorts = new Set(), streams = new Set(), sockets = new Set(), results = [];
const records = new Map();
const additionalServers = new Set();
const deviceId = "11111111-1111-4111-8111-111111111111";
let sourceSequence = 0, snapshotRequests = 0, previewProfile = "standard", armed = false, bleReady = true, heldKey = 0;
let holdNextStatus = false, delayedStatus;
const reports = [];
const textReports = [];
let imeReplyMode = "accepted", pressAckDelay = 0;
const profiles = ["turbo", "fast", "standard", "original"];
const previewImages = Object.fromEntries(profiles.map((profile) => {
  // Preserve a genuine JPEG while distinguishing preview bytes from the
  // original-resolution snapshot. All fixture images keep the same 2x3 size.
  const label = Buffer.from(`EXE preview ${profile}`), marker = Buffer.alloc(4);
  marker[0] = 0xff; marker[1] = 0xfe; marker.writeUInt16BE(label.length + 2, 2);
  return [profile, Buffer.concat([JPEG_FIXTURE.subarray(0, 2), marker, label, JPEG_FIXTURE.subarray(2)])];
}));
const frameHeaders = (image, id, profile) => ({ "Content-Type": "image/jpeg", "Content-Length": String(image.length),
  "X-Device-Id": deviceId, "X-Frame-Id": id, "X-Frame-Age-Ms": "0", "X-Captured-At": new Date().toISOString(),
  "X-Frame-Width": "2", "X-Frame-Height": "3", "X-Device-Width": "2", "X-Device-Height": "3",
  "X-Preview-Profile": profile, "X-Display-Rotation": "0" });
const phone = createHttpServer((request, response) => {
  if (request.url === "/pointer/calibration") {
    assert.equal(request.method, "GET", "Calibration page is only inspected, never opened by MCP.");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ active: false, deviceId, sessionId: null, width: 0, height: 0, rotation: 0, point: null }));
    return;
  }
  if (request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "qdd-android-screen", deviceId, model: "EXE offline fixture", projecting: true }));
    return;
  }
  if (request.url === "/preview/profile") {
    const send = () => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ profile: previewProfile, deviceWidth: 2, deviceHeight: 3 })); };
    if (request.method === "GET") { send(); return; }
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.once("end", () => {
      let selected;
      try { const value = JSON.parse(body); if (Object.keys(value).length === 1 && profiles.includes(value.profile)) selected = value.profile; } catch { /* Reject malformed fixture requests. */ }
      if (!selected) { response.writeHead(400); response.end(); return; }
      previewProfile = selected; send();
    });
    return;
  }
  if (request.url === "/frame.jpg" && request.method === "GET") {
    snapshotRequests++;
    // Capture after receiving this request. Never satisfy MCP from the latest
    // preview, and never reuse a previous snapshot's source identifier.
    setImmediate(() => {
      response.writeHead(200, frameHeaders(JPEG_FIXTURE, `exe-snapshot-${++sourceSequence}`, "original"));
      response.end(JPEG_FIXTURE);
    });
    return;
  }
  if (request.url !== "/stream.mjpg") { response.writeHead(404); response.end(); return; }
  streams.add(response);
  response.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=qdd-frame" });
  const frame = () => {
    const id = `exe-source-${++sourceSequence}`;
    const image = previewImages[previewProfile];
    response.write(`--qdd-frame\r\n${Object.entries(frameHeaders(image, id, previewProfile)).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
    response.write(image); response.write("\r\n");
  };
  frame(); const timer = setInterval(frame, 80);
  response.once("close", () => { clearInterval(timer); streams.delete(response); });
});
const esp = createTcpServer((socket) => {
  sockets.add(socket); socket.once("close", () => sockets.delete(socket));
  let buffered = "";
  let textId = "0000000000000000", textBytes = 0, textReceived = 0, textPhase = "idle", textPolls = 0;
  socket.on("data", (chunk) => {
    buffered += chunk;
    for (;;) {
      const end = buffered.indexOf("\n"); if (end < 0) break;
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      const textMatch = /^QDDTXT\/1 (\d+) ([A-Z]+) (.*)$/.exec(line);
      if (textMatch) {
        const [, id, op, body] = textMatch, args = body.split(" ");
        textReports.push({ op, args });
        if (op === "BEGIN") { textId = args[0]; textBytes = Number(args[2]); textReceived = 0; textPhase = "receiving"; textPolls = 0; }
        if (op === "DATA") { assert.equal(args[0], textId); assert.equal(Number(args[1]), textReceived); textReceived += Buffer.from(args[2], "hex").length; }
        if (op === "COMMIT") { assert.equal(textReceived, textBytes); textPhase = "queued"; if (imeReplyMode === "lost-commit") continue; }
        if (op === "STATUS" && ["queued", "awaiting_ack"].includes(textPhase)) textPhase = ++textPolls >= 2 ? "accepted" : "awaiting_ack";
        if (op === "CANCEL") textPhase = "cancelled";
        if (["accepted", "rejected", "uncertain", "cancelled"].includes(textPhase)) { textBytes = 0; textReceived = 0; }
        socket.write(`QDDTXT/1 ${id} OK ${JSON.stringify({ id: textId, status: textPhase, editorEpoch: 7, ready: true, received: textReceived, bytes: textBytes })}\n`);
        continue;
      }
      const match = /^QDDHID\/1 (\d+) ([A-Z_]+)(.*)$/.exec(line); assert.ok(match);
      const [, id, op, args] = match;
      reports.push({ op, args: args.trim().split(" ").filter(Boolean).map(Number), at: performance.now() });
      if (op === "ARM") armed = true; if (op === "PAUSE") armed = false;
      if (op === "KEY") heldKey = Number(args.trim().split(" ")[1]);
      if (op === "RELEASE") heldKey = 0;
      const status = { v: 1, connected: true, encrypted: true, bonded: true,
        ready: bleReady, locked: false, armed, name: "EXE fixture BLE" };
      const reply = (overrides = {}) => socket.write(`QDDHID/1 ${id} OK ${JSON.stringify({ ...status, ...overrides })}\n`);
      if (op === "STATUS" && holdNextStatus) { holdNextStatus = false; delayedStatus = reply; continue; }
      const values = args.trim().split(" ").map(Number);
      if (pressAckDelay && ((op === "KEY" && values[1]) || (op === "MOVE" && values[3]) || (op === "CONSUMER" && values[0]))) {
        setTimeout(reply, pressAckDelay); continue;
      }
      reply();
    }
  });
});
const listen = (server) => new Promise((resolveListen, reject) => {
  server.once("error", reject); server.listen(0, "127.0.0.1", () => resolveListen(server.address().port));
});
const phonePort = await listen(phone), espPort = await listen(esp);
async function unusedPort() { const server = createTcpServer(); const port = await listen(server); await new Promise((done) => server.close(done)); return port; }
function start(args) {
  const child = spawn(executable, args, { cwd: emptyDirectory, env: environment, windowsHide: true, stdio: "pipe" });
  children.push(child);
  const record = { child, stdout: "", stderr: "", exit: undefined };
  records.set(child, record);
  child.stdout.on("data", (data) => { record.stdout += data; });
  child.stderr.on("data", (data) => { record.stderr += data; });
  record.done = new Promise((resolveDone, reject) => { child.once("error", reject); child.once("exit", (code) => { record.exit = code; resolveDone(code); }); });
  return record;
}
async function waitFor(check, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(25); }
  throw new Error(message);
}
async function readHealth(port) {
  try { const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(400) }); return response.ok ? await response.json() : undefined; }
  catch { return undefined; }
}
function metadata(result) {
  const parsed = CallToolResultSchema.parse(result);
  assert.notEqual(parsed.isError, true, JSON.stringify(parsed.content));
  const value = parsed.structuredContent;
  assert.ok(value);
  return { parsed, value };
}
async function stopHttp(record, port) {
  assert.equal((await fetch(`http://127.0.0.1:${port}/desktop/quit`, { method: "POST" })).status, 204);
  if (record) {
    await waitFor(() => record.exit !== undefined, `EXE failed to exit gracefully: ${record.stderr}`);
    assert.equal(record.exit, 0);
  }
  await waitFor(async () => !await readHealth(port), "Packaged service left its listener open after shutdown.");
  assert.equal(await readHealth(port), undefined);
}

try {
  const selfTest = start(["--self-test"]);
  assert.equal(await selfTest.done, 0, selfTest.stderr);
  const native = JSON.parse(selfTest.stdout);
  assert.equal(native.status, "ok"); assert.equal(native.runtime, "rust");
  assert.ok(native.embeddedAssets.includes("tools.json"));
  results.push({ name: "single native EXE in empty Chinese/space/# folder, empty PATH, embedded schemas and system serial API", pass: true });
  const port = await unusedPort();
  ownedPorts.add(port);
  const config = { ANDROID_SCREEN_URL: `http://127.0.0.1:${phonePort}`, ANDROID_DEVICE_ID: deviceId,
    ESP_HOST: "127.0.0.1", ESP_TCP_PORT: String(espPort), ESP_PORT: "COM5", ANDROID_MCP_PORT: String(port) };
  const configPath = join(temporary, "fixture-config.json");
  await writeFile(configPath, JSON.stringify(config));
  const service = start(["--no-browser", "--config", configPath]);
  await waitFor(async () => (await readHealth(port))?.desktopBuildId === native.buildId, `EXE HTTP failed: ${service.stderr}`);
  for (const embedded of releaseManifest.embeddedAssets.filter((asset) => asset.httpPath)) {
    const asset = basename(embedded.path);
    const response = await fetch(`http://127.0.0.1:${port}${embedded.httpPath}`);
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash("sha256").update(bytes).digest("hex"), embedded.sha256);
    if (asset === "operator.html") assert.match(bytes.toString("utf8"), /href="\/desktop\/settings"/);
    assert.deepEqual(bytes, preparedAssets.assets.get(asset));
  }
  const client = new Client({ name: "exe-http-smoke", version: "1" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  const packagedTools = (await client.listTools()).tools;
  assert.deepEqual(packagedTools, JSON.parse(preparedAssets.assets.get("tools.json")));
  assert.ok(packagedTools.some((tool) => tool.name === "android_control"));
  assert.ok(packagedTools.some((tool) => tool.name === "android_pointer_calibration"));
  assert.ok(packagedTools.some((tool) => tool.name === "android_preview_tap"));
  const coldObserver = new Client({ name: "exe-cold-readonly-observer", version: "1" }); clients.push(coldObserver);
  let cancellationDelivered = false;
  await coldObserver.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    fetch: async (url, init) => {
      const notification = typeof init?.body === "string" && JSON.parse(init.body).method === "notifications/cancelled";
      const response = await fetch(url, init);
      if (notification) { assert.equal(response.status, 202); cancellationDelivered = true; }
      return response;
    },
  }));
  // Another physical controller may hold input while this service only observes.
  // The fake hardware models that owner without allowing the EXE to claim it.
  armed = true; heldKey = 4;
  const coldStart = reports.length, statusAbort = new AbortController();
  holdNextStatus = true; delayedStatus = undefined;
  const cancelledStatus = coldObserver.callTool({ name: "android_hid_status" }, undefined, { signal: statusAbort.signal });
  void cancelledStatus.catch(() => {});
  await waitFor(() => Boolean(delayedStatus), "Cold observer STATUS did not reach the fake ESP.");
  statusAbort.abort(new Error("Cancel only the read-only observer."));
  await assert.rejects(cancelledStatus, /Cancel only the read-only observer/);
  await waitFor(() => cancellationDelivered, "Official SDK cancellation notification did not reach the packaged server.");
  const coldStatus = metadata(await client.callTool({ name: "android_hid_status" })).value;
  assert.equal(coldStatus.armed, true); assert.equal(coldStatus.input.armed, false);
  delayedStatus({ armed: false }); delayedStatus = undefined;
  const currentStatus = metadata(await client.callTool({ name: "android_hid_status" })).value;
  assert.equal(currentStatus.armed, true); assert.equal(currentStatus.input.armed, false);
  assert.equal(armed, true); assert.equal(heldKey, 4);
  assert.ok(reports.slice(coldStart).every(({ op }) => op === "STATUS"),
    "Cancelling a cold observer and receiving its stale ACK must not claim, arm or release another controller.");
  await coldObserver.close();
  armed = false; heldKey = 0;
  results.push({ name: "official SDK cancels a real pending cold STATUS, ignores its late ACK and preserves another controller without PING or cleanup", pass: true });
  const before = metadata(await client.callTool({ name: "android_screenshot" }));
  const image = before.parsed.content.find((entry) => entry.type === "image");
  assert.deepEqual(Buffer.from(image.data, "base64"), JPEG_FIXTURE);
  const after = metadata(await client.callTool({ name: "android_control", arguments: { action: "home", frameId: before.value.frameId } }));
  assert.equal(after.value.actionCompleted, true); assert.equal(after.value.observedAfterAction, true);
  assert.notEqual(after.value.sourceFrameId, before.value.sourceFrameId);
  assert.ok(reports.some((entry) => entry.op === "CONSUMER" && entry.args[0] === 0x223));
  assert.equal(after.value.previewProfile, "original");
  assert.match(after.value.sourceFrameId, /^exe-snapshot-/u);
  results.push({ name: "EXE HTTP assets + official MCP SDK screenshot/action/new-image with offline phone/ESP", pass: true });
  const delayedStart = reports.length;
  pressAckDelay = 300;
  metadata(await client.callTool({ name: "android_type", arguments: { text: "a" } }));
  pressAckDelay = 0;
  const delayedKeys = reports.slice(delayedStart).filter(({ op }) => op === "KEY");
  assert.equal(delayedKeys.length, 2);
  assert.deepEqual(delayedKeys.map(({ args }) => args), [[0, 4], [0, 0]]);
  assert.ok(delayedKeys[1].at - delayedKeys[0].at >= 40 && delayedKeys[1].at - delayedKeys[0].at < 200);
  results.push({ name: "packaged ASCII key release occurs after a short hold without waiting for delayed press ACK; no report replay", pass: true });
  const unicodeStart = textReports.length;
  const unicode = metadata(await client.callTool({ name: "android_type", arguments: { text: "中文🙂" } })).value;
  assert.equal(unicode.textTransfer.status, "accepted");
  const unicodeWire = textReports.slice(unicodeStart);
  assert.equal(unicodeWire.filter(({ op }) => op === "COMMIT").length, 1);
  assert.ok(unicodeWire.filter(({ op }) => op === "STATUS").length >= 3);
  assert.equal(Buffer.concat(unicodeWire.filter(({ op }) => op === "DATA").map(({ args }) => Buffer.from(args[2], "hex"))).toString("utf8"), "中文🙂");
  results.push({ name: "packaged Unicode text uses QDDTXT UTF-8 bytes, commits once and waits past queued until a simulated phone acceptance", pass: true });
  // A raw MCP request simulates retransmission after the COMMIT ACK is lost.
  // The same id must not dispatch again after the uncertain result completes.
  imeReplyMode = "lost-commit";
  const rawTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  const rawClient = new Client({ name: "exe-replay-boundary", version: "1" }); clients.push(rawClient);
  await rawClient.connect(rawTransport);
  metadata(await rawClient.callTool({ name: "android_hid_arm" }));
  const rawMessage = { jsonrpc: "2.0", id: "unicode-retransmit-v44", method: "tools/call", params: { name: "android_type", arguments: { text: "中文" } } };
  const rawCall = async (message) => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": rawTransport.sessionId },
      body: JSON.stringify(message), signal: AbortSignal.timeout(6000) });
    assert.equal(response.status, 200);
    const body = await response.text();
    return JSON.parse(/^data: (.+)$/mu.exec(body)[1]);
  };
  const uncertainStart = textReports.length;
  const uncertain = await rawCall(rawMessage);
  assert.equal(uncertain.result.isError, true);
  assert.equal(uncertain.result.structuredContent.textTransfer.status, "uncertain");
  const afterUncertain = textReports.length;
  const repeated = await rawCall(rawMessage);
  assert.equal(repeated.error.code, -32600);
  assert.equal(textReports.length, afterUncertain);
  assert.equal(textReports.slice(uncertainStart).filter(({ op }) => op === "COMMIT").length, 1);
  imeReplyMode = "accepted";
  await rawClient.close();
  metadata(await client.callTool({ name: "android_hid_arm" }));
  results.push({ name: "packaged lost COMMIT ACK reports uncertain, never repeats text and rejects the same completed MCP request id without new wire input", pass: true });
  const profileOrigin = `http://127.0.0.1:${port}`;
  assert.equal((await (await fetch(`${profileOrigin}/screen/profile`)).json()).profile, "standard");
  const previewAbort = new AbortController();
  const previewResponse = await fetch(`${profileOrigin}/screen/stream`, { signal: previewAbort.signal });
  assert.equal(previewResponse.status, 200);
  const previewReader = previewResponse.body.getReader();
  let previewBuffer = Buffer.alloc(0);
  const readPreview = async () => {
    for (;;) {
      if (previewBuffer.length >= 8) {
        const jsonLength = previewBuffer.readUInt32BE(0), imageLength = previewBuffer.readUInt32BE(4);
        assert.ok(jsonLength > 0 && jsonLength <= 8192 && imageLength <= 32 * 1024 * 1024);
        const length = 8 + jsonLength + imageLength;
        if (previewBuffer.length >= length) {
          const metadata = JSON.parse(previewBuffer.subarray(8, 8 + jsonLength).toString());
          const image = Buffer.from(previewBuffer.subarray(8 + jsonLength, length));
          previewBuffer = previewBuffer.subarray(length);
          return { metadata, image };
        }
      }
      const chunk = await previewReader.read(); assert.equal(chunk.done, false, "Packaged preview ended unexpectedly.");
      previewBuffer = Buffer.concat([previewBuffer, chunk.value]);
    }
  };
  const inputOperations = () => reports.filter(({ op }) => ["ARM", "PAUSE", "MOVE", "KEY", "CONSUMER", "RELEASE"].includes(op)).length;
  const ownerOperations = inputOperations();
  let previousSnapshot = after.value.sourceFrameId;
  const profileDeadline = setTimeout(() => previewAbort.abort(), 10000);
  try {
    for (const profile of profiles) {
      const changedProfile = await fetch(`${profileOrigin}/screen/profile`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile }) });
      assert.equal(changedProfile.status, 200);
      assert.equal((await changedProfile.json()).profile, profile);
      assert.equal((await (await fetch(`${profileOrigin}/screen/profile`)).json()).profile, profile);
      let preview;
      for (let attempts = 0; attempts < 30; attempts++) { preview = await readPreview(); if (preview.metadata.previewProfile === profile) break; }
      assert.equal(preview.metadata.previewProfile, profile);
      assert.equal(preview.metadata.deviceWidth, 2); assert.equal(preview.metadata.deviceHeight, 3);
      assert.deepEqual(preview.image, previewImages[profile]);
      assert.notDeepEqual(preview.image, JPEG_FIXTURE, "Preview fixture must distinguish video from full-resolution MCP bytes.");
      const requestsBefore = snapshotRequests;
      const snapshot = metadata(await client.callTool({ name: "android_screenshot" }));
      assert.equal(snapshotRequests, requestsBefore + 1, "Each MCP screenshot requests a new original capture from /frame.jpg.");
      assert.equal(snapshot.value.width, 2); assert.equal(snapshot.value.height, 3);
      assert.equal(snapshot.value.deviceWidth, 2); assert.equal(snapshot.value.deviceHeight, 3);
      assert.equal(snapshot.value.previewProfile, "original");
      assert.match(snapshot.value.sourceFrameId, /^exe-snapshot-/u);
      assert.notEqual(snapshot.value.sourceFrameId, previousSnapshot); previousSnapshot = snapshot.value.sourceFrameId;
      assert.deepEqual(Buffer.from(snapshot.parsed.content.find((entry) => entry.type === "image").data, "base64"), JPEG_FIXTURE);
      assert.equal(armed, true, "Changing read-only preview quality must preserve the existing HID owner.");
      assert.equal(inputOperations(), ownerOperations, "Quality and screenshots must not arm, pause or send input.");
    }
    const invalid = await fetch(`${profileOrigin}/screen/profile`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile: "invalid" }) });
    assert.equal(invalid.status, 400);
    assert.equal((await (await fetch(`${profileOrigin}/screen/profile`)).json()).profile, "original");
    assert.equal(inputOperations(), ownerOperations);
  } finally { clearTimeout(profileDeadline); previewAbort.abort(); await previewReader.cancel().catch(() => {}); previewReader.releaseLock(); }
  assert.equal(armed, true, "Closing a preview viewer must not release the active owner.");
  results.push({ name: "packaged four-profile preview persists settings without claiming input; every MCP screenshot captures a fresh original JPEG", pass: true });
  const targetFrame = metadata(await client.callTool({ name: "android_screenshot" })).value;
  const targetInputReports = inputOperations();
  const target = metadata(await client.callTool({ name: "android_preview_tap", arguments: {
    frameId: targetFrame.frameId, x: 500, y: 500, coordinateSpace: "normalized1000",
  } }));
  assert.equal(target.value.simulatedTarget, true);
  assert.equal(target.value.realMouseMoved, false); assert.equal(target.value.realClickSent, false);
  assert.deepEqual(target.value.target, { x: 1, y: 1, coordinateSpace: "pixels" });
  const targetImages = target.parsed.content.filter(({ type }) => type === "image");
  assert.equal(targetImages.length, 2);
  assert.equal(target.value.annotation.coordinateSpace, "originalPhonePixels");
  assert.equal(target.value.annotation.label, "PHONE PX: X=1 Y=1");
  for (const [index, block] of targetImages.entries()) {
    const annotation = index === 0 ? target.value.annotation.original : target.value.annotation.zoom;
    const bytes = Buffer.from(block.data, "base64"), decoded = PNG.sync.read(bytes);
    assert.deepEqual(readPngDimensions(bytes), { width: annotation.width, height: annotation.height });
    assert.deepEqual(annotation.sourceRect, { x: 0, y: 0, width: index === 0 ? 2 : 4, height: index === 0 ? 3 : 6 });
    assert.deepEqual(annotation.legend, { x: 0, y: annotation.sourceRect.height, width: annotation.width, height: 52 });
    let white = 0, magenta = 0;
    for (let y = annotation.legend.y; y < decoded.height; y++) for (let x = 0; x < decoded.width; x++) {
      const offset = (y * decoded.width + x) * 4;
      if (decoded.data[offset] === 255 && decoded.data[offset + 1] === 255 && decoded.data[offset + 2] === 255) white++;
      if (decoded.data[offset] === 255 && decoded.data[offset + 1] === 0 && decoded.data[offset + 2] === 255) magenta++;
    }
    assert.ok(white > 100 && magenta > 100, "Packaged worker must draw visible coordinate text and SIMULATED TARGET in both image footers.");
  }
  assert.equal(target.value.sourceSha256, createHash("sha256").update(JPEG_FIXTURE).digest("hex"));
  assert.equal(inputOperations(), targetInputReports, "Packaged worker rendering must not send any hardware input.");
  assert.equal(armed, true);
  results.push({ name: "single EXE decodes and annotates an original JPEG in its embedded worker, returns target plus zoom PNGs, and preserves input owner without HID", pass: true });
  const calibrationFrame = metadata(await client.callTool({ name: "android_screenshot" })).value;
  const calibrationReports = reports.length;
  const measured = metadata(await client.callTool({ name: "android_pointer_calibration", arguments: {
    phase: "probe", frameId: calibrationFrame.frameId,
  } }));
  assert.equal(measured.value.phase, "probe");
  assert.equal(measured.value.measurable, false);
  assert.equal(measured.value.measurementAvailable, false);
  assert.equal(measured.value.reason, "identical_images");
  assert.equal(measured.value.probeId, undefined);
  assert.deepEqual(measured.value.counts, { dx: -96, dy: -96 });
  assert.deepEqual(measured.value.imageOrder, ["before", "after"]);
  assert.equal(measured.parsed.content.filter(({ type }) => type === "image").length, 2);
  assert.notEqual(measured.value.before.sourceFrameId, measured.value.sourceFrameId);
  assert.deepEqual(reports.slice(calibrationReports).filter(({ op }) => op === "MOVE").map(({ args }) => args), [[1, 1, 0, 0], [-96, -96, 0, 0]]);
  const measuredInputReports = inputOperations();
  // The real fixture is only 2x3 pixels, so no >=12px calibration is possible.
  // This checks packaged result validation, not physical cursor measurement.
  const invalidMeasurement = CallToolResultSchema.parse(await client.callTool({ name: "android_pointer_calibration", arguments: {
    phase: "finish", frameId: measured.value.frameId, probeId: "no-ticket-on-identical-images",
    startX: 1, startY: 2, endX: 0, endY: 0,
  } }));
  assert.equal(invalidMeasurement.isError, true);
  assert.equal(inputOperations(), measuredInputReports, "Submitting an invalid measurement must send no extra hardware input.");
  assert.equal(armed, false);
  results.push({ name: "packaged calibration probe returns both identical images, declares unmeasurable, pauses, issues no finish ticket and never replays input", pass: true });
  const autoFrame = metadata(await client.callTool({ name: "android_screenshot" })).value;
  const autoOperations = inputOperations();
  const inactiveAuto = CallToolResultSchema.parse(await client.callTool({ name: "android_pointer_calibration", arguments: {
    phase: "auto", frameId: autoFrame.frameId,
  } }));
  assert.equal(inactiveAuto.isError, true);
  assert.equal(inactiveAuto.structuredContent.movementAttempted, false);
  assert.equal(inactiveAuto.structuredContent.measurementAvailable, false);
  assert.match(inactiveAuto.structuredContent.message, /Open Pointer calibration/);
  assert.equal(inputOperations(), autoOperations);
  results.push({ name: "packaged auto calibration only reads the phone endpoint; inactive user-opened page sends no input and reports an actionable prerequisite", pass: true });
  const observer = new Client({ name: "exe-readonly-observer", version: "1" }); clients.push(observer);
  await observer.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  metadata(await client.callTool({ name: "android_hid_arm" }));
  metadata(await client.callTool({ name: "android_key_report", arguments: { modifier: 0, keycode: 4 } }));
  assert.equal(heldKey, 4);
  const ownerStart = reports.length;
  const preserved = metadata(await observer.callTool({ name: "android_hid_status" })).value;
  assert.equal(preserved.armed, true); assert.equal(preserved.input.armed, true);
  assert.equal(armed, true); assert.equal(heldKey, 4);
  assert.equal(reports.slice(ownerStart).some(({ op }) => ["STATUS", "RELEASE", "PAUSE"].includes(op)), false,
    "An active owner's recent heartbeat state must not inject an exclusive STATUS or release its held key.");
  const continued = metadata(await client.callTool({ name: "android_key_report", arguments: { modifier: 0, keycode: 5 } })).value;
  assert.equal(continued.armed, true); assert.equal(heldKey, 5);
  assert.equal(reports.slice(ownerStart).some(({ op }) => ["RELEASE", "PAUSE"].includes(op)), false,
    "A cached observer read must not retire or pause the owner's input round.");
  metadata(await client.callTool({ name: "android_key_report", arguments: { modifier: 0, keycode: 0 } }));
  assert.equal(heldKey, 0);
  await observer.close();
  results.push({ name: "two official SDK clients: active STATUS reads recent heartbeat state without a wire barrier and preserves held key plus next input", pass: true });
  await client.close();
  const streamCount = streams.size;
  const duplicate = start(["--no-browser", "--config", configPath]);
  assert.equal(await duplicate.done, 0, duplicate.stderr);
  assert.equal(streams.size, streamCount);
  assert.equal((await readHealth(port)).desktopBuildId, native.buildId);
  results.push({ name: "duplicate EXE launch reuses current service without orphan phone connection", pass: true });
  const oldConfigHash = (await readHealth(port)).desktopConfigHash;
  await writeFile(configPath, JSON.stringify({ ...config, ANDROID_DEVICE_ID: "" }));
  const replacement = start(["--no-browser", "--config", configPath]);
  await waitFor(async () => {
    const state = await readHealth(port);
    return state?.desktopBuildId === native.buildId && state.desktopConfigHash !== oldConfigHash;
  }, `Changed configuration was not applied: ${replacement.stderr}`);
  await waitFor(() => service.exit !== undefined, "Replaced EXE did not exit.");
  assert.equal(service.exit, 0);
  results.push({ name: "changed saved configuration gracefully replaces the owned older service", pass: true });
  const settings = await fetch(`http://127.0.0.1:${port}/desktop/settings`);
  const settingsHtml = await settings.text();
  assert.equal(settings.status, 200); assert.match(settingsHtml, /设备控制器怎样连接电脑/);
  const settingsFixture = bootSettingsHtml(settingsHtml);
  assert.equal(String(settingsFixture.elements.get("local-port").value), String(port));
  assert.ok(settingsFixture.elements.get("mcp-address").textContent.endsWith(`:${port}/mcp`));
  await settingsFixture.elements.get("form").onsubmit({ preventDefault() {} });
  assert.equal(settingsFixture.requests[0].url, "/desktop/settings");
  assert.equal(String(JSON.parse(settingsFixture.requests[0].options.body).ANDROID_MCP_PORT), String(port));
  // Pasting the address displayed on the controller must override the form's
  // old default port, including the full-width colon commonly entered in Chinese.
  const pastedLanConfig = { ...config, ESP_HOST: `127.0.0.1：${espPort}`, ESP_TCP_PORT: "3333" };
  const pastedReportsStart = reports.length;
  bleReady = false;
  const changed = await fetch(`http://127.0.0.1:${port}/desktop/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pastedLanConfig) });
  assert.equal(changed.status, 200);
  const changedResult = await changed.json();
  assert.equal(changedResult.restart, true);
  await waitFor(async () => (await readHealth(port))?.desktopConfigHash === changedResult.configHash, "GUI settings did not apply via service reload.");
  assert.equal((await readHealth(port)).desktopPid, replacement.child.pid);
  assert.equal(replacement.exit, undefined);
  const pastedPersisted = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(pastedPersisted.ANDROID_DEVICE_ID, deviceId);
  assert.equal(pastedPersisted.ESP_HOST, "127.0.0.1");
  assert.equal(pastedPersisted.ESP_TCP_PORT, String(espPort));
  let currentPort = port;
  for (let round = 0; round < 4; round++) {
    const probe = new Client({ name: "exe-reload-handle-probe", version: "1" }); clients.push(probe);
    await probe.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${currentPort}/mcp`)));
    const status = metadata(await probe.callTool({ name: "android_hid_status" })).value;
    assert.equal(status.connected, true);
    if (round === 0) {
      assert.equal(status.ready, false, "LAN status must not require the phone's BLE HID subscription to be ready.");
      assert.equal(status.armed, false);
      assert.ok(reports.slice(pastedReportsStart).some(({ op }) => op === "STATUS"),
        "Packaged MCP status must reach the fixture at the pasted LAN port.");
      assert.equal(reports.slice(pastedReportsStart).some(({ op }) => ["ARM", "MOVE", "KEY", "CONSUMER"].includes(op)), false,
        "Saving a LAN address and reading status must not arm or send phone input.");
      results.push({ name: "GUI pasted full-width LAN host:port overrides default port, persists normalized values and official MCP status works before BLE ready without input", pass: true });
      bleReady = true;
    }
    await probe.close();
    assert.equal(sockets.size, 1, "The old service has a real fixture transport to release.");
    const nextPort = round === 2 ? await unusedPort() : currentPort;
    ownedPorts.add(nextPort);
    const nextConfig = { ...config, ANDROID_DEVICE_ID: round % 2 === 0 ? "" : deviceId, ANDROID_MCP_PORT: String(nextPort) };
    const response = await fetch(`http://127.0.0.1:${currentPort}/desktop/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(nextConfig) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.url, `${deviceBaseUrl(nextPort)}/`);
    await waitFor(async () => (await readHealth(nextPort))?.desktopConfigHash === result.configHash, "Repeated GUI reload did not finish.");
    assert.equal((await readHealth(nextPort)).desktopPid, replacement.child.pid);
    assert.equal(replacement.exit, undefined);
    if (currentPort !== nextPort) {
      assert.equal(await readHealth(currentPort), undefined);
      const checkPort = createTcpServer();
      await new Promise((done, reject) => { checkPort.once("error", reject); checkPort.listen(currentPort, "127.0.0.1", done); });
      await new Promise((done) => checkPort.close(done));
      const status = await fetch(`http://127.0.0.1:${nextPort}/desktop/status`, { headers: { Origin: `http://127.0.0.1:${currentPort}` } });
      assert.equal(status.headers.get("access-control-allow-origin"), `http://127.0.0.1:${currentPort}`);
      assert.equal((await status.json()).desktopConfigHash, result.configHash);
      assert.equal((await fetch(`http://127.0.0.1:${nextPort}/desktop/status`, { headers: { Origin: "http://evil.invalid" } })).status, 403);
    }
    currentPort = nextPort;
    await waitFor(() => streams.size === 1 && sockets.size === 0, "Reload retained old phone/ESP connections.");
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).ANDROID_MCP_PORT, String(nextPort));
  }
  results.push({ name: "GUI connection changes reload five times in the same process; changed port persists and old listeners/connections close", pass: true });
  await stopHttp(replacement, currentPort);
  results.push({ name: "packaged service graceful shutdown releases input and closes listener", pass: true });

  const transport = new StdioClientTransport({ command: executable, args: ["--stdio", "--config", configPath], env: environment, stderr: "pipe" });
  const stdioClient = new Client({ name: "exe-stdio-smoke", version: "1" });
  clients.push(stdioClient);
  await stdioClient.connect(transport);
  assert.ok((await stdioClient.listTools()).tools.some((tool) => tool.name === "android_screenshot"));
  assert.ok(metadata(await stdioClient.callTool({ name: "android_screenshot" })).parsed.content.some((entry) => entry.type === "image"));
  await stdioClient.close();
  results.push({ name: "official MCP stdio client initializes EXE and receives clean protocol with JPEG", pass: true });

  const setupPort = await unusedPort();
  ownedPorts.add(setupPort);
  const setupConfigPath = join(temporary, "first-run-config.json");
  const setup = start(["--no-browser", "--configure", "--config", setupConfigPath]);
  await waitFor(() => /连接设置：http:\/\/(?:localhost|[\d.]+):\d+\//.test(setup.stderr), `Setup page missing: ${setup.stderr}`);
  const setupUrl = /连接设置：(http:\/\/(?:localhost|[\d.]+):\d+\/)/.exec(setup.stderr)[1];
  const setupHtml = await (await fetch(setupUrl)).text();
  assert.match(setupHtml, /设备操作台/); assert.match(setupHtml, /保存并打开操作台/);
  const saved = await fetch(new URL("config", setupUrl), { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...config, ANDROID_MCP_PORT: String(setupPort), PASSWORD: "must-not-persist" }) });
  assert.equal(saved.status, 200, setup.stderr);
  assert.equal((await saved.json()).url, `${deviceBaseUrl(setupPort)}/`);
  const persisted = JSON.parse(await readFile(setupConfigPath, "utf8"));
  assert.equal(persisted.ANDROID_SCREEN_URL, config.ANDROID_SCREEN_URL); assert.equal(persisted.PASSWORD, undefined);
  assert.equal((await readHealth(setupPort)).desktopBuildId, native.buildId);
  await stopHttp(setup, setupPort);
  results.push({ name: "first-run browser setup persists only connection fields and transitions to running service", pass: true });
  let heldHealth;
  const healthGate = createHttpServer((_request, response) => { heldHealth = response; });
  additionalServers.add(healthGate);
  const concurrentPort = await listen(healthGate); ownedPorts.add(concurrentPort);
  const concurrentPath = join(temporary, "concurrent-first-run.json");
  const concurrent = start(["--no-browser", "--configure", "--config", concurrentPath]);
  await waitFor(() => /连接设置：http:\/\/(?:localhost|[\d.]+):\d+\//.test(concurrent.stderr), "Concurrent setup page missing.");
  const concurrentUrl = /连接设置：(http:\/\/(?:localhost|[\d.]+):\d+\/)/.exec(concurrent.stderr)[1];
  const partialPost = (value) => {
    const body = JSON.stringify(value);
    let complete;
    const result = new Promise((done, reject) => {
      const request = httpRequest(new URL("config", concurrentUrl), { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (response) => {
        let text = ""; response.on("data", (chunk) => { text += chunk; }); response.once("end", () => done({ status: response.statusCode, value: JSON.parse(text) }));
      });
      request.once("error", reject); request.setTimeout(5000, () => request.destroy(new Error("Concurrent setup POST timed out.")));
      request.flushHeaders(); request.write(body.slice(0, -1)); complete = () => request.end(body.slice(-1));
    });
    void result.catch(() => {});
    return { result, complete: () => complete() };
  };
  const first = partialPost({ ...config, ANDROID_MCP_PORT: String(concurrentPort) });
  const second = partialPost({ ...config, ANDROID_MCP_PORT: String(concurrentPort), ANDROID_DEVICE_ID: "" });
  await delay(50); first.complete();
  await waitFor(() => Boolean(heldHealth), "First setup did not reach service discovery.");
  second.complete();
  const conflict = await second.result;
  assert.equal(conflict.status, 409);
  assert.equal(JSON.parse(await readFile(concurrentPath, "utf8")).ANDROID_DEVICE_ID, deviceId);
  heldHealth.destroy(); healthGate.closeAllConnections(); await new Promise((done) => healthGate.close(done));
  assert.equal((await first.result).status, 200);
  await stopHttp(concurrent, concurrentPort);
  results.push({ name: "two first-run forms finish reading together: only first configuration is claimed, second gets 409 without overwriting", pass: true });
  const foreign = createHttpServer((_request, response) => response.end("foreign service remains running"));
  const foreignPort = await listen(foreign), recoveredPort = await unusedPort();
  ownedPorts.add(recoveredPort);
  const occupiedPath = join(temporary, "occupied-config.json");
  await writeFile(occupiedPath, JSON.stringify({ ...config, ANDROID_MCP_PORT: String(foreignPort) }));
  const occupied = start(["--no-browser", "--config", occupiedPath]);
  try {
    await waitFor(() => /连接设置：http:\/\/(?:localhost|[\d.]+):\d+\//.test(occupied.stderr), "Occupied port did not open connection settings.");
    const recoveryUrl = /连接设置：(http:\/\/(?:localhost|[\d.]+):\d+\/)/.exec(occupied.stderr)[1];
    assert.match(await (await fetch(recoveryUrl)).text(), /端口.*占用/);
    const response = await fetch(new URL("config", recoveryUrl), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...config, ANDROID_MCP_PORT: String(recoveredPort) }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).url, `${deviceBaseUrl(recoveredPort)}/`);
    assert.equal(await (await fetch(`http://127.0.0.1:${foreignPort}`)).text(), "foreign service remains running");
    await stopHttp(occupied, recoveredPort);
  } finally { foreign.closeAllConnections(); await new Promise((done) => foreign.close(done)); }
  results.push({ name: "occupied foreign port opens a useful settings page, saves alternate port, and leaves foreign service untouched", pass: true });
  const occupiedSetupServer = createHttpServer((_request, response) => response.end("foreign setup fixture"));
  const occupiedSetupPort = await listen(occupiedSetupServer), resolvedSetupPort = await unusedPort(); ownedPorts.add(resolvedSetupPort);
  const retrySetup = start(["--no-browser", "--configure", "--config", join(temporary, "first-run-occupied.json")]);
  try {
    await waitFor(() => /连接设置：http:\/\/(?:localhost|[\d.]+):\d+\//.test(retrySetup.stderr), "Initial occupied setup page missing.");
    const initialUrl = /连接设置：(http:\/\/(?:localhost|[\d.]+):\d+\/)/.exec(retrySetup.stderr)[1];
    const failedSave = await fetch(new URL("config", initialUrl), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...config, ANDROID_MCP_PORT: String(occupiedSetupPort) }) });
    assert.equal(failedSave.status, 500); assert.match((await failedSave.json()).error, /端口.*占用/);
    await waitFor(() => [...retrySetup.stderr.matchAll(/连接设置：(http:\/\/(?:localhost|[\d.]+):\d+\/)/g)].length === 2, "Occupied first setup did not offer alternate settings.");
    const recoveryUrl = [...retrySetup.stderr.matchAll(/连接设置：(http:\/\/(?:localhost|[\d.]+):\d+\/)/g)][1][1];
    await assert.rejects(fetch(initialUrl, { signal: AbortSignal.timeout(500) }));
    const retried = await fetch(new URL("config", recoveryUrl), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...config, ANDROID_MCP_PORT: String(resolvedSetupPort) }) });
    assert.equal(retried.status, 200);
    await stopHttp(retrySetup, resolvedSetupPort);
  } finally { occupiedSetupServer.closeAllConnections(); await new Promise((done) => occupiedSetupServer.close(done)); }
  results.push({ name: "first-run occupied port closes old setup response/listener before recovery; graceful exit leaves no orphan setup server", pass: true });
  await writeFile(join(output, "exe-smoke.json"), `${JSON.stringify({ status: "pass", buildId: native.buildId, timestamp: new Date().toISOString(), results, realDeviceInput: false }, null, 2)}\n`);
  console.log(JSON.stringify({ status: "pass", results, realDeviceInput: false }));
} catch (error) {
  await writeFile(join(output, "exe-smoke-failure.json"), `${JSON.stringify({ error: error.message, fixtureRequest: error.fixtureRequest, results,
    children: children.map((child) => ({ pid: child.pid, exitCode: child.exitCode })),
    processLogs: children.map((child) => ({ stdout: records.get(child).stdout, stderr: records.get(child).stderr })),
    health: await Promise.all([...ownedPorts].map(async (port) => ({ port, health: await readHealth(port) }))),
  }, null, 2)}\n`);
  throw error;
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
  for (const port of ownedPorts) {
    if ((await readHealth(port))?.desktopBuildId === releaseManifest.buildId) {
      await fetch(`http://127.0.0.1:${port}/desktop/quit`, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(() => {});
      await waitFor(async () => !await readHealth(port), "Fixture EXE failed to stop during cleanup.").catch(() => {});
    }
  }
  for (const child of children) if (child.exitCode === null) child.kill();
  for (const server of additionalServers) { server.closeAllConnections(); if (server.listening) await new Promise((done) => server.close(done)); }
  for (const response of streams) response.destroy();
  for (const socket of sockets) socket.destroy();
  await Promise.all([new Promise((done) => phone.close(done)), new Promise((done) => esp.close(done))]);
  await Promise.allSettled(children.filter((child) => child.exitCode === null).map((child) => new Promise((done) => child.once("exit", done))));
  const resolvedTemporary = resolve(temporary), allowedRoot = `${resolve(output)}${sep}`;
  if (!resolvedTemporary.toLowerCase().startsWith(allowedRoot.toLowerCase()) || !basename(resolvedTemporary).startsWith("smoke-")) {
    throw new Error("Refusing cleanup outside the generated EXE smoke-test workspace.");
  }
  await rm(resolvedTemporary, { recursive: true, force: true });
}

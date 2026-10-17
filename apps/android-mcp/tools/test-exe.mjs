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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { deviceBaseUrl } from "./desktop-network.mjs";
import { JPEG_FIXTURE } from "../dist/fixtures/jpeg.js";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const output = join(appRoot, "build", "windows");
const releaseManifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
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
let sourceSequence = 0, snapshotRequests = 0, previewProfile = "standard", armed = false, bleReady = true;
const reports = [];
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
  socket.on("data", (chunk) => {
    buffered += chunk;
    for (;;) {
      const end = buffered.indexOf("\n"); if (end < 0) break;
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      const match = /^QDDHID\/1 (\d+) ([A-Z_]+)(.*)$/.exec(line); assert.ok(match);
      const [, id, op, args] = match;
      reports.push({ op, args: args.trim().split(" ").filter(Boolean).map(Number) });
      if (op === "ARM") armed = true; if (op === "PAUSE") armed = false;
      socket.write(`QDDHID/1 ${id} OK ${JSON.stringify({ v: 1, connected: true, encrypted: true, bonded: true,
        ready: bleReady, locked: false, armed, name: "EXE fixture BLE" })}\n`);
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
  assert.equal(native.status, "ok"); assert.equal(native.node, "24.15.0");
  assert.ok(native.embeddedAssets.includes("native/serialport.node"));
  results.push({ name: "single EXE in empty Chinese/space/# folder, empty PATH, embedded native addon", pass: true });
  const port = await unusedPort();
  ownedPorts.add(port);
  const config = { ANDROID_SCREEN_URL: `http://127.0.0.1:${phonePort}`, ANDROID_DEVICE_ID: deviceId,
    ESP_HOST: "127.0.0.1", ESP_TCP_PORT: String(espPort), ESP_PORT: "COM5", ANDROID_MCP_PORT: String(port) };
  const configPath = join(temporary, "fixture-config.json");
  await writeFile(configPath, JSON.stringify(config));
  const service = start(["--no-browser", "--config", configPath]);
  await waitFor(async () => (await readHealth(port))?.desktopBuildId === native.buildId, `EXE HTTP failed: ${service.stderr}`);
  for (const embedded of releaseManifest.embeddedAssets.filter((asset) => asset.path.startsWith("assets/"))) {
    const asset = basename(embedded.path);
    const response = await fetch(`http://127.0.0.1:${port}/${asset === "operator.html" ? "" : asset}`);
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash("sha256").update(bytes).digest("hex"), embedded.sha256);
    if (asset === "operator.html") assert.match(bytes.toString("utf8"), /href="\/desktop\/settings"/);
    else assert.deepEqual(bytes, await readFile(join(appRoot, "assets", asset)));
  }
  const client = new Client({ name: "exe-http-smoke", version: "1" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === "android_control"));
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
  assert.match(settingsHtml, /get\("local-port"\)\.value=data\.defaults\.ANDROID_MCP_PORT/);
  assert.match(settingsHtml, /ANDROID_MCP_PORT:get\("local-port"\)\.value/);
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
  await writeFile(join(output, "exe-smoke-failure.json"), `${JSON.stringify({ error: error.message, results,
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

#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { JPEG_FIXTURE } from "../dist/fixtures/jpeg.js";

// Everything this soak controls is a loopback fixture. It never opens COM5.
const appRoot = fileURLToPath(new URL("../", import.meta.url));
const output = join(appRoot, "build", "windows");
const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
const temporary = await mkdtemp(join(output, "soak-"));
const directory = join(temporary, "独立 EXE # 无 Node"); await mkdir(directory);
const executable = join(directory, "设备操作台.exe");
await copyFile(join(output, "设备操作台.exe"), executable);
const deviceId = "22222222-2222-4222-8222-222222222222";
const parts = [JPEG_FIXTURE.subarray(0, 2)];
let remaining = 150 * 1024 - JPEG_FIXTURE.length;
while (remaining > 0) {
  const size = Math.min(remaining, 65537), comment = Buffer.alloc(size);
  comment[0] = 0xff; comment[1] = 0xfe; comment.writeUInt16BE(size - 2, 2);
  parts.push(comment); remaining -= size;
}
parts.push(JPEG_FIXTURE.subarray(2));
const jpeg = Buffer.concat(parts); assert.equal(jpeg.length, 150 * 1024);
const streams = new Set(), sockets = new Set(), clients = [], lanes = [];
const reports = [], latencies = [], checkpoints = [];
let sourceId = 0, snapshotId = 0, previewProfile = "standard", armed = false, faultNextMove = false, faultObserved = false, child, stderr = "", reader;
let frames = 0, bytes = 0, lastFrameAt = 0, maxFrameGapMs = 0, screenError;
let lastPreviewProfile;
const profiles = ["turbo", "fast", "standard", "original"];
const frameHeaders = (id, profile) => ({ "Content-Type": "image/jpeg", "Content-Length": String(jpeg.length),
  "X-Device-Id": deviceId, "X-Frame-Id": id, "X-Frame-Age-Ms": "0", "X-Captured-At": new Date().toISOString(),
  "X-Frame-Width": "2", "X-Frame-Height": "3", "X-Device-Width": "2", "X-Device-Height": "3",
  "X-Preview-Profile": profile, "X-Display-Rotation": "0" });
const phone = createHttpServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "qdd-android-screen", deviceId, model: "30fps offline EXE soak", projecting: true })); return;
  }
  if (request.url === "/preview/profile") {
    const send = () => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ profile: previewProfile, deviceWidth: 2, deviceHeight: 3 })); };
    if (request.method === "GET") { send(); return; }
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    let body = ""; request.on("data", (chunk) => { body += chunk; });
    request.once("end", () => {
      let selected;
      try { const value = JSON.parse(body); if (Object.keys(value).length === 1 && profiles.includes(value.profile)) selected = value.profile; } catch { /* Reject malformed fixture requests. */ }
      if (!selected) { response.writeHead(400); response.end(); return; }
      previewProfile = selected; send();
    });
    return;
  }
  if (request.url === "/frame.jpg" && request.method === "GET") {
    // Full captures have their own source IDs and occur after request arrival;
    // a 30fps preview must never masquerade as an original MCP screenshot.
    setImmediate(() => { response.writeHead(200, frameHeaders(`soak-snapshot-${++snapshotId}`, "original")); response.end(jpeg); });
    return;
  }
  if (request.url !== "/stream.mjpg") { response.writeHead(404); response.end(); return; }
  streams.add(response);
  response.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=qdd-frame" });
  const frame = () => {
    if (response.writableLength > 0) return;
    response.cork();
    response.write(`--qdd-frame\r\n${Object.entries(frameHeaders(`soak-${++sourceId}`, previewProfile)).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
    response.write(jpeg); response.write("\r\n"); response.uncork();
  };
  // Windows timer rounding must not turn a nominal 33ms interval into ~21fps.
  let timer, deadline = performance.now();
  const schedule = () => { frame(); deadline += 1000 / 30; timer = setTimeout(schedule, Math.max(0, deadline - performance.now())); };
  schedule();
  response.once("close", () => { clearInterval(timer); streams.delete(response); });
});
const esp = createTcpServer((socket) => {
  sockets.add(socket); socket.once("close", () => sockets.delete(socket));
  socket.on("error", () => {}); let buffered = "";
  socket.on("data", (chunk) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n"); if (newline < 0) break;
      const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
      const match = /^QDDHID\/1 (\d+) ([A-Z_]+)(.*)$/.exec(line); assert.ok(match);
      const [, id, op, values] = match, args = values.trim().split(" ").filter(Boolean).map(Number);
      reports.push({ op, args });
      if (op === "ARM") armed = true; if (op === "PAUSE") armed = false;
      if (faultNextMove && op === "MOVE" && args[0] === 117) {
        faultNextMove = false; faultObserved = true; armed = false; socket.destroy(); return;
      }
      socket.write(`QDDHID/1 ${id} OK ${JSON.stringify({ v: 1, connected: true, encrypted: true, bonded: true, ready: true, locked: false, armed, name: "Offline BLE fixture" })}\n`);
    }
  });
});
const listen = (server) => new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => done(server.address().port)); });
async function unusedPort() { const server = createTcpServer(), port = await listen(server); await new Promise((done) => server.close(done)); return port; }
async function waitFor(check, message, timeout = 5000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) { if (await check()) return; await delay(10); }
  throw new Error(message);
}
let port, origin, baseClient;
async function health() {
  try { return await (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(400) })).json(); } catch { return undefined; }
}
function toolResult(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  return result.structuredContent;
}
async function openLane() {
  const client = new Client({ name: "exe-soak", version: "1" }); clients.push(client);
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`));
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === "android_control"));
  const screenshot = await client.callTool({ name: "android_screenshot" });
  const observed = toolResult(screenshot);
  assert.equal(observed.previewProfile, "original"); assert.match(observed.sourceFrameId, /^soak-snapshot-/u);
  assert.deepEqual(Buffer.from(screenshot.content.find((item) => item.type === "image").data, "base64"), jpeg);
  toolResult(await client.callTool({ name: "android_hid_arm" }));
  const lease = await fetch(`${origin}/remote/lease`, { method: "POST", headers: { "Mcp-Session-Id": transport.sessionId } });
  assert.equal(lease.status, 204);
  const round = lease.headers.get("x-remote-round"); assert.ok(round);
  const socket = new WebSocket(`${origin.replace("http:", "ws:")}/remote/socket`, { origin });
  let sequence = 0, ready = false, failure;
  const pending = new Map();
  socket.on("error", () => {});
  socket.on("message", (bytes) => {
    const data = JSON.parse(bytes.toString());
    if (data.type === "ready") ready = true;
    if (data.type === "error") failure = new Error(data.message);
    if (data.type === "ack") { const item = pending.get(data.sequence); if (item) { pending.delete(data.sequence); latencies.push(performance.now() - item.sent); item.resolve(); } }
  });
  socket.once("close", () => { for (const item of pending.values()) item.reject(failure || new Error("Input socket closed.")); pending.clear(); });
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "hello", sessionId: transport.sessionId, round }));
  await waitFor(() => ready || failure, "WebSocket handshake not ready."); if (failure) throw failure;
  const heartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" })); }, 200);
  const lane = { client, socket, round,
    report(report) {
      return new Promise((resolveReport, reject) => {
        if (socket.readyState !== WebSocket.OPEN) { reject(new Error("Input socket closed.")); return; }
        const current = ++sequence;
        pending.set(current, { resolve: resolveReport, reject, sent: performance.now() });
        socket.send(JSON.stringify({ type: "report", sequence: current, report }));
      });
    },
    async close() { clearInterval(heartbeat); if (socket.readyState === WebSocket.OPEN) { socket.close(); await once(socket, "close"); } else socket.terminate(); await client.close(); },
  };
  lanes.push(lane); baseClient = client; return lane;
}
const mouse = (dx = 0, buttons = 0) => ({ kind: "mouse", dx, dy: 0, wheel: 0, buttons });
const pattern = [mouse(2), mouse(0, 1), mouse(), { kind: "key", modifier: 0, keycode: 4 }, { kind: "key", modifier: 0, keycode: 0 }];
let patternIndex = 0;
async function burst(lane) { await Promise.all(Array.from({ length: 4 }, () => lane.report(pattern[patternIndex++ % pattern.length]))); }
let aborted = false;
try {
  const phonePort = await listen(phone), espPort = await listen(esp); port = await unusedPort(); origin = `http://127.0.0.1:${port}`;
  const config = { ANDROID_SCREEN_URL: `http://127.0.0.1:${phonePort}`, ANDROID_DEVICE_ID: deviceId, ESP_HOST: "127.0.0.1", ESP_TCP_PORT: String(espPort), ESP_PORT: "COM5", ANDROID_MCP_PORT: String(port) };
  const configPath = join(temporary, "fixture.json"); await writeFile(configPath, JSON.stringify(config));
  child = spawn(executable, ["--no-browser", "--config", configPath], { cwd: directory, env: { ...process.env, PATH: "", Path: "", NODE_PATH: "", LOCALAPPDATA: join(temporary, "cache") }, windowsHide: true, stdio: "pipe" });
  child.stderr.on("data", (bytes) => { stderr += bytes; }); child.stdout.resume();
  await waitFor(async () => (await health())?.desktopBuildId === manifest.buildId, `EXE did not start: ${stderr}`);
  const video = await fetch(`${origin}/screen/stream`); assert.equal(video.status, 200); reader = video.body.getReader();
  const consume = (async () => {
    let buffered = Buffer.alloc(0);
    while (!aborted) {
      const part = await reader.read(); if (part.done) return;
      buffered = Buffer.concat([buffered, Buffer.from(part.value)]);
      while (buffered.length >= 8) {
        const jsonSize = buffered.readUInt32BE(0), imageSize = buffered.readUInt32BE(4), size = 8 + jsonSize + imageSize;
        assert.ok(jsonSize < 8192 && imageSize <= 150 * 1024);
        if (buffered.length < size) break;
        const metadata = JSON.parse(buffered.subarray(8, 8 + jsonSize).toString());
        if (metadata.type === "frame") {
          assert.equal(metadata.width, 2); assert.equal(metadata.height, 3);
          assert.equal(metadata.deviceWidth, 2); assert.equal(metadata.deviceHeight, 3);
          assert.ok(profiles.includes(metadata.previewProfile)); lastPreviewProfile = metadata.previewProfile;
          assert.deepEqual(buffered.subarray(8 + jsonSize, size), jpeg);
          const now = performance.now(); if (lastFrameAt) maxFrameGapMs = Math.max(maxFrameGapMs, now - lastFrameAt);
          lastFrameAt = now; frames++; bytes += imageSize;
        } else throw new Error(`Unexpected video loss: ${metadata.message}`);
        buffered = buffered.subarray(size);
      }
    }
  })().catch((error) => { if (!aborted) screenError = error; });
  let lane = await openLane();
  const inputOperations = () => reports.filter(({ op }) => ["ARM", "PAUSE", "MOVE", "KEY", "CONSUMER", "RELEASE"].includes(op)).length;
  const ownerOperations = inputOperations();
  let previousSnapshot;
  for (const profile of profiles) {
    const response = await fetch(`${origin}/screen/profile`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).profile, profile);
    await waitFor(() => lastPreviewProfile === profile || screenError, "Packaged stream did not apply preview quality.");
    if (screenError) throw screenError;
    const snapshotsBefore = snapshotId;
    const screenshot = await baseClient.callTool({ name: "android_screenshot" }), observed = toolResult(screenshot);
    assert.equal(snapshotId, snapshotsBefore + 1);
    assert.equal(observed.previewProfile, "original"); assert.match(observed.sourceFrameId, /^soak-snapshot-/u);
    assert.notEqual(observed.sourceFrameId, previousSnapshot); previousSnapshot = observed.sourceFrameId;
    assert.deepEqual(Buffer.from(screenshot.content.find((item) => item.type === "image").data, "base64"), jpeg);
    assert.equal(armed, true); assert.equal(inputOperations(), ownerOperations, "Preview quality cannot claim or pause the realtime input owner.");
  }
  checkpoints.push({ phase: "four preview profiles preserve the active owner and original MCP captures", frames, snapshots: snapshotId });
  const started = performance.now(), elapsed = () => performance.now() - started;
  const activeUntil = async (deadline) => { while (elapsed() < deadline) { if (screenError) throw screenError; await burst(lane); await delay(80); } };
  await activeUntil(45000); checkpoints.push({ phase: "45s video + four-report bursts", frames, reports: reports.length });
  while (elapsed() < 60000) { if (screenError) throw screenError; await delay(100); }
  assert.ok((await baseClient.listTools()).tools.length >= 20);
  assert.equal(toolResult(await baseClient.callTool({ name: "android_hid_status" })).input.armed, true);
  checkpoints.push({ phase: "15s idle: MCP session and WebSocket lease remain live", frames });
  await lane.close(); await waitFor(() => !armed, "Closing realtime socket did not release input.");
  lane = await openLane(); await burst(lane);
  checkpoints.push({ phase: "intentional WebSocket close, released, fresh SDK session recovered", frames });
  await activeUntil(90000);
  faultNextMove = true;
  await assert.rejects(lane.report(mouse(117)), /closed|disconnect|connection|round|ESP|Serial|socket/i);
  assert.equal(faultObserved, true);
  await lane.close(); lane = await openLane(); await burst(lane);
  assert.equal(reports.filter((item) => item.op === "MOVE" && item.args[0] === 117).length, 1);
  checkpoints.push({ phase: "TCP drops before ACK: failed movement never replayed, fresh connection recovered", frames });
  await activeUntil(120000);
  if (screenError) throw screenError;
  assert.ok(frames >= 2500, `Too few continuous large frames: ${frames}`);
  assert.ok(latencies.length >= 4000, `Too few realtime acknowledged reports: ${latencies.length}`);
  assert.equal(reports.filter((item) => item.op === "MOVE" && item.args[0] === 117).length, 1);
  assert.equal(toolResult(await baseClient.callTool({ name: "android_hid_status" })).input.armed, true);
  await lane.close(); aborted = true; await reader.cancel(); await consume;
  latencies.sort((a, b) => a - b);
  const result = { status: "pass", buildId: manifest.buildId, sha256: manifest.sha256, durationMs: Math.round(elapsed()),
    jpegBytes: jpeg.length, sourceTargetFps: 30, emittedSourceFrames: sourceId, requestedOriginalSnapshots: snapshotId, receivedFrames: frames, receivedImageBytes: bytes, receivedFps: frames / (elapsed() / 1000), maxFrameGapMs,
    acknowledgedReports: latencies.length, fixtureAckMs: { median: latencies[Math.floor(latencies.length / 2)], p95: latencies[Math.floor(latencies.length * 0.95)], max: latencies.at(-1) },
    checkpoints, realDeviceInput: false, timestamp: new Date().toISOString() };
  await writeFile(join(output, "exe-soak.json"), `${JSON.stringify(result, null, 2)}\n`); console.log(JSON.stringify(result));
} catch (error) {
  await writeFile(join(output, "exe-soak-failure.json"), `${JSON.stringify({ error: error.message, frames, reports: reports.length, checkpoints, stderr, realDeviceInput: false }, null, 2)}\n`); throw error;
} finally {
  aborted = true; await reader?.cancel().catch(() => {});
  await Promise.allSettled(lanes.map((lane) => lane.close()));
  await Promise.allSettled(clients.map((client) => client.close()));
  if ((await health())?.desktopBuildId === manifest.buildId) await fetch(`${origin}/desktop/quit`, { method: "POST" }).catch(() => {});
  if (child && child.exitCode === null) await Promise.race([once(child, "exit"), delay(3000)]);
  if (child?.exitCode === null) { child.kill(); await once(child, "exit"); }
  for (const stream of streams) stream.destroy(); for (const socket of sockets) socket.destroy();
  await Promise.all([new Promise((done) => phone.close(done)), new Promise((done) => esp.close(done))]);
  const target = resolve(temporary), allowed = `${resolve(output)}${sep}`;
  if (!target.toLowerCase().startsWith(allowed.toLowerCase()) || !basename(target).startsWith("soak-")) throw new Error("Refusing to clean a non-fixture directory.");
  await rm(target, { recursive: true, force: true });
}

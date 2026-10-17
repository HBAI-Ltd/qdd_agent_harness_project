import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { boardStatus, broadcastAddresses, discoverBoards, fetchBoardStatus } from "../tools/desktop-discovery.mjs";

const deviceId = "33333333-3333-4333-8333-333333333333";
const state = () => ({ service: "qdd-esp-onboarding", version: 1, ip: "127.0.0.1", tcpPort: 3333, deviceName: "QDD-Passport-test",
  phone: { fresh: true, ip: "192.168.1.20", port: 8791, deviceId, projecting: true }, bluetooth: { connected: true, ready: true } });
async function fixture(context, handler) {
  let requests = 0;
  const http = createServer((request, response) => { requests++; if (handler) handler(request, response); else { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(state())); } });
  await new Promise((done) => http.listen(0, "127.0.0.1", done));
  const boardUrl = `http://127.0.0.1:${http.address().port}`;
  const udp = createSocket("udp4"); udp.bind(0, "127.0.0.1"); await once(udp, "listening");
  context.after(async () => { udp.close(); http.closeAllConnections(); await new Promise((done) => http.close(done)); });
  return { http, udp, boardUrl, udpPort: udp.address().port, get requests() { return requests; } };
}

test("board status yields usable phone and control addresses without requiring projection to have started", () => {
  const result = boardStatus(state(), "http://127.0.0.1:3334/");
  assert.equal(result.boardUrl, "http://127.0.0.1:3334");
  assert.equal(result.name, "QDD-Passport-test");
  assert.equal(result.phone.screenUrl, "http://192.168.1.20:8791"); assert.equal(result.phone.deviceId, deviceId);
  assert.equal(boardStatus({ ...state(), phone: { ...state().phone, projecting: false } }, result.boardUrl).phone.projecting, false);
  assert.equal(boardStatus({ ...state(), phone: {} }, result.boardUrl).phone, null);
  assert.equal(boardStatus({ ...state(), phone: { ...state().phone, fresh: false } }, result.boardUrl).phone, null);
  assert.throws(() => boardStatus({ ...state(), ip: "192.168.1.99" }, result.boardUrl));
  assert.throws(() => boardStatus({ ...state(), service: "unrelated-service" }, result.boardUrl));
});

test("broadcast scan covers each private interface and excludes loopback/public interfaces", () => {
  assert.deepEqual(broadcastAddresses({ wifi: [{ family: "IPv4", address: "192.168.101.7", netmask: "255.255.255.0", internal: false }],
    vpn: [{ family: "IPv4", address: "10.65.201.9", netmask: "255.255.255.0", internal: false }],
    ignored: [{ family: "IPv4", address: "127.0.0.1", netmask: "255.0.0.0", internal: true }, { family: "IPv4", address: "8.8.8.8", netmask: "255.255.255.0", internal: false }] }),
  ["255.255.255.255", "192.168.101.255", "10.65.201.255"]);
});

test("real UDP discovery verifies board HTTP status once and retains exact registered phone identity", async (context) => {
  const app = await fixture(context); let discoveryRequest;
  app.udp.on("message", (bytes, peer) => {
    discoveryRequest = bytes.toString();
    const reply = Buffer.from(JSON.stringify({ ...state(), boardUrl: app.boardUrl }));
    for (let index = 0; index < 3; index++) app.udp.send(reply, peer.port, peer.address);
  });
  const results = await discoverBoards({ broadcasts: ["127.0.0.1"], udpPort: app.udpPort, timeoutMs: 150 });
  assert.equal(discoveryRequest, "QDD-DISCOVER/1"); assert.equal(results.length, 1); assert.equal(app.requests, 1);
  assert.equal(results[0].phone.deviceId, deviceId); assert.equal(results[0].ip, "127.0.0.1");
});

test("unrelated, oversized, public and mismatched UDP adverts cannot initiate status requests", async (context) => {
  const app = await fixture(context);
  app.udp.on("message", (_bytes, peer) => {
    for (const reply of ["x".repeat(2049), "not json", JSON.stringify({ ...state(), service: "other", boardUrl: app.boardUrl }),
      JSON.stringify({ ...state(), boardUrl: "http://8.8.8.8:3334" }), JSON.stringify({ ...state(), boardUrl: "http://192.168.1.99:3334" })]) app.udp.send(reply, peer.port, peer.address);
  });
  assert.deepEqual(await discoverBoards({ broadcasts: ["127.0.0.1"], udpPort: app.udpPort, timeoutMs: 100 }), []);
  assert.equal(app.requests, 0);
});

test("saved board HTTP hint works without UDP and malformed/oversized/redirected status remains bounded", async (context) => {
  const app = await fixture(context);
  assert.equal((await discoverBoards({ hints: [app.boardUrl], broadcasts: [], timeoutMs: 100 }))[0].phone.deviceId, deviceId);
  for (const handler of [(_request, response) => response.end("x".repeat(8193)), (_request, response) => { response.writeHead(302, { Location: "http://8.8.8.8/" }); response.end(); },
    (_request, response) => response.end(JSON.stringify({ ...state(), version: 2 }))]) {
    const invalid = await fixture(context, handler);
    await assert.rejects(fetchBoardStatus(invalid.boardUrl, { timeoutMs: 100 }));
  }
});

test("cancellation closes discovery's UDP socket and slow HTTP response within the caller deadline", async (context) => {
  const app = await fixture(context, (_request, response) => { response.writeHead(200); response.write("{"); });
  let senderPort;
  app.udp.on("message", (_bytes, peer) => { senderPort = peer.port; app.udp.send(JSON.stringify({ ...state(), boardUrl: app.boardUrl }), peer.port, peer.address); });
  const controller = new AbortController(), started = performance.now();
  const discovery = discoverBoards({ broadcasts: ["127.0.0.1"], udpPort: app.udpPort, timeoutMs: 1400, signal: controller.signal });
  await new Promise((done) => setTimeout(done, 50)); controller.abort();
  assert.deepEqual(await discovery, []); assert.ok(performance.now() - started < 500);
  const replacement = createSocket("udp4"); replacement.bind(senderPort, "0.0.0.0"); await once(replacement, "listening"); replacement.close();
});

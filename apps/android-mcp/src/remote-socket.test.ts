import assert from "node:assert/strict";
import { once } from "node:events";
import { Agent, createServer, get } from "node:http";
import type { ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { WebSocket } from "ws";
import { attachRemoteSocket } from "./remote-socket.js";
import type { RemoteSocketBinding } from "./remote-socket.js";
import type { InputState, RemoteReport } from "./input.js";
import { lanUrls } from "./lan.js";

const state: InputState = { armed: true, calibrated: false, scaleX: null, scaleY: null,
  positionEstimated: true, pointer: null, screen: { width: 1080, height: 2400, rotation: 0 } };
async function waitFor(check: () => boolean): Promise<void> {
  for (let index = 0; index < 200 && !check(); index += 1) await delay(5);
  assert.ok(check(), "Remote socket did not reach its checkpoint.");
}
async function fixture(lan = false) {
  let binding: RemoteSocketBinding = { sessionId: "operator-session", round: "1", inputEpoch: 1 };
  let armed = true, releases = 0, renewals = 0, binds = 0;
  const reports: { report: RemoteReport; signal: AbortSignal; resolve(state: InputState): void }[] = [];
  const heldHttp: ServerResponse[] = [];
  let queuedHttpArrived = false;
  const server = createServer((request, response) => {
    if (request.url === "/hold") { response.writeHead(200); response.flushHeaders(); heldHttp.push(response); return; }
    if (request.url === "/queued") queuedHttpArrived = true;
    response.end("ok");
  });
  const current = (candidate: RemoteSocketBinding) => armed && candidate.sessionId === binding.sessionId
    && candidate.round === binding.round && candidate.inputEpoch === binding.inputEpoch;
  const remote = attachRemoteSocket(server, {
    bind(sessionId, round) {
      binds++;
      if (sessionId !== binding.sessionId || round !== binding.round || !armed) throw new Error("Unknown operator round.");
      return { ...binding };
    }, current,
    renew(candidate) { assert.equal(current(candidate), true); renewals++; },
    report(candidate, report, signal) {
      assert.equal(current(candidate), true);
      return new Promise<InputState>((resolve, reject) => {
        const abort = () => reject(new Error("Report cancelled."));
        signal.addEventListener("abort", abort, { once: true });
        reports.push({ report, signal, resolve(value) { signal.removeEventListener("abort", abort); resolve(value); } });
      });
    },
    release(candidate) { if (current(candidate)) { releases++; armed = false; } },
  });
  await new Promise<void>((resolve) => server.listen(0, lan ? "0.0.0.0" : "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = lan ? lanUrls(address.port)[0]!.replace(/\/$/u, "") : `http://127.0.0.1:${address.port}`;
  const open = async (round = binding.round) => {
    const socket = new WebSocket(url.replace("http:", "ws:") + "/remote/socket", { origin: url });
    const messages: Record<string, unknown>[] = [];
    socket.on("error", () => {});
    socket.on("message", (bytes) => messages.push(JSON.parse(bytes.toString()) as Record<string, unknown>));
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "hello", sessionId: binding.sessionId, round }));
    await waitFor(() => messages.some((message) => message["type"] === "ready" || message["type"] === "error"));
    return { socket, messages, send(data: unknown) { socket.send(JSON.stringify(data)); } };
  };
  return {
    url, open, reports, heldHttp,
    get releases() { return releases; }, get renewals() { return renewals; }, get binds() { return binds; },
    get queuedHttpArrived() { return queuedHttpArrived; },
    nextRound() { binding = { ...binding, round: String(Number(binding.round) + 1), inputEpoch: binding.inputEpoch + 1 }; armed = true; },
    async close() {
      await remote.close();
      for (const response of heldHttp) response.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("four real socket reports keep wire order while PING bypasses every held acknowledgement", async (context) => {
  const app = await fixture(); context.after(() => app.close());
  const client = await app.open();
  const values: RemoteReport[] = [
    { kind: "mouse", dx: 1, dy: 0, wheel: 0, buttons: 0 },
    { kind: "mouse", dx: 0, dy: 0, wheel: 0, buttons: 1 },
    { kind: "key", modifier: 0, keycode: 4 },
    { kind: "mouse", dx: 0, dy: 0, wheel: 0, buttons: 0 },
  ];
  values.forEach((report, index) => client.send({ type: "report", sequence: index + 1, report }));
  await waitFor(() => app.reports.length === 4);
  assert.deepEqual(app.reports.map(({ report }) => report), values);
  client.send({ type: "ping" });
  await waitFor(() => client.messages.some((message) => message["type"] === "pong"));
  assert.equal(app.renewals, 2);
  assert.equal(client.messages.filter((message) => message["type"] === "ack").length, 0);
  for (const report of [...app.reports].reverse()) report.resolve(state);
  await waitFor(() => client.messages.filter((message) => message["type"] === "ack").length === 4);
  assert.deepEqual(client.messages.filter((message) => message["type"] === "ack").map((message) => message["sequence"]), [4, 3, 2, 1]);
});

test("a full six-connection HTTP pool cannot block the separate realtime lease socket", async (context) => {
  const app = await fixture(); context.after(() => app.close());
  const agent = new Agent({ keepAlive: true, maxSockets: 6 }); context.after(() => agent.destroy());
  const client = await app.open();
  await Promise.all(Array.from({ length: 6 }, () => new Promise<void>((resolve, reject) => {
    get(`${app.url}/hold`, { agent }, (response) => { response.resume(); resolve(); }).on("error", reject);
  })));
  const queued = get(`${app.url}/queued`, { agent }, (response) => response.resume()); queued.on("error", () => {});
  client.send({ type: "report", sequence: 1, report: { kind: "mouse", dx: 1, dy: 0, wheel: 0, buttons: 0 } });
  await waitFor(() => app.reports.length === 1);
  client.send({ type: "ping" });
  await waitFor(() => client.messages.some((message) => message["type"] === "pong"));
  assert.equal(app.queuedHttpArrived, false, "the ordinary seventh HTTP request is still waiting for a pool slot");
  assert.equal(app.renewals, 2);
  app.reports[0]!.resolve(state);
  queued.destroy();
});

test("invalid origin or host is refused before binding any input session", async (context) => {
  const app = await fixture(); context.after(() => app.close());
  for (const options of [{ origin: "https://example.com" }, { headers: { Host: "example.com" } }]) {
    const socket = new WebSocket(app.url.replace("http:", "ws:") + "/remote/socket", options);
    socket.on("error", () => {});
    await assert.rejects(once(socket, "open"), /403/u);
  }
  assert.equal(app.binds, 0); assert.equal(app.releases, 0);
});

test("real private-LAN websocket accepts its page origin and rejects public origins without touching the owner", async (context) => {
  const app = await fixture(true); context.after(() => app.close());
  const owner = await app.open();
  owner.send({ type: "ping" }); await waitFor(() => owner.messages.some((message) => message["type"] === "pong"));
  for (const options of [{ origin: "https://public.example" }, { origin: "null" }, { headers: { Host: "8.8.8.8:8790" } }]) {
    const socket = new WebSocket(app.url.replace("http:", "ws:") + "/remote/socket", options); socket.on("error", () => {});
    await assert.rejects(once(socket, "open"), /403/u);
  }
  assert.equal(app.binds, 1); assert.equal(app.releases, 0);
  owner.send({ type: "report", sequence: 1, report: { kind: "mouse", dx: 1, dy: 0, wheel: 0, buttons: 0 } });
  await waitFor(() => app.reports.length === 1); app.reports[0]!.resolve(state);
  await waitFor(() => owner.messages.some((message) => message["type"] === "ack"));
});

test("a duplicate HELLO cannot release the socket that already owns that round", async (context) => {
  const app = await fixture(); context.after(() => app.close());
  const first = await app.open();
  const duplicate = await app.open();
  assert.ok(duplicate.messages.some((message) => message["type"] === "error"));
  assert.equal(app.releases, 0);
  first.send({ type: "ping" });
  await waitFor(() => first.messages.some((message) => message["type"] === "pong"));
});

test("an unknown HELLO round does not release the legitimate operator", async (context) => {
  const app = await fixture(); context.after(() => app.close());
  const owner = await app.open();
  const wrong = await app.open("not-the-current-round");
  assert.ok(wrong.messages.some((message) => message["type"] === "error"));
  assert.equal(app.releases, 0);
  owner.send({ type: "ping" });
  await waitFor(() => owner.messages.some((message) => message["type"] === "pong"));
});

test("a missing sequence or fifth pending report closes the lane, aborts and never replays input", async (context) => {
  for (const invalid of ["gap", "window"]) await context.test(invalid, async () => {
    const app = await fixture();
    try {
      const client = await app.open();
      const count = invalid === "gap" ? 1 : 5;
      for (let index = 0; index < count; index++) client.send({ type: "report", sequence: invalid === "gap" ? 2 : index + 1,
        report: { kind: "mouse", dx: 1, dy: 0, wheel: 0, buttons: 1 } });
      await waitFor(() => app.releases === 1);
      assert.equal(app.reports.length, invalid === "gap" ? 0 : 4);
      assert.ok(app.reports.every(({ signal }) => signal.aborted));
    } finally { await app.close(); }
  });
});

test("closing an old socket cannot stop a newer operator round", async (context) => {
  const app = await fixture(); context.after(() => app.close());
  const old = await app.open();
  old.send({ type: "report", sequence: 1, report: { kind: "key", modifier: 0, keycode: 4 } });
  await waitFor(() => app.reports.length === 1);
  app.nextRound();
  const next = await app.open();
  old.socket.close();
  await waitFor(() => app.reports[0]!.signal.aborted);
  assert.equal(app.releases, 0);
  next.send({ type: "ping" });
  await waitFor(() => next.messages.some((message) => message["type"] === "pong"));
});

test("acknowledgement timeout aborts held reports and releases without replay", { timeout: 4000 }, async (context) => {
  const app = await fixture(); context.after(() => app.close());
  const client = await app.open();
  client.send({ type: "report", sequence: 1, report: { kind: "mouse", dx: 1, dy: 0, wheel: 0, buttons: 1 } });
  await waitFor(() => app.reports.length === 1);
  await delay(1550);
  assert.equal(app.releases, 1);
  assert.equal(app.reports[0]!.signal.aborted, true);
  assert.equal(app.reports.length, 1);
});

test("binary and oversized socket messages abort held input with bounded parsing", async (context) => {
  for (const invalid of ["binary", "oversized"]) await context.test(invalid, async () => {
    const app = await fixture();
    try {
      const client = await app.open();
      client.send({ type: "report", sequence: 1, report: { kind: "key", modifier: 0, keycode: 4 } });
      await waitFor(() => app.reports.length === 1);
      client.socket.send(invalid === "binary" ? Buffer.from("invalid") : "x".repeat(2049));
      await waitFor(() => app.releases === 1);
      assert.equal(app.reports[0]!.signal.aborted, true);
      assert.equal(app.reports.length, 1);
    } finally { await app.close(); }
  });
});

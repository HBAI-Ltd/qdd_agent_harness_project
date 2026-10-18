import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { WebSocket } from "ws";
import { InputController } from "./input.js";
import { attachRemoteSocket } from "./remote-socket.js";
import { SerialHidBridge } from "./serial.js";
import type { SerialTransport } from "./serial.js";
import { createFixture } from "./fixtures/stdio-server.js";
import { AndroidTools } from "./mcp.js";

test("a remote observer cannot spend the report deadline behind a 900ms STATUS barrier before a legal 900ms mouse ACK", { timeout: 5000 }, async (context) => {
  const writes: { op: string; sentAt: number; acknowledgedAt: number | undefined }[] = [];
  const timers = new Set<NodeJS.Timeout>();
  class Port extends EventEmitter implements SerialTransport {
    isOpen = false;
    armed = false;
    open(callback: (error?: Error | null) => void): void { this.isOpen = true; callback(); }
    write(line: string, callback: (error?: Error | null) => void): void {
      const [, id, op] = line.trim().split(" ");
      const entry = { op: op!, sentAt: performance.now(), acknowledgedAt: undefined as number | undefined };
      writes.push(entry); callback();
      if (op === "ARM") this.armed = true;
      if (op === "PAUSE") this.armed = false;
      const reply = `QDDHID/1 ${id} OK ${JSON.stringify({ v: 1, connected: true, encrypted: true,
        armed: this.armed, locked: false, bonded: true, name: "Offline scheduling fixture" })}\n`;
      const timer = setTimeout(() => {
        timers.delete(timer); entry.acknowledgedAt = performance.now();
        if (this.isOpen) this.emit("data", Buffer.from(reply));
      }, op === "STATUS" || op === "MOVE" ? 900 : 0);
      timers.add(timer);
    }
    close(callback: (error?: Error | null) => void): void {
      // Preserve the independently scheduled ACK timestamp even if the outer
      // socket deadline tears down this fake transport before it is delivered.
      this.isOpen = false;
      this.emit("close"); callback();
    }
  }
  const port = new Port();
  const bridge = new SerialHidBridge({ path: "OFFLINE", portFactory: () => port });
  const input = new InputController(bridge, { width: 1080, height: 2400 });
  await input.arm();
  const server = createServer((_request, response) => response.end());
  const binding = { sessionId: "owner", round: "1", inputEpoch: input.controlEpoch };
  let released = false;
  const remote = attachRemoteSocket(server, {
    bind() { return binding; }, current: () => !released && input.state.armed,
    renew() {}, report(_binding, report, signal) { return input.remoteReport(report, signal); },
    release() { released = true; void input.stop().catch(() => {}); },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/remote/socket`);
  socket.on("error", () => {});
  const messages: Record<string, unknown>[] = [];
  socket.on("message", (bytes) => messages.push(JSON.parse(bytes.toString()) as Record<string, unknown>));
  context.after(async () => {
    socket.terminate(); await remote.close(); await input.stop(); await bridge.close();
    for (const timer of timers) clearTimeout(timer); timers.clear();
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "hello", sessionId: binding.sessionId, round: binding.round }));
  for (let index = 0; index < 100 && !messages.length; index++) await delay(5);
  assert.equal(messages[0]?.["type"], "ready");
  const observer = new AndroidTools(createFixture().adb, input).fork();
  const observed = observer.call("android_hid_status"); void observed.catch(() => {});
  await delay(30);
  socket.send(JSON.stringify({ type: "report", sequence: 1,
    report: { kind: "mouse", dx: 1, dy: 0, wheel: 0, buttons: 0 } }));
  await delay(2000);
  const observation = await observed;
  assert.notEqual(observation.isError, true);
  assert.equal(observation.structuredContent?.["armed"], true);
  const wire = writes.filter(({ op }) => op === "STATUS" || op === "MOVE");
  assert.ok(wire.every(({ sentAt, acknowledgedAt }) => acknowledgedAt !== undefined
    && acknowledgedAt - sentAt >= 850 && acknowledgedAt - sentAt < 1200), JSON.stringify(wire));
  assert.equal(messages.some((message) => message["type"] === "error"), false, JSON.stringify({ messages, wire }));
  assert.equal(messages.filter((message) => message["type"] === "ack").length, 1);
  assert.equal(released, false); assert.equal(input.state.armed, true);
  assert.equal(writes.filter(({ op }) => op === "MOVE").length, 1);
  assert.equal(writes.filter(({ op }) => op === "STATUS").length, 0, "Recent heartbeat status must not insert an exclusive wire query.");
  assert.ok(writes.filter(({ op }) => op === "PING").length >= 5, "Neutral heartbeat continues independently of the mouse ACK.");
});

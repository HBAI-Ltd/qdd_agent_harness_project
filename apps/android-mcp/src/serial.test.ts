import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { SerialHidBridge } from "./serial.js";
import type { SerialTransport } from "./serial.js";
import type { HidStatus } from "./protocol.js";

class FakePort extends EventEmitter implements SerialTransport {
  isOpen = false;
  opens = 0;
  writes: string[] = [];
  hold = "";
  status: HidStatus = { v: 1, connected: true, encrypted: true, armed: false, locked: false, bonded: true, name: "QDD HID" };
  open(callback: (error?: Error | null) => void): void { this.isOpen = true; this.opens += 1; callback(); }
  write(data: string, callback: (error?: Error | null) => void): void {
    this.writes.push(data);
    callback();
    const [, id, op] = data.trim().split(" ");
    if (op === this.hold) return;
    if (op === "ARM") this.status.armed = true;
    if (op === "PAUSE") this.status.armed = false;
    queueMicrotask(() => this.emit("data", Buffer.from(`QDDHID/1 ${id} OK ${JSON.stringify(this.status)}\n`)));
  }
  close(callback: (error?: Error | null) => void): void { this.isOpen = false; this.emit("close"); callback(); }
  disconnect(): void { this.isOpen = false; this.emit("close"); }
}

class LostHandshakePort extends FakePort {
  lostPings = 1;
  onLostPing: (() => void) | undefined;
  override write(data: string, callback: (error?: Error | null) => void): void {
    if (data.endsWith(" PING\n") && this.lostPings > 0) {
      this.lostPings -= 1;
      this.writes.push(data);
      callback();
      this.onLostPing?.();
      return;
    }
    super.write(data, callback);
  }
}

test("serial opens lazily, handshakes paused and PING precedes explicit ARM", async () => {
  const port = new FakePort();
  const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port });
  assert.equal(port.opens, 0);
  await bridge.request("STATUS");
  assert.deepEqual(port.writes.map((line) => line.split(" ")[2]?.trim()), ["PING", "RELEASE", "PAUSE", "STATUS"]);
  const status = await bridge.request("ARM");
  assert.equal(status.armed, true);
  assert.deepEqual(port.writes.slice(-2).map((line) => line.split(" ")[2]?.trim()), ["PING", "ARM"]);
  await bridge.close();
});

test("lost acknowledgement releases reports and never retries the input", async () => {
  const port = new FakePort();
  const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port, timeoutMs: 20 });
  await bridge.request("ARM");
  port.hold = "MOVE";
  await assert.rejects(bridge.request("MOVE", [10, 0, 0, 1]), /not retried/);
  assert.equal(port.writes.filter((line) => line.includes(" MOVE ")).length, 1);
  assert.match(port.writes.at(-1)!, / RELEASE\n$/);
  await bridge.close();
});

test("cold connection retries only its first neutral PING with a new id and remains paused", async () => {
  const port = new LostHandshakePort();
  const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port, timeoutMs: 20 });
  const status = await bridge.request("STATUS");
  assert.equal(status.armed, false);
  assert.equal(port.opens, 1);
  assert.deepEqual(port.writes.map((line) => line.split(" ")[2]?.trim()), ["PING", "PING", "RELEASE", "PAUSE", "STATUS"]);
  assert.notEqual(port.writes[0]!.split(" ")[1], port.writes[1]!.split(" ")[1]);
  await bridge.close();
});

test("a late first PING ACK cannot satisfy the retry, and its timeout closes the same port", async () => {
  const port = new LostHandshakePort();
  port.lostPings = 2;
  port.onLostPing = () => {
    if (port.writes.length === 2) {
      const firstId = port.writes[0]!.split(" ")[1];
      queueMicrotask(() => port.emit("data", Buffer.from(`QDDHID/1 ${firstId} OK ${JSON.stringify(port.status)}\n`)));
    }
  };
  const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port, timeoutMs: 20 });
  await assert.rejects(bridge.request("ARM"), /acknowledgement timed out/);
  assert.equal(port.isOpen, false);
  assert.equal(port.opens, 1);
  assert.deepEqual(port.writes.map((line) => line.split(" ")[2]?.trim()), ["PING", "PING"]);
  await bridge.close();
});

test("closing during the cold PING settle prevents further writes or a queued ARM", async () => {
  const port = new LostHandshakePort();
  const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port, timeoutMs: 20 });
  let closed: Promise<void> | undefined;
  port.onLostPing = () => { setTimeout(() => { closed = bridge.close(); }, 50); };
  await assert.rejects(bridge.request("ARM"), /closing/);
  await closed;
  assert.equal(port.isOpen, false);
  assert.equal(port.writes.length, 1);
  await delay(30);
  assert.equal(port.writes.length, 1);
});

test("transport and malformed protocol faults during cold settle prevent the retry", async (t) => {
  const faults: readonly [string, (port: LostHandshakePort) => void, RegExp][] = [
    ["error", (port) => port.emit("error", new Error("USB fault during settle.")), /USB fault/],
    ["disconnect", (port) => port.disconnect(), /disconnected/],
    ["malformed reply", (port) => port.emit("data", Buffer.from("QDDHID/1 invalid\n")), /Malformed HID reply/],
    ["oversized reply", (port) => port.emit("data", Buffer.alloc(8193, 65)), /reply buffer exceeded/],
  ];
  for (const [name, fault, expected] of faults) {
    await t.test(name, async () => {
      const port = new LostHandshakePort();
      port.onLostPing = () => { setTimeout(() => fault(port), 50); };
      const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port, timeoutMs: 20 });
      await assert.rejects(bridge.request("STATUS"), expected);
      assert.equal(port.writes.length, 1);
      assert.equal(port.isOpen, false);
      await bridge.close();
    });
  }
});

test("non-timeout cold handshake errors are never retried, including timeout-like write errors", async (t) => {
  const failures: readonly [string, string | Error, RegExp][] = [
    ["write error", new Error("ESP32 PING acknowledgement timed out; action was not retried."), /not retried/],
    ["firmware rejection", "ERR BAD_COMMAND", /rejected command: BAD_COMMAND/],
    ["invalid protocol", "OK invalid-json", /Invalid JSON/],
  ];
  for (const [name, failure, expected] of failures) {
    await t.test(name, async () => {
      class FailedHandshakePort extends FakePort {
        override write(data: string, callback: (error?: Error | null) => void): void {
          this.writes.push(data);
          if (failure instanceof Error) { callback(failure); return; }
          callback();
          queueMicrotask(() => this.emit("data", Buffer.from(`QDDHID/1 ${data.split(" ")[1]} ${failure}\n`)));
        }
      }
      const port = new FailedHandshakePort();
      const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port, timeoutMs: 20 });
      await assert.rejects(bridge.request("STATUS"), expected);
      assert.equal(port.writes.length, 1);
      assert.equal(port.isOpen, false);
      await bridge.close();
    });
  }
});

test("ARM watchdog PING and ordinary PING timeouts remain single-attempt requests", async () => {
  const port = new FakePort();
  const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port, timeoutMs: 20 });
  await bridge.request("STATUS");
  port.hold = "PING";
  const beforeArm = port.writes.length;
  await assert.rejects(bridge.request("ARM"), /acknowledgement timed out/);
  assert.deepEqual(port.writes.slice(beforeArm).map((line) => line.split(" ")[2]?.trim()), ["PING", "RELEASE"]);
  const beforePing = port.writes.length;
  await assert.rejects(bridge.request("PING"), /acknowledgement timed out/);
  assert.deepEqual(port.writes.slice(beforePing).map((line) => line.split(" ")[2]?.trim()), ["PING", "RELEASE"]);
  await bridge.close();
});

test("cancelled report releases and stale response cannot resolve a different request", async () => {
  const port = new FakePort();
  const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port });
  await bridge.request("ARM");
  port.hold = "KEY";
  const abort = new AbortController();
  const pending = bridge.request("KEY", [2, 4], abort.signal);
  await delay(0);
  const line = port.writes.at(-1)!;
  abort.abort();
  await assert.rejects(pending, /cancelled/);
  const id = line.split(" ")[1];
  port.emit("data", Buffer.from(`QDDHID/1 ${id} OK ${JSON.stringify(port.status)}\n`));
  assert.equal((await bridge.request("STATUS")).v, 1);
  await bridge.close();
});

test("disconnect clears pending and reconnect never re-arms", async () => {
  const ports = [new FakePort(), new FakePort()];
  let index = 0;
  const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => ports[index++]! });
  await bridge.request("ARM");
  ports[0]!.hold = "KEY";
  const pending = bridge.request("KEY", [0, 4]);
  await delay(0);
  ports[0]!.disconnect();
  await assert.rejects(pending, /disconnected/);
  assert.equal((await bridge.request("STATUS")).armed, false);
  assert.equal(ports[1]!.writes.some((line) => line.includes(" ARM")), false);
  await bridge.close();
});

test("timer heartbeats stop on close and an unconfigured port never opens", async () => {
  const port = new FakePort();
  const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port, heartbeatMs: 10 });
  await bridge.request("STATUS");
  const deadline = Date.now() + 500;
  while (port.writes.filter((line) => line.endsWith(" PING\n")).length < 3 && Date.now() < deadline) await delay(10);
  assert.ok(port.writes.filter((line) => line.endsWith(" PING\n")).length >= 3);
  await bridge.close();
  const count = port.writes.length;
  await delay(25);
  assert.equal(port.writes.length, count);
  const absent = new SerialHidBridge({ path: "", portFactory: () => port });
  await assert.rejects(absent.request("STATUS"), /ESP_PORT is not configured/);
  assert.equal(port.opens, 1);
  await absent.close();
});

test("closing while the port opens cannot send a queued ARM", async () => {
  class SlowPort extends FakePort {
    override open(callback: (error?: Error | null) => void): void {
      this.opens += 1;
      setTimeout(() => { this.isOpen = true; callback(); }, 20);
    }
  }
  const port = new SlowPort();
  const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port });
  const request = bridge.request("ARM");
  const rejected = assert.rejects(request, /closing/);
  await delay(5);
  await bridge.close();
  await rejected;
  assert.equal(port.writes.some((line) => line.includes(" ARM")), false);
  assert.equal(port.isOpen, false);
});

test("serial chunks preserve UTF-8 status names across byte boundaries", async () => {
  class FragmentedPort extends FakePort {
    override write(data: string, callback: (error?: Error | null) => void): void {
      this.writes.push(data);
      callback();
      const id = data.split(" ")[1];
      const bytes = Buffer.from(`QDDHID/1 ${id} OK ${JSON.stringify(this.status)}\n`);
      const split = bytes.indexOf(Buffer.from("中")) + 1;
      queueMicrotask(() => {
        this.emit("data", bytes.subarray(0, split));
        this.emit("data", bytes.subarray(split));
      });
    }
  }
  const port = new FragmentedPort();
  port.status.name = "中文 HID";
  const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port });
  assert.equal((await bridge.request("STATUS")).name, "中文 HID");
  await bridge.close();
});

test("ESP control lines release RTS with DTR enabled before the first PING", async () => {
  class ControlledPort extends FakePort {
    controls: { dtr: boolean; rts: boolean }[] = [];
    set(options: { dtr: boolean; rts: boolean }, callback: (error?: Error | null) => void): void {
      assert.equal(this.isOpen, true);
      assert.deepEqual(this.writes, []);
      this.controls.push(options);
      callback();
    }
  }
  const port = new ControlledPort();
  const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port });
  await bridge.request("STATUS");
  assert.deepEqual(port.controls, [{ dtr: true, rts: false }]);
  assert.match(port.writes[0]!, / PING\n$/);
  await bridge.close();
  assert.equal(port.isOpen, false);
});

test("control line failure closes the target port without sending protocol commands", async () => {
  class FailedControlPort extends FakePort {
    set(_options: { dtr: boolean; rts: boolean }, callback: (error?: Error | null) => void): void {
      callback(new Error("Control line setup failed."));
    }
  }
  const port = new FailedControlPort();
  const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port });
  await assert.rejects(bridge.request("STATUS"), /Control line setup failed/);
  assert.equal(port.isOpen, false);
  assert.deepEqual(port.writes, []);
  await bridge.close();
});

test("a missing control line callback times out and close does not leave a live port", async () => {
  class StalledControlPort extends FakePort {
    set(_options: { dtr: boolean; rts: boolean }, _callback: (error?: Error | null) => void): void {}
  }
  const port = new StalledControlPort();
  const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port, timeoutMs: 20 });
  await assert.rejects(bridge.request("STATUS"), /DTR\/RTS control lines timed out/);
  assert.equal(port.isOpen, false);
  assert.deepEqual(port.writes, []);
  await bridge.close();
});

test("neutral heartbeats continue during continuous slow report acknowledgements", async () => {
  class SlowAckPort extends FakePort {
    override write(data: string, callback: (error?: Error | null) => void): void {
      if (data.includes(" KEY ")) setTimeout(() => super.write(data, callback), 45);
      else super.write(data, callback);
    }
  }
  const port = new SlowAckPort();
  const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port, timeoutMs: 300, heartbeatMs: 20 });
  await bridge.request("ARM");
  const started = Date.now();
  for (let i = 0; i < 12; i += 1) await bridge.request("KEY", [0, i % 2 ? 0 : 4]);
  assert.ok(Date.now() - started >= 500);
  const first = port.writes.findIndex((line) => line.includes(" KEY "));
  const last = port.writes.findLastIndex((line) => line.includes(" KEY "));
  assert.ok(port.writes.slice(first, last).filter((line) => line.endsWith(" PING\n")).length >= 3);
  await bridge.close();
});

class RealtimePort extends FakePort {
  override write(data: string, callback: (error?: Error | null) => void): void {
    if (/ (?:MOVE|KEY) /u.test(data)) { this.writes.push(data); callback(); return; }
    super.write(data, callback);
  }
  reportLines(): string[] { return this.writes.filter((line) => / (?:MOVE|KEY) /u.test(line)); }
  ack(line: string): void {
    this.emit("data", Buffer.from(`QDDHID/1 ${line.split(" ")[1]} OK ${JSON.stringify(this.status)}\n`));
  }
}

test("neutral heartbeat is sent before four slow realtime acknowledgements finish", { timeout: 2000 }, async () => {
  const port = new RealtimePort();
  const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port, timeoutMs: 400, heartbeatMs: 20 });
  await bridge.request("ARM");
  const pingsBefore = port.writes.filter(line => line.endsWith(" PING\n")).length;
  const reports = Array.from({ length: 4 }, () => bridge.requestRealtime("MOVE", [1, 0, 0, 0]));
  try {
    await delay(65);
    assert.equal(port.reportLines().length, 4);
    assert.ok(port.writes.filter(line => line.endsWith(" PING\n")).length > pingsBefore,
      "Heartbeat must refresh the board lease while reports are still awaiting ACKs.");
  } finally {
    for (const line of port.reportLines()) port.ack(line);
    await Promise.allSettled(reports);
    await bridge.close();
  }
});

test("realtime reports submit four ordered writes before ACK and exclusive STATUS is a barrier", async () => {
  const port = new RealtimePort();
  const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port, heartbeatMs: 1400 });
  await bridge.request("ARM");
  const reports = [
    bridge.requestRealtime("MOVE", [1, 0, 0, 0]), bridge.requestRealtime("MOVE", [0, 0, 0, 1]),
    bridge.requestRealtime("KEY", [0, 4]), bridge.requestRealtime("MOVE", [0, 0, 0, 0]),
  ];
  const all = Promise.all(reports);
  await assert.rejects(bridge.requestRealtime("KEY", [0, 0]), /window is full/u);
  const status = bridge.request("STATUS");
  await delay(0);
  assert.deepEqual(port.reportLines().map((line) => line.trim().split(" ").slice(2).join(" ")), [
    "MOVE 1 0 0 0", "MOVE 0 0 0 1", "KEY 0 4", "MOVE 0 0 0 0",
  ]);
  assert.equal(port.writes.some((line) => line.endsWith(" STATUS\n")), false);
  for (const line of [...port.reportLines()].reverse()) port.ack(line);
  await all; await status;
  assert.match(port.writes.at(-1)!, / STATUS\n$/u);
  await bridge.close();
});

test("a missing realtime ACK fails the whole lane, releases and never replays queued reports", async () => {
  const port = new RealtimePort();
  const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port, timeoutMs: 60, heartbeatMs: 1400 });
  await bridge.request("ARM");
  const first = bridge.requestRealtime("MOVE", [1, 0, 0, 1]);
  const second = bridge.requestRealtime("KEY", [0, 4]);
  const results = Promise.allSettled([first, second]);
  await delay(0);
  port.ack(port.reportLines()[1]!);
  const finished = await results;
  assert.equal(finished[0]!.status, "rejected");
  assert.equal(port.reportLines().length, 2);
  assert.deepEqual(port.writes.slice(-2).map((line) => line.trim().split(" ")[2]), ["RELEASE", "PAUSE"]);
  await assert.rejects(bridge.requestRealtime("MOVE", [1, 0, 0, 0]), /arm explicitly/u);
  port.ack(port.reportLines()[0]!); // A late ACK never executes the report again.
  assert.equal(port.reportLines().length, 2);
  await bridge.close();
});

test("realtime cancellation or an unknown ACK rejects every outstanding report without retries", async (context) => {
  for (const cause of ["abort", "unknown"] as const) await context.test(cause, async () => {
    const port = new RealtimePort();
    const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port, heartbeatMs: 1400 });
    await bridge.request("ARM");
    const abort = new AbortController();
    const reports = Promise.allSettled([
      bridge.requestRealtime("MOVE", [1, 0, 0, 1], abort.signal), bridge.requestRealtime("KEY", [0, 4]),
    ]);
    await delay(0);
    if (cause === "abort") abort.abort();
    else port.emit("data", Buffer.from(`QDDHID/1 123456 OK ${JSON.stringify(port.status)}\n`));
    assert.ok((await reports).every((result) => result.status === "rejected"));
    assert.equal(port.reportLines().length, 2);
    assert.equal(port.status.armed, false);
    await bridge.close();
  });
});

test("realtime failure cancels launch waiters behind an exclusive barrier without deadlock", { timeout: 2000 }, async () => {
  const port = new RealtimePort();
  const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port, timeoutMs: 60, heartbeatMs: 1400 });
  await bridge.request("ARM");
  const first = bridge.requestRealtime("MOVE", [1, 0, 0, 1]);
  const exclusive = bridge.request("STATUS");
  const queued = bridge.requestRealtime("KEY", [0, 4]);
  const results = await Promise.allSettled([first, exclusive, queued]);
  assert.equal(results[0]!.status, "rejected");
  assert.equal(results[2]!.status, "rejected");
  assert.equal(port.reportLines().length, 1);
  await bridge.close();
});

test("a failed realtime window drains recovery before explicit ARM starts the next round", { timeout: 2500 }, async () => {
  const port = new RealtimePort();
  const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port, timeoutMs: 60, heartbeatMs: 1400 });
  await bridge.request("ARM");
  const failed = bridge.requestRealtime("MOVE", [1, 0, 0, 1]);
  const failure = assert.rejects(failed, /timed out/u);
  const nextArm = bridge.request("ARM");
  await failure; await nextArm;
  const start = port.writes.length;
  const next = bridge.requestRealtime("MOVE", [-1, 0, 0, 0]);
  await delay(0); port.ack(port.reportLines().at(-1)!); await next;
  await delay(80);
  assert.equal(port.status.armed, true);
  assert.deepEqual(port.writes.slice(start).map((line) => line.trim().split(" ")[2]), ["MOVE"]);
  await bridge.close();
});

class HeldNeutralPort extends FakePort {
  holdNextPing = false;
  heldPing: string | undefined;
  override write(data: string, callback: (error?: Error | null) => void): void {
    if (data.endsWith(" PING\n") && this.holdNextPing) {
      this.holdNextPing = false;
      this.heldPing = data.split(" ")[1];
      this.writes.push(data); callback(); return;
    }
    super.write(data, callback);
  }
}
async function waitForHeldPing(port: HeldNeutralPort): Promise<void> {
  const deadline = Date.now() + 500;
  while (!port.heldPing && Date.now() < deadline) await delay(5);
  assert.ok(port.heldPing, "The neutral heartbeat must reach the test checkpoint");
}

test("an old neutral heartbeat cannot pause a newer explicit ARM or suppress its fresh heartbeat", { timeout: 2500 }, async () => {
  const port = new HeldNeutralPort();
  const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port, timeoutMs: 60, heartbeatMs: 10 });
  await bridge.request("STATUS");
  port.holdNextPing = true; await waitForHeldPing(port);
  await bridge.request("ARM");
  const afterArm = port.writes.length;
  await delay(100);
  assert.equal(port.status.armed, true, "A superseded timer timeout must not send a late PAUSE");
  port.emit("data", Buffer.from(`QDDHID/1 ${port.heldPing} OK ${JSON.stringify({ ...port.status, armed: false })}\n`));
  await delay(0);
  assert.equal(bridge.lastStatus?.armed, true, "A retired timer ACK cannot replace the newer ARM status");
  const operations = port.writes.slice(afterArm).map((line) => line.trim().split(" ")[2]);
  assert.equal(operations.includes("PAUSE"), false);
  assert.ok(operations.filter((op) => op === "PING").length >= 3, "Retiring the old request must free heartbeat scheduling promptly");
  await bridge.close();
});

test("an old connection's neutral heartbeat cannot stop the reconnected and rearmed bridge", { timeout: 2500 }, async () => {
  const ports = [new HeldNeutralPort(), new HeldNeutralPort()];
  let index = 0;
  const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => ports[index++]!, timeoutMs: 60, heartbeatMs: 10 });
  await bridge.request("STATUS");
  ports[0]!.holdNextPing = true; await waitForHeldPing(ports[0]!);
  ports[0]!.disconnect();
  await bridge.request("ARM");
  const afterArm = ports[1]!.writes.length;
  ports[0]!.emit("data", Buffer.from(`QDDHID/1 ${ports[0]!.heldPing} OK ${JSON.stringify(ports[0]!.status)}\n`));
  await delay(100);
  assert.equal(ports[1]!.status.armed, true);
  assert.equal(ports[1]!.writes.slice(afterArm).some((line) => line.endsWith(" PAUSE\n")), false);
  await bridge.close();
});

test("one lost neutral heartbeat ACK does not suppress later heartbeats or pause the current round", { timeout: 2500 }, async (context) => {
  const port = new HeldNeutralPort();
  const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port, timeoutMs: 60, heartbeatMs: 10 });
  context.after(() => bridge.close());
  await bridge.request("ARM");
  port.holdNextPing = true; await waitForHeldPing(port);
  const afterHeld = port.writes.length;
  await delay(120);
  assert.equal(port.status.armed, true, "A later neutral ACK must supersede the single lost ACK without stopping input.");
  const subsequent = port.writes.slice(afterHeld);
  assert.ok(subsequent.filter((line) => line.endsWith(" PING\n")).length >= 2);
  assert.equal(subsequent.some((line) => / (?:RELEASE|PAUSE)\n$/u.test(line)), false);
  port.emit("data", Buffer.from(`QDDHID/1 ${port.heldPing} OK ${JSON.stringify({ ...port.status, armed: false })}\n`));
  await delay(0);
  assert.equal(bridge.lastStatus?.armed, true, "The retired neutral ACK cannot replace a newer acknowledged status.");
  assert.equal(port.opens, 1);
});

test("missing all current-round neutral heartbeat ACKs still releases and pauses input", { timeout: 2500 }, async () => {
  const port = new HeldNeutralPort();
  const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port, timeoutMs: 60, heartbeatMs: 10 });
  await bridge.request("ARM");
  const afterArm = port.writes.length;
  port.hold = "PING";
  await delay(100);
  assert.equal(port.status.armed, false);
  const heartbeatCount = port.writes.slice(afterArm).filter((line) => line.endsWith(" PING\n")).length;
  assert.ok(heartbeatCount >= 2 && heartbeatCount <= 4, "Neutral requests stay bounded while retaining the first original timeout.");
  assert.deepEqual(port.writes.slice(-2).map((line) => line.trim().split(" ")[2]), ["RELEASE", "PAUSE"]);
  await bridge.close();
});

test("a delayed superseded neutral ACK stays retired after high-rate report acknowledgements", { timeout: 2500 }, async (context) => {
  class DelayedNeutralPort extends RealtimePort {
    holdNextPing = false;
    heldPing: string | undefined;
    override write(data: string, callback: (error?: Error | null) => void): void {
      if (data.endsWith(" PING\n") && this.holdNextPing) {
        this.holdNextPing = false; this.heldPing = data.split(" ")[1];
        this.writes.push(data); callback(); return;
      }
      super.write(data, callback);
    }
  }
  const port = new DelayedNeutralPort();
  const bridge = new SerialHidBridge({ path: "FAKE", portFactory: () => port, timeoutMs: 300, heartbeatMs: 10 });
  context.after(() => bridge.close());
  await bridge.request("ARM");
  port.holdNextPing = true; await waitForHeldPing(port);
  await delay(30); // A later neutral acknowledgement supersedes the held ID.
  for (let i = 0; i < 70; i++) {
    const report = bridge.requestRealtime("MOVE", [1, 0, 0, 0]);
    await delay(0); port.ack(port.reportLines().at(-1)!); await report;
  }
  const report = bridge.requestRealtime("MOVE", [0, 0, 0, 0]);
  const result = report.then(() => true, () => false);
  await delay(0);
  port.emit("data", Buffer.from(`QDDHID/1 ${port.heldPing} OK ${JSON.stringify({ ...port.status, armed: false })}\n`));
  await delay(0);
  assert.equal(port.status.armed, true, "An old neutral ACK must not become an unknown ACK after report churn.");
  port.ack(port.reportLines().at(-1)!);
  assert.equal(await result, true);
});

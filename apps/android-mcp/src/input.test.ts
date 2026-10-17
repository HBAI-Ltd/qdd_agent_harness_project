import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { asciiKey, InputController, parseKeyCombo, splitMove } from "./input.js";
import type { SerialBridge } from "./serial.js";
import type { HidOperation, HidStatus } from "./protocol.js";

class FakeBridge implements SerialBridge {
  requestRealtime?: NonNullable<SerialBridge["requestRealtime"]>;
  records: { op: HidOperation; args: readonly number[] }[] = [];
  times: number[] = [];
  status: HidStatus = { v: 1, connected: true, encrypted: true, armed: false, locked: false, bonded: true, name: "QDD HID" };
  reportDelay = 0;
  failNext: HidOperation | undefined;
  async request(op: HidOperation, args: readonly number[] = [], signal?: AbortSignal): Promise<HidStatus> {
    signal?.throwIfAborted();
    this.records.push({ op, args });
    this.times.push(Date.now());
    if (op === this.failNext) { this.failNext = undefined; throw new Error("Device disconnected."); }
    if (op === "ARM") {
      if (this.status.locked) throw new Error("LOCKED");
      this.status.armed = true;
    }
    if (op === "PAUSE") this.status.armed = false;
    if (op === "MOVE" || op === "KEY" || op === "CONSUMER") {
      if (!this.status.armed) throw new Error("NOT_ARMED");
      if (this.reportDelay) await delay(this.reportDelay, undefined, { signal });
    }
    return { ...this.status };
  }
  async close(): Promise<void> {}
}

test("realtime reports overlap ACK waits, preserve edges and drain before ordinary input", async () => {
  const bridge = new FakeBridge(); bridge.reportDelay = 80;
  bridge.requestRealtime = bridge.request.bind(bridge);
  const input = new InputController(bridge, { width: 100, height: 200 });
  await input.arm();
  const before = bridge.records.length;
  const reports = [
    input.remoteReport({ kind: "mouse", dx: 2, dy: 0, wheel: 0, buttons: 0 }),
    input.remoteReport({ kind: "mouse", dx: 0, dy: 0, wheel: 0, buttons: 1 }),
    input.remoteReport({ kind: "key", modifier: 0, keycode: 4 }),
    input.remoteReport({ kind: "mouse", dx: 0, dy: 0, wheel: 0, buttons: 0 }),
  ];
  await assert.rejects(input.remoteReport({ kind: "key", modifier: 0, keycode: 0 }), /window is full/u);
  const ordinary = input.status();
  await delay(0);
  assert.deepEqual(bridge.records.slice(before), [
    { op: "MOVE", args: [2, 0, 0, 0] }, { op: "MOVE", args: [0, 0, 0, 1] },
    { op: "KEY", args: [0, 4] }, { op: "MOVE", args: [0, 0, 0, 0] },
  ]);
  await Promise.all(reports); await ordinary;
  assert.equal(bridge.records.at(-1)!.op, "STATUS");
});

test("pause aborts the realtime window immediately and old reports cannot resume after rearm", async () => {
  const bridge = new FakeBridge(); bridge.reportDelay = 200;
  bridge.requestRealtime = bridge.request.bind(bridge);
  const input = new InputController(bridge, { width: 100, height: 200 });
  await input.arm();
  const reports = Promise.allSettled([
    input.remoteReport({ kind: "mouse", dx: 1, dy: 0, wheel: 0, buttons: 1 }),
    input.remoteReport({ kind: "key", modifier: 0, keycode: 4 }),
  ]);
  await delay(0);
  const paused = input.pause();
  assert.equal(input.state.armed, false);
  assert.ok((await reports).every((result) => result.status === "rejected"));
  await paused;
  const count = bridge.records.filter(({ op }) => op === "MOVE" || op === "KEY").length;
  await input.arm(); await delay(220);
  assert.equal(bridge.records.filter(({ op }) => op === "MOVE" || op === "KEY").length, count);
  assert.equal(input.state.armed, true);
});

test("realtime failure and queued ordinary barriers drain before rearm without stale PAUSE", { timeout: 2500 }, async () => {
  const bridge = new FakeBridge(); bridge.reportDelay = 100; bridge.failNext = "MOVE";
  bridge.requestRealtime = bridge.request.bind(bridge);
  const input = new InputController(bridge, { width: 100, height: 200 });
  await input.arm();
  const first = input.remoteReport({ kind: "mouse", dx: 1, dy: 0, wheel: 0, buttons: 1 });
  const barrier = input.status();
  const queued = input.remoteReport({ kind: "key", modifier: 0, keycode: 4 });
  const results = Promise.allSettled([first, barrier, queued]);
  await results;
  assert.equal(input.state.armed, false);
  assert.equal(bridge.records.filter(({ op }) => op === "MOVE" || op === "KEY").length, 1);
  await input.arm();
  const start = bridge.records.length;
  await input.remoteReport({ kind: "mouse", dx: -1, dy: 0, wheel: 0, buttons: 0 });
  await delay(150);
  assert.equal(input.state.armed, true);
  assert.deepEqual(bridge.records.slice(start).map(({ op }) => op), ["MOVE"]);
});

test("later keyboard ACKs do not discard the latest realtime mouse button state", async () => {
  const bridge = new FakeBridge();
  const acknowledgements: (() => void)[] = [];
  bridge.requestRealtime = async (op, args) => {
    bridge.records.push({ op, args });
    return new Promise<HidStatus>((resolve) => { acknowledgements.push(() => resolve({ ...bridge.status })); });
  };
  const input = new InputController(bridge, { width: 100, height: 200 });
  await input.arm();
  const mouse = input.remoteReport({ kind: "mouse", dx: 0, dy: 0, wheel: 0, buttons: 1 });
  const key = input.remoteReport({ kind: "key", modifier: 0, keycode: 4 });
  await delay(0);
  acknowledgements[1]!(); await key;
  acknowledgements[0]!(); await mouse;
  await input.mouseButton("right", true);
  assert.deepEqual(bridge.records.at(-1), { op: "MOVE", args: [0, 0, 0, 3] });
});

test("screen changes cancel realtime reports and clear host armed state", { timeout: 2000 }, async () => {
  const bridge = new FakeBridge(); bridge.reportDelay = 200;
  bridge.requestRealtime = bridge.request.bind(bridge);
  const input = new InputController(bridge, { width: 100, height: 200 });
  await input.arm();
  const report = input.remoteReport({ kind: "mouse", dx: 1, dy: 0, wheel: 0, buttons: 1 });
  const failed = assert.rejects(report, /abort|cancel/iu);
  await delay(0);
  input.setScreen({ width: 200, height: 100, rotation: 1 });
  assert.equal(input.state.armed, false);
  await failed;
  await input.arm();
  assert.equal(input.state.armed, true);
});

test("US ASCII and keyboard combinations map to HID reports", () => {
  assert.deepEqual(asciiKey("A"), [2, 4]);
  assert.deepEqual(asciiKey("a"), [0, 4]);
  assert.deepEqual(asciiKey("!"), [2, 0x1e]);
  assert.deepEqual(asciiKey("+"), [2, 0x2e]);
  assert.deepEqual(asciiKey("?"), [2, 0x38]);
  assert.deepEqual(parseKeyCombo("ctrl+shift+a"), [3, 4]);
  assert.deepEqual(parseKeyCombo("alt+tab"), [4, 0x2b]);
  assert.deepEqual(parseKeyCombo("F12"), [0, 0x45]);
  assert.throws(() => asciiKey("中"), /ASCII only/);
  assert.throws(() => parseKeyCombo("bogus+a"), /Unknown keyboard modifier/);
});

test("relative moves split into safe reports without losing totals", () => {
  for (const input of [[300, -500, 256], [-128, 127, -1], [0, 0, 0]] as const) {
    const reports = splitMove(input[0], input[1], input[2]);
    assert.ok(reports.every((report) => report.every((value) => value >= -127 && value <= 127)));
    assert.deepEqual([0, 1, 2].map((index) => reports.reduce((sum, report) => sum + report[index]!, 0)), [...input]);
  }
  assert.throws(() => splitMove(0.5, 0), /safe integers/);
  assert.throws(() => splitMove(Number.MAX_SAFE_INTEGER, 0), /too large/);
});

test("absolute tap requires explicit calibration and geometry changes invalidate it", async () => {
  const bridge = new FakeBridge();
  const input = new InputController(bridge, { width: 1080, height: 2400 });
  await input.arm();
  await assert.rejects(input.tap(100, 200), /explicit calibration/);
  assert.equal(bridge.records.some((record) => record.op === "MOVE"), false);
  input.setCalibration(0.5, 0.75);
  await input.arm();
  const state = await input.tap(100, 200);
  assert.equal(state.positionEstimated, true);
  assert.deepEqual(state.pointer, { x: 100, y: 200 });
  assert.ok(bridge.records.filter((record) => record.op === "MOVE" && record.args[0] === -127).length >= 17);
  assert.deepEqual(bridge.records.at(-1), { op: "MOVE", args: [0, 0, 0, 0] });
  assert.equal(input.setScreen({ width: 1080, height: 2400, rotation: 0 }).calibrated, true);
  assert.equal(input.setScreen({ width: 2400, height: 1080, rotation: 1 }).calibrated, false);
  await assert.rejects(input.tap(100, 200), /explicit calibration/);
});

test("raw mouse and clicks do not require absolute calibration", async () => {
  const bridge = new FakeBridge();
  const input = new InputController(bridge, { width: 100, height: 200 });
  await input.arm();
  await input.move(300, -400, 130, 1);
  assert.deepEqual(bridge.records.filter((record) => record.op === "MOVE").map((record) => record.args[3]), [1, 1, 1, 1]);
  await input.click("right");
  assert.deepEqual(bridge.records.slice(-2), [{ op: "MOVE", args: [0, 0, 0, 2] }, { op: "MOVE", args: [0, 0, 0, 0] }]);
  assert.equal(input.state.calibrated, false);
});

test("direct pointer positions once, applies button changes at the destination and retains drag buttons", async () => {
  const bridge = new FakeBridge();
  const input = new InputController(bridge, { width: 200, height: 200, scaleX: 1, scaleY: 1 });
  await input.arm();
  await input.pointerTo(0, 0);
  const homes = bridge.records.filter(({ op, args }) => op === "MOVE" && args[0] === -127).length;
  assert.equal(homes, 4);
  let before = bridge.records.length;
  const pressed = await input.pointerTo(150, 160, 1);
  assert.deepEqual(bridge.records.slice(before), [
    { op: "MOVE", args: [75, 80, 0, 0] }, { op: "MOVE", args: [75, 80, 0, 0] },
    { op: "MOVE", args: [0, 0, 0, 1] },
  ]);
  assert.deepEqual(pressed.pointer, { x: 150, y: 160 });
  before = bridge.records.length;
  const released = await input.pointerTo(100, 100, 0, 1);
  assert.deepEqual(bridge.records.slice(before), [
    { op: "MOVE", args: [-50, -60, 0, 1] }, { op: "MOVE", args: [0, 0, 1, 0] },
  ]);
  assert.equal(bridge.records.filter(({ op, args }) => op === "MOVE" && args[0] === -127).length, homes);
  assert.deepEqual(released.pointer, { x: 100, y: 100 });
  assert.equal(released.calibrated, true);
});

test("direct pointer retains the validated post-ACK cadence across calls and before button changes", { timeout: 5000 }, async (context) => {
  for (const ackDelay of [0, 140]) await context.test(`${ackDelay}ms ACK`, async () => {
    const bridge = new FakeBridge();
    const input = new InputController(bridge, { width: 200, height: 200, scaleX: 1, scaleY: 1 });
    await input.arm(); await input.homePointer();
    const before = bridge.records.length;
    bridge.reportDelay = ackDelay;
    await input.pointerTo(150, 150);
    await input.pointerTo(170, 150, 1);
    const starts = bridge.records.flatMap(({ op, args }, index) => index >= before && op === "MOVE" && (args[0] !== 0 || args[1] !== 0) ? [bridge.times[index]!] : []);
    assert.equal(starts.length, 3);
    const intervals = starts.slice(1).map((time, index) => time - starts[index]!);
    assert.ok(intervals.every((interval) => interval >= ackDelay + 90), `validated 100ms post-ACK cadence must remain: ${intervals}`);
    const press = bridge.records.findLastIndex(({ op, args }) => op === "MOVE" && args[3] === 1);
    assert.ok(bridge.times[press]! - starts.at(-1)! >= ackDelay + 90, "button changes follow the final position report and its settling gap");
  });
});

test("direct pointer keeps rounded HID-count estimates through fractional-scale hover, press, drag and release", { timeout: 5000 }, async (context) => {
  for (const scale of [1.25, 1.5]) await context.test(`scale ${scale}`, async () => {
    const bridge = new FakeBridge();
    const input = new InputController(bridge, { width: 100, height: 100, scaleX: scale, scaleY: scale });
    await input.arm();
    const hover = await input.pointerTo(1, 1);
    assert.deepEqual(hover.pointer, { x: Math.round(scale) / scale, y: Math.round(scale) / scale });
    const homes = bridge.records.filter(({ op, args }) => op === "MOVE" && args[0] === -127).length;
    const before = bridge.records.length;
    assert.notEqual((await input.pointerTo(2, 2, 1)).pointer, null);
    assert.notEqual((await input.pointerTo(3, 4, 1)).pointer, null);
    const released = await input.pointerTo(4, 5, 0);
    assert.deepEqual(released.pointer, { x: Math.round(4 * scale) / scale, y: Math.round(5 * scale) / scale });
    assert.equal(released.positionEstimated, true); assert.equal(released.armed, true);
    assert.equal(bridge.records.filter(({ op, args }) => op === "MOVE" && args[0] === -127).length, homes);
    const later = bridge.records.slice(before).filter(({ op }) => op === "MOVE");
    assert.deepEqual(later.map(({ args }) => args[3]), [0, 1, 1, 1, 0]);
    assert.deepEqual(later.at(-1)?.args, [0, 0, 0, 0]);
  });
});

test("direct pointer requires calibration and refuses to home while an unknown-position button is held", async () => {
  const bridge = new FakeBridge();
  const input = new InputController(bridge, { width: 200, height: 200 });
  await input.arm();
  await assert.rejects(input.pointerTo(1, 2), /explicit calibration/);
  input.setCalibration(1, 1); await input.arm();
  await input.move(0, 0, 0, 1);
  const before = bridge.records.length;
  await assert.rejects(input.pointerTo(1, 2), /unknown while a mouse button is held/);
  assert.deepEqual(bridge.records.slice(before).map(({ op }) => op), ["RELEASE", "PAUSE"]);
  assert.equal(input.state.armed, false);
  assert.throws(() => input.pointerTo(1.5, 2), /safe integers/);
  assert.throws(() => input.pointerTo(200, 2), /inside/);
  assert.throws(() => input.pointerTo(1, 2, 0, 128), /wheel/);
});

test("coordinate frame guards run after queued HID work and fail closed before movement", async (context) => {
  for (const action of ["home", "tap", "swipe"] as const) {
    await context.test(action, async () => {
      const bridge = new FakeBridge();
      const input = new InputController(bridge, { width: 100, height: 200, scaleX: 1, scaleY: 1 });
      await input.arm();
      let started!: () => void, release!: () => void;
      const reportStarted = new Promise<void>((resolve) => { started = resolve; });
      const reportReleased = new Promise<void>((resolve) => { release = resolve; });
      const request = bridge.request.bind(bridge);
      bridge.request = async (op, args = [], signal) => {
        if (op === "KEY" && args[1] === 4) { started(); await reportReleased; }
        return request(op, args, signal);
      };
      const active = input.keyReport(0, 4);
      await reportStarted;
      let fresh = true, checked = false;
      const guard = () => {
        checked = true;
        if (!fresh) throw new Error("Queued frame expired.");
      };
      const queued = action === "home" ? input.homePointer(undefined, guard)
        : action === "tap" ? input.tap(10, 20, undefined, guard)
        : input.swipe(0, 0, 10, 20, 50, undefined, guard);
      const rejected = assert.rejects(queued, /Queued frame expired/);
      assert.equal(checked, false);
      fresh = false;
      release();
      await active;
      await rejected;
      assert.equal(checked, true);
      assert.equal(bridge.records.some(({ op }) => op === "MOVE"), false);
      assert.equal(input.state.armed, false);
      assert.deepEqual(bridge.records.slice(-2).map(({ op }) => op), ["RELEASE", "PAUSE"]);
    });
  }
});

test("ASCII validation happens before typing, and key reports always release", async () => {
  const bridge = new FakeBridge();
  const input = new InputController(bridge, { width: 100, height: 200 });
  await input.arm();
  const before = bridge.records.length;
  assert.throws(() => input.type("hello中"), /ASCII only/);
  assert.equal(bridge.records.length, before);
  await input.type("aA!");
  assert.deepEqual(bridge.records.slice(before), [
    { op: "KEY", args: [0, 4] }, { op: "KEY", args: [0, 0] },
    { op: "KEY", args: [2, 4] }, { op: "KEY", args: [0, 0] },
    { op: "KEY", args: [2, 0x1e] }, { op: "KEY", args: [0, 0] }, { op: "RELEASE", args: [] },
  ]);
  await input.key("ctrl+a");
  assert.deepEqual(bridge.records.slice(-2), [{ op: "KEY", args: [1, 4] }, { op: "KEY", args: [0, 0] }]);
});

test("pause cancels active and already queued actions and releases held reports", async () => {
  const bridge = new FakeBridge();
  const input = new InputController(bridge, { width: 100, height: 200 });
  await input.arm();
  bridge.reportDelay = 30;
  const active = input.type("abcdefgh");
  const queued = input.key("enter");
  const rejectedActive = assert.rejects(active);
  const rejectedQueued = assert.rejects(queued, /Queued input was cancelled/);
  await delay(5);
  await input.pause();
  await rejectedActive; await rejectedQueued;
  assert.equal(bridge.records.filter((record) => record.op === "KEY").length, 1);
  assert.equal(input.state.armed, false);
  assert.deepEqual(bridge.records.slice(-2), [{ op: "RELEASE", args: [] }, { op: "PAUSE", args: [] }]);
});

test("report failure releases, pauses, and requires explicit ARM without repeating action", async () => {
  const bridge = new FakeBridge();
  const input = new InputController(bridge, { width: 100, height: 200, scaleX: 1, scaleY: 1 });
  await input.arm();
  bridge.failNext = "MOVE";
  await assert.rejects(input.move(10, 20, 0, 1), /disconnected/);
  assert.equal(bridge.records.filter((record) => record.op === "MOVE").length, 1);
  assert.deepEqual(bridge.records.slice(-2), [{ op: "RELEASE", args: [] }, { op: "PAUSE", args: [] }]);
  assert.equal(input.state.pointer, null);
  assert.equal(input.state.calibrated, true);
  await assert.rejects(input.key("enter"), /ARM explicitly/);
});

test("physical lock remains until board unlock and navigation uses consumer reports", async () => {
  const bridge = new FakeBridge();
  const input = new InputController(bridge, { width: 100, height: 200 });
  bridge.status.locked = true;
  await assert.rejects(input.arm(), /LOCKED/);
  await input.releaseAll();
  assert.equal(bridge.status.locked, true);
  bridge.status.locked = false;
  await input.arm();
  await input.home(); await input.back();
  assert.deepEqual(bridge.records.slice(-4), [
    { op: "CONSUMER", args: [0x223] }, { op: "CONSUMER", args: [0] },
    { op: "CONSUMER", args: [0x224] }, { op: "CONSUMER", args: [0] },
  ]);
});

test("same-geometry phone switch explicitly resets calibration and cancels old coordinates", async () => {
  const bridge = new FakeBridge();
  const input = new InputController(bridge, { width: 100, height: 200, scaleX: 1, scaleY: 1 });
  await input.arm();
  assert.equal(input.setScreen({ width: 100, height: 200 }).calibrated, true);
  const queued = input.tap(10, 20);
  const rejected = assert.rejects(queued, /Queued input was cancelled/);
  const reset = input.resetCalibration();
  await rejected;
  assert.equal(reset.calibrated, false);
  assert.equal(reset.pointer, null);
  assert.deepEqual(reset.screen, { width: 100, height: 200, rotation: 0 });
  assert.equal(bridge.records.some((record) => record.op === "MOVE"), false);
  await assert.rejects(input.tap(10, 20), /explicit calibration/);
});

test("stopping screenshot-only sessions never touches the lazy serial bridge", async () => {
  const bridge = new FakeBridge();
  const input = new InputController(bridge, { width: 1080, height: 2400 });
  input.setCalibration(1, 1);
  input.setScreen({ width: 1080, height: 2400 });
  const state = await input.stop();
  assert.equal(state.armed, false);
  assert.equal(state.pointer, null);
  assert.deepEqual(bridge.records, []);
  await input.stop();
  assert.deepEqual(bridge.records, []);
  await Promise.all([input.stop(), input.stop()]);
  assert.deepEqual(bridge.records, []);
});

test("stopping before queued ARM starts cancels it without opening the bridge", async () => {
  const bridge = new FakeBridge();
  const input = new InputController(bridge, { width: 100, height: 200 });
  const arm = input.arm();
  const rejected = assert.rejects(arm, /Queued input was cancelled/);
  await input.stop();
  await rejected;
  assert.deepEqual(bridge.records, []);
});

test("stopping a used bridge aborts active input, drops queued input, releases and pauses", async () => {
  const bridge = new FakeBridge();
  const input = new InputController(bridge, { width: 100, height: 200 });
  await input.arm();
  bridge.reportDelay = 30;
  const active = input.type("abcdef");
  const queued = input.key("enter");
  const activeRejected = assert.rejects(active);
  const queuedRejected = assert.rejects(queued, /Queued input was cancelled/);
  await delay(5);
  await input.stop();
  await activeRejected; await queuedRejected;
  assert.equal(bridge.records.filter((record) => record.op === "KEY").length, 1);
  assert.deepEqual(bridge.records.slice(-2), [{ op: "RELEASE", args: [] }, { op: "PAUSE", args: [] }]);
  assert.equal(input.state.armed, false);
});

test("explicit pause and release still access a previously unused bridge", async () => {
  const bridge = new FakeBridge();
  const input = new InputController(bridge, { width: 100, height: 200 });
  await input.pause();
  assert.deepEqual(bridge.records, [{ op: "RELEASE", args: [] }, { op: "PAUSE", args: [] }]);
  const freshBridge = new FakeBridge();
  const freshInput = new InputController(freshBridge, { width: 100, height: 200 });
  await freshInput.releaseAll();
  assert.deepEqual(freshBridge.records, [{ op: "RELEASE", args: [] }]);
});

test("coordinate motion settles after homing, paces packets and waits before clicking", async () => {
  const bridge = new FakeBridge();
  const input = new InputController(bridge, { width: 200, height: 200, scaleX: 1, scaleY: 1 });
  await input.arm();
  await input.tap(150, 150);
  const home = bridge.records.findLastIndex((record) => record.op === "MOVE" && record.args[0] === -127);
  const moves = bridge.records.flatMap((record, index) => record.op === "MOVE" && record.args[0]! > 0 ? [index] : []);
  const press = bridge.records.findIndex((record) => record.op === "MOVE" && record.args[3] === 1);
  assert.equal(moves.length, 2);
  assert.deepEqual(moves.map((index) => bridge.records[index]!.args), [[75, 75, 0, 0], [75, 75, 0, 0]]);
  assert.ok(bridge.times[moves[0]!]! - bridge.times[home]! >= 530);
  assert.ok(bridge.times[moves[1]!]! - bridge.times[moves[0]!]! >= 90);
  assert.ok(bridge.times[press]! - bridge.times[moves[1]!]! >= 90);
  assert.deepEqual(bridge.records.at(-1), { op: "MOVE", args: [0, 0, 0, 0] });
});

test("swipe duration is a minimum and cancelling paced drag always releases", async () => {
  const bridge = new FakeBridge();
  const input = new InputController(bridge, { width: 200, height: 200, scaleX: 1, scaleY: 1 });
  await input.arm();
  const state = await input.swipe(0, 0, 150, 150, 50);
  assert.equal(state.plannedDurationMs, 200);
  const dragIndices = bridge.records.flatMap((record, index) => record.op === "MOVE" && record.args[0]! > 0 && record.args[3] === 1 ? [index] : []);
  assert.equal(dragIndices.length, 2);
  assert.ok(bridge.times[dragIndices[1]!]! - bridge.times[dragIndices[0]!]! >= 90);
  assert.deepEqual(bridge.records.at(-1), { op: "MOVE", args: [0, 0, 0, 0] });
  let started!: () => void;
  const dragStarted = new Promise<void>((resolve) => { started = resolve; });
  const request = bridge.request.bind(bridge);
  bridge.request = async (op, args = [], signal) => {
    const result = await request(op, args, signal);
    if (op === "MOVE" && args[0]! > 0 && args[3] === 1) started();
    return result;
  };
  const abort = new AbortController();
  const drag = input.swipe(0, 0, 150, 150, 200, abort.signal);
  const rejected = assert.rejects(drag);
  await dragStarted;
  abort.abort();
  await rejected;
  assert.deepEqual(bridge.records.slice(-2), [{ op: "RELEASE", args: [] }, { op: "PAUSE", args: [] }]);
  assert.equal(input.state.armed, false);
});

test("coordinate report budget fails before any pointer movement", async () => {
  const bridge = new FakeBridge();
  const input = new InputController(bridge, { width: 1080, height: 2400, scaleX: 20, scaleY: 20 });
  await input.arm();
  await assert.rejects(input.tap(1000, 2300), /300 reports/);
  assert.equal(bridge.records.some((record) => record.op === "MOVE"), false);
});

test("nearby coordinate actions reuse a known position and retain packet pacing", async (context) => {
  const bridge = new FakeBridge();
  const input = new InputController(bridge, { width: 1080, height: 2400, scaleX: 1, scaleY: 1 });
  await input.arm();
  const firstStarted = Date.now();
  await input.tap(540, 1200);
  const firstDuration = Date.now() - firstStarted;
  const firstReports = bridge.records.filter(({ op }) => op === "MOVE");
  assert.equal(firstReports.length, 33);
  assert.equal(firstReports.filter(({ args }) => args[0] === -127 && args[1] === -127).length, 21);
  const before = bridge.records.length;
  const nextStarted = Date.now();
  const second = await input.tap(540, 1300);
  const nextDuration = Date.now() - nextStarted;
  assert.deepEqual(bridge.records.slice(before), [
    { op: "MOVE", args: [0, 100, 0, 0] },
    { op: "MOVE", args: [0, 0, 0, 1] },
    { op: "MOVE", args: [0, 0, 0, 0] },
  ]);
  assert.deepEqual(second.pointer, { x: 540, y: 1300 });
  assert.ok(bridge.times[before + 1]! - bridge.times[before]! >= 90);
  const swipeBefore = bridge.records.length;
  const dragged = await input.swipe(540, 1300, 540, 1400, 50);
  assert.deepEqual(bridge.records.slice(swipeBefore), [
    { op: "MOVE", args: [0, 0, 0, 1] },
    { op: "MOVE", args: [0, 100, 0, 1] },
    { op: "MOVE", args: [0, 0, 0, 0] },
  ]);
  assert.deepEqual(dragged.pointer, { x: 540, y: 1400 });
  assert.equal(dragged.plannedDurationMs, 100);
  const coldBridge = new FakeBridge();
  const coldInput = new InputController(coldBridge, { width: 1080, height: 2400, scaleX: 1, scaleY: 1 });
  await coldInput.arm();
  const coldStarted = Date.now();
  await coldInput.tap(540, 1300);
  const coldDuration = Date.now() - coldStarted;
  const coldReports = coldBridge.records.filter(({ op }) => op === "MOVE").length;
  assert.equal(coldReports, 34);
  context.diagnostic(`1080x2400: first tap ${firstReports.length} MOVE reports / ${firstDuration}ms; same target from unknown position ${coldReports} MOVE reports / ${coldDuration}ms versus nearby known position 3 MOVE reports / ${nextDuration}ms. Saved 31 reports, ${coldDuration - nextDuration}ms measured and 1550ms scheduled waiting, excluding real serial ACK time.`);
});

test("wheel scrolling and keyboard navigation retain position while raw moves invalidate it", async () => {
  const bridge = new FakeBridge();
  const input = new InputController(bridge, { width: 100, height: 200, scaleX: 1, scaleY: 1 });
  await input.arm();
  await input.tap(10, 20);
  const before = bridge.records.length;
  const scrolled = await input.scroll(256);
  assert.deepEqual(bridge.records.slice(before), [
    { op: "MOVE", args: [0, 0, 85, 0] },
    { op: "MOVE", args: [0, 0, 86, 0] },
    { op: "MOVE", args: [0, 0, 85, 0] },
  ]);
  assert.deepEqual(scrolled.pointer, { x: 10, y: 20 });
  await input.key("enter"); await input.home(); await input.back();
  assert.deepEqual(input.state.pointer, { x: 10, y: 20 });
  const next = bridge.records.length;
  await input.tap(20, 30);
  assert.deepEqual(bridge.records[next], { op: "MOVE", args: [10, 10, 0, 0] });
  await input.move(0, 0, 1);
  assert.equal(input.state.pointer, null);
  const raw = bridge.records.length;
  await input.tap(20, 30);
  assert.deepEqual(bridge.records[raw], { op: "MOVE", args: [-127, -127, 0, 0] });
});

test("off-grid fractional targets force rehoming instead of accumulating rounded movement", async () => {
  const bridge = new FakeBridge();
  const input = new InputController(bridge, { width: 100, height: 100, scaleX: 0.5, scaleY: 0.5 });
  await input.arm();
  assert.equal((await input.tap(1, 2)).pointer, null);
  const before = bridge.records.length;
  assert.deepEqual((await input.tap(2, 2)).pointer, { x: 2, y: 2 });
  const afterUnknown = bridge.records.slice(before);
  assert.equal(afterUnknown.filter(({ args }) => args[0] === -127 && args[1] === -127).length, 3);
  assert.ok(afterUnknown.some(({ op, args }) => op === "MOVE" && args[0] === 1 && args[1] === 1));
  const next = bridge.records.length;
  await input.tap(4, 4);
  assert.deepEqual(bridge.records.slice(next), [
    { op: "MOVE", args: [1, 1, 0, 0] },
    { op: "MOVE", args: [0, 0, 0, 1] },
    { op: "MOVE", args: [0, 0, 0, 0] },
  ]);
});

test("an off-grid swipe start cannot make its aligned endpoint reusable", async () => {
  const bridge = new FakeBridge();
  const input = new InputController(bridge, { width: 100, height: 100, scaleX: 0.5, scaleY: 0.5 });
  await input.arm();
  const swipe = await input.swipe(1, 2, 2, 4, 50);
  assert.equal(swipe.pointer, null);
  const before = bridge.records.length;
  await input.tap(2, 4);
  assert.equal(bridge.records.slice(before).filter(({ args }) => args[0] === -127 && args[1] === -127).length, 3);
});

test("pause, release, calibration and phone or rotation changes invalidate reusable positions", async (context) => {
  for (const reason of ["pause", "stop", "release", "calibration", "phone", "rotation", "status"] as const) {
    await context.test(reason, async () => {
      const bridge = new FakeBridge();
      const input = new InputController(bridge, { width: 100, height: 200, scaleX: 1, scaleY: 1 });
      await input.arm();
      await input.tap(10, 20);
      if (reason === "pause") await input.pause();
      else if (reason === "stop") await input.stop();
      else if (reason === "release") await input.releaseAll();
      else if (reason === "calibration") input.setCalibration(1, 1);
      else if (reason === "phone") input.resetCalibration();
      else if (reason === "rotation") input.setScreen({ width: 100, height: 200, rotation: 2 });
      else { bridge.status.armed = false; await input.status(); }
      assert.equal(input.state.pointer, null);
      if (reason === "pause" || reason === "stop" || reason === "status") {
        assert.equal(input.state.armed, false);
        await input.arm();
      }
      if (reason === "phone" || reason === "rotation") {
        assert.equal(input.state.calibrated, false);
        input.setCalibration(1, 1);
      }
      const before = bridge.records.length;
      await input.tap(20, 30);
      assert.deepEqual(bridge.records[before], { op: "MOVE", args: [-127, -127, 0, 0] });
    });
  }
});

test("frame rejection and report failure clear a known position before later coordinates", async (context) => {
  for (const failure of ["frame", "report"] as const) {
    await context.test(failure, async () => {
      const bridge = new FakeBridge();
      const input = new InputController(bridge, { width: 100, height: 200, scaleX: 1, scaleY: 1 });
      await input.arm();
      await input.tap(10, 20);
      const before = bridge.records.length;
      if (failure === "frame") {
        await assert.rejects(input.tap(20, 30, undefined, () => { throw new Error("Frame superseded."); }), /Frame superseded/);
        assert.equal(bridge.records.slice(before).some(({ op }) => op === "MOVE"), false);
      } else {
        bridge.failNext = "MOVE";
        await assert.rejects(input.tap(20, 30), /disconnected/);
        assert.deepEqual(bridge.records[before], { op: "MOVE", args: [10, 10, 0, 0] });
        assert.equal(bridge.records.slice(before).filter(({ op }) => op === "MOVE").length, 1);
      }
      assert.equal(input.state.pointer, null);
      assert.equal(input.state.armed, false);
      await input.arm();
      const next = bridge.records.length;
      await input.tap(20, 30);
      assert.deepEqual(bridge.records[next], { op: "MOVE", args: [-127, -127, 0, 0] });
    });
  }
});

test("known-position swipe still rejects its combined report budget before movement", async () => {
  const bridge = new FakeBridge();
  const input = new InputController(bridge, { width: 200, height: 200, scaleX: 100, scaleY: 100 });
  await input.arm();
  await input.tap(0, 0);
  assert.deepEqual(input.state.pointer, { x: 0, y: 0 });
  const before = bridge.records.length;
  await assert.rejects(input.swipe(199, 199, 0, 0, 50), /300 reports/);
  assert.equal(bridge.records.slice(before).some(({ op }) => op === "MOVE"), false);
  assert.equal(input.state.armed, false);
});

test("pause interrupts reused-coordinate motion and cancels the next queued tap", async () => {
  const bridge = new FakeBridge();
  const input = new InputController(bridge, { width: 100, height: 200, scaleX: 1, scaleY: 1 });
  await input.arm();
  await input.tap(10, 20);
  const before = bridge.records.length;
  let started!: () => void;
  const motionStarted = new Promise<void>((resolve) => { started = resolve; });
  const request = bridge.request.bind(bridge);
  bridge.reportDelay = 30;
  bridge.request = async (op, args = [], signal) => {
    const pending = request(op, args, signal);
    if (op === "MOVE" && args[0] === 10 && args[1] === 10) started();
    return pending;
  };
  const active = input.tap(20, 30);
  const queued = input.tap(30, 40);
  const activeRejected = assert.rejects(active);
  const queuedRejected = assert.rejects(queued, /Queued input was cancelled/);
  await motionStarted;
  await input.pause();
  await activeRejected; await queuedRejected;
  assert.deepEqual(bridge.records.slice(before).filter(({ op }) => op === "MOVE"), [
    { op: "MOVE", args: [10, 10, 0, 0] },
  ]);
  assert.equal(input.state.pointer, null);
  assert.equal(input.state.armed, false);
  assert.deepEqual(bridge.records.slice(-2), [{ op: "RELEASE", args: [] }, { op: "PAUSE", args: [] }]);
});

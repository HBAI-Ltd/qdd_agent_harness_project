import { setTimeout as delay } from "node:timers/promises";
import { aborted, isHidCancellation } from "./serial.js";
import { encodeCommand } from "./protocol.js";
import type { SerialBridge } from "./serial.js";
import type { HidOperation, HidStatus } from "./protocol.js";

export interface ScreenGeometry { width: number; height: number; rotation?: number }
export interface InputOptions extends ScreenGeometry { scaleX?: number; scaleY?: number }
export interface InputState {
  screen: ScreenGeometry;
  calibrated: boolean;
  scaleX: number | null;
  scaleY: number | null;
  positionEstimated: true;
  pointer: { x: number; y: number } | null;
  armed: boolean;
}
export type RemoteReport = { kind: "mouse"; dx: number; dy: number; wheel: number; buttons: number }
  | { kind: "key"; modifier: number; keycode: number };
type KeyReport = readonly [modifier: number, keycode: number];
export type CoordinateGuard = () => void;

const SPECIAL_KEYS: Record<string, number> = {
  enter: 0x28, return: 0x28, esc: 0x29, escape: 0x29, backspace: 0x2a,
  tab: 0x2b, space: 0x2c, capslock: 0x39, printscreen: 0x46, scrolllock: 0x47,
  pause: 0x48, insert: 0x49, home: 0x4a, pageup: 0x4b, delete: 0x4c,
  end: 0x4d, pagedown: 0x4e, right: 0x4f, left: 0x50, down: 0x51, up: 0x52,
};
const MODIFIERS: Record<string, number> = { ctrl: 1, control: 1, shift: 2, alt: 4, meta: 8, gui: 8, win: 8, cmd: 8 };
const PUNCTUATION = "-=[]\\;'`,./";
const PUNCTUATION_CODES = [0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38];
const SHIFTED = "_+{}|:\"~<>?";
const SHIFTED_DIGITS = ")!@#$%^&*(";
const MAX_REPORTS_PER_MOVE = 8192;
const MAX_COORDINATE_REPORTS = 300;
const POINTER_HOME_SETTLE_MS = 550;
const POINTER_REPORT_GAP_MS = 100;

export function asciiKey(character: string): KeyReport {
  if (/^[a-z]$/.test(character)) return [0, character.charCodeAt(0) - 97 + 4];
  if (/^[A-Z]$/.test(character)) return [2, character.charCodeAt(0) - 65 + 4];
  if (/^[0-9]$/.test(character)) return [0, character === "0" ? 0x27 : character.charCodeAt(0) - 49 + 0x1e];
  if (character === " ") return [0, 0x2c];
  if (character === "\n" || character === "\r") return [0, 0x28];
  if (character === "\t") return [0, 0x2b];
  const plain = PUNCTUATION.indexOf(character);
  if (plain >= 0 && character.length === 1) return [0, PUNCTUATION_CODES[plain]!];
  const shifted = SHIFTED.indexOf(character);
  if (shifted >= 0 && character.length === 1) return [2, PUNCTUATION_CODES[shifted]!];
  const digit = SHIFTED_DIGITS.indexOf(character);
  if (digit >= 0 && character.length === 1) return [2, digit === 0 ? 0x27 : 0x1e + digit - 1];
  throw new Error("Text input supports US keyboard ASCII only; select an English hardware keyboard layout on the phone.");
}

export function parseKeyCombo(combo: string): KeyReport {
  const normalized = combo.trim().toLowerCase();
  if (!normalized) throw new Error("A key or key combination is required.");
  if (combo.length === 1) return asciiKey(combo);
  const parts = normalized.split("+");
  let modifier = 0;
  const key = parts.pop()!;
  for (const part of parts) {
    const bit = MODIFIERS[part];
    if (bit === undefined) throw new Error(`Unknown keyboard modifier: ${part}.`);
    modifier |= bit;
  }
  const special = SPECIAL_KEYS[key];
  if (special !== undefined) return [modifier, special];
  if (/^f(?:[1-9]|1[0-2])$/.test(key)) return [modifier, 0x3a + Number(key.slice(1)) - 1];
  if (key.length === 1) {
    const [extra, keycode] = asciiKey(key);
    return [modifier | extra, keycode];
  }
  throw new Error(`Unknown keyboard key: ${key}.`);
}

export function splitMove(dx: number, dy: number, wheel = 0): readonly (readonly [number, number, number])[] {
  if (![dx, dy, wheel].every(Number.isSafeInteger)) throw new Error("Mouse deltas and wheel must be safe integers.");
  const count = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(wheel)) / 127));
  if (count > MAX_REPORTS_PER_MOVE) throw new Error("Mouse movement is too large; split it into smaller calls.");
  const reports: [number, number, number][] = [];
  let lastX = 0, lastY = 0, lastWheel = 0;
  for (let i = 1; i <= count; i += 1) {
    const x = Math.round(dx * i / count), y = Math.round(dy * i / count), w = Math.round(wheel * i / count);
    reports.push([x - lastX, y - lastY, w - lastWheel]);
    lastX = x; lastY = y; lastWheel = w;
  }
  return reports;
}

/** All HID actions use the ESP32 serial bridge. No ADB input commands are used. */
export class InputController {
  private screen: ScreenGeometry;
  private scaleX: number | undefined;
  private scaleY: number | undefined;
  // Reusable only within the current geometry/calibration. Keep the estimated
  // integer HID-count position / scale, never the unquantized requested pixel.
  // This remains an estimate; external mouse motion is not observable here.
  private pointer: { x: number; y: number } | undefined;
  private armed = false;
  private pendingArms = 0;
  private buttons = 0;
  private tail: Promise<void> = Promise.resolve();
  private active: AbortController | undefined;
  private generation = 0;
  private activationEpoch = 0;
  private revision = 0;
  private bridgeUsed = false;
  private readonly remoteReports = new Set<Promise<InputState>>();
  private readonly remoteAborts = new Set<AbortController>();
  private remoteFailure: Promise<void> | undefined;
  private remoteSequence = 0;
  private remoteAcknowledged = 0;

  constructor(private readonly bridge: SerialBridge, options: InputOptions) {
    this.screen = this.validateScreen(options);
    if (options.scaleX !== undefined || options.scaleY !== undefined) {
      this.setCalibration(options.scaleX ?? 1, options.scaleY ?? 1);
    }
  }

  /** Transports awaiting request bytes must not carry input across cancellation. */
  get controlEpoch(): number { return this.generation + this.activationEpoch; }

  /** HID dispatch attempts, including realtime and release reports. ACK failure
   * cannot prove that a report did not reach the phone. Observation/arming do
   * not advance this counter. */
  get inputRevision(): number { return this.revision; }

  get state(): InputState {
    return { screen: { ...this.screen }, calibrated: this.scaleX !== undefined && this.scaleY !== undefined,
      scaleX: this.scaleX ?? null, scaleY: this.scaleY ?? null, positionEstimated: true,
      pointer: this.pointer ? { ...this.pointer } : null, armed: this.armed };
  }

  setScreen(screen: ScreenGeometry): InputState {
    const next = this.validateScreen(screen);
    if (next.width !== this.screen.width || next.height !== this.screen.height || next.rotation !== this.screen.rotation) {
      this.screen = next;
      this.scaleX = undefined; this.scaleY = undefined; this.pointer = undefined;
      // A geometry change invalidates any coordinates queued before it.
      this.generation += 1;
      this.active?.abort(new Error("Device screen geometry changed; calibrate again."));
      this.abortRemote(new Error("Device screen geometry changed; calibrate again."));
    }
    return this.state;
  }

  setCalibration(scaleX: number, scaleY: number): InputState {
    if (![scaleX, scaleY].every((value) => Number.isFinite(value) && value > 0)) {
      throw new Error("Pointer calibration needs positive finite HID counts per screen pixel for both axes.");
    }
    if (Math.max(this.screen.width * scaleX, this.screen.height * scaleY) / 127 > MAX_REPORTS_PER_MOVE - 2) {
      throw new Error("Pointer calibration would exceed the supported movement report limit.");
    }
    this.generation += 1;
    this.active?.abort(new Error("Pointer calibration changed."));
    this.abortRemote(new Error("Pointer calibration changed."));
    this.scaleX = scaleX; this.scaleY = scaleY; this.pointer = undefined;
    return this.state;
  }

  /** Device identity changes invalidate calibration even if both phones have identical geometry. */
  resetCalibration(): InputState {
    this.generation += 1;
    this.active?.abort(new Error("Pointer calibration reset for a different device."));
    this.abortRemote(new Error("Pointer calibration reset for a different device."));
    this.scaleX = undefined; this.scaleY = undefined; this.pointer = undefined;
    return this.state;
  }

  async status(signal?: AbortSignal): Promise<HidStatus & { input: InputState }> {
    aborted(signal);
    // The active control connection already reports status in each heartbeat
    // and input ACK. Observers must not queue an exclusive wire query ahead of
    // reports whose end-to-end socket deadlines are already running.
    const current = this.armed && this.pendingArms === 0 ? this.bridge.controlStatus : undefined;
    if (current) {
      this.observeStatus(current);
      return { ...current, input: this.state };
    }
    return this.enqueue(async (abort) => {
      const status = await this.send("STATUS", [], abort);
      return { ...status, input: this.state };
    }, signal, false, true);
  }

  arm(signal?: AbortSignal): Promise<HidStatus & { input: InputState }> {
    // Re-arming is an explicit new control round, without changing queued HID
    // cancellation semantics. Awaiting HTTP bodies must acquire a new lease.
    this.activationEpoch += 1;
    this.pendingArms += 1;
    this.abortRemote(new Error("A new input control round started."));
    return this.enqueue(async (abort) => {
      await this.send("PING", [], abort);
      const status = await this.send("ARM", [], abort);
      if (!status.armed || status.locked || !status.connected || !status.encrypted || !status.bonded) {
        throw new Error("Device controller did not arm. Pair its keyboard on the phone; select Cancel emergency stop on the controller and confirm there.");
      }
      this.armed = true;
      return { ...status, input: this.state };
    }, signal).finally(() => { this.pendingArms -= 1; });
  }

  /** Emergency stop bypasses older queued actions and aborts the current one before releasing. */
  pause(): Promise<HidStatus & { input: InputState }> {
    this.generation += 1;
    this.armed = false;
    this.active?.abort(new Error("Input paused."));
    this.abortRemote(new Error("Input paused."));
    return this.enqueue(async () => {
      await this.request("RELEASE");
      this.buttons = 0; this.pointer = undefined;
      const status = await this.request("PAUSE");
      return { ...status, input: this.state };
    });
  }

  /** Session cleanup cancels work without opening hardware for screenshot-only sessions. */
  stop(): Promise<InputState> {
    this.generation += 1;
    this.armed = false;
    this.active?.abort(new Error("Input session stopped."));
    this.abortRemote(new Error("Input session stopped."));
    return this.enqueue(async () => {
      this.buttons = 0; this.pointer = undefined;
      if (this.bridgeUsed) {
        await this.request("RELEASE");
        await this.request("PAUSE");
      }
      return this.state;
    }, undefined, true);
  }

  releaseAll(): Promise<InputState> {
    this.generation += 1;
    this.active?.abort(new Error("All HID reports released."));
    this.abortRemote(new Error("All HID reports released."));
    return this.enqueue(async () => {
      await this.request("RELEASE");
      this.buttons = 0; this.pointer = undefined;
      return this.state;
    });
  }

  move(dx: number, dy: number, wheel = 0, buttons = 0, signal?: AbortSignal, frameGuard?: CoordinateGuard): Promise<InputState> {
    const reports = splitMove(dx, dy, wheel);
    this.validateButtons(buttons);
    return this.enqueue(async (abort) => {
      this.requireArmed();
      this.pointer = undefined;
      for (const report of reports) {
        frameGuard?.();
        await this.mouseReport(...report, buttons, abort);
      }
      return this.state;
    }, signal);
  }

  /** Browser reports keep wire order while up to four ACKs are in flight. */
  remoteReport(report: RemoteReport, signal?: AbortSignal): Promise<InputState> {
    const op = report.kind === "mouse" ? "MOVE" : "KEY";
    const args = report.kind === "mouse" ? [report.dx, report.dy, report.wheel, report.buttons]
      : [report.modifier, report.keycode];
    encodeCommand(1, op, args);
    aborted(signal);
    this.requireArmed();
    if (this.remoteReports.size >= 4) return Promise.reject(new Error("Realtime input window is full."));
    const epoch = this.controlEpoch;
    const sequence = ++this.remoteSequence;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    this.remoteAborts.add(controller);
    const task = this.tail.then(async () => {
      aborted(controller.signal);
      if (epoch !== this.controlEpoch) throw new Error("Queued realtime input was cancelled.");
      this.requireArmed();
      this.pointer = undefined;
      this.bridgeUsed = true;
      this.revision += 1;
      const status = await (this.bridge.requestRealtime?.(op, args, controller.signal)
        ?? this.bridge.request(op, args, controller.signal));
      aborted(controller.signal);
      if (epoch !== this.controlEpoch) throw new Error("Realtime input belongs to an expired control round.");
      if (!status.connected || !status.encrypted || !status.bonded || status.locked || !status.armed) {
        throw new Error("ESP32 stopped realtime input; reconnect or clear the physical emergency stop.");
      }
      if (report.kind === "mouse" && sequence >= this.remoteAcknowledged) {
        this.remoteAcknowledged = sequence;
        this.buttons = report.buttons;
      }
      return this.state;
    }).catch(async (error: unknown) => {
      if (epoch === this.controlEpoch) {
        this.generation += 1;
        this.armed = false; this.pointer = undefined; this.buttons = 0;
        this.abortRemote(error);
      }
      if (!this.remoteFailure) {
        const cleanup = (async () => {
          try { await this.request("RELEASE"); } catch { /* board watchdog releases */ }
          try { await this.request("PAUSE"); } catch { /* disconnected */ }
        })();
        this.remoteFailure = cleanup;
        void cleanup.finally(() => { if (this.remoteFailure === cleanup) this.remoteFailure = undefined; });
      }
      await this.remoteFailure;
      throw error;
    }).finally(() => {
      signal?.removeEventListener("abort", abort);
      this.remoteAborts.delete(controller);
    });
    this.remoteReports.add(task);
    void task.then(() => this.remoteReports.delete(task), () => this.remoteReports.delete(task));
    return task;
  }

  mouseButton(button: "left" | "right" | "middle", pressed: boolean, signal?: AbortSignal): Promise<InputState> {
    return this.enqueue(async (abort) => {
      this.requireArmed();
      const bit = { left: 1, right: 2, middle: 4 }[button];
      if (!bit) throw new Error("Unknown mouse button.");
      await this.mouseReport(0, 0, 0, pressed ? this.buttons | bit : this.buttons & ~bit, abort);
      return this.state;
    }, signal);
  }

  click(button: "left" | "right" | "middle" = "left", count: 1 | 2 = 1, signal?: AbortSignal): Promise<InputState> {
    if (count !== 1 && count !== 2) throw new Error("Click count must be 1 or 2.");
    const bit = { left: 1, right: 2, middle: 4 }[button];
    if (!bit) throw new Error("Unknown mouse button.");
    return this.enqueue(async (abort) => {
      this.requireArmed();
      for (let i = 0; i < count; i += 1) {
        await this.mouseReport(0, 0, 0, bit, abort);
        try { await delay(50, undefined, { signal: abort }); }
        finally { await this.request("MOVE", [0, 0, 0, 0]); this.buttons = 0; }
        if (i < count - 1) await delay(80, undefined, { signal: abort });
      }
      return this.state;
    }, signal);
  }

  homePointer(signal?: AbortSignal, frameGuard?: CoordinateGuard): Promise<InputState> {
    return this.enqueue(async (abort) => {
      this.requireArmed();
      frameGuard?.();
      await this.homeInternal(abort);
      return this.state;
    }, signal);
  }

  /** Direct operator coordinates share the validated AI pointer cadence. */
  pointerTo(x: number, y: number, buttons = 0, wheel = 0, signal?: AbortSignal, frameGuard?: CoordinateGuard): Promise<InputState> {
    if (![x, y].every(Number.isSafeInteger)) throw new Error("Pointer coordinates must be safe integers.");
    this.validatePoint(x, y); this.validateButtons(buttons);
    if (!Number.isInteger(wheel) || wheel < -127 || wheel > 127) throw new Error("Pointer wheel must be in -127..127.");
    return this.enqueue(async (abort) => {
      this.requireArmed(); this.requireCalibration();
      frameGuard?.();
      if (!this.pointer && this.buttons !== 0) throw new Error("Pointer position is unknown while a mouse button is held. Pause and start control again.");
      const target = this.coordinateTarget(x, y);
      const origin = this.pointer ?? { x: 0, y: 0 };
      this.coordinateBudget((this.pointer ? 0 : this.homeReportCount()) + this.coordinateReports(target.x - origin.x, target.y - origin.y).length + 1);
      if (!this.pointer) await this.homeInternal(abort);
      // Retain the old buttons through positioning. Press at the destination;
      // for a drag, reach its final destination before releasing there.
      await this.moveTo(target.x, target.y, this.buttons, abort);
      aborted(abort);
      if (buttons !== this.buttons || wheel !== 0) await this.mouseReport(0, 0, wheel, buttons, abort);
      return this.state;
    }, signal);
  }

  /** Move for visual inspection, releasing an old mouse hold before positioning. */
  hover(x: number, y: number, signal?: AbortSignal, frameGuard?: CoordinateGuard): Promise<InputState> {
    this.validatePoint(x, y);
    return this.enqueue(async (abort) => {
      this.requireArmed(); this.requireCalibration();
      frameGuard?.();
      const target = this.coordinateTarget(x, y), origin = this.pointer ?? { x: 0, y: 0 };
      this.coordinateBudget((this.pointer ? 0 : this.homeReportCount())
        + this.coordinateReports(target.x - origin.x, target.y - origin.y).length);
      // pointerTo intentionally preserves held buttons while dragging. Hover
      // must neutralize them first, including when a raw report lost position.
      if (this.buttons !== 0) await this.mouseReport(0, 0, 0, 0, abort);
      if (!this.pointer) await this.homeInternal(abort);
      await this.moveTo(target.x, target.y, 0, abort);
      return this.state;
    }, signal);
  }

  tap(x: number, y: number, signal?: AbortSignal, frameGuard?: CoordinateGuard): Promise<InputState> {
    this.validatePoint(x, y);
    return this.enqueue(async (abort) => {
      this.requireArmed(); this.requireCalibration();
      frameGuard?.();
      const target = this.coordinateTarget(x, y);
      const origin = this.pointer ?? { x: 0, y: 0 };
      this.coordinateBudget((this.pointer ? 0 : this.homeReportCount()) + this.coordinateReports(target.x - origin.x, target.y - origin.y).length);
      if (!this.pointer) await this.homeInternal(abort);
      await this.moveTo(target.x, target.y, 0, abort);
      await this.mouseReport(0, 0, 0, 1, abort);
      try { await delay(50, undefined, { signal: abort }); }
      finally { await this.request("MOVE", [0, 0, 0, 0]); this.buttons = 0; }
      return this.state;
    }, signal);
  }

  swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 400, signal?: AbortSignal, frameGuard?: CoordinateGuard): Promise<InputState & { plannedDurationMs: number }> {
    this.validatePoint(x1, y1); this.validatePoint(x2, y2);
    if (!Number.isFinite(durationMs) || durationMs < 50 || durationMs > 10_000) throw new Error("Swipe duration must be between 50 and 10000 ms.");
    return this.enqueue(async (abort) => {
      this.requireArmed(); this.requireCalibration();
      frameGuard?.();
      const start = this.coordinateTarget(x1, y1), end = this.coordinateTarget(x2, y2);
      const reports = this.coordinateReports(end.x - start.x, end.y - start.y);
      const origin = this.pointer ?? { x: 0, y: 0 };
      this.coordinateBudget((this.pointer ? 0 : this.homeReportCount()) + this.coordinateReports(start.x - origin.x, start.y - origin.y).length + reports.length);
      const plannedDurationMs = Math.max(durationMs, reports.length * POINTER_REPORT_GAP_MS);
      if (!this.pointer) await this.homeInternal(abort);
      await this.moveTo(start.x, start.y, 0, abort);
      const dragOrigin = this.pointer!;
      await this.mouseReport(0, 0, 0, 1, abort);
      try {
        if (reports.length) {
          for (const report of reports) {
            await this.mouseReport(...report, 1, abort);
            await delay(Math.ceil(plannedDurationMs / reports.length), undefined, { signal: abort });
          }
        } else await delay(plannedDurationMs, undefined, { signal: abort });
        this.pointer = this.estimateAfterReports(dragOrigin, reports);
      } finally { await this.request("MOVE", [0, 0, 0, 0]); this.buttons = 0; }
      return { ...this.state, plannedDurationMs };
    }, signal);
  }

  scroll(amount: number, signal?: AbortSignal): Promise<InputState> {
    const reports = splitMove(0, 0, amount);
    return this.enqueue(async (abort) => {
      this.requireArmed();
      // Wheel reports do not move the physical pointer. Raw move() deliberately
      // keeps its existing unknown-position semantics, including wheel-only calls.
      for (const report of reports) await this.mouseReport(...report, 0, abort);
      return this.state;
    }, signal);
  }

  type(text: string, signal?: AbortSignal): Promise<InputState> {
    // Validate the entire string first: Unicode must never type a partial ASCII prefix.
    const reports = [...text].map(asciiKey);
    return this.enqueue(async (abort) => {
      this.requireArmed();
      try {
        for (const report of reports) {
          await this.send("KEY", report, abort);
          await this.send("KEY", [0, 0], abort);
        }
      } finally { await this.request("RELEASE"); this.buttons = 0; }
      return this.state;
    }, signal);
  }

  key(combo: string, signal?: AbortSignal): Promise<InputState> {
    const report = parseKeyCombo(combo);
    return this.enqueue(async (abort) => {
      this.requireArmed();
      try { await this.send("KEY", report, abort); }
      finally { await this.request("KEY", [0, 0]); }
      return this.state;
    }, signal);
  }

  keyReport(modifier: number, keycode: number, signal?: AbortSignal): Promise<InputState> {
    return this.enqueue(async (abort) => {
      this.requireArmed(); await this.send("KEY", [modifier, keycode], abort); return this.state;
    }, signal);
  }

  consumerReport(usage: number, signal?: AbortSignal): Promise<InputState> {
    return this.enqueue(async (abort) => {
      this.requireArmed(); await this.send("CONSUMER", [usage], abort); return this.state;
    }, signal);
  }

  // Linux HID maps AC Home/Back to KEY_HOMEPAGE/KEY_BACK; AOSP Generic.kl maps those to HOME/BACK.
  // Vendor keyboard layouts can override this; phone behavior still needs device verification.
  home(signal?: AbortSignal): Promise<InputState> { return this.consumerKey(0x223, signal); }
  back(signal?: AbortSignal): Promise<InputState> { return this.consumerKey(0x224, signal); }

  private consumerKey(usage: number, signal?: AbortSignal): Promise<InputState> {
    return this.enqueue(async (abort) => {
      this.requireArmed();
      try { await this.send("CONSUMER", [usage], abort); }
      finally { await this.request("CONSUMER", [0]); }
      return this.state;
    }, signal);
  }

  private async homeInternal(signal: AbortSignal): Promise<void> {
    this.requireCalibration();
    const reports = this.homeReportCount();
    this.coordinateBudget(reports);
    for (let i = 0; i < reports; i += 1) await this.mouseReport(-127, -127, 0, 0, signal);
    // Android 13 VelocityControl resets after 500 ms without nonzero motion.
    // Its VelocityTracker also clears after 40 ms. The 100 ms packet cadence
    // below was verified on the connected OnePlus and avoids carry-over gain.
    await delay(POINTER_HOME_SETTLE_MS, undefined, { signal });
    this.pointer = { x: 0, y: 0 };
  }

  private async moveTo(x: number, y: number, buttons: number, signal: AbortSignal): Promise<void> {
    this.validatePoint(x, y);
    const pointer = this.pointer;
    if (!pointer) throw new Error("Pointer position is unknown; home it first.");
    const reports = this.coordinateReports(x - pointer.x, y - pointer.y);
    for (const report of reports) {
      await this.mouseReport(...report, buttons, signal);
      // Wait after the last packet too, before a click/drag can follow it.
      await delay(POINTER_REPORT_GAP_MS, undefined, { signal });
    }
    this.pointer = this.estimateAfterReports(pointer, reports);
  }

  private coordinateTarget(x: number, y: number): { x: number; y: number } {
    // Quantize the destination once, independently of the previous requested
    // pixels. The last legal count is strictly inside the display bounds.
    return {
      x: Math.min(Math.round(x * this.scaleX!), Math.ceil(this.screen.width * this.scaleX!) - 1) / this.scaleX!,
      y: Math.min(Math.round(y * this.scaleY!), Math.ceil(this.screen.height * this.scaleY!) - 1) / this.scaleY!,
    };
  }

  private estimateAfterReports(origin: { x: number; y: number }, reports: readonly (readonly [number, number, number])[]): { x: number; y: number } {
    // Sum actual integer reports, then convert once. Summing pixel deltas (or
    // keeping requested pixels) would accumulate fractional-scale rounding.
    let countsX = Math.round(origin.x * this.scaleX!), countsY = Math.round(origin.y * this.scaleY!);
    for (const [dx, dy] of reports) { countsX += dx; countsY += dy; }
    return { x: countsX / this.scaleX!, y: countsY / this.scaleY! };
  }

  private coordinateReports(dx: number, dy: number): readonly (readonly [number, number, number])[] {
    return splitMove(Math.round(dx * this.scaleX!), Math.round(dy * this.scaleY!))
      .filter(([x, y]) => x !== 0 || y !== 0);
  }

  private homeReportCount(): number {
    return Math.ceil(Math.max(this.screen.width * this.scaleX!, this.screen.height * this.scaleY!) / 127) + 2;
  }

  private coordinateBudget(reports: number): void {
    if (reports > MAX_COORDINATE_REPORTS) throw new Error("Coordinate action exceeds 300 reports; reduce calibration counts per pixel or use raw relative movement.");
  }

  private async mouseReport(dx: number, dy: number, wheel: number, buttons: number, signal: AbortSignal): Promise<void> {
    await this.send("MOVE", [dx, dy, wheel, buttons], signal);
    this.buttons = buttons;
  }

  private async send(op: HidOperation, args: readonly number[], signal: AbortSignal): Promise<HidStatus> {
    aborted(signal);
    const status = await this.request(op, args, signal);
    aborted(signal);
    this.observeStatus(status);
    return status;
  }

  private observeStatus(status: HidStatus): void {
    if (!status.connected || !status.encrypted || !status.bonded || status.locked || !status.armed) {
      if (this.armed) this.activationEpoch += 1;
      this.armed = false; this.pointer = undefined;
    }
  }

  private request(op: HidOperation, args: readonly number[] = [], signal?: AbortSignal): Promise<HidStatus> {
    if (op !== "STATUS") this.bridgeUsed = true;
    if (op === "MOVE" || op === "KEY" || op === "CONSUMER" || op === "RELEASE" || op === "PAUSE") this.revision += 1;
    return this.bridge.request(op, args, signal);
  }

  private enqueue<T>(action: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, cleanup = false, inspection = false): Promise<T> {
    const generation = this.generation;
    const reports = [...this.remoteReports];
    const task = this.tail.then(async () => {
      await Promise.allSettled(reports);
      aborted(signal);
      const independentInspection = inspection && !this.bridgeUsed;
      if (!cleanup && !independentInspection && generation !== this.generation) throw new Error("Queued input was cancelled by pause, release or screen geometry change.");
      const controller = new AbortController();
      // A never-control observer is unrelated to phone projection/geometry.
      // External caller cancellation still reaches its own controller below.
      if (!independentInspection) this.active = controller;
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      try { return await action(controller.signal); }
      catch (error) {
        // A cancelled read-only caller has no authority over another input
        // owner. Internal safety aborts and genuine link failures still clean up.
        if (inspection && isHidCancellation(error, signal) && isHidCancellation(error, controller.signal)) throw error;
        if (inspection && !this.bridgeUsed) throw error;
        this.armed = false; this.pointer = undefined; this.buttons = 0;
        // RELEASE is allowed even when locked/unarmed. Failure relies on the board watchdog.
        try { await this.request("RELEASE"); } catch { /* disconnected */ }
        try { await this.request("PAUSE"); } catch { /* disconnected */ }
        throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
        if (this.active === controller) this.active = undefined;
      }
    });
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }

  private abortRemote(reason: unknown): void {
    if (this.remoteAborts.size) this.armed = false;
    for (const controller of this.remoteAborts) controller.abort(reason);
  }

  private requireArmed(): void { if (!this.armed) throw new Error("ESP32 input is paused. Call ARM explicitly after pairing and physical unlock."); }
  private requireCalibration(): void { if (this.scaleX === undefined || this.scaleY === undefined) throw new Error("Absolute pointer actions need explicit calibration for the current screen geometry."); }
  private validatePoint(x: number, y: number): void {
    if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x >= this.screen.width || y >= this.screen.height) {
      throw new Error(`Pointer coordinates must be inside the ${this.screen.width} x ${this.screen.height} screenshot.`);
    }
  }
  private validateButtons(buttons: number): void { if (!Number.isInteger(buttons) || buttons < 0 || buttons > 7) throw new Error("Mouse buttons must be a bit mask from 0 to 7."); }
  private validateScreen(screen: ScreenGeometry): ScreenGeometry {
    if (![screen.width, screen.height].every((value) => Number.isSafeInteger(value) && value > 0)
      || (screen.rotation !== undefined && ![0, 1, 2, 3].includes(screen.rotation))) {
      throw new Error("Screen geometry needs positive integer width/height and an optional rotation from 0 to 3.");
    }
    return { width: screen.width, height: screen.height, rotation: screen.rotation ?? 0 };
  }
}

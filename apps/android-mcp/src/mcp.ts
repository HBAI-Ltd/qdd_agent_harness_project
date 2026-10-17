import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AdbCapture, AdbDevice } from "./adb.js";
import { asciiKey, InputController, parseKeyCombo, splitMove } from "./input.js";

type Arguments = Record<string, unknown>;
type Properties = Record<string, Record<string, unknown>>;
const integer = (description: string, minimum?: number, maximum?: number) => ({
  type: "integer", description, ...(minimum === undefined ? {} : { minimum }),
  ...(maximum === undefined ? {} : { maximum }),
});
const string = (description: string) => ({ type: "string", description });
const frameId = string("frameId from this MCP session's latest android_screenshot or android_control result of this exact phone, less than 30 seconds old.");
const coordinates: Properties = {
  frameId, x: integer("X coordinate"), y: integer("Y coordinate"),
  coordinateSpace: { type: "string", enum: ["pixels", "normalized1000"], default: "pixels" },
};
function tool(name: string, description: string, properties: Properties = {}, required: string[] = [], readOnly = false): Tool {
  return {
    name, description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false },
  };
}
export const ANDROID_TOOLS: Tool[] = [
  tool("android_devices", "Read the configured LAN screen-sharing App's device identity and list available ESP32 serial ports. Does not open a serial port or scan the network.", {}, [], true),
  tool("android_screenshot", "Read a fresh original-resolution JPEG from the installed device screen-sharing App at its configured LAN address. Returns an MCP image and this session's frameId. The phone must have granted screen-sharing permission.", { deviceSerial: string("Exact screen App device UUID; when provided it must match the configured endpoint's phone.") }, [], true),
  tool("android_control", "Preferred observe-act-observe tool: use this session's screenshot frameId, send one ESP32 BLE action, and return a new phone image captured after the action completed. Prepares input automatically; the physical emergency stop always wins. move/click/scroll/key/type/home/back need no pointer calibration. tap/swipe retain explicit measured calibration and estimated coordinates. Never repeat an action just because its resulting image timed out.", {
    action: { type: "string", enum: ["move", "click", "scroll", "key", "type", "home", "back", "tap", "swipe", "wait"] },
    frameId, dx: integer("Relative horizontal HID counts for move"), dy: integer("Relative vertical HID counts for move"),
    button: { type: "string", enum: ["left", "right", "middle"] }, count: integer("Click count, default 1", 1, 2),
    amount: integer("Signed wheel counts for scroll"), combo: string("Keyboard key/chord for key"), text: string("US-layout ASCII for type"),
    x: integer("Estimated screenshot X for tap"), y: integer("Estimated screenshot Y for tap"),
    x1: integer("Swipe start X"), y1: integer("Swipe start Y"), x2: integer("Swipe end X"), y2: integer("Swipe end Y"),
    coordinateSpace: coordinates["coordinateSpace"]!, durationMs: integer("Minimum swipe duration, default 400 ms", 50, 10000),
    waitMs: integer("Wait before observing, only for wait; default 200 ms", 0, 3000),
  }, ["action", "frameId"]),
  tool("android_hid_status", "Read BLE connection, authentication, physical stop lock, armed state and pointer calibration from the ESP32 bridge.", {}, [], true),
  tool("android_hid_arm", "Explicitly arm authenticated BLE keyboard/mouse input. A physical stop lock must first be cleared on the device controller: select Cancel emergency stop and confirm there. The computer cannot unlock it."),
  tool("android_hid_pause", "Immediately cancel queued computer input, release all held keys/buttons and disarm. Does not clear the physical stop lock."),
  tool("android_release", "Cancel queued input and release all held keyboard keys, mouse buttons and consumer keys."),
  tool("android_calibrate_pointer", "Set measured HID counts per screenshot pixel. This does not infer mouse acceleration or prove accuracy. Recalibrate after any phone rotation, pointer speed or keyboard/mouse setting change.", {
    frameId,
    scaleX: { type: "number", exclusiveMinimum: 0, description: "Horizontal HID counts per screenshot pixel." },
    scaleY: { type: "number", exclusiveMinimum: 0, description: "Vertical HID counts per screenshot pixel." },
    rotation: integer("Operator-reported display rotation, 0, 1, 2 or 3. A change invalidates old calibration.", 0, 3),
  }, ["frameId", "scaleX", "scaleY"]),
  tool("android_pointer_home", "Move the calibrated relative mouse into the top-left corner and reset its estimated position. Requires explicit calibration and armed HID.", { frameId }, ["frameId"]),
  tool("android_mouse_move", "Move the real BLE mouse by relative HID counts. No calibration required. buttons is a held-button bit mask (left=1,right=2,middle=4); always release after a drag.", {
    dx: integer("Relative horizontal HID counts"), dy: integer("Relative vertical HID counts"),
    wheel: integer("Relative wheel counts, default 0"), buttons: integer("Held button bit mask, default 0", 0, 7),
  }, ["dx", "dy"]),
  tool("android_mouse_click", "Click at the mouse's current physical position. Does not move or assume a calibrated location.", {
    button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
    count: integer("One click or double-click", 1, 2),
  }),
  tool("android_tap", "Move the calibrated BLE mouse to an estimated screenshot coordinate and click. Uses hardware HID, not ADB input. Accuracy requires real-phone calibration.", coordinates, ["frameId", "x", "y"]),
  tool("android_swipe", "Drag the calibrated BLE mouse between two screenshot coordinates, then release. The phone must support mouse drag for the target UI.", {
    frameId, x1: integer("Start X"), y1: integer("Start Y"), x2: integer("End X"), y2: integer("End Y"),
    durationMs: integer("Minimum drag duration, default 400 ms. Report pacing may extend it; result includes plannedDurationMs.", 50, 10000),
    coordinateSpace: coordinates["coordinateSpace"]!,
  }, ["frameId", "x1", "y1", "x2", "y2"]),
  tool("android_scroll", "Send hardware mouse wheel reports. The target device app determines how scrolling is handled.", { amount: integer("Signed wheel counts") }, ["amount"]),
  tool("android_type", "Type US-layout ASCII using the ESP32 keyboard. Focus the intended field first. Non-ASCII is rejected before any typing; use the phone's IME and ASCII pinyin when appropriate.", { text: string("ASCII text, tabs and newlines") }, ["text"]),
  tool("android_key", "Press and release a keyboard key or chord, e.g. enter, escape, ctrl+a, shift+tab, meta+h.", { combo: string("Keyboard key/chord") }, ["combo"]),
  tool("android_key_report", "Send a raw standard keyboard report. keycode=0 releases the keyboard; release after a held report.", { modifier: integer("USB HID modifier mask", 0, 255), keycode: integer("USB HID keyboard usage", 0, 255) }, ["modifier", "keycode"]),
  tool("android_consumer_report", "Send a raw 16-bit consumer HID usage; usage=0 releases it. OEM mappings may differ.", { usage: integer("Consumer usage", 0, 65535) }, ["usage"]),
  tool("android_home", "Press and release the hardware consumer Home usage. Phone/OEM mapping requires device verification."),
  tool("android_back", "Press and release the hardware consumer Back usage. Phone/OEM mapping requires device verification."),
];

function object(value: unknown): Arguments {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool arguments must be an object.");
  return value as Arguments;
}
function text(args: Arguments, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string.`);
  return value;
}
function number(args: Arguments, key: string, fallback?: number): number {
  const value = args[key] ?? fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a finite number.`);
  return value;
}
function int(args: Arguments, key: string, fallback?: number): number {
  const value = number(args, key, fallback);
  if (!Number.isSafeInteger(value)) throw new Error(`${key} must be a safe integer.`);
  return value;
}
function json(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(value !== null && typeof value === "object" && !Array.isArray(value)
      ? { structuredContent: value as Record<string, unknown> } : {}),
  };
}

export type AndroidCapture = AdbCapture & { mimeType?: "image/jpeg" | "image/png";
  deviceWidth?: number; deviceHeight?: number; previewProfile?: "turbo" | "fast" | "standard" | "original" };
interface CaptureClient { listDevices(): Promise<AdbDevice[]>; capture(serial?: string, signal?: AbortSignal): Promise<AndroidCapture>;
  preview?(serial?: string): Promise<AndroidCapture> }
interface Frame extends AndroidCapture { frameId: string; observedAt: number; epoch: number }
interface Observation {
  serial: string;
  width: number;
  height: number;
  rotation: number;
}
interface SharedObservation {
  captures: Promise<void>;
  controls: Promise<void>;
  epoch: number;
  current?: Observation;
  inputOwner?: AndroidTools;
}
export interface AndroidToolsOptions {
  now?: () => number;
  frameMaxAgeMs?: number;
  listSerialPorts?: () => Promise<unknown[]>;
  actionFrameTimeoutMs?: number;
}
export class AndroidTools {
  private frame: Frame | undefined;
  private readonly now: () => number;
  private readonly maxAge: number;
  private readonly ports: () => Promise<unknown[]>;
  private readonly actionFrameTimeout: number;
  private observation: SharedObservation = { captures: Promise.resolve(), controls: Promise.resolve(), epoch: 0 };
  constructor(
    private readonly adb: CaptureClient,
    readonly input: InputController,
    options: AndroidToolsOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.maxAge = options.frameMaxAgeMs ?? 30_000;
    if (!Number.isFinite(this.maxAge) || this.maxAge <= 0) throw new Error("frameMaxAgeMs must be positive.");
    this.ports = options.listSerialPorts ?? (async () => (await import("serialport")).SerialPort.list());
    this.actionFrameTimeout = options.actionFrameTimeoutMs ?? 2500;
    if (!Number.isFinite(this.actionFrameTimeout) || this.actionFrameTimeout <= 0) throw new Error("actionFrameTimeoutMs must be positive.");
  }

  /** Keep one latest frame per caller while sharing the physical phone and HID state. */
  fork(): AndroidTools {
    const tools = new AndroidTools(this.adb, this.input, {
      now: this.now, frameMaxAgeMs: this.maxAge, listSerialPorts: this.ports, actionFrameTimeoutMs: this.actionFrameTimeout,
    });
    tools.observation = this.observation;
    return tools;
  }

  /** Continuous video changes the shared geometry, not a caller's chosen MCP snapshot. */
  observeLive(capture: AndroidCapture): Promise<void> {
    return this.sequenceObservation(() => this.observe({
      serial: capture.serial, width: capture.deviceWidth ?? capture.width, height: capture.deviceHeight ?? capture.height,
      rotation: capture.rotation ?? this.input.state.screen.rotation ?? 0,
    }));
  }

  /** Operator input reads the shared live cache without replacing any MCP snapshot. */
  async readLiveFrame(signal?: AbortSignal): Promise<AndroidCapture> {
    const capture = await this.captureWithSignal(undefined, signal, true);
    const receivedAt = performance.now();
    signal?.throwIfAborted();
    await this.observeLive(capture);
    return capture.frameAgeMs === undefined || !Number.isFinite(capture.frameAgeMs) || capture.frameAgeMs < 0 ? capture : {
      ...capture, frameAgeMs: Math.ceil(capture.frameAgeMs + performance.now() - receivedAt),
    };
  }

  async visualLost(): Promise<void> {
    this.observation.epoch += 1;
    await this.input.stop();
  }

  private sequenceObservation<T>(task: () => Promise<T>): Promise<T> {
    const result = this.observation.captures.then(task);
    this.observation.captures = result.then(() => undefined, () => undefined);
    return result;
  }

  private captureWithSignal(serial?: string, signal?: AbortSignal, preview = false): Promise<AndroidCapture> {
    signal?.throwIfAborted();
    const capture = () => preview && this.adb.preview ? this.adb.preview(serial) : this.adb.capture(serial, signal);
    if (!signal) return capture();
    return new Promise<AndroidCapture>((resolve, reject) => {
      const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      capture().then((frame) => {
        signal.removeEventListener("abort", abort); resolve(frame);
      }, (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); });
      if (signal.aborted) abort();
    });
  }

  private async observe(next: Observation): Promise<void> {
    const previous = this.observation.current;
    const changed = previous !== undefined && (
      previous.serial !== next.serial || previous.width !== next.width ||
      previous.height !== next.height || previous.rotation !== next.rotation
    );
    this.observation.current = next;
    if (changed) {
      // Invalidate every session before waiting for transport cleanup.
      this.observation.epoch += 1;
      try {
        await this.input.stop();
      } finally {
        this.input.resetCalibration();
        this.input.setScreen(next);
      }
    } else {
      this.input.setScreen(next);
    }
  }

  private requireFrame(args: Arguments): Frame {
    const id = text(args, "frameId");
    if (!this.frame || this.frame.frameId !== id || this.frame.epoch !== this.observation.epoch) {
      throw new Error("Screenshot is missing or superseded. Call android_screenshot again.");
    }
    if (this.now() - this.frame.observedAt > this.maxAge) throw new Error("Screenshot has expired. Call android_screenshot again.");
    return this.frame;
  }

  private executionFrameGuard(args: Arguments): () => void {
    const frameId = this.requireFrame(args).frameId;
    // A coordinate action may wait behind a long HID action. Recheck this
    // session's immutable frame ID and the shared epoch when its turn starts.
    return () => { this.requireFrame({ frameId }); };
  }

  private point(args: Arguments, xKey: string, yKey: string): [number, number] {
    const frame = this.requireFrame(args);
    const x = int(args, xKey), y = int(args, yKey);
    const space = args["coordinateSpace"] ?? "pixels";
    if (space === "normalized1000") {
      if (x < 0 || x > 1000 || y < 0 || y > 1000) throw new Error("Normalized coordinates must be in 0..1000.");
      return [Math.round(x * (frame.width - 1) / 1000), Math.round(y * (frame.height - 1) / 1000)];
    }
    if (space !== "pixels") throw new Error("coordinateSpace must be pixels or normalized1000.");
    if (x < 0 || x >= frame.width || y < 0 || y >= frame.height) throw new Error("Coordinates fall outside the latest screenshot.");
    return [x, y];
  }

  private snapshot(capture: AndroidCapture, extra: Record<string, unknown> = {}): CallToolResult {
    this.frame = { ...capture, frameId: randomUUID(), observedAt: this.now(), epoch: this.observation.epoch };
    const metadata = {
      frameId: this.frame.frameId, deviceSerial: capture.serial, capturedAt: capture.capturedAt,
      width: capture.width, height: capture.height, sha256: createHash("sha256").update(capture.png).digest("hex"),
      input: this.input.state,
      ...(capture.source ? { source: capture.source } : {}),
      ...(capture.sourceFrameId ? { sourceFrameId: capture.sourceFrameId } : {}),
      ...(capture.frameAgeMs === undefined ? {} : { frameAgeMs: capture.frameAgeMs }),
      ...(capture.deviceWidth === undefined ? {} : { deviceWidth: capture.deviceWidth, deviceHeight: capture.deviceHeight }),
      ...(capture.previewProfile === undefined ? {} : { previewProfile: capture.previewProfile }),
      rotation: this.input.state.screen.rotation, mimeType: capture.mimeType ?? "image/png",
      note: "Coordinates refer to this session's latest image. Relative HID position is estimated; phone and rotation changes invalidate all sessions' old frames.",
      ...extra,
    };
    return { ...json(metadata), content: [
      { type: "text", text: JSON.stringify(metadata) },
      { type: "image", mimeType: capture.mimeType ?? "image/png", data: capture.png.toString("base64") },
    ] };
  }

  /** Parse every action argument before opening or enabling the hardware. */
  private controlAction(args: Arguments, signal?: AbortSignal): { action: string; execute: () => Promise<unknown> } {
    const action = text(args, "action");
    const fields: Record<string, string[]> = {
      move: ["dx", "dy"], click: ["button", "count"], scroll: ["amount"], key: ["combo"], type: ["text"],
      home: [], back: [], tap: ["x", "y", "coordinateSpace"],
      swipe: ["x1", "y1", "x2", "y2", "durationMs", "coordinateSpace"], wait: ["waitMs"],
    };
    const allowed = fields[action];
    if (!allowed) throw new Error("Unknown control action.");
    if (Object.keys(args).some((key) => key !== "action" && key !== "frameId" && !allowed.includes(key))) {
      throw new Error(`Unexpected argument for ${action}.`);
    }
    this.requireFrame(args);
    switch (action) {
      case "move": {
        const dx = int(args, "dx"), dy = int(args, "dy");
        splitMove(dx, dy);
        return { action, execute: () => this.input.move(dx, dy, 0, 0, signal) };
      }
      case "click": {
        const button = args["button"] ?? "left", count = int(args, "count", 1);
        if (button !== "left" && button !== "right" && button !== "middle") throw new Error("Unknown mouse button.");
        if (count !== 1 && count !== 2) throw new Error("count must be 1 or 2.");
        return { action, execute: () => this.input.click(button, count, signal) };
      }
      case "scroll": {
        const amount = int(args, "amount");
        splitMove(0, 0, amount);
        return { action, execute: () => this.input.scroll(amount, signal) };
      }
      case "key": {
        const combo = text(args, "combo");
        parseKeyCombo(combo);
        return { action, execute: () => this.input.key(combo, signal) };
      }
      case "type": {
        const value = text(args, "text");
        for (const character of value) asciiKey(character);
        return { action, execute: () => this.input.type(value, signal) };
      }
      case "home": return { action, execute: () => this.input.home(signal) };
      case "back": return { action, execute: () => this.input.back(signal) };
      case "tap": {
        const [x, y] = this.point(args, "x", "y"), guard = this.executionFrameGuard(args);
        if (!this.input.state.calibrated) throw new Error("Coordinate actions need explicit calibration. Use relative move/click or android_calibrate_pointer first.");
        return { action, execute: () => this.input.tap(x, y, signal, guard) };
      }
      case "swipe": {
        const [x1, y1] = this.point(args, "x1", "y1"), [x2, y2] = this.point(args, "x2", "y2");
        const duration = int(args, "durationMs", 400), guard = this.executionFrameGuard(args);
        if (duration < 50 || duration > 10000) throw new Error("durationMs must be in 50..10000.");
        if (!this.input.state.calibrated) throw new Error("Coordinate actions need explicit calibration. Use relative move/click or android_calibrate_pointer first.");
        return { action, execute: () => this.input.swipe(x1, y1, x2, y2, duration, signal, guard) };
      }
      default: {
        const wait = int(args, "waitMs", 200);
        if (wait < 0 || wait > 3000) throw new Error("waitMs must be in 0..3000.");
        return { action, execute: () => delay(wait, undefined, { signal }) };
      }
    }
  }

  private async afterActionFrame(before: AndroidCapture, completedAt: number, signal?: AbortSignal): Promise<AndroidCapture> {
    const timeout = AbortSignal.timeout(this.actionFrameTimeout);
    const waiting = signal ? AbortSignal.any([signal, timeout]) : timeout;
    for (;;) {
      waiting.throwIfAborted();
      // A projection can disappear while capture is waiting for its first frame.
      // Bound this read independently of the screen client's reconnect timeout.
      const capture = await this.captureWithSignal(before.serial, waiting);
      waiting.throwIfAborted();
      if (capture.serial !== before.serial) throw new Error("Phone identity changed while waiting for the action result.");
      const newer = before.sourceFrameId !== undefined
        ? capture.sourceFrameId !== undefined && capture.sourceFrameId !== before.sourceFrameId
        : capture.capturedAt !== before.capturedAt;
      // Source age is monotonic, unlike the independent phone/PC wall clocks.
      // A different cache entry may still have been captured before the action.
      const age = capture.frameAgeMs;
      if (newer && age !== undefined && Number.isFinite(age) && age >= 0 && age <= performance.now() - completedAt) {
        return capture;
      }
      await delay(25, undefined, { signal: waiting });
    }
  }

  private control(args: Arguments, signal?: AbortSignal): Promise<CallToolResult> {
    const task = this.observation.controls.then(async () => {
      let actionCompleted = false, actionStarted = false, visualChecked = false;
      let inputEpoch = this.input.controlEpoch;
      const action = text(args, "action");
      const requireInputRound = () => {
        if (action !== "wait" && inputEpoch !== this.input.controlEpoch) {
          throw new Error("Input control round changed while this action was waiting; observe again before controlling.");
        }
      };
      try {
        signal?.throwIfAborted();
        const command = this.controlAction(args, signal);
        visualChecked = true;
        const before = await this.readLiveFrame(signal);
        requireInputRound();
        this.requireFrame(args);
        const epoch = this.observation.epoch;
        signal?.throwIfAborted();
        if (action !== "wait" && !this.input.state.armed) {
          const arming = this.input.arm(signal);
          // ARM reserves its round synchronously. A later ARM while its ACK is
          // pending must supersede this workflow rather than be adopted by it.
          inputEpoch = this.input.controlEpoch;
          await arming;
        }
        requireInputRound();
        this.requireFrame(args);
        signal?.throwIfAborted();
        actionStarted = action !== "wait";
        const actionResult = await command.execute();
        actionCompleted = true;
        requireInputRound();
        const completedAt = performance.now();
        const capture = await this.afterActionFrame(before, completedAt, signal);
        requireInputRound();
        return await this.sequenceObservation(async () => {
          signal?.throwIfAborted();
          requireInputRound();
          if (this.observation.epoch !== epoch) throw new Error("Phone or display geometry changed during the action; observe again.");
          await this.observe({ serial: capture.serial, width: capture.width, height: capture.height,
            rotation: capture.rotation ?? this.input.state.screen.rotation ?? 0 });
          signal?.throwIfAborted();
          requireInputRound();
          return this.snapshot(capture, { action, actionCompleted: true, observedAfterAction: true,
            actionResult: actionResult ?? null, previousSourceFrameId: before.sourceFrameId ?? null });
        });
      } catch (error) {
        if (visualChecked && inputEpoch === this.input.controlEpoch && !(action === "wait" && signal?.aborted)) {
          this.frame = undefined;
          this.observation.epoch += 1;
          await this.input.stop().catch(() => {});
        }
        const message = error instanceof Error ? error.message : String(error);
        return { ...json({ action, actionCompleted, actionStarted, observedAfterAction: false,
          message: actionCompleted
            ? `Action completed, but a new post-action phone image was not available: ${message}. Do not repeat the action blindly; call android_screenshot to observe.`
            : message }), isError: true };
      }
    });
    // Only high-level workflows serialize here; live geometry observations and
    // emergency cancellation must remain able to interrupt an active action.
    this.observation.controls = task.then(() => undefined, () => undefined);
    return task;
  }

  async call(name: string, raw: unknown = {}, signal?: AbortSignal): Promise<CallToolResult> {
    const spec = ANDROID_TOOLS.find((entry) => entry.name === name);
    if (!spec) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    let inputEpoch = this.input.controlEpoch;
    const stop = () => {
      if (inputEpoch === this.input.controlEpoch) void this.input.pause().catch(() => {});
    };
    try {
      if (signal?.aborted) throw new Error("Tool call was cancelled.");
      const args = object(raw);
      const properties = spec.inputSchema.properties ?? {};
      if (Object.keys(args).some((key) => !Object.hasOwn(properties, key))) throw new Error("Unknown tool argument.");
      if ((spec.inputSchema.required ?? []).some((key) => !(key in args))) throw new Error("Required tool argument is missing.");
      // Match HTTP input ownership for standalone/stdio and directly forked
      // callers too. Read-only observation never acquires another caller's input.
      if (!spec.annotations?.readOnlyHint && !(name === "android_control" && args["action"] === "wait")) {
        this.observation.inputOwner = this;
      }
      // High-level control owns cleanup inside its workflow, where the input
      // round can be checked. Its old cancellation must not pause a newer ARM.
      if (!spec.annotations?.readOnlyHint && name !== "android_hid_pause" && name !== "android_release"
        && name !== "android_control") signal?.addEventListener("abort", stop, { once: true });
      let result: unknown;
      switch (name) {
        case "android_devices": {
          const [devices, ports] = await Promise.allSettled([this.adb.listDevices(), this.ports()]);
          return json({
            android: devices.status === "fulfilled" ? devices.value : [],
            serialPorts: ports.status === "fulfilled" ? ports.value : [],
            errors: [devices, ports].filter((item) => item.status === "rejected").map((item) => String(item.reason instanceof Error ? item.reason.message : item.reason)),
          });
        }
        case "android_control": return await this.control(args, signal);
        case "android_screenshot": {
          return await this.sequenceObservation(async () => {
            try {
              if (signal?.aborted) throw new Error("Screenshot request was cancelled.");
              const serial = args["deviceSerial"] === undefined ? undefined : text(args, "deviceSerial");
              const capture = await this.captureWithSignal(serial, signal);
              if (signal?.aborted) throw new Error("Screenshot request was cancelled.");
              await this.observe({
                serial: capture.serial, width: capture.width, height: capture.height,
                rotation: capture.rotation ?? this.input.state.screen.rotation ?? 0,
              });
              if (signal?.aborted) throw new Error("Screenshot request was cancelled.");
              return this.snapshot(capture);
            } catch (error) {
              // A failed original capture belongs to this observer, while the
              // shared preview may remain healthy for a different input owner.
              // Actual shared feed loss still stops everyone through visualLost.
              this.frame = undefined;
              if (!signal?.aborted && this.observation.inputOwner === this && inputEpoch === this.input.controlEpoch) {
                this.observation.epoch += 1;
                await this.input.stop().catch(() => {});
              }
              throw error;
            }
          });
        }
        case "android_hid_status": result = await this.input.status(signal); break;
        case "android_hid_arm": {
          const arming = this.input.arm(signal);
          inputEpoch = this.input.controlEpoch;
          result = await arming;
          break;
        }
        case "android_hid_pause": result = await this.input.pause(); break;
        case "android_release": result = await this.input.releaseAll(); break;
        case "android_calibrate_pointer": {
          result = await this.sequenceObservation(async () => {
            if (signal?.aborted) throw new Error("Tool call was cancelled.");
            const frame = this.requireFrame(args);
            const rotation = int(args, "rotation", this.input.state.screen.rotation ?? 0);
            if (rotation < 0 || rotation > 3) throw new Error("rotation must be 0, 1, 2 or 3.");
            const scaleX = number(args, "scaleX"), scaleY = number(args, "scaleY");
            if (scaleX <= 0 || scaleY <= 0) throw new Error("Pointer calibration scales must be positive.");
            await this.observe({ serial: frame.serial, width: frame.width, height: frame.height, rotation });
            if (signal?.aborted) throw new Error("Tool call was cancelled.");
            return this.input.setCalibration(scaleX, scaleY);
          });
          break;
        }
        case "android_pointer_home": result = await this.input.homePointer(signal, this.executionFrameGuard(args)); break;
        case "android_mouse_move": result = await this.input.move(int(args, "dx"), int(args, "dy"), int(args, "wheel", 0), int(args, "buttons", 0), signal); break;
        case "android_mouse_click": {
          const button = args["button"] ?? "left", count = int(args, "count", 1);
          if (button !== "left" && button !== "right" && button !== "middle") throw new Error("Unknown mouse button.");
          if (count !== 1 && count !== 2) throw new Error("count must be 1 or 2.");
          result = await this.input.click(button, count, signal); break;
        }
        case "android_tap": {
          const [x, y] = this.point(args, "x", "y");
          result = await this.input.tap(x, y, signal, this.executionFrameGuard(args)); break;
        }
        case "android_swipe": {
          const [x1, y1] = this.point(args, "x1", "y1"), [x2, y2] = this.point(args, "x2", "y2");
          result = await this.input.swipe(x1, y1, x2, y2, int(args, "durationMs", 400), signal, this.executionFrameGuard(args)); break;
        }
        case "android_scroll": result = await this.input.scroll(int(args, "amount"), signal); break;
        case "android_type": result = await this.input.type(text(args, "text"), signal); break;
        case "android_key": result = await this.input.key(text(args, "combo"), signal); break;
        case "android_key_report": result = await this.input.keyReport(int(args, "modifier"), int(args, "keycode"), signal); break;
        case "android_consumer_report": result = await this.input.consumerReport(int(args, "usage"), signal); break;
        case "android_home": result = await this.input.home(signal); break;
        case "android_back": result = await this.input.back(signal); break;
      }
      return json(result);
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    } finally {
      signal?.removeEventListener("abort", stop);
    }
  }
}

export function createMcpServer(tools: AndroidTools): Server {
  const sessionTools = tools.fork();
  const server = new Server({ name: "qdd-android-hid", version: "0.0.0" }, { capabilities: { tools: {} }, instructions:
    "Observe the device with android_screenshot, then prefer android_control with that frameId: it prepares input, executes one action, and returns a real newer image captured after the action completed. Continue using the returned frameId. Relative move/click, key, scroll, home and back need no calibration. Coordinates in tap/swipe remain estimates and require explicit measured calibration. All input is through the ESP32 BLE keyboard/mouse, connected over Wi-Fi TCP or USB serial. Never use ADB input as a fallback. Legacy individual input tools require android_hid_arm and a separate screenshot afterward. If an action completed but the image failed, do not repeat it blindly; observe again. Cancellation/failure releases input; clear physical emergency stop only on the board. Text typing is US-layout ASCII. No model API or API key is required by this MCP server.",
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ANDROID_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => sessionTools.call(request.params.name, request.params.arguments, extra.signal));
  return server;
}

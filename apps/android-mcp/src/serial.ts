import { decodeReply, encodeCommand, HidProtocolError, MAX_REQUEST_ID } from "./protocol.js";
import type { HidOperation, HidStatus } from "./protocol.js";

export interface SerialBridge {
  request(op: HidOperation, args?: readonly number[], signal?: AbortSignal): Promise<HidStatus>;
  requestRealtime?(op: "MOVE" | "KEY", args: readonly number[], signal?: AbortSignal): Promise<HidStatus>;
  close(): Promise<void>;
}

/** Shared byte-stream transport, injectable for serial and TCP tests. */
export interface SerialTransport {
  readonly isOpen: boolean;
  on(event: "data", listener: (data: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: () => void): this;
  open(callback: (error?: Error | null) => void): void;
  set?(options: { dtr: boolean; rts: boolean }, callback: (error?: Error | null) => void): void;
  write(data: string, callback: (error?: Error | null) => void): unknown;
  close(callback: (error?: Error | null) => void): void;
}

export interface SerialBridgeOptions {
  path: string;
  baudRate?: number;
  timeoutMs?: number;
  heartbeatMs?: number;
  portFactory?: (path: string, baudRate: number) => SerialTransport;
}

interface Pending {
  id: number;
  sequence: number;
  resolve: (status: HidStatus) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  removeAbort: () => void;
}

class AckTimeoutError extends Error {
  constructor(readonly op: HidOperation) {
    super(`ESP32 ${op} acknowledgement timed out; action was not retried.`);
    this.name = "AckTimeoutError";
  }
}

export function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("HID operation cancelled.", { cause: signal.reason });
}

/** Shared HID session; every new serial/TCP connection stays paused until explicit ARM. */
export class SerialHidBridge implements SerialBridge {
  private port: SerialTransport | undefined;
  private readonly pending = new Map<number, Pending>();
  private readonly retired = new Set<number>();
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private nextId = 1;
  private tail: Promise<void> = Promise.resolve();
  private launches: Promise<void> = Promise.resolve();
  private readonly realtime = new Set<Promise<HidStatus>>();
  private realtimeEpoch = 0;
  private realtimeAbort = new AbortController();
  private realtimeCleanup: Promise<void> | undefined;
  private sequence = 0;
  private latestSequence = 0;
  private heartbeat: NodeJS.Timeout | undefined;
  private heartbeatQueued = false;
  private heartbeatRevision = 0;
  private heartbeatPendingId: number | undefined;
  private ready = false;
  private disposed = false;
  private transportFailure: Error | undefined;
  private latest: HidStatus | undefined;
  private readonly timeoutMs: number;
  private readonly heartbeatMs: number;

  constructor(private readonly options: SerialBridgeOptions) {
    this.timeoutMs = options.timeoutMs ?? 1200;
    this.heartbeatMs = options.heartbeatMs ?? 300;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0
      || !Number.isFinite(this.heartbeatMs) || this.heartbeatMs <= 0 || this.heartbeatMs >= 1500) {
      throw new Error("HID timeout must be positive and heartbeat must be below 1500 ms.");
    }
  }

  get lastStatus(): HidStatus | undefined { return this.latest; }

  request(op: HidOperation, args: readonly number[] = [], signal?: AbortSignal): Promise<HidStatus> {
    encodeCommand(1, op, args); // reject malformed input before opening the port
    const startsRound = op === "ARM" || op === "PAUSE" || op === "RELEASE";
    if (startsRound) this.retireHeartbeat();
    const reports = [...this.realtime];
    const task = this.tail.then(async () => {
      await Promise.allSettled(reports);
      aborted(signal);
      if (this.disposed) throw new Error("HID bridge is closed.");
      await this.connect();
      aborted(signal);
      if (this.disposed) throw new Error("HID bridge is closing.");
      try {
        // ARM may follow a long idle period; only PING refreshes the firmware watchdog.
        if (op === "ARM") await this.exchange("PING", []);
        // A timer may have run while the exclusive request or ARM's PING waited.
        // Retire it at the actual state-changing wire boundary as well.
        if (startsRound) this.retireHeartbeat();
        return await this.exchange(op, args, signal);
      } catch (error) {
        // An acknowledgement can be lost after execution. Release, never retry the input.
        if (op !== "RELEASE" && this.port?.isOpen) {
          try { await this.exchange("RELEASE", []); } catch { /* firmware watchdog releases on link loss */ }
        }
        throw error;
      }
    });
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }

  /** Four ordered wire submissions may await ACKs together; exclusive requests are barriers. */
  requestRealtime(op: "MOVE" | "KEY", args: readonly number[], signal?: AbortSignal): Promise<HidStatus> {
    encodeCommand(1, op, args);
    aborted(signal);
    if (this.disposed || !this.ready || !this.port?.isOpen || !this.latest?.armed) {
      return Promise.reject(new Error("ESP32 realtime input is unavailable; arm explicitly after reconnecting."));
    }
    if (this.realtime.size >= 4) return Promise.reject(new Error("ESP32 realtime input window is full."));
    const epoch = this.realtimeEpoch;
    const lane = this.realtimeAbort.signal;
    const barrier = this.tail;
    const launch = this.launches.then(async () => {
      // A queued exclusive barrier may itself be waiting for this lane to
      // fail. Let cancellation release launch waiters without a dependency cycle.
      await new Promise<void>((resolve) => {
        const done = () => { lane.removeEventListener("abort", done); resolve(); };
        lane.addEventListener("abort", done, { once: true });
        if (lane.aborted) done(); else void barrier.then(done, done);
      });
      aborted(signal);
      if (epoch !== this.realtimeEpoch || this.disposed || !this.ready || !this.port?.isOpen || !this.latest?.armed) {
        throw new Error("Queued realtime input was cancelled.");
      }
      // Returning an object deliberately does not await its acknowledgement.
      return { reply: this.exchange(op, args, signal) };
    });
    this.launches = launch.then(() => undefined, () => undefined);
    const task = launch.then(({ reply }) => reply).catch(async (error: unknown) => {
      await this.releaseRealtime(error instanceof Error ? error : new Error(String(error)));
      throw error;
    });
    this.realtime.add(task);
    void task.then(() => this.realtime.delete(task), () => this.realtime.delete(task));
    return task;
  }

  private releaseRealtime(error: Error): Promise<void> {
    if (this.realtimeCleanup) return this.realtimeCleanup;
    this.realtimeEpoch++;
    this.realtimeAbort.abort(error);
    this.realtimeAbort = new AbortController();
    this.ready = false;
    this.clearHeartbeat();
    this.failPending(error);
    const cleanup = this.launches.then(async () => {
      if (!this.port?.isOpen) return;
      try { await this.exchange("RELEASE", []); } catch { /* watchdog remains the final release */ }
      try { await this.exchange("PAUSE", []); } catch { /* disconnected */ }
    });
    this.realtimeCleanup = cleanup;
    void cleanup.finally(() => { if (this.realtimeCleanup === cleanup) this.realtimeCleanup = undefined; });
    return cleanup;
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.realtimeEpoch++;
    this.realtimeAbort.abort(new Error("HID bridge is closing."));
    this.clearHeartbeat();
    this.failPending(new Error("HID bridge is closing."));
    await Promise.allSettled([this.tail, this.launches, ...this.realtime]);
    const port = this.port;
    if (port?.isOpen) {
      try { await this.exchange("RELEASE", []); } catch { /* best effort */ }
      try { await this.exchange("PAUSE", []); } catch { /* best effort */ }
      await new Promise<void>((resolve, reject) => port.close((error) => error ? reject(error) : resolve()));
    }
    this.ready = false;
  }

  private async connect(): Promise<void> {
    if (!this.options.path.trim()) throw new Error("ESP_PORT is not configured. Set it to the ESP32 serial port to use HID input.");
    if (this.port?.isOpen && this.ready) return;
    this.clearHeartbeat();
    this.ready = false;
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    const stale = this.port;
    if (stale?.isOpen) {
      try { await this.exchange("RELEASE", []); } catch { /* best effort before replacing transport */ }
      try { await this.exchange("PAUSE", []); } catch { /* best effort */ }
      await new Promise<void>((resolve) => stale.close(() => resolve()));
    }
    const port: SerialTransport = this.options.portFactory
      ? this.options.portFactory(this.options.path, this.options.baudRate ?? 115200)
      : new (await import("serialport")).SerialPort({ path: this.options.path, baudRate: this.options.baudRate ?? 115200, autoOpen: false });
    this.port = port;
    this.transportFailure = undefined;
    port.on("data", (data) => { if (this.port === port) this.onData(data); });
    port.on("error", (error) => {
      if (this.port !== port) return;
      this.ready = false;
      this.clearHeartbeat();
      this.failTransport(error);
    });
    port.on("close", () => {
      if (this.port !== port) return;
      this.ready = false;
      this.latest = undefined;
      this.clearHeartbeat();
      this.failTransport(new Error("ESP32 link disconnected; re-arm explicitly after reconnecting."));
    });
    await new Promise<void>((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => { expired = true; reject(new Error("Opening ESP32 connection timed out.")); }, this.timeoutMs * 3);
      port.open((error) => {
        clearTimeout(timer);
        if (expired) { if (port.isOpen) port.close(() => undefined); return; }
        if (error) reject(error); else resolve();
      });
    });
    try {
      this.assertConnectPort(port);
      // ESP USB Serial/JTAG uses DTR for CDC traffic; asserting RTS can keep a
      // freshly flashed board in reset. Set only the explicitly chosen port.
      const setControl = port.set?.bind(port);
      if (setControl) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Setting ESP32 DTR/RTS control lines timed out.")), this.timeoutMs);
          try {
            setControl({ dtr: true, rts: false }, (error) => {
              clearTimeout(timer);
              if (error) reject(error); else resolve();
            });
          } catch (error) {
            clearTimeout(timer);
            reject(error);
          }
        });
      }
      this.assertConnectPort(port);
      try {
        await this.exchange("PING", []);
      } catch (error) {
        // A cold connection may miss its first neutral handshake. Only
        // that ACK timeout can retry; report/ARM requests are never replayed.
        if (!(error instanceof AckTimeoutError) || error.op !== "PING") throw error;
        this.assertConnectPort(port);
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        this.assertConnectPort(port);
        await this.exchange("PING", []);
      }
      this.assertConnectPort(port);
      await this.exchange("RELEASE", []);
      this.assertConnectPort(port);
      await this.exchange("PAUSE", []);
      this.assertConnectPort(port);
      this.ready = true;
      this.heartbeat = setInterval(() => {
        if (!this.ready || this.disposed || this.heartbeatQueued) return;
        this.heartbeatQueued = true;
        const revision = this.heartbeatRevision;
        const heartbeatId = this.nextId;
        this.heartbeatPendingId = heartbeatId;
        // PING is neutral and has its own request ID. Waiting behind slow report
        // ACKs can starve the board's 1500 ms lease even while inputs are arriving.
        // Only the timer may bypass the exclusive action barrier; no input does.
        void this.exchange("PING", []).catch((error: unknown) => {
          if (revision !== this.heartbeatRevision || this.port !== port || this.disposed) return;
          void this.releaseRealtime(error instanceof Error ? error : new Error(String(error)));
        }).finally(() => {
          if (revision !== this.heartbeatRevision || this.heartbeatPendingId !== heartbeatId) return;
          this.heartbeatPendingId = undefined;
          this.heartbeatQueued = false;
        });
      }, this.heartbeatMs);
      this.heartbeat.unref();
    } catch (error) {
      if (port.isOpen) await new Promise<void>((resolve) => port.close(() => resolve()));
      throw error;
    }
  }

  private assertConnectPort(port: SerialTransport): void {
    if (this.disposed) throw new Error("HID bridge is closing.");
    if (this.transportFailure) throw this.transportFailure;
    if (this.port !== port || !port.isOpen) throw new Error("ESP32 link is not open.");
  }

  private exchange(op: HidOperation, args: readonly number[], signal?: AbortSignal): Promise<HidStatus> {
    aborted(signal);
    const port = this.port;
    if (!port?.isOpen) return Promise.reject(new Error("ESP32 link is not open."));
    const id = this.nextId;
    this.nextId = id === MAX_REQUEST_ID ? 1 : id + 1;
    const line = encodeCommand(id, op, args);
    return new Promise<HidStatus>((resolve, reject) => {
      const onAbort = () => this.failPending(new Error("HID operation cancelled.", { cause: signal?.reason }), id);
      const timer = setTimeout(() => this.failPending(new AckTimeoutError(op), id), this.timeoutMs);
      this.pending.set(id, { id, sequence: ++this.sequence, resolve, reject, timer, removeAbort: () => signal?.removeEventListener("abort", onAbort) });
      signal?.addEventListener("abort", onAbort, { once: true });
      port.write(line, (error) => {
        if (error && this.port === port) {
          this.transportFailure = error;
          this.failPending(error, id);
        }
      });
    });
  }

  private onData(data: Buffer): void {
    this.buffer += this.decoder.write(data);
    if (this.buffer.length > 8192) {
      this.buffer = "";
      this.failTransport(new HidProtocolError("ESP32 reply buffer exceeded its limit."));
      return;
    }
    let end: number;
    while ((end = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      try {
        const reply = decodeReply(line);
        if (!reply) continue;
        const waiting = this.pending.get(reply.id);
        if (!waiting) {
          if (this.realtime.size && this.pending.size && !this.retired.has(reply.id)) {
            this.failTransport(new HidProtocolError("ESP32 returned an unknown realtime acknowledgement id."));
          }
          continue;
        }
        if (!reply.ok) {
          const message = reply.code === "CONTROL_BUSY"
            ? "控制板正在由另一个连接控制，请先停止那个连接后再试。"
            : reply.code === "USB_ONLY"
              ? "首次蓝牙配对需要用 USB 连接控制板，完成配对后可通过 Wi-Fi 控制。"
              : `ESP32 rejected command: ${reply.code}.`;
          this.failPending(new HidProtocolError(message, reply.code), reply.id);
          continue;
        }
        if (waiting.sequence >= this.latestSequence) {
          this.latest = reply.status; this.latestSequence = waiting.sequence;
        }
        const pending = this.takePending(reply.id);
        pending?.resolve(reply.status);
      } catch (error) {
        this.failTransport(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private takePending(id: number): Pending | undefined {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    if (pending) {
      clearTimeout(pending.timer); pending.removeAbort();
      this.retired.add(id);
      if (this.retired.size > 64) this.retired.delete(this.retired.values().next().value!);
    }
    return pending;
  }

  private failPending(error: Error, id?: number): void {
    for (const key of id === undefined ? [...this.pending.keys()] : [id]) this.takePending(key)?.reject(error);
  }
  private failTransport(error: Error): void { this.transportFailure = error; this.failPending(error); }
  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.retireHeartbeat();
  }
  private retireHeartbeat(): void {
    this.heartbeatRevision++;
    const id = this.heartbeatPendingId;
    this.heartbeatPendingId = undefined;
    this.heartbeatQueued = false;
    // Only the timer's neutral PING is superseded. Explicit FIFO PING and every
    // input request retain their own acknowledgement and failure semantics.
    if (id !== undefined) this.failPending(new Error("Neutral heartbeat was superseded by a new control round."), id);
  }
}
import { StringDecoder } from "node:string_decoder";

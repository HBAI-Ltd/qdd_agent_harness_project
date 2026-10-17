import { performance } from "node:perf_hooks";
import type { AdbDevice } from "./adb.js";
import { ScreenClient, ScreenError, MAX_SCREEN_FRAME_AGE_MS } from "./screen.js";
import type { PreviewProfile, PreviewProfileState, ScreenCapture } from "./screen.js";

type FrameListener = (frame: ScreenCapture) => void;
type ErrorListener = (error: Error) => void;

/** One preview connection feeds viewers; MCP requests fresh original frames separately. */
export class LiveScreenSource {
  private controller: AbortController | undefined;
  private task: Promise<void> | undefined;
  private latest: { frame: ScreenCapture; receivedAt: number } | undefined;
  private readonly listeners = new Set<{ frame: FrameListener; error: ErrorListener }>();
  private closed = false;
  private lossReported = false;
  private lastError: Error | undefined;
  private readonly captures = new Set<AbortController>();

  constructor(private readonly phone: ScreenClient) {}

  listDevices(): Promise<AdbDevice[]> { return this.phone.listDevices(); }
  getPreviewProfile(): Promise<PreviewProfileState> { return this.phone.getPreviewProfile(); }
  setPreviewProfile(profile: PreviewProfile): Promise<PreviewProfileState> { return this.phone.setPreviewProfile(profile); }

  subscribe(frame: FrameListener, error: ErrorListener = () => {}): () => void {
    if (this.closed) throw new Error("手机画面连接已关闭。");
    const listener = { frame, error };
    this.listeners.add(listener);
    this.start();
    if (this.lastError) queueMicrotask(() => {
      if (this.listeners.has(listener) && this.lastError) listener.error(this.lastError);
    });
    return () => { this.listeners.delete(listener); };
  }

  async capture(serial?: string, signal?: AbortSignal): Promise<ScreenCapture> {
    signal?.throwIfAborted();
    this.start();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    this.captures.add(controller);
    if (signal?.aborted) abort();
    try {
      const frame = await this.phone.capture(serial, controller.signal);
      controller.signal.throwIfAborted();
      if (this.closed) throw new Error("手机画面连接已关闭。");
      return frame;
    } finally {
      this.captures.delete(controller);
      signal?.removeEventListener("abort", abort);
    }
  }

  /** Human-input visual guards use the fresh preview, never trigger a full JPEG capture. */
  async preview(serial?: string): Promise<ScreenCapture> {
    this.start();
    const cached = this.fresh(serial);
    if (cached) return cached;
    return new Promise<ScreenCapture>((resolve, reject) => {
      const timer = setTimeout(() => finish(new ScreenError("SCREEN_TIMEOUT", "还没有收到手机画面，请在手机上开始投屏。")), 10_000);
      const unsubscribe = this.subscribe(() => {
        try { const frame = this.fresh(serial); if (frame) finish(undefined, frame); }
        catch (error) { finish(error as Error); }
      }, (error) => finish(error));
      const finish = (error?: Error, frame?: ScreenCapture) => {
        clearTimeout(timer);
        unsubscribe();
        if (error) reject(error); else resolve(frame!);
      };
    });
  }

  private fresh(serial?: string): ScreenCapture | undefined {
    if (!this.latest) return undefined;
    const { frame, receivedAt } = this.latest;
    if (serial !== undefined && serial.toLowerCase() !== frame.serial) {
      throw new ScreenError("SCREEN_DEVICE_MISMATCH", "连接的是另一台手机，请重新选择手机。");
    }
    const frameAgeMs = Math.ceil(frame.frameAgeMs + performance.now() - receivedAt);
    if (frameAgeMs > MAX_SCREEN_FRAME_AGE_MS) return undefined;
    return { ...frame, frameAgeMs };
  }

  private start(): void {
    if (this.closed) throw new Error("手机画面连接已关闭。");
    if (this.task) return;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.task = this.run(signal);
  }

  private lost(error: Error): void {
    this.latest = undefined;
    this.lastError = error;
    if (this.lossReported) return;
    this.lossReported = true;
    for (const listener of this.listeners) listener.error(error);
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        for await (const frame of this.phone.stream(signal)) {
          if (signal.aborted) break;
          this.latest = { frame, receivedAt: performance.now() };
          this.lossReported = false;
          this.lastError = undefined;
          for (const listener of this.listeners) listener.frame(frame);
        }
        if (!signal.aborted) throw new ScreenError("SCREEN_UNREACHABLE", "手机已停止传送画面，操作已暂停。");
      } catch (error) {
        if (signal.aborted) break;
        this.lost(error instanceof Error ? error : new Error(String(error)));
      }
      if (signal.aborted) break;
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, 1000);
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }

  async close(): Promise<void> {
    if (this.closed) { await this.task; return; }
    this.closed = true;
    this.latest = undefined;
    for (const capture of this.captures) capture.abort(new Error("手机画面连接已关闭。"));
    for (const listener of this.listeners) listener.error(new Error("手机画面连接已关闭。"));
    this.controller?.abort();
    await this.task;
    this.latest = undefined;
    this.listeners.clear();
  }
}

/** Multipart parser uses declared byte lengths, never a JPEG byte pattern as a delimiter. */
export class MultipartFrameParser {
  private buffer = Buffer.alloc(0);
  private headers: Headers | undefined;
  private length = 0;
  private receivedAt = 0;
  constructor(private readonly maxBytes: number) {}

  push(chunk: Uint8Array): { headers: Headers; bytes: Buffer; receivedAt: number }[] {
    if (this.buffer.length + chunk.byteLength > this.maxBytes + 16_384) throw new ScreenError("SCREEN_TOO_LARGE", "手机视频帧超过大小限制。");
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: { headers: Headers; bytes: Buffer; receivedAt: number }[] = [];
    for (;;) {
      if (!this.headers) {
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end < 0) {
          if (this.buffer.length > 8192) throw new ScreenError("SCREEN_INVALID_FRAME", "手机视频帧头过长。");
          break;
        }
        if (end > 8192) throw new ScreenError("SCREEN_INVALID_FRAME", "手机视频帧头过长。");
        const lines = this.buffer.subarray(0, end).toString("ascii").split("\r\n");
        if (lines.shift() !== "--qdd-frame") throw new ScreenError("SCREEN_INVALID_FRAME", "手机视频流的边界无效。");
        const headers = new Headers();
        for (const line of lines) {
          const match = /^([a-z0-9-]+):[ \t]*([^\r\n]*)$/iu.exec(line);
          if (!match || headers.has(match[1]!)) throw new ScreenError("SCREEN_INVALID_FRAME", "手机视频帧头无效或重复。");
          headers.set(match[1]!, match[2]!);
        }
        const length = headers.get("content-length");
        if (!length || !/^[1-9]\d*$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > this.maxBytes) {
          throw new ScreenError("SCREEN_INVALID_FRAME", "手机视频帧长度无效。");
        }
        this.headers = headers;
        this.length = Number(length);
        this.receivedAt = performance.now();
        this.buffer = this.buffer.subarray(end + 4);
      }
      if (this.buffer.length < this.length + 2) break;
      if (this.buffer[this.length] !== 13 || this.buffer[this.length + 1] !== 10) throw new ScreenError("SCREEN_INVALID_FRAME", "手机视频帧没有完整结束。");
      frames.push({ headers: this.headers, bytes: Buffer.from(this.buffer.subarray(0, this.length)), receivedAt: this.receivedAt });
      this.buffer = this.buffer.subarray(this.length + 2);
      this.headers = undefined;
    }
    return frames;
  }
}

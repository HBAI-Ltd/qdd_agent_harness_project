import { performance } from "node:perf_hooks";
import { readPngDimensions } from "./adb.js";
import type { AdbCapture, AdbDevice } from "./adb.js";

export const PHONE_SCREEN_PORT = 8791;
export const MAX_SCREEN_FRAME_AGE_MS = 3000;
export const MAX_SCREEN_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_HEALTH_BYTES = 64 * 1024;
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
type FrameResponse = Pick<Response, "headers" | "body">;

function withAbortSignal<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    task.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}
export const PREVIEW_PROFILES = ["turbo", "fast", "standard", "original"] as const;
export type PreviewProfile = typeof PREVIEW_PROFILES[number];
export interface PreviewProfileState { profile: PreviewProfile; deviceWidth?: number; deviceHeight?: number }

export interface ScreenCapture extends AdbCapture {
  mimeType: "image/jpeg" | "image/png";
  source: "screen-app";
  sourceFrameId: string;
  frameAgeMs: number;
  deviceWidth?: number;
  deviceHeight?: number;
  previewProfile?: PreviewProfile;
}

export interface ScreenClientOptions {
  endpoint: string;
  deviceId?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  maxFrameAgeMs?: number;
  fetch?: typeof globalThis.fetch;
}

export type ScreenErrorCode = "SCREEN_INVALID_ENDPOINT" | "SCREEN_DEVICE_MISMATCH"
  | "SCREEN_TIMEOUT" | "SCREEN_UNREACHABLE" | "SCREEN_NOT_PROJECTING"
  | "SCREEN_HTTP_ERROR" | "SCREEN_INVALID_HEALTH" | "SCREEN_INVALID_FRAME" | "SCREEN_STALE_FRAME" | "SCREEN_TOO_LARGE" | "SCREEN_INVALID_PROFILE";

export class ScreenError extends Error {
  constructor(readonly code: ScreenErrorCode, message: string) {
    super(message);
    this.name = "ScreenError";
  }
}

function endpointOrigin(endpoint: string): string {
  const invalid = () => new ScreenError("SCREEN_INVALID_ENDPOINT", "ANDROID_SCREEN_URL 必须是明确的内网 IPv4 地址，例如 http://192.168.1.20:8791；不得包含账号、查询参数或公开互联网地址。");
  let url: URL;
  try { url = new URL(endpoint); } catch { throw invalid(); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "/frame.jpg")) throw invalid();
  const octets = url.hostname.split(".").map(Number);
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(url.hostname) || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) throw invalid();
  const [a, b] = octets;
  if (!(a === 10 || a === 127 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168))) throw invalid();
  return url.origin;
}

/** Validate JPEG marker boundaries and its complete ending without decoding pixels. */
export function readJpegDimensions(jpeg: Buffer): { width: number; height: number } {
  const invalid = (): never => { throw new Error("Invalid or incomplete JPEG image."); };
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) invalid();
  let offset = 2, width = 0, height = 0, components = 0;
  let scan = false, sawScan = false, entropyBytes = 0;
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset < jpeg.length) {
    if (scan) {
      while (offset < jpeg.length && jpeg[offset] !== 0xff) { offset += 1; entropyBytes += 1; }
      if (offset >= jpeg.length) invalid();
      let next = offset + 1;
      while (next < jpeg.length && jpeg[next] === 0xff) next += 1;
      const marker = jpeg[next];
      if (marker === 0 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) {
        offset = next + 1; entropyBytes += 1; continue;
      }
      if (entropyBytes === 0) invalid();
      scan = false;
    }
    if (jpeg[offset++] !== 0xff) invalid();
    while (offset < jpeg.length && jpeg[offset] === 0xff) offset += 1;
    const marker = jpeg[offset++];
    if (marker === undefined || marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) invalid();
    if (marker === 0xd9) {
      if (offset !== jpeg.length || !width || !height || !sawScan || !entropyBytes) invalid();
      return { width, height };
    }
    if (marker === 1) continue;
    if (offset + 2 > jpeg.length) invalid();
    const length = jpeg.readUInt16BE(offset), end = offset + length;
    if (length < 2 || end > jpeg.length) invalid();
    if (frameMarkers.has(marker!)) {
      if (width || length < 11 || jpeg[offset + 2] !== 8) invalid();
      height = jpeg.readUInt16BE(offset + 3); width = jpeg.readUInt16BE(offset + 5);
      components = jpeg[offset + 7]!;
      if (!width || !height || components < 1 || components > 4 || length !== 8 + 3 * components) invalid();
    }
    if (marker === 0xda) {
      const count = jpeg[offset + 2];
      if (!width || !height || count === undefined || count < 1 || count > components || length !== 6 + 2 * count) invalid();
      scan = true; sawScan = true; entropyBytes = 0;
    }
    offset = end;
  }
  return invalid();
}

/** Screens come exclusively from one explicitly configured LAN MediaProjection app. */
export class ScreenClient {
  readonly endpoint: string;
  private readonly deviceId: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxBuffer: number;
  private readonly maxFrameAgeMs: number;
  private readonly fetcher: typeof globalThis.fetch;
  private tail: Promise<void> = Promise.resolve();
  private profileTail: Promise<void> = Promise.resolve();

  constructor(options: ScreenClientOptions) {
    this.endpoint = endpointOrigin(options.endpoint);
    if (options.deviceId !== undefined && !DEVICE_ID.test(options.deviceId)) throw new ScreenError("SCREEN_DEVICE_MISMATCH", "deviceId 必须是手机投屏 App 的完整设备 UUID。");
    this.deviceId = options.deviceId?.toLowerCase();
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxBuffer = options.maxBuffer ?? MAX_SCREEN_FRAME_BYTES;
    this.maxFrameAgeMs = options.maxFrameAgeMs ?? MAX_SCREEN_FRAME_AGE_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_147_483_647) throw new RangeError("投屏 timeoutMs 必须是有效的正整数。");
    if (!Number.isSafeInteger(this.maxBuffer) || this.maxBuffer <= 0 || this.maxBuffer > MAX_SCREEN_FRAME_BYTES) throw new RangeError("投屏 maxBuffer 必须是 1 到 32 MiB 之间的整数。");
    if (!Number.isSafeInteger(this.maxFrameAgeMs) || this.maxFrameAgeMs < 0 || this.maxFrameAgeMs > MAX_SCREEN_FRAME_AGE_MS) throw new RangeError("投屏帧时效上限不得超过 3000 ms。");
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  listDevices(): Promise<AdbDevice[]> {
    return this.request("/health", async (response, signal) => {
      if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        this.cancelBody(response);
        throw new ScreenError("SCREEN_INVALID_HEALTH", "手机投屏 App 未返回有效的设备健康信息。");
      }
      const bytes = await this.readBody(response, signal, MAX_HEALTH_BYTES, "SCREEN_INVALID_HEALTH");
      let health: Record<string, unknown>;
      try { health = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>; }
      catch { throw new ScreenError("SCREEN_INVALID_HEALTH", "手机投屏 App 的设备健康信息不是有效 JSON。"); }
      if (!health || typeof health !== "object" || Array.isArray(health) || health["status"] !== "ok"
        || health["service"] !== "qdd-android-screen" || typeof health["deviceId"] !== "string"
        || !DEVICE_ID.test(health["deviceId"]) || typeof health["model"] !== "string" || !health["model"]
        || health["model"].length > 256 || typeof health["projecting"] !== "boolean") {
        throw new ScreenError("SCREEN_INVALID_HEALTH", "手机投屏 App 的设备 ID、型号或投屏状态无效，请更新手机 App。");
      }
      const serial = health["deviceId"].toLowerCase();
      this.checkDeviceId(serial, this.deviceId);
      return [{ serial, state: health["projecting"] ? "device" : "not_projecting", model: health["model"],
        properties: { source: "screen-app", endpoint: this.endpoint, projecting: String(health["projecting"]),
          ...(typeof health["frameReady"] === "boolean" ? { frameReady: String(health["frameReady"]) } : {}),
        } }];
    });
  }

  capture(serial: string | undefined = this.deviceId, signal?: AbortSignal): Promise<ScreenCapture> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const task = this.tail.then(() => {
      // A queued cancellation rejects its caller immediately and must not send
      // an obsolete request when the previous caller eventually releases FIFO.
      signal?.throwIfAborted();
      return this.request("/frame.jpg", async (response, active) => {
        const frame = await this.readFrame(response, serial, active);
        if (frame.width !== frame.deviceWidth || frame.height !== frame.deviceHeight || frame.previewProfile !== "original") {
          throw new ScreenError("SCREEN_INVALID_FRAME", "MCP 原图接口返回了缩小预览，请更新手机投屏 App。");
        }
        return frame;
      }, "GET", undefined, undefined, signal);
    });
    this.tail = task.then(() => undefined, () => undefined);
    return withAbortSignal(task, signal);
  }

  getPreviewProfile(): Promise<PreviewProfileState> {
    return this.profileRequest();
  }

  setPreviewProfile(profile: PreviewProfile): Promise<PreviewProfileState> {
    if (!PREVIEW_PROFILES.includes(profile)) return Promise.reject(new ScreenError("SCREEN_INVALID_PROFILE", "未知画质档位。"));
    return this.profileRequest(profile);
  }

  private profileRequest(profile?: PreviewProfile): Promise<PreviewProfileState> {
    const task = this.profileTail.then(() => this.request("/preview/profile", async (response, signal) => {
      if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        this.cancelBody(response);
        throw new ScreenError("SCREEN_INVALID_PROFILE", "手机未返回有效的画质设置。");
      }
      const bytes = await this.readBody(response, signal, 2048, "SCREEN_INVALID_PROFILE");
      let state: Record<string, unknown>;
      try { state = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>; }
      catch { throw new ScreenError("SCREEN_INVALID_PROFILE", "手机画质设置不是有效 JSON。"); }
      if (!state || typeof state !== "object" || Array.isArray(state)
        || !PREVIEW_PROFILES.includes(state["profile"] as PreviewProfile)) throw new ScreenError("SCREEN_INVALID_PROFILE", "手机返回了未知画质档位。");
      if (profile !== undefined && state["profile"] !== profile) throw new ScreenError("SCREEN_INVALID_PROFILE", "手机未应用所选画质，请重新选择。");
      const width = state["deviceWidth"], height = state["deviceHeight"];
      if ((width === undefined) !== (height === undefined) || (width !== undefined &&
        (![width, height].every((size) => typeof size === "number" && Number.isSafeInteger(size) && size > 0 && size <= 65535)))) {
        throw new ScreenError("SCREEN_INVALID_PROFILE", "手机画质设置的物理屏幕尺寸无效。");
      }
      return { profile: state["profile"] as PreviewProfile,
        ...(width === undefined ? {} : { deviceWidth: width as number, deviceHeight: height as number }) };
    }, profile === undefined ? "GET" : "POST", profile === undefined ? undefined : JSON.stringify({ profile }),
    profile === undefined ? () => ({ profile: "original" as const }) : undefined));
    this.profileTail = task.then(() => undefined, () => undefined);
    return task;
  }

  /** A single HTTP response carries every new phone frame until cancelled. */
  async *stream(signal: AbortSignal): AsyncGenerator<ScreenCapture> {
    const { MultipartFrameParser } = await import("./live.js");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    let timer: NodeJS.Timeout | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const deadline = (ms: number) => { clearTimeout(timer); timer = setTimeout(cancel, ms); };
    deadline(this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.endpoint}/stream.mjpg`, {
        signal: controller.signal, redirect: "error", cache: "no-store",
      });
      if (response.status !== 200 || response.redirected ||
        !/^multipart\/x-mixed-replace;\s*boundary=(?:qdd-frame|"qdd-frame")$/iu.test(response.headers.get("content-type") ?? "")) {
        this.cancelBody(response);
        throw new ScreenError("SCREEN_HTTP_ERROR", response.status === 404
          ? "请先更新手机投屏 App，新版本才能连续传送画面。" : "手机暂时不能传送视频，请重新开始投屏。");
      }
      if (!response.body) throw new ScreenError("SCREEN_INVALID_FRAME", "手机没有传送视频数据。");
      reader = response.body.getReader();
      const parser = new MultipartFrameParser(this.maxBuffer);
      const abortRead = () => { void reader?.cancel().catch(() => {}); };
      controller.signal.addEventListener("abort", abortRead, { once: true });
      if (controller.signal.aborted) abortRead();
      let previousId: string | undefined;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (controller.signal.aborted) throw new ScreenError("SCREEN_TIMEOUT", "手机画面已中断，操作已暂停。");
          if (chunk.done) break;
          for (const part of parser.push(chunk.value)) {
            // The multipart parser has already bounded and assembled this JPEG.
            // Validate those exact bytes instead of wrapping them in another
            // Response and copying them through a second body reader.
            const frame = await this.readFrame({ headers: part.headers, body: null }, this.deviceId,
              controller.signal, part.bytes, part.receivedAt);
            if (frame.sourceFrameId === previousId) throw new ScreenError("SCREEN_INVALID_FRAME", "手机重复发送了旧画面，操作已暂停。");
            previousId = frame.sourceFrameId;
            deadline(Math.max(1, MAX_SCREEN_FRAME_AGE_MS - frame.frameAgeMs));
            yield frame;
          }
        }
      } finally { controller.signal.removeEventListener("abort", abortRead); }
    } catch (error) {
      if (error instanceof ScreenError) throw error;
      throw new ScreenError("SCREEN_UNREACHABLE", "没有收到手机视频，请检查 Wi-Fi 和手机投屏开关。");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      controller.abort();
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  }

  private async request<T>(path: "/health" | "/frame.jpg" | "/preview/profile", read: (response: Response, signal: AbortSignal) => Promise<T>,
    method: "GET" | "POST" = "GET", body?: string, missing?: () => T, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    let abort: (() => void) | undefined;
    const cancellation = signal ? new Promise<never>((_resolve, reject) => {
      abort = () => { controller.abort(signal.reason); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    }) : undefined;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(this.timeoutError());
      }, this.timeoutMs);
    });
    const request = async (): Promise<T> => {
      let response: Response;
      try {
        response = await this.fetcher(`${this.endpoint}${path}`, {
          method,
          ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body }),
          signal: controller.signal, redirect: "error", cache: "no-store",
        });
      } catch {
        this.checkActive(controller.signal);
        throw new ScreenError("SCREEN_UNREACHABLE", "无法连接内网手机投屏 App，请检查手机与电脑的局域网连接、App 地址和投屏状态。");
      }
      if (controller.signal.aborted) this.cancelBody(response);
      this.checkActive(controller.signal);
      if (response.status !== 200 || response.redirected) {
        this.cancelBody(response);
        if (response.status === 404 && !response.redirected && path === "/preview/profile") {
          if (missing) return missing();
          throw new ScreenError("SCREEN_HTTP_ERROR", "请先更新手机投屏 App，才能切换预览画质。");
        }
        if (response.status === 503) throw new ScreenError("SCREEN_NOT_PROJECTING", "手机暂时没有新画面：可能尚未开始投屏、投屏已停止，或画面超过三秒未更新。请检查设备投屏 App 的状态与局域网连接；未开始时请点击“开始投屏”并确认系统屏幕共享授权。");
        throw new ScreenError("SCREEN_HTTP_ERROR", `手机投屏 App 返回 HTTP ${response.status} 或重定向，已拒绝该响应。`);
      }
      return read(response, controller.signal);
    };
    try {
      signal?.throwIfAborted();
      return await Promise.race([request(), timeout, ...(cancellation ? [cancellation] : [])]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }

  private async readFrame(response: FrameResponse, expectedId: string | undefined, signal: AbortSignal,
    assembledBytes?: Buffer, receivedAt = performance.now()): Promise<ScreenCapture> {
    const invalid = (message: string): never => {
      this.cancelBody(response);
      throw new ScreenError("SCREEN_INVALID_FRAME", message);
    };
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mimeType !== "image/jpeg" && mimeType !== "image/png") invalid("手机投屏 App 未返回 JPEG 或 PNG 图像。");
    const deviceId = response.headers.get("x-device-id");
    if (!deviceId || !DEVICE_ID.test(deviceId)) invalid("手机投屏帧缺少有效的 X-Device-Id 设备 UUID，请更新手机投屏 App。");
    const serial = deviceId!.toLowerCase();
    try { this.checkDeviceId(serial, this.deviceId); this.checkDeviceId(serial, expectedId); }
    catch (error) { this.cancelBody(response); throw error; }
    const sourceFrameId = response.headers.get("x-frame-id")?.trim();
    if (!sourceFrameId || sourceFrameId.length > 256) invalid("手机投屏帧缺少有效的 X-Frame-Id，请更新手机投屏 App。");
    const rawAge = response.headers.get("x-frame-age-ms");
    if (rawAge === null || !/^\d+$/u.test(rawAge) || !Number.isSafeInteger(Number(rawAge))) invalid("手机投屏帧缺少有效的 X-Frame-Age-Ms，无法验证画面时效。");
    const frameAge = Number(rawAge);
    if (frameAge > this.maxFrameAgeMs) {
      this.cancelBody(response);
      throw new ScreenError("SCREEN_STALE_FRAME", "手机投屏画面已超过 3 秒未更新，请恢复手机 App 的投屏后重试。");
    }
    const capturedAt = response.headers.get("x-captured-at");
    if (!capturedAt || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/u.test(capturedAt) || !Number.isFinite(Date.parse(capturedAt))) invalid("手机投屏帧缺少有效的 X-Captured-At 时间。");
    const rawRotation = response.headers.get("x-display-rotation");
    if (rawRotation !== null && !/^[0-3]$/u.test(rawRotation)) invalid("手机投屏帧的 X-Display-Rotation 必须是 0 到 3 的整数。");
    const rotation = rawRotation === null ? undefined : Number(rawRotation) as 0 | 1 | 2 | 3;
    this.checkActive(signal);
    const bytes = assembledBytes ?? await this.readBody(response, signal, this.maxBuffer, "SCREEN_INVALID_FRAME");
    let dimensions: { width: number; height: number };
    try { dimensions = mimeType === "image/jpeg" ? readJpegDimensions(bytes) : readPngDimensions(bytes); }
    catch { throw new ScreenError("SCREEN_INVALID_FRAME", "手机投屏 App 返回的图像不完整或校验失败。"); }
    for (const [header, size] of [["x-frame-width", dimensions.width], ["x-frame-height", dimensions.height]] as const) {
      const value = response.headers.get(header);
      if (value !== null && (!/^\d+$/u.test(value) || Number(value) !== size)) invalid("手机投屏帧头尺寸与图像尺寸不匹配。");
    }
    const physicalWidth = response.headers.get("x-device-width"), physicalHeight = response.headers.get("x-device-height");
    const rawProfile = response.headers.get("x-preview-profile");
    const hasPreviewMetadata = physicalWidth !== null || physicalHeight !== null || rawProfile !== null;
    let deviceWidth = dimensions.width, deviceHeight = dimensions.height;
    let previewProfile: PreviewProfile = "original";
    if (hasPreviewMetadata) {
      if (physicalWidth === null || physicalHeight === null || rawProfile === null
        || ![physicalWidth, physicalHeight].every((value) => /^[1-9]\d*$/u.test(value)
          && Number.isSafeInteger(Number(value)) && Number(value) <= 65535)
        || !PREVIEW_PROFILES.includes(rawProfile as PreviewProfile)) invalid("手机预览帧缺少成对物理尺寸或有效画质档位。");
      deviceWidth = Number(physicalWidth); deviceHeight = Number(physicalHeight); previewProfile = rawProfile as PreviewProfile;
      if (deviceWidth < dimensions.width || deviceHeight < dimensions.height
        || Math.abs(dimensions.width * deviceHeight - dimensions.height * deviceWidth) > deviceWidth + deviceHeight
        || (previewProfile === "original" && (deviceWidth !== dimensions.width || deviceHeight !== dimensions.height))) {
        invalid("手机预览尺寸与真实屏幕尺寸不一致。");
      }
    }
    const frameAgeMs = Math.ceil(frameAge + performance.now() - receivedAt);
    if (frameAgeMs > this.maxFrameAgeMs) throw new ScreenError("SCREEN_STALE_FRAME", "手机投屏图像传输后已超过 3 秒，请恢复投屏后重试。");
    // Preserve the existing capture buffer field for ADB/PNG adapters; MIME describes its actual bytes.
    return { png: bytes, ...dimensions, serial, capturedAt: new Date(capturedAt!).toISOString(),
      source: "screen-app", sourceFrameId: sourceFrameId!, frameAgeMs, mimeType: mimeType as ScreenCapture["mimeType"],
      deviceWidth, deviceHeight, previewProfile,
      ...(rotation === undefined ? {} : { rotation }) };
  }

  private async readBody(response: FrameResponse, signal: AbortSignal, limit: number,
    invalidCode: "SCREEN_INVALID_FRAME" | "SCREEN_INVALID_HEALTH" | "SCREEN_INVALID_PROFILE"): Promise<Buffer> {
    const invalid = (message: string): never => { this.cancelBody(response); throw new ScreenError(invalidCode, message); };
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && (!/^\d+$/u.test(contentLength) || !Number.isSafeInteger(Number(contentLength)))) invalid("手机投屏响应的 Content-Length 无效。");
    if (contentLength !== null && Number(contentLength) > limit) {
      this.cancelBody(response);
      throw new ScreenError("SCREEN_TOO_LARGE", "手机投屏响应超过大小上限，已停止读取。");
    }
    if (!response.body) invalid("手机投屏 App 返回了空响应。");
    const reader = response.body!.getReader();
    const chunks: Buffer[] = [];
    let length = 0;
    const onAbort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        this.checkActive(signal);
        const chunk = await reader.read();
        this.checkActive(signal);
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > limit) {
          void reader.cancel().catch(() => {});
          throw new ScreenError("SCREEN_TOO_LARGE", "手机投屏响应超过大小上限，已停止读取。");
        }
        chunks.push(Buffer.from(chunk.value));
      }
    } catch (error) {
      if (error instanceof ScreenError) throw error;
      this.checkActive(signal);
      throw new ScreenError(invalidCode, "手机投屏数据传输中断，请检查局域网连接后重试。");
    } finally {
      signal.removeEventListener("abort", onAbort);
      reader.releaseLock();
    }
    if (contentLength !== null && Number(contentLength) !== length) throw new ScreenError(invalidCode, "手机投屏响应未完整传输。");
    return Buffer.concat(chunks, length);
  }

  private checkDeviceId(actual: string, expected: string | undefined): void {
    if (expected !== undefined && (!DEVICE_ID.test(expected) || actual !== expected.toLowerCase())) {
      throw new ScreenError("SCREEN_DEVICE_MISMATCH", "当前投屏 App 的设备 UUID 与所选设备不匹配，请重新观察并明确选择当前手机。");
    }
  }
  private timeoutError(): ScreenError { return new ScreenError("SCREEN_TIMEOUT", `手机投屏在 ${this.timeoutMs} ms 内未响应，请检查局域网连接及手机 App 的投屏状态。`); }
  private checkActive(signal: AbortSignal): void {
    if (signal.aborted) throw this.timeoutError();
  }
  private cancelBody(response: FrameResponse): void { void response.body?.cancel().catch(() => {}); }
}

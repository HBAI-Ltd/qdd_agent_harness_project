import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";

export const MAX_ADB_OUTPUT_BYTES = 32 * 1024 * 1024;
export const DEFAULT_ADB_TIMEOUT_MS = 10_000;

export interface AdbDevice {
  serial: string;
  state: string;
  model?: string;
  product?: string;
  device?: string;
  transportId?: string;
  properties: Record<string, string>;
}

export interface AdbCapture {
  png: Buffer;
  width: number;
  height: number;
  capturedAt: string;
  serial: string;
  rotation?: 0 | 1 | 2 | 3;
  source?: "screen-app" | "adb";
  sourceFrameId?: string;
  frameAgeMs?: number;
}

export interface AdbExecution {
  command: string;
  args: readonly string[];
  timeoutMs: number;
  maxBuffer: number;
}

export interface AdbExecutionResult {
  stdout: Buffer;
  stderr: Buffer;
}

export type AdbExecutor = (execution: AdbExecution) => Promise<AdbExecutionResult>;

export interface AdbClientOptions {
  adbPath?: string;
  deviceSerial?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  executor?: AdbExecutor;
  environment?: NodeJS.ProcessEnv;
}

export type AdbErrorCode =
  | "ADB_NOT_FOUND"
  | "ADB_NO_DEVICES"
  | "ADB_SERIAL_REQUIRED"
  | "ADB_INVALID_SERIAL"
  | "ADB_DEVICE_NOT_FOUND"
  | "ADB_UNAUTHORIZED"
  | "ADB_OFFLINE"
  | "ADB_DEVICE_UNAVAILABLE"
  | "ADB_TIMEOUT"
  | "ADB_OUTPUT_TOO_LARGE"
  | "ADB_COMMAND_FAILED"
  | "ADB_INVALID_PNG";

export class AdbError extends Error {
  constructor(readonly code: AdbErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AdbError";
  }
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function pathCandidates(name: string, environment: NodeJS.ProcessEnv): string[] {
  const pathValue = environment.PATH ?? environment.Path ?? "";
  const names = process.platform === "win32" && !name.toLowerCase().endsWith(".exe")
    ? [`${name}.exe`, name]
    : [name];
  return pathValue.split(delimiter).filter(Boolean).flatMap((entry) => {
    const directory = entry.replace(/^"|"$/g, "");
    return names.map((fileName) => resolve(directory, fileName));
  });
}

/** Resolve the executable without trusting a stale SDK environment variable. */
export function resolveAdbPath(
  explicitPath?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (explicitPath !== undefined) {
    const configured = explicitPath.trim();
    const candidates = isAbsolute(configured) || /[/\\]/u.test(configured)
      ? [resolve(configured)]
      : pathCandidates(configured, environment);
    const match = configured.length > 0 ? candidates.find(isFile) : undefined;
    if (match !== undefined) return match;
    throw new AdbError("ADB_NOT_FOUND", `配置的 ADB 可执行文件不存在：${explicitPath || "(空路径)"}。请设置有效的 adbPath。`);
  }

  const executable = process.platform === "win32" ? "adb.exe" : "adb";
  const sdkCandidates = [environment.ANDROID_HOME, environment.ANDROID_SDK_ROOT]
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .map((directory) => resolve(directory, "platform-tools", executable));
  const match = [...sdkCandidates, ...pathCandidates("adb", environment)].find(isFile);
  if (match !== undefined) return match;
  const checkedSdk = sdkCandidates.length > 0 ? ` 已检查 SDK 路径：${sdkCandidates.join("、")}。` : "";
  throw new AdbError("ADB_NOT_FOUND", `未找到 ADB。请显式配置 adbPath，或安装 Android SDK Platform Tools 并设置 ANDROID_HOME / ANDROID_SDK_ROOT 或 PATH。${checkedSdk}`);
}

/** Parse `adb devices -l`; unavailable devices remain visible to the caller. */
export function parseAdbDevices(output: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("List of devices") || line.startsWith("*")) continue;
    const [serial, state, ...details] = line.split(/\s+/u);
    if (serial === undefined || state === undefined) continue;
    const properties: Record<string, string> = {};
    for (const detail of details) {
      const separator = detail.indexOf(":");
      if (separator > 0) properties[detail.slice(0, separator)] = detail.slice(separator + 1);
    }
    devices.push({
      serial,
      state,
      properties,
      ...(properties.model === undefined ? {} : { model: properties.model }),
      ...(properties.product === undefined ? {} : { product: properties.product }),
      ...(properties.device === undefined ? {} : { device: properties.device }),
      ...(properties.transport_id === undefined ? {} : { transportId: properties.transport_id }),
    });
  }
  return devices;
}

function validateSerial(serial: string): string {
  const normalized = serial.trim();
  if (normalized.length === 0 || normalized.length > 512 || /[\s\0]/u.test(normalized) || normalized.startsWith("-")) {
    throw new AdbError("ADB_INVALID_SERIAL", "Android 设备 serial 无效，请使用 list_devices 返回的完整 serial。");
  }
  return normalized;
}

export function selectAdbDevice(devices: readonly AdbDevice[], requestedSerial?: string): AdbDevice {
  if (devices.length === 0) {
    throw new AdbError("ADB_NO_DEVICES", "未发现 Android 设备。请通过 USB 连接手机、开启 USB 调试，并在手机上确认调试授权。");
  }
  if (requestedSerial === undefined || requestedSerial.trim().length === 0) {
    const available = devices.map(({ serial, state }) => `${serial} (${state})`).join("、");
    throw new AdbError("ADB_SERIAL_REQUIRED", `必须显式选择 Android 设备 serial，避免操作错误手机。当前设备：${available}。`);
  }
  const serial = validateSerial(requestedSerial);
  const selected = devices.find((device) => device.serial === serial);
  if (selected === undefined) throw new AdbError("ADB_DEVICE_NOT_FOUND", `未发现指定的 Android 设备 ${serial}，请重新调用 list_devices 并检查 USB 连接。`);
  if (selected.state === "unauthorized") throw new AdbError("ADB_UNAUTHORIZED", `Android 设备 ${serial} 尚未授权 USB 调试，请解锁手机并确认 RSA 授权对话框。`);
  if (selected.state === "offline") throw new AdbError("ADB_OFFLINE", `Android 设备 ${serial} 处于 offline 状态，请检查 USB 连接并重新授权调试。`);
  if (selected.state !== "device") throw new AdbError("ADB_DEVICE_UNAVAILABLE", `Android 设备 ${serial} 当前状态为 ${selected.state}，无法采集屏幕。`);
  return selected;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Validate signature, IHDR, chunk boundaries/CRCs and a complete IDAT/IEND stream. */
export function readPngDimensions(png: Buffer): { width: number; height: number } {
  const invalid = (reason: string): never => {
    throw new AdbError("ADB_INVALID_PNG", `ADB 返回的屏幕图像不是完整有效的 PNG：${reason}。`);
  };
  if (png.length < 45 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) invalid("签名或长度无效");
  if (png.readUInt32BE(8) !== 13 || png.toString("ascii", 12, 16) !== "IHDR") invalid("缺少有效 IHDR");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) invalid("图像尺寸无效");
  const bitDepth = png[24];
  const colorType = png[25];
  const validBitDepths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (colorType === undefined || bitDepth === undefined || !validBitDepths[colorType]?.includes(bitDepth)) invalid("IHDR 像素格式无效");
  if (png[26] !== 0 || png[27] !== 0 || (png[28] !== 0 && png[28] !== 1)) invalid("IHDR 编码方式无效");

  let offset = 8;
  let hasImageData = false;
  while (offset < png.length) {
    if (png.length - offset < 12) invalid("PNG 块被截断");
    const length = png.readUInt32BE(offset);
    if (length > png.length - offset - 12) invalid("PNG 块长度超过剩余数据");
    const type = png.toString("ascii", offset + 4, offset + 8);
    const end = offset + 8 + length;
    if (crc32(png.subarray(offset + 4, end)) !== png.readUInt32BE(end)) invalid(`${type} 校验和不匹配`);
    if (type === "IHDR" && offset !== 8) invalid("IHDR 重复");
    if (type === "IDAT" && length > 0) hasImageData = true;
    offset = end + 4;
    if (type === "IEND") {
      if (length !== 0 || !hasImageData || offset !== png.length) invalid("IEND 或图像数据无效");
      return { width, height };
    }
  }
  return invalid("缺少 IEND");
}

const executeAdb: AdbExecutor = ({ command, args, timeoutMs, maxBuffer }) => new Promise((resolveExecution, rejectExecution) => {
  execFile(command, [...args], { encoding: "buffer", timeout: timeoutMs, maxBuffer, windowsHide: true, shell: false }, (error, stdout, stderr) => {
    if (error !== null) {
      Object.assign(error, { stderr });
      rejectExecution(error);
      return;
    }
    resolveExecution({ stdout, stderr });
  });
});

function executionError(error: unknown, timeoutMs: number): AdbError {
  const details = error instanceof Error ? error : new Error(String(error));
  const metadata = error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
  if (metadata.code === "ETIMEDOUT" || (metadata.killed === true && metadata.signal === "SIGTERM")) {
    return new AdbError("ADB_TIMEOUT", `ADB 命令在 ${timeoutMs} ms 内未完成，请检查 USB 连接和手机状态。`, { cause: details });
  }
  if (metadata.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || metadata.code === "ENOBUFS") {
    return new AdbError("ADB_OUTPUT_TOO_LARGE", "ADB 输出超过允许的缓冲区大小，已停止采集。", { cause: details });
  }
  const stderr = Buffer.isBuffer(metadata.stderr) ? metadata.stderr.toString("utf8").trim() : "";
  return new AdbError("ADB_COMMAND_FAILED", `ADB 命令失败：${stderr || details.message}`, { cause: details });
}

export class AdbClient {
  readonly path: string;
  private readonly serial: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxBuffer: number;
  private readonly executor: AdbExecutor;

  constructor(options: AdbClientOptions = {}) {
    this.path = resolveAdbPath(options.adbPath, options.environment ?? process.env);
    this.serial = options.deviceSerial;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ADB_TIMEOUT_MS;
    this.maxBuffer = options.maxBuffer ?? MAX_ADB_OUTPUT_BYTES;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_147_483_647) throw new RangeError("ADB timeoutMs 必须是有效的正整数。");
    if (!Number.isSafeInteger(this.maxBuffer) || this.maxBuffer <= 0 || this.maxBuffer > MAX_ADB_OUTPUT_BYTES) throw new RangeError("ADB maxBuffer 必须是 1 到 32 MiB 之间的整数。");
    this.executor = options.executor ?? executeAdb;
  }

  private async run(args: readonly string[]): Promise<Buffer> {
    let output: AdbExecutionResult;
    try {
      output = await this.executor({ command: this.path, args, timeoutMs: this.timeoutMs, maxBuffer: this.maxBuffer });
    } catch (error) {
      throw executionError(error, this.timeoutMs);
    }
    if (!Buffer.isBuffer(output.stdout)) throw new AdbError("ADB_COMMAND_FAILED", "ADB 必须返回二进制 Buffer，不能对 PNG 输出进行文本转换。");
    if (output.stdout.length > this.maxBuffer) throw new AdbError("ADB_OUTPUT_TOO_LARGE", "ADB 输出超过允许的缓冲区大小，已停止采集。");
    return output.stdout;
  }

  async listDevices(): Promise<AdbDevice[]> {
    return parseAdbDevices((await this.run(["devices", "-l"])).toString("utf8"));
  }

  async capture(serial: string | undefined = this.serial): Promise<AdbCapture> {
    const selected = selectAdbDevice(await this.listDevices(), serial);
    const png = await this.run(["-s", selected.serial, "exec-out", "screencap", "-p"]);
    const dimensions = readPngDimensions(png);
    return { png, ...dimensions, capturedAt: new Date().toISOString(), serial: selected.serial };
  }
}

export function createAdbClient(options: AdbClientOptions = {}): AdbClient {
  return new AdbClient(options);
}

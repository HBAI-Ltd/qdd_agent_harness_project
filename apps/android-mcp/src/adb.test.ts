import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import {
  AdbClient,
  AdbError,
  DEFAULT_ADB_TIMEOUT_MS,
  MAX_ADB_OUTPUT_BYTES,
  parseAdbDevices,
  readPngDimensions,
  resolveAdbPath,
  selectAdbDevice,
} from "./adb.js";
import type { AdbClientOptions, AdbExecution, AdbExecutionResult, AdbExecutor } from "./adb.js";

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  let checksum = 0xffffffff;
  for (const byte of chunk.subarray(4, chunk.length - 4)) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) checksum = (checksum >>> 1) ^ ((checksum & 1) === 1 ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((checksum ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

function makePng(width = 2, height = 3): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const DEVICES = "List of devices attached\r\nUSB-ONE device product:phone model:Pixel_8 device:husky transport_id:4\r\nUSB-TWO device product:phone model:Phone device:phone transport_id:5\r\n";

function mockClient(
  outputs: (Buffer | Error)[],
  options: Omit<AdbClientOptions, "adbPath" | "executor"> = {},
): { client: AdbClient; calls: AdbExecution[] } {
  const calls: AdbExecution[] = [];
  const executor: AdbExecutor = async (execution) => {
    calls.push(execution);
    const output = outputs.shift();
    assert.notEqual(output, undefined, "Unexpected ADB command");
    if (output instanceof Error) throw output;
    return { stdout: output as Buffer, stderr: Buffer.alloc(0) };
  };
  return { client: new AdbClient({ ...options, adbPath: process.execPath, executor }), calls };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof AdbError && error.code === code;
}

test("parse devices keeps authorized, unauthorized, offline and multiple devices", () => {
  const devices = parseAdbDevices(`${DEVICES}UNAUTHORIZED unauthorized transport_id:6\nOFFLINE offline transport_id:7\nRECOVERY recovery\n\n`);
  assert.equal(devices.length, 5);
  assert.deepEqual(devices.map(({ serial, state }) => ({ serial, state })), [
    { serial: "USB-ONE", state: "device" },
    { serial: "USB-TWO", state: "device" },
    { serial: "UNAUTHORIZED", state: "unauthorized" },
    { serial: "OFFLINE", state: "offline" },
    { serial: "RECOVERY", state: "recovery" },
  ]);
  assert.equal(devices[0]?.model, "Pixel_8");
  assert.equal(devices[0]?.transportId, "4");
});

test("resolve ADB falls back from stale ANDROID_HOME to SDK_ROOT then PATH", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "qdd-adb-test-"));
  context.after(() => {
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
    rmSync(directory, { recursive: true, force: true });
  });
  const sdkDirectory = join(directory, "sdk");
  const platformTools = join(sdkDirectory, "platform-tools");
  mkdirSync(platformTools, { recursive: true });
  const executableName = process.platform === "win32" ? "adb.exe" : "adb";
  const executable = join(platformTools, executableName);
  writeFileSync(executable, "test fixture, never executed");
  const invalidSdk = join(directory, "missing-sdk");
  assert.equal(resolveAdbPath(undefined, { ANDROID_HOME: invalidSdk, ANDROID_SDK_ROOT: sdkDirectory, PATH: "" }), executable);
  assert.equal(resolveAdbPath(undefined, { ANDROID_HOME: invalidSdk, PATH: platformTools }), executable);
  assert.equal(resolveAdbPath("adb", { PATH: platformTools }), executable);
  assert.equal(resolveAdbPath(executable, { PATH: "" }), executable);
  assert.throws(() => resolveAdbPath(join(directory, "missing-adb"), { ANDROID_SDK_ROOT: sdkDirectory }), hasCode("ADB_NOT_FOUND"));
  assert.throws(() => resolveAdbPath(undefined, { ANDROID_HOME: invalidSdk, PATH: "" }), (error) => hasCode("ADB_NOT_FOUND")(error) && String(error).includes(invalidSdk));
});

test("no devices reports USB debugging and authorization instructions", async () => {
  const { client, calls } = mockClient([Buffer.from("List of devices attached\n\n")], { deviceSerial: "USB-ONE" });
  await assert.rejects(client.capture(), (error) => hasCode("ADB_NO_DEVICES")(error) && String(error).includes("USB 调试"));
  assert.equal(calls.length, 1);
});

test("even one device requires explicit serial selection", async () => {
  const { client, calls } = mockClient([Buffer.from("List of devices attached\nUSB-ONE device\n")]);
  await assert.rejects(client.capture(), hasCode("ADB_SERIAL_REQUIRED"));
  assert.equal(calls.length, 1);
});

test("selected USB device captures untouched binary via exec-out with explicit serial", async () => {
  const png = makePng();
  const { client, calls } = mockClient([Buffer.from(DEVICES), png], { deviceSerial: "USB-TWO" });
  const capture = await client.capture();
  assert.equal(capture.png, png);
  assert.equal(capture.serial, "USB-TWO");
  assert.equal(capture.width, 2);
  assert.equal(capture.height, 3);
  assert.ok(Number.isFinite(Date.parse(capture.capturedAt)));
  assert.deepEqual(calls.map(({ args }) => args), [["devices", "-l"], ["-s", "USB-TWO", "exec-out", "screencap", "-p"]]);
  assert.ok(calls.every(({ command, timeoutMs, maxBuffer }) => command === process.execPath && timeoutMs === DEFAULT_ADB_TIMEOUT_MS && maxBuffer === MAX_ADB_OUTPUT_BYTES));
});

test("capture argument chooses a different explicitly selected device", async () => {
  const { client, calls } = mockClient([Buffer.from(DEVICES), makePng()], { deviceSerial: "USB-ONE" });
  assert.equal((await client.capture("USB-TWO")).serial, "USB-TWO");
  assert.equal(calls[1]?.args[1], "USB-TWO");
});

test("unavailable selected devices never execute screenshot command", async (context) => {
  for (const [state, code] of [["unauthorized", "ADB_UNAUTHORIZED"], ["offline", "ADB_OFFLINE"], ["recovery", "ADB_DEVICE_UNAVAILABLE"]]) {
    await context.test(state ?? "unknown", async () => {
      const { client, calls } = mockClient([Buffer.from(`List of devices attached\nUSB-ONE ${state}\n`)], { deviceSerial: "USB-ONE" });
      await assert.rejects(client.capture(), hasCode(code ?? ""));
      assert.equal(calls.length, 1);
    });
  }
});

test("unknown serial and option-shaped or whitespace serials are rejected", () => {
  const devices = parseAdbDevices(DEVICES);
  assert.throws(() => selectAdbDevice(devices, "MISSING"), hasCode("ADB_DEVICE_NOT_FOUND"));
  for (const serial of ["-d", "USB ONE", "USB\nONE", "USB\0ONE"]) assert.throws(() => selectAdbDevice(devices, serial), hasCode("ADB_INVALID_SERIAL"));
  assert.throws(() => selectAdbDevice(devices), hasCode("ADB_SERIAL_REQUIRED"));
});

test("timeout produces a bounded failure and respects configured timeout", async () => {
  const timeout = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
  const { client, calls } = mockClient([timeout], { timeoutMs: 1234 });
  await assert.rejects(client.listDevices(), (error) => hasCode("ADB_TIMEOUT")(error) && String(error).includes("1234"));
  assert.equal(calls[0]?.timeoutMs, 1234);
});

test("execFile timeout signal is reported as timeout", async () => {
  const timeout = Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" });
  const { client } = mockClient([timeout]);
  await assert.rejects(client.listDevices(), hasCode("ADB_TIMEOUT"));
});

test("large screenshot and execFile buffer errors fail without text decoding", async () => {
  const { client } = mockClient([Buffer.from("List of devices attached\nUSB-ONE device\n"), Buffer.alloc(129)], { deviceSerial: "USB-ONE", maxBuffer: 128 });
  await assert.rejects(client.capture(), hasCode("ADB_OUTPUT_TOO_LARGE"));
  const bufferError = Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  await assert.rejects(mockClient([bufferError]).client.listDevices(), hasCode("ADB_OUTPUT_TOO_LARGE"));
});

test("stderr from failed ADB commands remains readable", async () => {
  const error = Object.assign(new Error("Command failed"), { code: 1, stderr: Buffer.from("error: device disconnected") });
  await assert.rejects(mockClient([error]).client.listDevices(), (failure) => hasCode("ADB_COMMAND_FAILED")(failure) && String(failure).includes("device disconnected"));
});

test("non-binary executor output is rejected instead of corrupting PNG", async () => {
  const executor: AdbExecutor = async () => ({ stdout: "text", stderr: Buffer.alloc(0) } as unknown as AdbExecutionResult);
  const client = new AdbClient({ adbPath: process.execPath, executor });
  await assert.rejects(client.listDevices(), hasCode("ADB_COMMAND_FAILED"));
});

test("invalid screenshot data never returns a capture", async () => {
  for (const invalid of [Buffer.from("adb error\r\n"), makePng().subarray(0, 32)]) {
    const { client } = mockClient([Buffer.from(DEVICES), invalid], { deviceSerial: "USB-ONE" });
    await assert.rejects(client.capture(), hasCode("ADB_INVALID_PNG"));
  }
});

test("PNG dimensions reflect portrait and landscape frames for host recalibration", () => {
  assert.deepEqual(readPngDimensions(makePng(2, 3)), { width: 2, height: 3 });
  assert.deepEqual(readPngDimensions(makePng(3, 2)), { width: 3, height: 2 });
});

test("PNG validates IHDR, chunks, CRC and complete image ending", () => {
  const png = makePng();
  const invalidSignature = Buffer.from(png);
  invalidSignature[0] = 0;
  const invalidHeader = Buffer.from(png);
  invalidHeader.write("FAKE", 12, "ascii");
  const invalidDimensions = Buffer.from(png);
  invalidDimensions.writeUInt32BE(0, 16);
  const invalidChunkLength = Buffer.from(png);
  invalidChunkLength.writeUInt32BE(0xffffffff, 33);
  const invalidChecksum = Buffer.from(png);
  invalidChecksum[29] = (invalidChecksum[29] ?? 0) ^ 0xff;
  const duplicateHeader = Buffer.concat([png.subarray(0, 33), png.subarray(8)]);
  const noImageData = Buffer.concat([png.subarray(0, 33), pngChunk("IEND", Buffer.alloc(0))]);
  for (const invalid of [invalidSignature, invalidHeader, invalidDimensions, invalidChunkLength, invalidChecksum, duplicateHeader, noImageData, png.subarray(0, png.length - 12), Buffer.concat([png, Buffer.from([0])])]) {
    assert.throws(() => readPngDimensions(invalid), hasCode("ADB_INVALID_PNG"));
  }
});

test("invalid timeout or buffer configuration fails before invoking ADB", () => {
  assert.throws(() => new AdbClient({ adbPath: process.execPath, timeoutMs: 0 }), RangeError);
  assert.throws(() => new AdbClient({ adbPath: process.execPath, timeoutMs: Number.POSITIVE_INFINITY }), RangeError);
  assert.throws(() => new AdbClient({ adbPath: process.execPath, maxBuffer: MAX_ADB_OUTPUT_BYTES + 1 }), RangeError);
});

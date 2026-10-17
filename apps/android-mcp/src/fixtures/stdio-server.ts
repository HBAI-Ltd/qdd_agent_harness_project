import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AdbCapture, AdbDevice } from "../adb.js";
import { InputController } from "../input.js";
import { AndroidTools, createMcpServer } from "../mcp.js";
import { encodeCommand } from "../protocol.js";
import type { HidOperation, HidStatus } from "../protocol.js";
import type { SerialBridge } from "../serial.js";

function chunk(type: string, data: Buffer): Buffer {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length, 0);
  bytes.write(type, 4, "ascii");
  data.copy(bytes, 8);
  let checksum = 0xffffffff;
  for (const byte of bytes.subarray(4, bytes.length - 4)) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) checksum = (checksum >>> 1) ^ ((checksum & 1) === 1 ? 0xedb88320 : 0);
  }
  bytes.writeUInt32BE((checksum ^ 0xffffffff) >>> 0, bytes.length - 4);
  return bytes;
}

export function fixturePng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * height))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export interface FixtureRecord { op: HidOperation; args: readonly number[] }

function deferredVoid(): { promise: Promise<void>; resolve(): void } {
  let complete!: () => void;
  const promise = new Promise<void>((resolvePromise) => { complete = resolvePromise; });
  return { promise, resolve: complete };
}

/** No serial device is opened. The complete firmware status is simulated. */
export class FixtureBridge implements SerialBridge {
  records: FixtureRecord[] = [];
  status: HidStatus = { v: 1, connected: true, encrypted: true, armed: false, locked: false, bonded: true, name: "Offline fixture HID" };
  private blocked: { op: HidOperation; started: () => void; wait: Promise<void> } | undefined;

  blockNext(op: HidOperation): { started: Promise<void>; release(): void } {
    const started = deferredVoid();
    const release = deferredVoid();
    this.blocked = { op, started: started.resolve, wait: release.promise };
    return { started: started.promise, release: release.resolve };
  }

  async request(op: HidOperation, args: readonly number[] = [], signal?: AbortSignal): Promise<HidStatus> {
    signal?.throwIfAborted();
    encodeCommand(1, op, args);
    this.records.push({ op, args: [...args] });
    if (op === "ARM") {
      if (this.status.locked || !this.status.connected || !this.status.encrypted || !this.status.bonded) throw new Error("Fixture BLE input is unavailable or physically locked.");
      this.status.armed = true;
    }
    if (op === "PAUSE") this.status.armed = false;
    if (["KEY", "MOVE", "CONSUMER"].includes(op) && !this.status.armed) throw new Error("Fixture input is not armed.");
    if (this.blocked?.op === op) {
      const blocked = this.blocked;
      this.blocked = undefined;
      blocked.started();
      await new Promise<void>((resolveWait, rejectWait) => {
        const abort = () => { cleanup(); rejectWait(new Error("Fixture HID report cancelled.")); };
        const cleanup = () => signal?.removeEventListener("abort", abort);
        signal?.addEventListener("abort", abort, { once: true });
        blocked.wait.then(() => { cleanup(); resolveWait(); }, (error: unknown) => { cleanup(); rejectWait(error); });
        if (signal?.aborted) abort();
      });
    }
    signal?.throwIfAborted();
    return { ...this.status, fixture: true, reports: this.records.map((record) => ({ ...record })) };
  }

  async close(): Promise<void> {}
}

/** No ADB executable is launched. Frames are genuine synthetic PNG files. */
export class FixtureAdb {
  serial = "USB-ONE";
  width = 100;
  height = 200;
  captures: string[] = [];
  latestPng: Buffer = Buffer.alloc(0);

  async listDevices(): Promise<AdbDevice[]> {
    return ["USB-ONE", "USB-TWO"].map((serial) => ({ serial, state: "device", model: "Offline_fixture", properties: {} }));
  }

  async capture(serial: string | undefined = this.serial): Promise<AdbCapture> {
    const selected = serial ?? this.serial;
    if (selected !== "USB-ONE" && selected !== "USB-TWO") throw new Error("Fixture device is not connected.");
    this.captures.push(selected);
    this.latestPng = fixturePng(this.width, this.height);
    return { png: this.latestPng, width: this.width, height: this.height, serial: selected, capturedAt: "2026-10-17T00:00:00.000Z" };
  }
}

export function createFixture() {
  const adb = new FixtureAdb();
  const bridge = new FixtureBridge();
  const input = new InputController(bridge, { width: adb.width, height: adb.height, rotation: 0 });
  const clock = { now: 10_000 };
  const tools = new AndroidTools(adb, input, {
    now: () => clock.now,
    listSerialPorts: async () => [{ path: "FIXTURE_PORT", manufacturer: "Offline fixture" }],
  });
  return { adb, bridge, input, tools, clock };
}

// Importing this module only constructs test helpers; direct execution starts a mock-only stdio server.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = createFixture();
  const server = createMcpServer(fixture.tools);
  server.onclose = () => { void fixture.input.pause().catch(() => {}); };
  await server.connect(new StdioServerTransport() as unknown as Transport);
}

export const HID_PROTOCOL = "QDDHID/1";
export const MAX_HID_LINE_BYTES = 128;
export const MAX_REQUEST_ID = 2_147_483_647;

export type HidOperation = "PING" | "STATUS" | "ARM" | "PAUSE" | "RELEASE" | "PAIR" | "PAIR_STATUS" | "MOVE" | "KEY" | "CONSUMER";
export interface HidStatus extends Record<string, unknown> {
  v: 1;
  connected: boolean;
  encrypted: boolean;
  armed: boolean;
  locked: boolean;
  bonded: boolean;
  name: string;
}

export type HidReply =
  | { id: number; ok: true; status: HidStatus }
  | { id: number; ok: false; code: string };

export class HidProtocolError extends Error {
  constructor(message: string, readonly code = "PROTOCOL") {
    super(message);
    this.name = "HidProtocolError";
  }
}

const ARGUMENTS: Record<HidOperation, readonly (readonly [number, number])[]> = {
  PING: [], STATUS: [], ARM: [], PAUSE: [], RELEASE: [], PAIR: [], PAIR_STATUS: [],
  MOVE: [[-127, 127], [-127, 127], [-127, 127], [0, 7]],
  KEY: [[0, 255], [0, 255]],
  CONSUMER: [[0, 65_535]],
};

export function encodeCommand(id: number, op: HidOperation, args: readonly number[] = []): string {
  if (!Number.isInteger(id) || id < 1 || id > MAX_REQUEST_ID) {
    throw new HidProtocolError("Request id must be an integer between 1 and 2147483647.");
  }
  const ranges = ARGUMENTS[op];
  if (!ranges || args.length !== ranges.length) {
    throw new HidProtocolError(`Invalid arguments for ${op}.`);
  }
  args.forEach((value, index) => {
    const range = ranges[index]!;
    if (!Number.isInteger(value) || value < range[0] || value > range[1]) {
      throw new HidProtocolError(`Argument ${index + 1} for ${op} must be an integer from ${range[0]} to ${range[1]}.`);
    }
  });
  const line = `${HID_PROTOCOL} ${id} ${op}${args.length ? ` ${args.join(" ")}` : ""}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_HID_LINE_BYTES) {
    throw new HidProtocolError("HID command exceeds the 128 byte line limit.");
  }
  return line;
}

/** Unrelated serial boot logs are ignored; malformed protocol messages are errors. */
export function decodeReply(raw: string): HidReply | undefined {
  const line = raw.trim();
  if (!line.startsWith(HID_PROTOCOL)) return undefined;
  const match = /^QDDHID\/1 ([1-9]\d*) (OK|ERR)(?: (.*))?$/.exec(line);
  if (!match) throw new HidProtocolError("Malformed HID reply.");
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id) || id > MAX_REQUEST_ID) throw new HidProtocolError("Invalid HID reply id.");
  const payload = match[3] ?? "";
  if (match[2] === "ERR") {
    if (!/^[A-Z][A-Z0-9_]*$/.test(payload)) throw new HidProtocolError("Malformed HID error code.");
    return { id, ok: false, code: payload };
  }
  let status: unknown;
  try { status = JSON.parse(payload); } catch { throw new HidProtocolError("Invalid JSON in HID reply."); }
  if (status === null || typeof status !== "object" || Array.isArray(status)) {
    throw new HidProtocolError("HID status must be a JSON object.");
  }
  const fields = status as Record<string, unknown>;
  if (fields["v"] !== 1 || typeof fields["name"] !== "string"
    || ["connected", "encrypted", "armed", "locked", "bonded"].some((key) => typeof fields[key] !== "boolean")) {
    throw new HidProtocolError("Incomplete QDDHID/1 status. Check that the board runs matching firmware.");
  }
  return { id, ok: true, status: status as HidStatus };
}

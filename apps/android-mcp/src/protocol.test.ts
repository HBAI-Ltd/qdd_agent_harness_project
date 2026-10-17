import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeReply, encodeCommand } from "./protocol.js";

const status = { v: 1, connected: true, encrypted: true, armed: false, locked: false, bonded: true, name: "QDD HID" };

test("wire commands preserve numeric report boundaries and reject injection", () => {
  assert.equal(encodeCommand(2_147_483_647, "MOVE", [-127, 127, 0, 7]), "QDDHID/1 2147483647 MOVE -127 127 0 7\n");
  assert.equal(encodeCommand(1, "KEY", [255, 255]), "QDDHID/1 1 KEY 255 255\n");
  assert.equal(encodeCommand(1, "CONSUMER", [65_535]), "QDDHID/1 1 CONSUMER 65535\n");
  assert.equal(encodeCommand(1, "PAIR"), "QDDHID/1 1 PAIR\n");
  assert.equal(encodeCommand(1, "PAIR_STATUS"), "QDDHID/1 1 PAIR_STATUS\n");
  assert.throws(() => encodeCommand(0, "ARM"), /Request id/);
  assert.throws(() => encodeCommand(1, "MOVE", [128, 0, 0, 0]), /Argument 1/);
  assert.throws(() => encodeCommand(1, "MOVE", [0, 0, 0, 8]), /Argument 4/);
  assert.throws(() => encodeCommand(1, "KEY", [0, -1]), /Argument 2/);
  assert.throws(() => encodeCommand(1, "PING", [1]), /Invalid arguments/);
  assert.throws(() => encodeCommand(1, "PAIR", [1]), /Invalid arguments/);
});

test("pairing status extensions remain available without logging their values", () => {
  const extended = { ...status, pairingOpen: true, passkeyVisible: true, passkey: "000000", remainingMs: 1000 };
  const reply = decodeReply(`QDDHID/1 8 OK ${JSON.stringify(extended)}\n`);
  assert.ok(reply?.ok);
  assert.equal(reply.status["passkey"], extended.passkey);
  assert.equal(reply.status["remainingMs"], 1000);
});

test("reply parser ignores boot logs, checks full status and preserves errors", () => {
  assert.equal(decodeReply("ESP32 booting"), undefined);
  assert.deepEqual(decodeReply(`QDDHID/1 4 OK ${JSON.stringify(status)}\r\n`), { id: 4, ok: true, status });
  assert.deepEqual(decodeReply("QDDHID/1 9 ERR LOCKED"), { id: 9, ok: false, code: "LOCKED" });
  assert.throws(() => decodeReply("QDDHID/1 4 OK []"), /JSON object/);
  assert.throws(() => decodeReply("QDDHID/1 4 OK {}"), /Incomplete/);
  assert.throws(() => decodeReply("QDDHID/1 4 OK {"), /Invalid JSON/);
  assert.throws(() => decodeReply("QDDHID/1 4 ERR LOCKED\nARM"), /Malformed/);
  assert.throws(() => decodeReply("QDDHID/1 2147483648 ERR LOCKED"), /Invalid HID reply id/);
});

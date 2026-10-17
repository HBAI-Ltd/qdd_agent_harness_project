import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate as tick } from "node:timers/promises";
import vm from "node:vm";
import { test } from "node:test";

const source = await readFile(new URL("../assets/screen-channel.js", import.meta.url), "utf8");
const record = (metadata, image = Buffer.alloc(0)) => {
  const json = Buffer.from(JSON.stringify(metadata)), header = Buffer.alloc(8);
  header.writeUInt32BE(json.length); header.writeUInt32BE(image.length, 4);
  return Buffer.concat([header, json, image]);
};
function fixture() {
  let controller, cancelled = 0;
  const events = [], retries = [];
  const scope = { Uint8Array, DataView, TextDecoder, Blob, AbortController,
    fetch: async (_url, options) => new Response(new ReadableStream({
      start(value) { controller = value; options.signal.addEventListener("abort", () => controller.error(new Error("Aborted"))); },
      cancel() { cancelled++; },
    }), { headers: { "Content-Type": "application/x-qdd-screen" } }),
    setTimeout(callback) { retries.push(callback); return retries.length; }, clearTimeout() {},
  };
  vm.runInNewContext(source, scope);
  const channel = new scope.QddScreenChannel("/screen/stream");
  for (const type of ["frame", "unavailable", "error"]) channel.addEventListener(type, ({ data }) => events.push({ type, data }));
  return { channel, events, retries, send(bytes) { controller.enqueue(bytes); }, end() { controller.close(); }, get cancelled() { return cancelled; } };
}
async function flush() { for (let i = 0; i < 6; i++) await tick(); }

test("binary screen reads arbitrary byte boundaries and preserves JPEG bytes without Base64", async () => {
  const app = fixture(); await flush();
  const jpeg = Buffer.from([255, 216, 0, 1, 2, 13, 10, 255, 217]);
  const bytes = Buffer.concat([record({ type: "frame", sourceFrameId: "one" }, jpeg), record({ type: "unavailable", message: "Stopped" })]);
  for (const byte of bytes) app.send(Uint8Array.of(byte));
  await flush();
  assert.equal(app.events.length, 2);
  assert.equal(app.events[0].data.sourceFrameId, "one");
  assert.deepEqual(Buffer.from(await app.events[0].data.image.arrayBuffer()), jpeg);
  assert.equal(app.events[1].type, "unavailable");
  app.channel.close(); await flush();
  assert.equal(app.retries.length, 0);
});

test("oversized, truncated and invalid screen records stop reading and report connection loss", async () => {
  for (const makeBytes of [
    () => { const prefix = Buffer.alloc(8); prefix.writeUInt32BE(8193); return prefix; },
    () => { const prefix = Buffer.alloc(8); prefix.writeUInt32BE(2); prefix.writeUInt32BE(32 * 1024 * 1024 + 1, 4); return prefix; },
    () => record({ type: "other" }),
    () => record({ type: "frame" }, Buffer.from("image")).subarray(0, 10),
  ]) {
    const app = fixture(); await flush(); app.send(makeBytes()); app.end(); await flush();
    assert.equal(app.events.filter(({ type }) => type === "error").length, 1);
    assert.equal(app.events.filter(({ type }) => type === "frame").length, 0);
    assert.equal(app.retries.length, 1);
    app.channel.close();
  }
});

test("continuous static-content frames are consumed without a rate limit or waiting for display decoding", async () => {
  const app = fixture(); await flush();
  const jpeg = Buffer.from([255, 216, 1, 2, 3, 255, 217]);
  // A decoder may still be working on the previous image. Network consumption
  // must continue so the operator can replace its one pending image with the
  // latest real capture, including captures with identical JPEG content.
  let releaseDecode;
  const decode = new Promise((resolve) => { releaseDecode = resolve; });
  const consumed = [];
  app.channel.addEventListener("frame", async ({ data }) => {
    consumed.push(data.sourceFrameId);
    await decode;
  });
  app.send(Buffer.concat(Array.from({ length: 120 }, (_, index) => record({
    type: "frame", sourceFrameId: `capture-${index}`, capturedAt: new Date(index * 33).toISOString(),
  }, jpeg))));
  await flush();
  assert.deepEqual(consumed, Array.from({ length: 120 }, (_, index) => `capture-${index}`));
  assert.equal(app.events.length, 120);
  assert.equal(app.events.at(-1).data.sourceFrameId, "capture-119");
  assert.equal(app.events.some(({ type }) => type !== "frame"), false);
  releaseDecode();
  app.channel.close(); await flush();
  assert.equal(app.retries.length, 0);
});

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createFixture } from "./fixtures/stdio-server.js";
import { JPEG_FIXTURE } from "./fixtures/jpeg.js";
import { startHttpMcp } from "./http.js";
import type { ScreenCapture } from "./screen.js";

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = performance.now() + 2000;
  while (!predicate() && performance.now() < deadline) await delay(5);
  assert.ok(predicate(), message);
}

async function remoteFixture(context: TestContext) {
  const fixture = createFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0 });
  const transport = new StreamableHTTPClientTransport(new URL(listener.url));
  const client = new Client({ name: "ordered-http-test", version: "1" });
  context.after(async () => { await client.close(); await listener.close(); });
  await client.connect(transport as unknown as Transport);
  const origin = new URL(listener.url).origin;
  const headers = { "Mcp-Session-Id": transport.sessionId! };
  const arm = async () => {
    const result = CallToolResultSchema.parse(await client.callTool({ name: "android_hid_arm" }));
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
  };
  const lease = async () => {
    const response = await fetch(`${origin}/remote/lease`, { method: "POST", headers });
    assert.equal(response.status, 204);
    const round = response.headers.get("x-remote-round");
    assert.ok(round);
    return round;
  };
  const post = (round: string, sequence: number, report: unknown) => fetch(`${origin}/remote/input`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json",
      "X-Remote-Round": round, "X-Remote-Sequence": String(sequence) }, body: JSON.stringify(report),
  });
  await arm();
  const round = await lease();
  return { ...fixture, origin, headers, arm, lease, post, round };
}

const mouse = (dx: number, buttons = 0) => ({ kind: "mouse", dx, dy: 0, wheel: 0, buttons });
const key = (keycode: number) => ({ kind: "key", modifier: 0, keycode });

test("ordered HTTP input receives report 2 before 1 but sends mouse and keyboard edges in sequence order", async (context) => {
  const fixture = await remoteFixture(context);
  const second = fixture.post(fixture.round, 2, key(4));
  await delay(20);
  assert.equal(fixture.bridge.records.some(({ op }) => op === "KEY" || op === "MOVE"), false);
  const first = fixture.post(fixture.round, 1, mouse(7));
  assert.deepEqual((await Promise.all([first, second])).map((response) => response.status), [200, 200]);
  assert.deepEqual(fixture.bridge.records.filter(({ op }) => op === "KEY" || op === "MOVE"), [
    { op: "MOVE", args: [7, 0, 0, 0] }, { op: "KEY", args: [0, 4] },
  ]);
  assert.equal((await fixture.post(fixture.round, 3, key(0))).status, 200);
});

test("four-report HTTP window reorders 2,4,3,1 without losing press or release edges", async (context) => {
  const fixture = await remoteFixture(context);
  const pending = [fixture.post(fixture.round, 2, key(4)), fixture.post(fixture.round, 4, mouse(9)), fixture.post(fixture.round, 3, key(0))];
  await delay(20);
  assert.equal(fixture.bridge.records.some(({ op }) => op === "KEY" || op === "MOVE"), false);
  pending.push(fixture.post(fixture.round, 1, mouse(5, 1)));
  assert.deepEqual((await Promise.all(pending)).map((response) => response.status), [200, 200, 200, 200]);
  assert.deepEqual(fixture.bridge.records.filter(({ op }) => op === "KEY" || op === "MOVE"), [
    { op: "MOVE", args: [5, 0, 0, 1] }, { op: "KEY", args: [0, 4] },
    { op: "KEY", args: [0, 0] }, { op: "MOVE", args: [9, 0, 0, 0] },
  ]);
});

test("duplicate ordered reports stop the round without replaying the click", async (context) => {
  const fixture = await remoteFixture(context);
  assert.equal((await fixture.post(fixture.round, 1, mouse(0, 1))).status, 200);
  assert.equal((await fixture.post(fixture.round, 1, mouse(0, 1))).status, 400);
  await waitUntil(() => !fixture.input.state.armed, "Duplicate report must stop input.");
  assert.equal((await fixture.post(fixture.round, 2, mouse(0))).status, 409);
  assert.deepEqual(fixture.bridge.records.filter(({ op }) => op === "MOVE"), [{ op: "MOVE", args: [0, 0, 0, 1] }]);
});

test("expired ordered input cannot execute or pause a newer remote round", async (context) => {
  const fixture = await remoteFixture(context);
  assert.equal((await fetch(`${fixture.origin}/remote/lease`, { method: "DELETE", headers: fixture.headers })).status, 204);
  await fixture.arm();
  const nextRound = await fixture.lease();
  assert.notEqual(nextRound, fixture.round);
  const before = fixture.bridge.records.length;
  assert.equal((await fixture.post(fixture.round, 1, key(4))).status, 409);
  assert.equal(fixture.input.state.armed, true);
  assert.equal(fixture.bridge.records.length, before);
  assert.equal((await fixture.post(nextRound, 1, mouse(3))).status, 200);
});

test("a delayed DELETE from an old round cannot release the newly acquired round", async (context) => {
  const fixture = await remoteFixture(context);
  assert.equal((await fetch(`${fixture.origin}/remote/lease`, { method: "DELETE", headers: fixture.headers })).status, 204);
  await fixture.arm();
  const nextRound = await fixture.lease();
  const before = fixture.bridge.records.length;
  const oldDelete = await fetch(`${fixture.origin}/remote/lease`, { method: "DELETE",
    headers: { ...fixture.headers, "X-Remote-Round": fixture.round } });
  assert.equal(oldDelete.status, 409);
  assert.equal(fixture.input.state.armed, true);
  assert.equal(fixture.bridge.records.length, before);
  assert.equal((await fixture.post(nextRound, 1, mouse(2))).status, 200);
});

test("a missing ordered sequence releases the round after its 500 ms gap deadline without sending a later key", async (context) => {
  const fixture = await remoteFixture(context);
  const started = performance.now();
  const response = await fixture.post(fixture.round, 2, key(4));
  const elapsed = performance.now() - started;
  assert.equal(response.status, 409);
  assert.ok(elapsed >= 400 && elapsed < 850, `Expected the sequence gap deadline, got ${elapsed} ms.`);
  await waitUntil(() => !fixture.input.state.armed, "Missing sequence must release input.");
  assert.equal(fixture.bridge.records.some(({ op }) => op === "KEY"), false);
  assert.deepEqual(fixture.bridge.records.slice(-2).map(({ op }) => op), ["RELEASE", "PAUSE"]);
});

test("receiving more out-of-order reports cannot postpone the same missing-sequence deadline", async (context) => {
  const fixture = await remoteFixture(context);
  const started = performance.now();
  const second = fixture.post(fixture.round, 2, key(4));
  await delay(350);
  const third = fixture.post(fixture.round, 3, key(0));
  const responses = await Promise.all([second, third]);
  const elapsed = performance.now() - started;
  assert.deepEqual(responses.map((response) => response.status), [409, 409]);
  assert.ok(elapsed < 750, `A later report extended the same missing-sequence deadline to ${elapsed} ms.`);
  assert.equal(fixture.bridge.records.some(({ op }) => op === "KEY"), false);
});

test("an invalid preceding report cancels the pending key edge and rejects all later reports", async (context) => {
  const fixture = await remoteFixture(context);
  const later = fixture.post(fixture.round, 2, key(4));
  await delay(20);
  const invalid = await fixture.post(fixture.round, 1, { ...mouse(1), buttons: 99 });
  assert.equal(invalid.status, 400);
  assert.equal((await later).status, 409);
  assert.equal((await fixture.post(fixture.round, 3, key(0))).status, 409);
  assert.equal(fixture.bridge.records.some(({ op }) => op === "KEY" || op === "MOVE"), false);
  await waitUntil(() => fixture.bridge.records.at(-1)?.op === "PAUSE", "Failure must finish report release.");
});

function screenFixture() {
  const fixture = createFixture();
  const listeners = new Set<{ frame(frame: ScreenCapture): void; error(error: Error): void }>();
  let unsubscribed = 0;
  const liveScreen = { subscribe(frame: (frame: ScreenCapture) => void, error: (error: Error) => void) {
    const listener = { frame, error };
    listeners.add(listener);
    return () => { listeners.delete(listener); unsubscribed++; };
  } };
  const frame: ScreenCapture = { serial: "11111111-1111-4111-8111-111111111111", width: 2, height: 3,
    png: JPEG_FIXTURE, mimeType: "image/jpeg", source: "screen-app", sourceFrameId: "binary-frame-1",
    frameAgeMs: 3, rotation: 0, capturedAt: "2026-10-17T07:00:00Z" };
  return { ...fixture, liveScreen, frame, listeners, get unsubscribed() { return unsubscribed; } };
}

function binaryReader(response: Response) {
  assert.ok(response.body);
  const reader = response.body.getReader();
  let buffered: Buffer = Buffer.alloc(0);
  const read = async (length: number) => {
    while (buffered.length < length) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, "Binary stream ended mid-record.");
      buffered = Buffer.concat([buffered, chunk.value!]);
    }
    const bytes = buffered.subarray(0, length);
    buffered = buffered.subarray(length);
    return bytes;
  };
  return { reader, next: async () => {
    const header = await read(8);
    const metadataLength = header.readUInt32BE(0), imageLength = header.readUInt32BE(4);
    assert.ok(metadataLength >= 2 && metadataLength <= 8192);
    assert.ok(imageLength <= 16 * 1024 * 1024);
    const metadata = JSON.parse((await read(metadataLength)).toString("utf8")) as Record<string, unknown>;
    return { metadata, image: await read(imageLength) };
  } };
}

async function nextRecordWithin(stream: ReturnType<typeof binaryReader>, timeoutMs = 1000) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([stream.next(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Binary stream stopped forwarding frames after the previous large write.")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

test("binary phone stream retains exact JPEG bytes and metadata and sends a framed loss record", async (context) => {
  const fixture = screenFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0, liveScreen: fixture.liveScreen });
  const abort = new AbortController();
  context.after(async () => { abort.abort(); await listener.close(); });
  const response = await fetch(`${new URL(listener.url).origin}/screen/stream`, { signal: abort.signal });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/x-qdd-screen");
  const stream = binaryReader(response);
  for (const subscriber of fixture.listeners) subscriber.frame(fixture.frame);
  const received = await stream.next();
  assert.deepEqual(received.image, JPEG_FIXTURE);
  assert.equal(received.metadata["type"], "frame");
  assert.equal(received.metadata["sourceFrameId"], fixture.frame.sourceFrameId);
  assert.equal(received.metadata["deviceSerial"], fixture.frame.serial);
  assert.equal(received.metadata["mimeType"], "image/jpeg");
  assert.equal(received.metadata["width"], 2); assert.equal(received.metadata["height"], 3);
  assert.equal(Object.hasOwn(received.metadata, "image"), false, "Image must not be copied to Base64 JSON.");
  await fixture.input.arm();
  for (const subscriber of fixture.listeners) subscriber.error(new Error("phone projection stopped"));
  const unavailable = await stream.next();
  assert.deepEqual(unavailable.image, Buffer.alloc(0));
  assert.deepEqual(unavailable.metadata, { type: "unavailable", message: "phone projection stopped" });
  await waitUntil(() => !fixture.input.state.armed, "Actual source loss must still release input.");
  abort.abort();
  await waitUntil(() => fixture.unsubscribed === 1, "Closing binary stream must unsubscribe exactly once.");
});

test("closing a read-only binary viewer does not stop existing input", async (context) => {
  const fixture = screenFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0, liveScreen: fixture.liveScreen });
  const abort = new AbortController();
  context.after(async () => { abort.abort(); await listener.close(); });
  const response = await fetch(`${new URL(listener.url).origin}/screen/stream`, { signal: abort.signal });
  assert.equal(response.status, 200);
  await fixture.input.arm();
  const before = fixture.bridge.records.length;
  abort.abort();
  await waitUntil(() => fixture.unsubscribed === 1, "Viewer must unsubscribe.");
  assert.equal(fixture.input.state.armed, true);
  assert.equal(fixture.bridge.records.length, before, "Viewer close must not release unrelated input.");
});

test("binary stream forwards the second and third 150 KiB frame after a large corked write drains", async (context) => {
  const fixture = screenFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0, liveScreen: fixture.liveScreen });
  const abort = new AbortController();
  context.after(async () => { abort.abort(); await listener.close(); });
  const response = await fetch(`${new URL(listener.url).origin}/screen/stream`, { signal: abort.signal });
  const stream = binaryReader(response);
  for (let index = 1; index <= 3; index++) {
    // Exercise transport backpressure with opaque encoded-frame bytes. Image
    // decoding is tested separately; this HTTP route must preserve the buffer.
    const image = Buffer.alloc(150 * 1024, index);
    const sourceFrameId = `large-frame-${index}`;
    for (const subscriber of fixture.listeners) subscriber.frame({ ...fixture.frame, png: image, sourceFrameId });
    const record = await nextRecordWithin(stream);
    assert.equal(record.metadata["sourceFrameId"], sourceFrameId);
    assert.deepEqual(record.image, image);
  }
});

test("a burst during a large binary write retains only its latest frame and includes its queued age", async (context) => {
  const fixture = screenFixture();
  let now = 1000;
  context.mock.method(performance, "now", () => now);
  const listener = await startHttpMcp(fixture.tools, { port: 0, liveScreen: fixture.liveScreen });
  const abort = new AbortController();
  context.after(async () => { abort.abort(); await listener.close(); });
  const response = await fetch(`${new URL(listener.url).origin}/screen/stream`, { signal: abort.signal });
  const stream = binaryReader(response);
  for (let index = 1; index <= 64; index++) {
    for (const subscriber of fixture.listeners) subscriber.frame({ ...fixture.frame,
      png: Buffer.alloc(150 * 1024, index), sourceFrameId: `burst-frame-${index}` });
  }
  now += 37;
  assert.equal((await nextRecordWithin(stream)).metadata["sourceFrameId"], "burst-frame-1");
  let latest = await nextRecordWithin(stream), forwarded = 1;
  while (latest.metadata["sourceFrameId"] !== "burst-frame-64" && forwarded < 64) {
    latest = await nextRecordWithin(stream); forwarded++;
  }
  assert.equal(latest.metadata["sourceFrameId"], "burst-frame-64", "Intermediate pending frames must be replaced, never queued.");
  assert.equal(forwarded, 1, "Only one latest frame may wait behind the active write.");
  assert.equal(latest.metadata["frameAgeMs"], fixture.frame.frameAgeMs! + 37);
  assert.equal(latest.metadata["capturedAt"], fixture.frame.capturedAt, "Queueing must preserve the actual source timestamp.");
  assert.deepEqual(latest.image, Buffer.alloc(150 * 1024, 64));
});

test("source loss during a large binary write is delivered even if a recovery frame arrives before it drains", async (context) => {
  const fixture = screenFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0, liveScreen: fixture.liveScreen });
  const abort = new AbortController();
  context.after(async () => { abort.abort(); await listener.close(); });
  const response = await fetch(`${new URL(listener.url).origin}/screen/stream`, { signal: abort.signal });
  const stream = binaryReader(response);
  for (const subscriber of fixture.listeners) {
    for (let index = 1; index <= 64; index++) subscriber.frame({ ...fixture.frame, png: Buffer.alloc(150 * 1024, index) });
    subscriber.error(new Error("Source stopped during write."));
    subscriber.frame({ ...fixture.frame, sourceFrameId: "recovery-before-drain" });
  }
  assert.equal((await nextRecordWithin(stream)).metadata["sourceFrameId"], fixture.frame.sourceFrameId);
  let lost = await nextRecordWithin(stream), forwarded = 1;
  while (lost.metadata["type"] === "frame" && forwarded < 64) {
    lost = await nextRecordWithin(stream); forwarded++;
  }
  assert.deepEqual(lost.metadata, { type: "unavailable", message: "Source stopped during write." });
  assert.equal(forwarded, 1, "Loss must follow the active write instead of sitting behind a frame queue.");
  assert.equal(lost.image.length, 0);
});

test("an expired pending binary frame is dropped before a later fresh frame is forwarded", async (context) => {
  const fixture = screenFixture();
  let now = 1000;
  context.mock.method(performance, "now", () => now);
  const listener = await startHttpMcp(fixture.tools, { port: 0, liveScreen: fixture.liveScreen });
  const abort = new AbortController();
  context.after(async () => { abort.abort(); await listener.close(); });
  const response = await fetch(`${new URL(listener.url).origin}/screen/stream`, { signal: abort.signal });
  const stream = binaryReader(response);
  for (const subscriber of fixture.listeners) {
    subscriber.frame({ ...fixture.frame, png: Buffer.alloc(150 * 1024, 1) });
    subscriber.frame({ ...fixture.frame, sourceFrameId: "pending-expired", frameAgeMs: 2990 });
  }
  now += 20;
  await nextRecordWithin(stream);
  await delay(20);
  for (const subscriber of fixture.listeners) subscriber.frame({ ...fixture.frame, sourceFrameId: "later-fresh", frameAgeMs: 1 });
  const fresh = await nextRecordWithin(stream);
  assert.equal(fresh.metadata["sourceFrameId"], "later-fresh");
  assert.equal(fresh.metadata["frameAgeMs"], 1);
});

test("binary and legacy SSE viewers share the eight-viewer limit and closing one frees a slot", async (context) => {
  const fixture = screenFixture();
  const listener = await startHttpMcp(fixture.tools, { port: 0, liveScreen: fixture.liveScreen });
  const origin = new URL(listener.url).origin;
  const controllers: AbortController[] = [];
  context.after(async () => { for (const controller of controllers) controller.abort(); await listener.close(); });
  for (let index = 0; index < 8; index++) {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(`${origin}/screen/${index < 6 ? "stream" : "events"}`, { signal: controller.signal });
    assert.equal(response.status, 200);
  }
  assert.equal(fixture.listeners.size, 8);
  assert.equal((await fetch(`${origin}/screen/stream`)).status, 503);
  controllers[0]!.abort();
  await waitUntil(() => fixture.listeners.size === 7, "Closing a viewer must free its shared slot.");
  const replacement = new AbortController(); controllers.push(replacement);
  assert.equal((await fetch(`${origin}/screen/stream`, { signal: replacement.signal })).status, 200);
  assert.equal(fixture.listeners.size, 8);
  assert.equal((await fetch(`${origin}/screen/stream`, { headers: { Origin: "https://external.example" } })).status, 403);
  assert.deepEqual(fixture.bridge.records, []);
});

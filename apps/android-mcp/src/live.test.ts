import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LiveScreenSource, MultipartFrameParser } from "./live.js";
import { ScreenClient, ScreenError } from "./screen.js";
import { JPEG_FIXTURE } from "./fixtures/jpeg.js";
import { fixturePng } from "./fixtures/stdio-server.js";

const DEVICE = "11111111-1111-4111-8111-111111111111";
function part(id = "first", extra: Record<string, string> = {}, image = JPEG_FIXTURE): Buffer {
  const headers = { "Content-Type": "image/jpeg", "Content-Length": String(image.length),
    "X-Device-Id": DEVICE, "X-Frame-Id": id, "X-Frame-Age-Ms": "10",
    "X-Captured-At": "2026-10-17T04:00:00.000Z", "X-Frame-Width": "2", "X-Frame-Height": "3",
    "X-Display-Rotation": "0", ...extra };
  return Buffer.concat([Buffer.from(`--qdd-frame\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`), image, Buffer.from("\r\n")]);
}
function fixture() {
  const requests: string[] = [];
  let stream: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  let original = 0;
  const client = new ScreenClient({ endpoint: "http://192.168.1.20:8791", deviceId: DEVICE,
    fetch: async (url, options) => {
      requests.push(String(url));
      assert.equal(options?.headers, undefined);
      if (String(url).endsWith("/frame.jpg")) return new Response(new Uint8Array(fixturePng(4, 6)), { headers: {
        "Content-Type": "image/png", "X-Device-Id": DEVICE, "X-Frame-Id": `original-${++original}`,
        "X-Frame-Age-Ms": "0", "X-Captured-At": "2026-10-17T04:00:00.000Z", "X-Display-Rotation": "0",
        "X-Device-Width": "4", "X-Device-Height": "6", "X-Preview-Profile": "original",
      } });
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel() { cancelled = true; } }),
        { headers: { "Content-Type": "multipart/x-mixed-replace; boundary=qdd-frame" } });
    } });
  return { client, requests, send(bytes: Buffer) { stream.enqueue(new Uint8Array(bytes)); }, cancelled: () => cancelled };
}
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await delay(5);
  assert.ok(predicate(), "stream operation did not reach its checkpoint");
}

test("multipart parsing preserves byte-exact JPEG through every chunk boundary and multiple frames", () => {
  const bytes = Buffer.concat([part("one"), part("two")]);
  const parser = new MultipartFrameParser(4096);
  const frames = [];
  for (const byte of bytes) frames.push(...parser.push(Uint8Array.of(byte)));
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.headers.get("x-frame-id"), "one");
  assert.equal(frames[1]!.headers.get("x-frame-id"), "two");
  assert.deepEqual(frames[0]!.bytes, JPEG_FIXTURE);
  assert.deepEqual(new MultipartFrameParser(4096).push(bytes).map(({ bytes: image }) => image), [JPEG_FIXTURE, JPEG_FIXTURE]);
});

test("multipart parser rejects malformed boundaries, duplicate headers, invalid lengths and unbounded headers", () => {
  for (const bytes of [
    Buffer.from("--other\r\nContent-Length: 1\r\n\r\na\r\n"),
    Buffer.from("--qdd-frame\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\na\r\n"),
    Buffer.from("--qdd-frame\r\nContent-Length: -1\r\n\r\n"),
    Buffer.from("--qdd-frame\r\nContent-Length: 9999999999999999\r\n\r\n"),
    Buffer.from("--qdd-frame\r\nContent-Length: 1\r\n\r\naXX"),
    Buffer.from("x".repeat(8193)),
  ]) assert.throws(() => new MultipartFrameParser(10_000).push(bytes), ScreenError);
  assert.throws(() => new MultipartFrameParser(16).push(Buffer.alloc(20_000)), ScreenError);
});

test("phone video uses one GET and validates each frame without polling or Authorization", async () => {
  const mock = fixture();
  const stop = new AbortController();
  const video = mock.client.stream(stop.signal);
  const first = video.next();
  await waitFor(() => mock.requests.length === 1);
  mock.send(part("one"));
  assert.equal((await first).value?.sourceFrameId, "one");
  const second = video.next(); mock.send(part("two", { "X-Display-Rotation": "2" }));
  assert.equal((await second).value?.rotation, 2);
  assert.deepEqual(mock.requests, ["http://192.168.1.20:8791/stream.mjpg"]);
  await video.return(undefined);
  assert.equal(mock.cancelled(), true);
});

test("video rejects a repeated source frame, wrong phone, corrupt JPEG and stale capture", async () => {
  for (const [extra, bytes] of [
    [{ "X-Device-Id": "22222222-2222-4222-8222-222222222222" }, JPEG_FIXTURE],
    [{}, JPEG_FIXTURE.subarray(0, -2)],
    [{ "X-Frame-Age-Ms": "3001" }, JPEG_FIXTURE],
  ] as const) {
    const mock = fixture(); const video = mock.client.stream(new AbortController().signal);
    const frame = video.next(); await waitFor(() => mock.requests.length === 1);
    mock.send(part("bad", extra, bytes));
    await assert.rejects(frame, ScreenError);
    assert.equal(mock.cancelled(), true);
  }
  const mock = fixture(); const video = mock.client.stream(new AbortController().signal);
  const first = video.next(); await waitFor(() => mock.requests.length === 1); mock.send(part("same")); await first;
  const second = video.next(); mock.send(part("same"));
  await assert.rejects(second, /重复发送/u);
});

test("input guards share the newest validated preview cache without requesting original snapshots", async (context) => {
  const mock = fixture(); const live = new LiveScreenSource(mock.client);
  context.after(async () => { await live.close(); });
  const first = live.preview(); await waitFor(() => mock.requests.length === 1); mock.send(part("one"));
  assert.equal((await first).sourceFrameId, "one");
  const seen: string[] = [];
  const unsubscribe = live.subscribe((frame) => { seen.push(frame.sourceFrameId); });
  mock.send(part("two")); await waitFor(() => seen.includes("two"));
  const images = await Promise.all(Array.from({ length: 10 }, () => live.preview(DEVICE)));
  assert.ok(images.every((frame) => frame.sourceFrameId === "two" && frame.capturedAt === "2026-10-17T04:00:00.000Z"));
  assert.equal(mock.requests.length, 1);
  await assert.rejects(live.preview("22222222-2222-4222-8222-222222222222"), /另一台手机/u);
  unsubscribe();
});

test("an idle stream loses freshness, reports loss once and cancels its read", async (context) => {
  const mock = fixture(); const live = new LiveScreenSource(mock.client);
  context.after(async () => { await live.close(); });
  const errors: Error[] = [];
  live.subscribe(() => {}, (error) => { errors.push(error); });
  await waitFor(() => mock.requests.length === 1);
  mock.send(part("almost-old", { "X-Frame-Age-Ms": "2800" }));
  await waitFor(() => errors.length === 1);
  assert.equal(mock.cancelled(), true);
  assert.equal(errors.length, 1);
});

test("a later viewer immediately learns the current phone error instead of waiting silently", async (context) => {
  const phone = new ScreenClient({ endpoint: "http://192.168.1.20:8791", fetch: async () => new Response(null, { status: 404 }) });
  const live = new LiveScreenSource(phone); context.after(async () => { await live.close(); });
  let failed = false;
  live.subscribe(() => {}, () => { failed = true; });
  await waitFor(() => failed);
  await assert.rejects(live.preview(), /更新手机投屏/u);
});

test("closing a stream rejects pending cold snapshots without waiting for their timeout", async () => {
  const mock = fixture(); const live = new LiveScreenSource(mock.client);
  const waiting = live.preview();
  const rejected = assert.rejects(waiting, /已关闭/u);
  await waitFor(() => mock.requests.length === 1);
  await live.close(); await rejected;
  assert.equal(mock.cancelled(), true);
});

test("MCP capture always requests a fresh original even while a reduced preview is cached", async (context) => {
  const mock = fixture(); const live = new LiveScreenSource(mock.client);
  context.after(async () => { await live.close(); });
  const preview = live.preview(); await waitFor(() => mock.requests.length === 1);
  mock.send(part("small-preview", { "X-Device-Width": "4", "X-Device-Height": "6", "X-Preview-Profile": "fast" }));
  assert.equal((await preview).deviceWidth, 4);
  const first = await live.capture(DEVICE), second = await live.capture(DEVICE);
  assert.equal(first.sourceFrameId, "original-1"); assert.equal(second.sourceFrameId, "original-2");
  assert.equal(first.previewProfile, "original"); assert.equal(first.deviceWidth, first.width);
  assert.equal(first.width, 4); assert.equal(first.height, 6);
  assert.equal((await live.preview()).sourceFrameId, "small-preview", "MCP originals never replace the video preview.");
  assert.equal(mock.requests.filter((url) => url.endsWith("/frame.jpg")).length, 2);
  assert.equal(mock.requests.filter((url) => url.endsWith("/stream.mjpg")).length, 1);
});

test("closing a source promptly rejects a pending original capture without replaying it", async () => {
  let reads = 0;
  let release!: (response: Response) => void;
  const phone = new ScreenClient({ endpoint: "http://192.168.1.20:8791", fetch: async (url) => {
    if (String(url).endsWith("/frame.jpg")) { reads++; return new Promise((resolve) => { release = resolve; }); }
    return new Response(new ReadableStream({ start() {} }), { headers: { "Content-Type": "multipart/x-mixed-replace; boundary=qdd-frame" } });
  } });
  const live = new LiveScreenSource(phone);
  const pending = live.capture(); const rejected = assert.rejects(pending, /已关闭/u);
  await waitFor(() => reads === 1);
  await live.close(); await rejected;
  release(new Response(new Uint8Array(JPEG_FIXTURE), { headers: { "Content-Type": "image/jpeg",
    "X-Device-Id": DEVICE, "X-Frame-Id": "late-original", "X-Frame-Age-Ms": "0", "X-Captured-At": "2026-10-17T04:00:00.000Z" } }));
  assert.equal(reads, 1);
});

test("one cancelled original preserves the shared preview and a later original capture", async (context) => {
  let originals = 0, cancelled = false, stalled!: ReadableStreamDefaultController<Uint8Array>;
  let streamSignal: AbortSignal | null | undefined;
  const phone = new ScreenClient({ endpoint: "http://192.168.1.20:8791", timeoutMs: 1000, fetch: async (url, options) => {
    if (String(url).endsWith("/frame.jpg")) {
      const bytes = ++originals === 1 ? new ReadableStream<Uint8Array>({ start(controller) { stalled = controller; }, cancel() { cancelled = true; } }) : new Uint8Array(JPEG_FIXTURE);
      return new Response(bytes, { headers: { "Content-Type": "image/jpeg", "X-Device-Id": DEVICE,
        "X-Frame-Id": `original-${originals}`, "X-Frame-Age-Ms": "0", "X-Captured-At": "2026-10-17T04:00:00.000Z" } });
    }
    streamSignal = options?.signal;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(part("live-preview")); } }), { headers: { "Content-Type": "multipart/x-mixed-replace; boundary=qdd-frame" } });
  } });
  const live = new LiveScreenSource(phone); context.after(() => live.close());
  assert.equal((await live.preview()).sourceFrameId, "live-preview");
  const controller = new AbortController();
  const first = live.capture(undefined, controller.signal);
  await waitFor(() => originals === 1);
  const next = live.capture(), rejected = assert.rejects(first, /Cancel one original/u);
  try {
    controller.abort(new Error("Cancel one original"));
    await Promise.race([rejected, delay(250).then(() => { throw new Error("Original cancellation did not reach the phone request."); })]);
    assert.equal(cancelled, true);
    assert.equal((await next).sourceFrameId, "original-2");
    assert.equal(streamSignal?.aborted, false);
    assert.equal((await live.preview()).sourceFrameId, "live-preview");
  } finally { try { stalled.close(); } catch { /* Already cancelled. */ } await Promise.allSettled([first, next, rejected]); }
});

test("source close cancels only its owned originals and leaves another source's stream and capture alive", async (context) => {
  let originals = 0, cancelled = false, stalled!: ReadableStreamDefaultController<Uint8Array>;
  const signals: (AbortSignal | null | undefined)[] = [];
  const phone = new ScreenClient({ endpoint: "http://192.168.1.20:8791", timeoutMs: 1000, fetch: async (url, options) => {
    if (String(url).endsWith("/frame.jpg")) {
      const bytes = ++originals === 1 ? new ReadableStream<Uint8Array>({ start(controller) { stalled = controller; }, cancel() { cancelled = true; } }) : new Uint8Array(JPEG_FIXTURE);
      return new Response(bytes, { headers: { "Content-Type": "image/jpeg", "X-Device-Id": DEVICE,
        "X-Frame-Id": `owned-original-${originals}`, "X-Frame-Age-Ms": "0", "X-Captured-At": "2026-10-17T04:00:00.000Z" } });
    }
    signals.push(options?.signal);
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(part(`preview-${signals.length}`)); } }), { headers: { "Content-Type": "multipart/x-mixed-replace; boundary=qdd-frame" } });
  } });
  const firstSource = new LiveScreenSource(phone), otherSource = new LiveScreenSource(phone);
  context.after(async () => { await firstSource.close(); await otherSource.close(); });
  await firstSource.preview(); await otherSource.preview();
  const first = firstSource.capture(), rejected = assert.rejects(first, /已关闭/u);
  await waitFor(() => originals === 1);
  const other = otherSource.capture();
  try {
    await firstSource.close(); await rejected;
    assert.equal(cancelled, true, "Closing a source must cancel its in-flight original body.");
    assert.equal((await other).sourceFrameId, "owned-original-2");
    assert.equal(signals[0]?.aborted, true); assert.equal(signals[1]?.aborted, false);
    assert.equal((await otherSource.preview()).sourceFrameId, "preview-2");
  } finally { try { stalled.close(); } catch { /* Already cancelled. */ } await Promise.allSettled([first, other, rejected]); }
});

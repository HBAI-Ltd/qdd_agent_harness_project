import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { MAX_SCREEN_FRAME_BYTES, readJpegDimensions, ScreenClient, ScreenError } from "./screen.js";
import type { PreviewProfile, ScreenClientOptions } from "./screen.js";
import { JPEG_FIXTURE } from "./fixtures/jpeg.js";
import { MockAgent } from "undici";

function chunk(type: string, data: Buffer): Buffer {
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length);
  output.write(type, 4, "ascii");
  data.copy(output, 8);
  let crc = 0xffffffff;
  for (const byte of output.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
}
function makePng(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2); header.writeUInt32BE(3, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc(27))), chunk("IEND", Buffer.alloc(0))]);
}
const PNG = makePng();
const DEVICE_A = "11111111-1111-4111-8111-111111111111";
const DEVICE_B = "22222222-2222-4222-8222-222222222222";
const ENDPOINT = "http://192.168.1.20:8791";
type HttpBody = ConstructorParameters<typeof Response>[0];
function frame(body: HttpBody = new Uint8Array(PNG), headers: Record<string, string | null> = {}, status = 200): Response {
  const values = new Headers({ "Content-Type": "image/png", "X-Frame-Id": "app-frame-1",
    "X-Frame-Age-Ms": "0", "X-Captured-At": "2026-10-17T06:00:00.000Z", "X-Device-Id": DEVICE_A });
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) values.delete(name); else values.set(name, value);
  }
  return new Response(body, { status, headers: values });
}
function health(values: Record<string, unknown> = {}): Response {
  return Response.json({ status: "ok", service: "qdd-android-screen", deviceId: DEVICE_A,
    model: "OnePlus Offline Fixture", projecting: true, frameReady: true, ...values });
}
function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ScreenError && error.code === code;
}
function mockClient(response: (url: string, options?: RequestInit) => Response | Promise<Response> = (url) => url.endsWith("/health") ? health() : frame(), options: Partial<ScreenClientOptions> = {}) {
  const requests: { url: string; options: RequestInit | undefined }[] = [];
  const client = new ScreenClient({ endpoint: ENDPOINT,
    fetch: async (url, init) => { requests.push({ url: String(url), options: init }); return response(String(url), init); }, ...options });
  return { client, requests };
}

test("health, original capture, quality and continuous preview share the current matching LAN source", async (context) => {
  const agents: MockAgent[] = [];
  let destroyed = 0;
  const jpegHeaders = { "Content-Type": "image/jpeg", "Content-Length": String(JPEG_FIXTURE.length),
    "X-Frame-Id": "bound-preview", "X-Frame-Age-Ms": "0", "X-Device-Id": DEVICE_A,
    "X-Captured-At": "2026-10-17T06:00:00.000Z" };
  const multipart = Buffer.concat([Buffer.from(`--qdd-frame\r\n${Object.entries(jpegHeaders).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`), JPEG_FIXTURE, Buffer.from("\r\n")]);
  const { client, requests } = mockClient((url) => {
    if (url.endsWith("/health")) return health();
    if (url.endsWith("/preview/profile")) return Response.json({ profile: "standard" });
    if (url.endsWith("/stream.mjpg")) return new Response(multipart, { headers: { "Content-Type": "multipart/x-mixed-replace; boundary=qdd-frame" } });
    return frame();
  }, {
    networkInterfaces: () => ({ Mihomo: [{ address: "198.18.0.1", family: "IPv4", internal: false, netmask: "255.255.0.0" }],
      "Wi-Fi": [{ address: "192.168.1.10", family: "IPv4", internal: false, netmask: "255.255.255.0" }] }),
    dispatcherFactory: (options) => {
      assert.deepEqual(options.connect, { localAddress: "192.168.1.10" });
      const agent = new MockAgent(); agent.disableNetConnect(); agents.push(agent);
      context.mock.method(agent, "destroy", () => { destroyed++; return agent.close(); });
      return agent;
    },
  });
  const video = client.stream(new AbortController().signal);
  try {
    await client.listDevices(); await client.capture(); await client.getPreviewProfile();
    assert.equal((await video.next()).value?.sourceFrameId, "bound-preview");
    assert.equal(agents.length, 1);
    assert.deepEqual(requests.map(({ url }) => new URL(url).pathname), ["/health", "/frame.jpg", "/preview/profile", "/stream.mjpg"]);
    for (const request of requests) assert.equal(request.options?.dispatcher, agents[0]);
  } finally { await video.return(undefined); await client.close(); }
  assert.equal(destroyed, 1);
  await assert.rejects(client.capture(), hasCode("SCREEN_UNREACHABLE"));
  assert.equal(agents.length, 1, "Closing the screen owner must prevent a queued or later request from reopening its pool.");
});

test("LAN capture needs no credentials, uses the explicit endpoint and binds the App UUID", async () => {
  const { client, requests } = mockClient();
  const capture = await client.capture();
  assert.equal(capture.serial, DEVICE_A);
  assert.equal(capture.width, 2); assert.equal(capture.height, 3);
  assert.equal(capture.deviceWidth, 2); assert.equal(capture.deviceHeight, 3); assert.equal(capture.previewProfile, "original");
  assert.equal(capture.source, "screen-app");
  assert.equal(capture.sourceFrameId, "app-frame-1");
  assert.equal(capture.capturedAt, "2026-10-17T06:00:00.000Z");
  assert.deepEqual(capture.png, PNG);
  assert.ok(capture.frameAgeMs >= 0 && capture.frameAgeMs <= 3000);
  assert.equal(requests[0]?.url, `${ENDPOINT}/frame.jpg`);
  assert.equal(requests[0]?.options?.headers, undefined);
  assert.equal(requests[0]?.options?.redirect, "error");
  assert.equal(requests[0]?.options?.cache, "no-store");
  assert.ok(requests[0]?.options?.signal instanceof AbortSignal);
  assert.equal(requests.length, 1);
});

test("real JPEG dimensions and MIME survive the LAN capture unchanged", async () => {
  assert.deepEqual(readJpegDimensions(JPEG_FIXTURE), { width: 2, height: 3 });
  const { client, requests } = mockClient(() => frame(new Uint8Array(JPEG_FIXTURE), {
    "Content-Type": "image/jpeg", "X-Frame-Width": "2", "X-Frame-Height": "3",
    "Content-Length": String(JPEG_FIXTURE.length),
  }));
  const capture = await client.capture();
  assert.equal(capture.mimeType, "image/jpeg");
  assert.deepEqual(capture.png, JPEG_FIXTURE);
  assert.equal(capture.width, 2); assert.equal(capture.height, 3);
  assert.equal(requests[0]?.url, `${ENDPOINT}/frame.jpg`);
  assert.equal(requests[0]?.options?.headers, undefined);
});

test("JPEG truncation, marker lengths, missing scan and false dimensions are rejected", async () => {
  const overflow = Buffer.from(JPEG_FIXTURE); overflow.writeUInt16BE(65535, 4);
  const zeroHeight = Buffer.from(JPEG_FIXTURE);
  zeroHeight.writeUInt16BE(0, zeroHeight.indexOf(Buffer.from([0xff, 0xc0])) + 5);
  for (const bytes of [JPEG_FIXTURE.subarray(0, -2), JPEG_FIXTURE.subarray(0, -8),
    Buffer.concat([JPEG_FIXTURE, Buffer.from([0])]), overflow, zeroHeight,
    Buffer.from([0xff, 0xd8, 0xff, 0xd9]), PNG]) {
    assert.throws(() => readJpegDimensions(bytes));
    const { client } = mockClient(() => frame(new Uint8Array(bytes), { "Content-Type": "image/jpeg" }));
    await assert.rejects(client.capture(), hasCode("SCREEN_INVALID_FRAME"));
  }
  const { client: wrongDimensions } = mockClient(() => frame(new Uint8Array(JPEG_FIXTURE), {
    "Content-Type": "image/jpeg", "X-Frame-Width": "3", "X-Frame-Height": "3",
  }));
  await assert.rejects(wrongDimensions.capture(), hasCode("SCREEN_INVALID_FRAME"));
  const { client: wrongMime } = mockClient(() => frame(new Uint8Array(JPEG_FIXTURE)));
  await assert.rejects(wrongMime.capture(), hasCode("SCREEN_INVALID_FRAME"));
});

test("health reports only the configured App and exposes stopped projection without scanning", async () => {
  const { client, requests } = mockClient(() => health({ projecting: false, frameReady: false }));
  assert.deepEqual(await client.listDevices(), [{ serial: DEVICE_A, state: "not_projecting", model: "OnePlus Offline Fixture",
    properties: { source: "screen-app", endpoint: ENDPOINT, projecting: "false", frameReady: "false" } }]);
  assert.deepEqual(requests.map(({ url }) => url), [`${ENDPOINT}/health`]);
  assert.equal(requests[0]?.options?.headers, undefined);
});

test("malformed health metadata cannot masquerade as a phone App", async () => {
  for (const values of [{ status: "error" }, { service: "other" }, { deviceId: "USB-A" }, { deviceId: null },
    { model: "" }, { projecting: "true" }]) {
    const { client } = mockClient(() => health(values));
    await assert.rejects(client.listDevices(), hasCode("SCREEN_INVALID_HEALTH"));
  }
  const { client } = mockClient(() => new Response("{", { headers: { "Content-Type": "application/json" } }));
  await assert.rejects(client.listDevices(), hasCode("SCREEN_INVALID_HEALTH"));
});

test("capture matches explicit and configured UUIDs and detects a replaced phone App", async () => {
  const { client } = mockClient();
  assert.equal((await client.capture(DEVICE_A)).serial, DEVICE_A);
  await assert.rejects(client.capture(DEVICE_B), hasCode("SCREEN_DEVICE_MISMATCH"));
  await assert.rejects(client.capture("USB-A"), hasCode("SCREEN_DEVICE_MISMATCH"));
  const { client: pinned } = mockClient(() => frame(undefined, { "X-Device-Id": DEVICE_B }), { deviceId: DEVICE_A });
  await assert.rejects(pinned.capture(), hasCode("SCREEN_DEVICE_MISMATCH"));
  const { client: pinnedHealth } = mockClient(() => health({ deviceId: DEVICE_B }), { deviceId: DEVICE_A });
  await assert.rejects(pinnedHealth.listDevices(), hasCode("SCREEN_DEVICE_MISMATCH"));
});

test("LAN reconnect retries the configured endpoint and the same latest source frame is allowed", async () => {
  let online = true;
  const { client, requests } = mockClient(() => { if (!online) throw new Error("network gone"); return frame(); });
  assert.equal((await client.capture()).sourceFrameId, "app-frame-1");
  online = false;
  await assert.rejects(client.capture());
  online = true;
  assert.equal((await client.capture()).sourceFrameId, "app-frame-1");
  assert.equal(requests.length, 3);
  assert.ok(requests.every(({ url }) => url === `${ENDPOINT}/frame.jpg`));
});

test("concurrent frame requests remain FIFO and a failed request does not block the next", async () => {
  let release: (response: Response) => void = () => {};
  let calls = 0;
  const { client, requests } = mockClient(() => ++calls === 1
    ? new Promise<Response>((resolve) => { release = resolve; }) : frame());
  const first = client.capture(DEVICE_A);
  const second = client.capture(DEVICE_B);
  await delay(0);
  assert.equal(requests.length, 1);
  release(frame());
  assert.equal((await first).serial, DEVICE_A);
  await assert.rejects(second, hasCode("SCREEN_DEVICE_MISMATCH"));
  assert.equal((await client.capture()).serial, DEVICE_A);
  assert.equal(requests.length, 3);
});

const cancellableCapture = (client: ScreenClient, signal?: AbortSignal): ReturnType<ScreenClient["capture"]> =>
  client.capture(undefined, signal);
const promptly = <T>(task: Promise<T>): Promise<T> => Promise.race([task, delay(250).then(() => { throw new Error("Cancelled original capture still blocks the FIFO."); })]);

test("an aborted original queued behind another caller rejects promptly and never sends HTTP", async () => {
  let release!: (response: Response) => void;
  const { client, requests } = mockClient(() => requests.length === 1 ? new Promise<Response>((resolve) => { release = resolve; }) : frame(), { timeoutMs: 1000 });
  const first = client.capture(); await delay(0);
  const controller = new AbortController();
  const queued = cancellableCapture(client, controller.signal);
  const next = client.capture();
  const rejected = assert.rejects(queued, /Cancel queued original/u);
  try {
    controller.abort(new Error("Cancel queued original"));
    await promptly(rejected);
    assert.equal(requests.length, 1, "Cancelling the queued request cannot abort the active caller.");
  } finally { release(frame()); await Promise.allSettled([first, queued, next, rejected]); }
  assert.equal(requests.length, 2, "Only the first and surviving last caller may issue HTTP requests.");
  const cancelled = new AbortController(); cancelled.abort(new Error("Already cancelled"));
  await assert.rejects(cancellableCapture(client, cancelled.signal), /Already cancelled/u);
  assert.equal(requests.length, 2);
});

test("a cancelled original body releases the FIFO and cancels only that request", async () => {
  let stalled!: ReadableStreamDefaultController<Uint8Array>, cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { stalled = controller; }, cancel() { cancelled = true; } });
  const { client, requests } = mockClient(() => requests.length === 1 ? frame(body) : frame(undefined, { "X-Frame-Id": "next-original" }), { timeoutMs: 1000 });
  const controller = new AbortController();
  const first = cancellableCapture(client, controller.signal); await delay(0);
  const next = client.capture();
  const rejected = assert.rejects(first, /Cancel active original/u);
  try {
    controller.abort(new Error("Cancel active original")); await promptly(rejected);
    assert.equal(cancelled, true, "An aborted original HTTP body must be cancelled.");
    assert.equal((await promptly(next)).sourceFrameId, "next-original");
    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.options!.signal!.aborted, true);
    assert.equal(requests[1]!.options!.signal!.aborted, false);
  } finally { try { stalled.close(); } catch { /* Already cancelled. */ } await Promise.allSettled([first, next, rejected]); }
});

test("late HTTP responses to cancelled originals are discarded without blocking the next capture", async () => {
  let release!: (response: Response) => void;
  const { client, requests } = mockClient(() => requests.length === 1 ? new Promise<Response>((resolve) => { release = resolve; }) : frame(undefined, { "X-Frame-Id": "surviving-original" }), { timeoutMs: 1000 });
  const controller = new AbortController();
  const first = cancellableCapture(client, controller.signal); await delay(0);
  const next = client.capture();
  const rejected = assert.rejects(first, /Cancel slow HTTP/u);
  let lateCancelled = false;
  try {
    controller.abort(new Error("Cancel slow HTTP")); await promptly(rejected);
    assert.equal((await promptly(next)).sourceFrameId, "surviving-original");
  } finally {
    release(frame(new ReadableStream<Uint8Array>({ cancel() { lateCancelled = true; } })));
    await Promise.allSettled([first, next, rejected]); await delay(0);
  }
  assert.equal(lateCancelled, true, "Even a fetch adapter that ignores abort must cancel a late response body.");
});

test("503 gives explicit MediaProjection guidance", async () => {
  const { client, requests } = mockClient(() => frame("projection stopped", {}, 503));
  await assert.rejects(client.capture(), (error: unknown) => error instanceof ScreenError
    && error.code === "SCREEN_NOT_PROJECTING" && error.message.includes("开始投屏") && error.message.includes("系统屏幕共享授权"));
  assert.equal(requests.length, 1);
});

test("HTTP errors and redirects produce clear failures without response bodies", async () => {
  for (const status of [301, 302, 307, 401, 403, 404, 500]) {
    const { client } = mockClient(() => frame("unexpected response body", {}, status));
    await assert.rejects(client.capture(), (error: unknown) => error instanceof ScreenError
      && error.code === "SCREEN_HTTP_ERROR" && !error.message.includes("unexpected response body"));
  }
});

test("metadata and MIME must prove that the frame is current PNG from the screen app", async () => {
  for (const headers of [
    { "Content-Type": "image/webp" }, { "X-Frame-Id": null }, { "X-Frame-Id": " ".repeat(3) },
    { "X-Frame-Age-Ms": null }, { "X-Frame-Age-Ms": "-1" }, { "X-Frame-Age-Ms": "1.5" },
    { "X-Frame-Age-Ms": "Infinity" }, { "X-Captured-At": null }, { "X-Captured-At": "yesterday" },
    { "Content-Length": "-1" }, { "X-Device-Id": null }, { "X-Device-Id": "not-a-uuid" },
  ]) {
    const { client } = mockClient(() => frame(undefined, headers));
    await assert.rejects(client.capture(), hasCode("SCREEN_INVALID_FRAME"));
  }
});

test("stale frame age is rejected even when the PNG is valid", async () => {
  const { client } = mockClient(() => frame(undefined, { "X-Frame-Age-Ms": "3001" }));
  await assert.rejects(client.capture(), hasCode("SCREEN_STALE_FRAME"));
});

test("transfer time contributes to freshness before the captured frame is returned", async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    setTimeout(() => { controller.enqueue(new Uint8Array(PNG)); controller.close(); }, 30);
  } });
  const { client } = mockClient(() => frame(body, { "X-Frame-Age-Ms": "10" }), { maxFrameAgeMs: 20 });
  await assert.rejects(client.capture(), hasCode("SCREEN_STALE_FRAME"));
});

test("PNG CRC/truncation and mismatching Content-Length are rejected", async () => {
  const corrupt = Buffer.from(PNG); corrupt[30] = corrupt[30]! ^ 1;
  for (const body of [corrupt, PNG.subarray(0, -2), Buffer.from("not png")]) {
    const { client } = mockClient(() => frame(new Uint8Array(body)));
    await assert.rejects(client.capture(), hasCode("SCREEN_INVALID_FRAME"));
  }
  const { client } = mockClient(() => frame(undefined, { "Content-Length": String(PNG.length + 1) }));
  await assert.rejects(client.capture(), hasCode("SCREEN_INVALID_FRAME"));
});

test("MCP original capture rejects a reduced preview and inconsistent preview metadata", async () => {
  for (const headers of [
    { "X-Device-Width": "4", "X-Device-Height": "6", "X-Preview-Profile": "fast" },
    { "X-Device-Width": "2" }, { "X-Device-Height": "3" }, { "X-Preview-Profile": "original" },
    { "X-Device-Width": "2", "X-Device-Height": "3" },
    { "X-Device-Width": "0", "X-Device-Height": "3", "X-Preview-Profile": "original" },
    { "X-Device-Width": "65536", "X-Device-Height": "3", "X-Preview-Profile": "fast" },
    { "X-Device-Width": "2", "X-Device-Height": "3", "X-Preview-Profile": "unknown" },
    { "X-Device-Width": "4", "X-Device-Height": "6", "X-Preview-Profile": "original" },
    { "X-Device-Width": "2", "X-Device-Height": "1", "X-Preview-Profile": "fast" },
    { "X-Device-Width": "400", "X-Device-Height": "6", "X-Preview-Profile": "fast" },
  ]) {
    const { client } = mockClient(() => frame(undefined, headers));
    await assert.rejects(client.capture(), hasCode("SCREEN_INVALID_FRAME"));
  }
});

test("preview profile API validates typed settings, sends only bounded JSON and keeps mutation FIFO", async () => {
  let release!: (response: Response) => void;
  let count = 0;
  const { client, requests } = mockClient((_url, options) => {
    assert.equal(options?.method, "POST");
    assert.deepEqual(options.headers, { "Content-Type": "application/json" });
    assert.ok(typeof options.body === "string" && options.body.length < 256);
    return ++count === 1 ? new Promise((resolve) => { release = resolve; }) : Response.json({ profile: "turbo" });
  });
  const first = client.setPreviewProfile("fast"), next = client.setPreviewProfile("turbo");
  await delay(0); assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, `${ENDPOINT}/preview/profile`);
  assert.equal(requests[0]?.options?.body, '{"profile":"fast"}');
  release(Response.json({ profile: "fast", deviceWidth: 1080, deviceHeight: 2400 }));
  assert.deepEqual(await first, { profile: "fast", deviceWidth: 1080, deviceHeight: 2400 });
  assert.deepEqual(await next, { profile: "turbo" });
  assert.equal(requests[1]?.options?.body, '{"profile":"turbo"}');
  await assert.rejects(client.setPreviewProfile("not-a-profile" as PreviewProfile), hasCode("SCREEN_INVALID_PROFILE"));
  assert.equal(requests.length, 2);
});

test("profile reads support original-only old Apps and reject invalid response metadata", async () => {
  const { client: old, requests } = mockClient(() => new Response(null, { status: 404 }));
  assert.deepEqual(await old.getPreviewProfile(), { profile: "original" });
  await assert.rejects(old.setPreviewProfile("standard"), /更新手机投屏/u);
  assert.equal(requests[0]?.options?.headers, undefined);
  for (const state of [null, [], {}, { profile: "other" }, { profile: "fast", deviceWidth: 1080 },
    { profile: "fast", deviceWidth: 0, deviceHeight: 2400 }, { profile: "fast", deviceWidth: "1080", deviceHeight: 2400 }]) {
    const { client } = mockClient(() => Response.json(state));
    await assert.rejects(client.getPreviewProfile(), hasCode("SCREEN_INVALID_PROFILE"));
  }
  const { client: wrongMime } = mockClient(() => new Response('{"profile":"standard"}', { headers: { "Content-Type": "text/html" } }));
  await assert.rejects(wrongMime.getPreviewProfile(), hasCode("SCREEN_INVALID_PROFILE"));
});

test("oversized Content-Length is refused before reading the body", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const { client } = mockClient(() => frame(body, { "Content-Length": String(MAX_SCREEN_FRAME_BYTES + 1) }));
  await assert.rejects(client.capture(), hasCode("SCREEN_TOO_LARGE"));
  assert.equal(cancelled, true);
});

test("streamed responses enforce the byte limit without trusting Content-Length", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array(50)); controller.enqueue(new Uint8Array(50));
  }, cancel() { cancelled = true; } });
  const { client } = mockClient(() => frame(body), { maxBuffer: 80 });
  await assert.rejects(client.capture(), hasCode("SCREEN_TOO_LARGE"));
  assert.equal(cancelled, true);
});

test("a stalled frame body times out and its stream is cancelled", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const { client } = mockClient(() => frame(body), { timeoutMs: 20 });
  await assert.rejects(client.capture(), hasCode("SCREEN_TIMEOUT"));
  assert.equal(cancelled, true);
});

test("the timeout also bounds a stalled HTTP request and a stalled health body", async () => {
  const { client } = mockClient(() => new Promise<Response>(() => {}), { timeoutMs: 20 });
  await assert.rejects(client.capture(), hasCode("SCREEN_TIMEOUT"));
  const { client: stalledHealth } = mockClient(() => new Response(new ReadableStream<Uint8Array>(),
    { headers: { "Content-Type": "application/json" } }), { timeoutMs: 20 });
  await assert.rejects(stalledHealth.listDevices(), hasCode("SCREEN_TIMEOUT"));
});

test("network failures return a controlled error", async () => {
  const { client: offline } = mockClient(() => { throw new Error("internal network diagnostic"); });
  await assert.rejects(offline.capture(), (error: unknown) => error instanceof ScreenError
    && error.code === "SCREEN_UNREACHABLE" && !error.message.includes("internal network diagnostic") && error.cause === undefined);
});

test("configuration preserves the hard size/freshness limits", () => {
  const base = { endpoint: ENDPOINT };
  assert.throws(() => new ScreenClient({ ...base, timeoutMs: 0 }), RangeError);
  assert.throws(() => new ScreenClient({ ...base, maxBuffer: MAX_SCREEN_FRAME_BYTES + 1 }), RangeError);
  assert.throws(() => new ScreenClient({ ...base, maxFrameAgeMs: 3001 }), RangeError);
});

test("endpoint accepts only explicit RFC1918 or IPv4 loopback origins with fixed paths", () => {
  for (const endpoint of ["http://10.0.0.2:8791", "https://172.16.0.1", "http://172.31.255.254",
    "http://192.168.1.2:8791/frame.jpg", "http://127.0.0.1:1234"]) {
    assert.equal(new ScreenClient({ endpoint }).endpoint, new URL(endpoint).origin);
  }
  for (const endpoint of ["http://8.8.8.8", "http://172.15.0.1", "http://172.32.0.1", "http://192.169.0.1",
    "http://169.254.1.1", "http://0.0.0.0", "http://phone.local", "http://localhost:8791", "http://[::1]",
    "file:///frame.jpg", "ftp://192.168.1.1", "http://user:pass@192.168.1.2", "http://192.168.1.2?token=secret",
    "http://192.168.1.2#secret", "http://192.168.1.2/other", "not a url"]) {
    assert.throws(() => new ScreenClient({ endpoint }), hasCode("SCREEN_INVALID_ENDPOINT"), endpoint);
  }
});

test("real fetch against a local mock App needs no ADB and never follows redirects", async (context) => {
  const seen: string[] = [];
  let redirected = false;
  const server = createServer((request, response) => {
    seen.push(request.url ?? "");
    assert.equal(request.headers.authorization, undefined);
    if (redirected) {
      response.writeHead(302, { Location: "http://127.0.0.1:1/secret" }); response.end();
    } else if (request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok", service: "qdd-android-screen", deviceId: DEVICE_A,
        model: "Mock App", projecting: true }));
    } else {
      response.writeHead(200, { "Content-Type": "image/jpeg", "X-Device-Id": DEVICE_A,
        "X-Frame-Id": "local-frame", "X-Frame-Age-Ms": "0", "X-Captured-At": "2026-10-17T00:00:00Z",
        "X-Display-Rotation": "2", "Content-Length": JPEG_FIXTURE.length }); response.end(JPEG_FIXTURE);
    }
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  context.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => { server.close(() => resolve()); }); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const client = new ScreenClient({ endpoint: `http://127.0.0.1:${address.port}` });
  assert.equal((await client.listDevices())[0]?.serial, DEVICE_A);
  assert.equal((await client.capture(DEVICE_A)).rotation, 2);
  redirected = true;
  await assert.rejects(client.capture(), hasCode("SCREEN_UNREACHABLE"));
  assert.deepEqual(seen, ["/health", "/frame.jpg", "/frame.jpg"]);
});

test("display rotation is optional for existing apps and validated when provided", async () => {
  const { client: legacy } = mockClient();
  assert.equal((await legacy.capture()).rotation, undefined);
  for (const rotation of [0, 1, 2, 3] as const) {
    const { client } = mockClient(() => frame(undefined, { "X-Display-Rotation": String(rotation) }));
    assert.equal((await client.capture()).rotation, rotation);
  }
  for (const rotation of ["-1", "4", "1.5", "NaN", "01", ""]) {
    const { client } = mockClient(() => frame(undefined, { "X-Display-Rotation": rotation }));
    await assert.rejects(client.capture(), hasCode("SCREEN_INVALID_FRAME"));
  }
});

test("assembled video frames retain MIME, geometry and capture metadata validation", async () => {
  for (const invalidHeaders of [
    { "Content-Type": "text/plain" }, { "X-Frame-Width": "3" }, { "X-Frame-Height": "2" },
    { "X-Display-Rotation": "4" }, { "X-Frame-Age-Ms": "NaN" }, { "X-Captured-At": "yesterday" },
  ]) {
    const headers = { "Content-Type": "image/jpeg", "Content-Length": String(JPEG_FIXTURE.length),
      "X-Frame-Id": "video-frame", "X-Frame-Age-Ms": "0", "X-Device-Id": DEVICE_A,
      "X-Captured-At": "2026-10-17T06:00:00.000Z", "X-Frame-Width": "2", "X-Frame-Height": "3", ...invalidHeaders };
    const multipart = Buffer.concat([Buffer.from(`--qdd-frame\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`), JPEG_FIXTURE, Buffer.from("\r\n")]);
    const client = new ScreenClient({ endpoint: ENDPOINT, fetch: async () => new Response(multipart,
      { headers: { "Content-Type": "multipart/x-mixed-replace; boundary=qdd-frame" } }) });
    await assert.rejects(client.stream(new AbortController().signal).next(), hasCode("SCREEN_INVALID_FRAME"));
  }
});

test("multipart transfer time counts toward freshness without a second HTTP body reader", async () => {
  let send!: ReadableStreamDefaultController<Uint8Array>;
  let headerReceived!: () => void;
  const ready = new Promise<void>((resolve) => { headerReceived = resolve; });
  const headers = Buffer.from(`--qdd-frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${JPEG_FIXTURE.length}\r\nX-Frame-Id: slow-video\r\nX-Frame-Age-Ms: 0\r\nX-Device-Id: ${DEVICE_A}\r\nX-Captured-At: 2026-10-17T06:00:00.000Z\r\n\r\n`);
  const client = new ScreenClient({ endpoint: ENDPOINT, maxFrameAgeMs: 30, fetch: async () => new Response(
    new ReadableStream<Uint8Array>({ start(controller) { send = controller; controller.enqueue(headers); headerReceived(); } }),
    { headers: { "Content-Type": "multipart/x-mixed-replace; boundary=qdd-frame" } }) });
  const reading = client.stream(new AbortController().signal).next();
  await ready; await delay(80);
  send.enqueue(Buffer.concat([JPEG_FIXTURE, Buffer.from("\r\n")]));
  await assert.rejects(reading, hasCode("SCREEN_STALE_FRAME"));
});

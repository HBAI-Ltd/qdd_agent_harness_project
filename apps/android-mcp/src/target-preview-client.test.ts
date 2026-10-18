import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { PNG } from "pngjs";
import { fixturePng } from "./fixtures/stdio-server.js";
import { renderTargetPreview } from "./target-preview-client.js";

test("target rendering runs outside the main event loop and returns its original/crop geometry", async () => {
  const bytes = fixturePng(1080, 2400), original = Buffer.from(bytes);
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  try {
    const result = await renderTargetPreview(bytes, "image/png", 1080, 2400, 540, 1200);
    assert.ok(ticks > 0, "Main-thread heartbeat timers must run while the worker renders.");
    const image = PNG.sync.read(result.png), zoom = PNG.sync.read(result.zoomPng);
    assert.deepEqual([image.width, image.height], [1080, 2452]);
    assert.deepEqual([zoom.width, zoom.height], [320, 372]);
    assert.deepEqual(result.crop, { x: 460, y: 1120, width: 160, height: 160, scale: 2 });
    assert.deepEqual(bytes, original);
  } finally { clearInterval(timer); }
});

test("target worker queue is bounded and a cancelled waiter cannot consume another render slot", async () => {
  const bytes = fixturePng(100, 200);
  const firstAbort = new AbortController(), queuedAbort = new AbortController();
  const first = renderTargetPreview(bytes, "image/png", 100, 200, 50, 100, firstAbort.signal);
  const queued = renderTargetPreview(bytes, "image/png", 100, 200, 50, 100, queuedAbort.signal);
  const firstRejected = assert.rejects(first, /first render cancelled/);
  const queuedRejected = assert.rejects(queued, /queued render cancelled/);
  queuedAbort.abort(new Error("queued render cancelled"));
  await queuedRejected;
  await assert.rejects(renderTargetPreview(bytes, "image/png", 100, 200, 50, 100), /busy/);
  firstAbort.abort(new Error("first render cancelled"));
  await firstRejected;
  // Rejection is prompt; worker termination and the cancelled queued job then
  // complete in order. A later independent render must still be usable.
  let recovered = false;
  for (let index = 0; index < 100; index += 1) {
    try { await renderTargetPreview(bytes, "image/png", 100, 200, 50, 100); recovered = true; break; }
    catch (error) { if (!(error instanceof Error) || !/busy/.test(error.message)) throw error; await delay(5); }
  }
  assert.equal(recovered, true);
});

test("worker decode errors do not poison future target previews", async () => {
  await assert.rejects(renderTargetPreview(Buffer.from("invalid"), "image/png", 100, 200, 50, 100), /Cannot render target preview/);
  const result = await renderTargetPreview(fixturePng(100, 200), "image/png", 100, 200, 50, 100);
  assert.equal(result.simulatedTarget, true);
});

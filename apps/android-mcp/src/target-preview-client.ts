import { getAsset, isSea } from "node:sea";
import { Worker } from "node:worker_threads";
import { MAX_SCREEN_FRAME_BYTES } from "./screen.js";
import type { TargetPreview } from "./target-preview.js";

const MAX_RENDER_JOBS = 2; // One active worker and one waiting request.
const RENDER_TIMEOUT_MS = 5000;
let jobs = 0;
let tail = Promise.resolve();

function withCancellation<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    task.then((value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

async function inWorker(bytes: Buffer, mimeType: "image/jpeg" | "image/png", width: number, height: number,
  x: number, y: number, signal?: AbortSignal): Promise<TargetPreview> {
  signal?.throwIfAborted();
  const options = { stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 192, stackSizeMb: 4 } };
  const worker = isSea()
    ? new Worker(getAsset("workers/target-preview.cjs", "utf8"), { ...options, eval: true })
    : new Worker(new URL("./target-preview-worker.js", import.meta.url), options);
  worker.stdout?.resume(); worker.stderr?.resume();
  try {
    return await new Promise<TargetPreview>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, value?: TargetPreview) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
        if (error !== undefined) reject(error); else resolve(value!);
      };
      const abort = () => finish(signal?.reason ?? new Error("Target preview cancelled."));
      const timer = setTimeout(() => finish(new Error("Target preview rendering timed out; no phone input was sent.")), RENDER_TIMEOUT_MS);
      worker.once("error", (error) => finish(error));
      worker.once("exit", (code) => finish(new Error(`Target preview worker exited before returning an image (${code}).`)));
      worker.once("message", (message: { ok: boolean; message?: string; result?: TargetPreview }) => {
        if (!message.ok || !message.result) return finish(new Error(message.message ?? "Target preview rendering failed."));
        finish(undefined, { ...message.result, png: Buffer.from(message.result.png), zoomPng: Buffer.from(message.result.zoomPng) });
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else worker.postMessage({ bytes, mimeType, width, height, x, y });
    });
  } finally { await worker.terminate(); }
}

/** Decode/encode outside the HID heartbeat event loop; bounded work, no device input. */
export function renderTargetPreview(bytes: Buffer, mimeType: "image/jpeg" | "image/png", width: number, height: number,
  x: number, y: number, signal?: AbortSignal): Promise<TargetPreview> {
  signal?.throwIfAborted();
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_SCREEN_FRAME_BYTES) return Promise.reject(new Error("Target preview input exceeds 32 MiB."));
  if (jobs >= MAX_RENDER_JOBS) return Promise.reject(new Error("Target preview renderer is busy; wait for the current preview before requesting another."));
  jobs += 1;
  const task = tail.then(() => inWorker(bytes, mimeType, width, height, x, y, signal));
  // A cancelled waiter remains in this chain until its predecessor ends. It
  // cannot release the next slot early and create concurrent large decoders.
  tail = task.then(() => { jobs -= 1; }, () => { jobs -= 1; });
  return withCancellation(task, signal);
}

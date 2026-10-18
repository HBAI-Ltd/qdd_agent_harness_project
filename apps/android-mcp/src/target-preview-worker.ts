import { parentPort } from "node:worker_threads";
import { renderTargetPreview } from "./target-preview.js";
import { MAX_SCREEN_FRAME_BYTES } from "./screen.js";

if (!parentPort) throw new Error("Target preview rendering requires a worker thread.");
parentPort.once("message", (job: { bytes: Uint8Array; mimeType: "image/jpeg" | "image/png";
  width: number; height: number; x: number; y: number }) => {
  try {
    const result = renderTargetPreview(Buffer.from(job.bytes), job.mimeType, job.width, job.height, job.x, job.y);
    if (result.png.length > MAX_SCREEN_FRAME_BYTES || result.zoomPng.length > MAX_SCREEN_FRAME_BYTES) {
      throw new Error("Rendered target preview exceeds the image byte limit.");
    }
    parentPort!.postMessage({ ok: true, result });
  } catch (error) {
    parentPort!.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
  } finally { parentPort!.close(); }
});

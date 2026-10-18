import * as jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { inflateSync } from "node:zlib";
import { readPngDimensions } from "./adb.js";
import { MAX_SCREEN_FRAME_BYTES, readJpegDimensions } from "./screen.js";

export const MAX_TARGET_PREVIEW_DIMENSION = 8192;
export const MAX_TARGET_PREVIEW_PIXELS = 16 * 1024 * 1024;
const CROP_SIZE = 160;
const ZOOM_SCALE = 2;
const MARKER_RADIUS = 25;
const CENTER_RADIUS = 3;
const BLACK = [0, 0, 0, 255] as const;
const CYAN = [0, 255, 255, 255] as const;
const MAGENTA = [255, 0, 255, 255] as const;

export interface TargetPreview {
  png: Buffer;
  zoomPng: Buffer;
  /** x/y are the original-image crop origin; zoom target = (target - origin) * scale. */
  crop: { x: number; y: number; width: number; height: number; scale: number };
  /** This overlay marks an intended target; it is never a physical HID cursor. */
  simulatedTarget: true;
}

function validatePngInflation(bytes: Buffer, width: number, height: number): void {
  const depth = bytes[24]!, colorType = bytes[25]!;
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bitsPerPixel = channels[colorType]! * depth;
  const rowBytes = (w: number, h: number) => w === 0 || h === 0 ? 0 : (Math.ceil(w * bitsPerPixel / 8) + 1) * h;
  let expectedBytes = rowBytes(width, height);
  if (bytes[28] === 1) {
    expectedBytes = 0;
    // Adam7 passes have independent scanline filters and packed-pixel rounding.
    for (const [startX, startY, stepX, stepY] of [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
      [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const) {
      expectedBytes += rowBytes(Math.max(0, Math.ceil((width - startX) / stepX)), Math.max(0, Math.ceil((height - startY) / stepY)));
    }
  }
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  // pngjs has a separate interlaced decode path. Bound inflation independently
  // so a small IHDR cannot authorize an arbitrarily large zlib output there.
  const inflated = inflateSync(Buffer.concat(chunks), { maxOutputLength: expectedBytes });
  if (inflated.length !== expectedBytes) invalid("PNG filtered pixel data length does not match its dimensions");
}

function invalid(message: string, cause?: unknown): never {
  throw new Error(`Cannot render target preview: ${message}`, cause === undefined ? undefined : { cause });
}

function validGeometry(width: number, height: number, x: number, y: number): void {
  if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= MAX_TARGET_PREVIEW_DIMENSION)
    || width * height > MAX_TARGET_PREVIEW_PIXELS) {
    invalid(`dimensions must be positive integers at most ${MAX_TARGET_PREVIEW_DIMENSION} per side and ${MAX_TARGET_PREVIEW_PIXELS} pixels`);
  }
  if (![x, y].every(Number.isSafeInteger) || x < 0 || y < 0 || x >= width || y >= height) {
    invalid("target coordinates must be integers inside the original image");
  }
}

function paintTarget(data: Buffer, width: number, height: number, x: number, y: number): void {
  const fromX = Math.max(0, x - MARKER_RADIUS), toX = Math.min(width - 1, x + MARKER_RADIUS);
  const fromY = Math.max(0, y - MARKER_RADIUS), toY = Math.min(height - 1, y + MARKER_RADIUS);
  for (let py = fromY; py <= toY; py += 1) {
    for (let px = fromX; px <= toX; px += 1) {
      const dx = px - x, dy = py - y, distance = Math.hypot(dx, dy);
      // Leave the exact target and a small surrounding area visible.
      if (distance <= CENTER_RADIUS) continue;
      const horizontal = Math.abs(dx) >= 6 && Math.abs(dx) <= 24;
      const vertical = Math.abs(dy) >= 6 && Math.abs(dy) <= 24;
      const outerRing = Math.abs(distance - 18);
      const innerRing = Math.abs(distance - 13);
      let color: readonly [number, number, number, number] | undefined;
      if (outerRing <= 2.5 || innerRing <= 2.5
        || (horizontal && Math.abs(dy) <= 2) || (vertical && Math.abs(dx) <= 2)) color = BLACK;
      if (outerRing <= 1.5) color = MAGENTA;
      if (innerRing <= 1.5 || (horizontal && dy === 0) || (vertical && dx === 0)) color = CYAN;
      if (!color) continue;
      const offset = (py * width + px) * 4;
      data[offset] = color[0]; data[offset + 1] = color[1];
      data[offset + 2] = color[2]; data[offset + 3] = color[3];
    }
  }
}

function encodePng(width: number, height: number, data: Buffer): Buffer {
  // An empty PNG avoids allocating a second full-size constructor raster.
  const output = new PNG();
  output.width = width; output.height = height; output.data = data;
  return PNG.sync.write(output);
}

/**
 * Render a simulated click target on an immutable original-resolution screenshot.
 * No pointer movement, input dispatch, or screen acquisition takes place here.
 */
export function renderTargetPreview(bytes: Buffer, mimeType: "image/jpeg" | "image/png", width: number, height: number,
  x: number, y: number): TargetPreview {
  validGeometry(width, height, x, y);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_SCREEN_FRAME_BYTES) {
    invalid(`encoded image must contain 1 to ${MAX_SCREEN_FRAME_BYTES} bytes`);
  }
  if (mimeType !== "image/jpeg" && mimeType !== "image/png") invalid("only JPEG and PNG images are supported");
  let data: Buffer;
  try {
    // Read dimensions before any image decoder is permitted to allocate a raster.
    const dimensions = mimeType === "image/jpeg" ? readJpegDimensions(bytes) : readPngDimensions(bytes);
    if (dimensions.width !== width || dimensions.height !== height) invalid("declared dimensions do not match the encoded image");
    if (mimeType === "image/png") validatePngInflation(bytes, width, height);
    const decoded = mimeType === "image/jpeg"
      ? jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, tolerantDecoding: false,
        maxResolutionInMP: MAX_TARGET_PREVIEW_PIXELS / 1_000_000, maxMemoryUsageInMB: 192 })
      : PNG.sync.read(bytes, { checkCRC: true });
    if (decoded.width !== width || decoded.height !== height || decoded.data.length !== width * height * 4) {
      invalid("decoded image dimensions or pixel data do not match the original image");
    }
    // JPEG and PNG implementations own their raster; take our own writable copy.
    data = Buffer.from(decoded.data);
  } catch (cause) {
    invalid("image validation or decoding failed", cause);
  }
  paintTarget(data, width, height, x, y);
  const cropWidth = Math.min(CROP_SIZE, width), cropHeight = Math.min(CROP_SIZE, height);
  const cropX = Math.max(0, Math.min(width - cropWidth, x - Math.floor(cropWidth / 2)));
  const cropY = Math.max(0, Math.min(height - cropHeight, y - Math.floor(cropHeight / 2)));
  const zoomWidth = cropWidth * ZOOM_SCALE, zoomHeight = cropHeight * ZOOM_SCALE;
  const zoom = Buffer.alloc(zoomWidth * zoomHeight * 4);
  for (let py = 0; py < zoomHeight; py += 1) {
    for (let px = 0; px < zoomWidth; px += 1) {
      const source = ((cropY + Math.floor(py / ZOOM_SCALE)) * width + cropX + Math.floor(px / ZOOM_SCALE)) * 4;
      data.copy(zoom, (py * zoomWidth + px) * 4, source, source + 4);
    }
  }
  return { png: encodePng(width, height, data),
    zoomPng: encodePng(zoomWidth, zoomHeight, zoom),
    crop: { x: cropX, y: cropY, width: cropWidth, height: cropHeight, scale: ZOOM_SCALE }, simulatedTarget: true };
}

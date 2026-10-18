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
const WHITE = [255, 255, 255, 255] as const;
const LEGEND_HEIGHT = 52;
const GLYPHS: Record<string, readonly number[]> = {
  " ": [0, 0, 0, 0, 0, 0, 0], ":": [0, 4, 4, 0, 4, 4, 0], "=": [0, 0, 31, 0, 31, 0, 0],
  "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14],
  "2": [14, 17, 1, 2, 4, 8, 31], "3": [30, 1, 1, 14, 1, 1, 30],
  "4": [2, 6, 10, 18, 31, 2, 2], "5": [31, 16, 16, 30, 1, 1, 30],
  "6": [14, 16, 16, 30, 17, 17, 14], "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14], "9": [14, 17, 17, 15, 1, 1, 14],
  A: [14, 17, 17, 31, 17, 17, 17], D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31], G: [14, 17, 16, 23, 17, 17, 15],
  H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14],
  L: [16, 16, 16, 16, 16, 16, 31], M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 25, 21, 19, 17, 17, 17], O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], X: [17, 17, 10, 4, 10, 17, 17], Y: [17, 17, 10, 4, 4, 4, 4],
};

interface AnnotatedCanvas {
  width: number;
  height: number;
  sourceRect: { x: 0; y: 0; width: number; height: number };
  legend: { x: 0; y: number; width: number; height: 52 };
}

export interface TargetPreview {
  png: Buffer;
  zoomPng: Buffer;
  /** x/y are the original-image crop origin; zoom target = (target - origin) * scale. */
  crop: { x: number; y: number; width: number; height: number; scale: number };
  /** This overlay marks an intended target; it is never a physical HID cursor. */
  simulatedTarget: true;
  /** Caption pixels belong to the annotation canvas, never to the phone display. */
  annotation: { coordinateSpace: "originalPhonePixels"; label: string; original: AnnotatedCanvas; zoom: AnnotatedCanvas };
}

function captionCanvas(width: number, height: number, label: string): AnnotatedCanvas {
  const canvasWidth = Math.max(width, Math.max(label.length, "SIMULATED TARGET".length) * 12 - 2 + 16);
  return { width: canvasWidth, height: height + LEGEND_HEIGHT,
    sourceRect: { x: 0, y: 0, width, height }, legend: { x: 0, y: height, width: canvasWidth, height: LEGEND_HEIGHT } };
}

function paintCaption(data: Buffer, canvas: AnnotatedCanvas, label: string): void {
  data.fill(Buffer.from(CYAN), canvas.legend.y * canvas.width * 4, (canvas.legend.y + 2) * canvas.width * 4);
  for (const [row, line] of [label, "SIMULATED TARGET"].entries()) {
    const color = row === 0 ? WHITE : MAGENTA;
    for (let column = 0; column < line.length; column += 1) {
      const glyph = GLYPHS[line[column]!]!;
      for (let gy = 0; gy < 7; gy += 1) for (let gx = 0; gx < 5; gx += 1) {
        if (!(glyph[gy]! & (1 << (4 - gx)))) continue;
        for (let sy = 0; sy < 2; sy += 1) for (let sx = 0; sx < 2; sx += 1) {
          const offset = ((canvas.legend.y + 8 + row * 22 + gy * 2 + sy) * canvas.width + 8 + column * 12 + gx * 2 + sx) * 4;
          data[offset] = color[0]; data[offset + 1] = color[1]; data[offset + 2] = color[2]; data[offset + 3] = color[3];
        }
      }
    }
  }
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

function paintTarget(data: Buffer, width: number, height: number, x: number, y: number, stride = width): void {
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
      const offset = (py * stride + px) * 4;
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
  const label = `PHONE PX: X=${x} Y=${y}`;
  const originalCanvas = captionCanvas(width, height, label);
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
    // Copy straight into the annotated canvas, avoiding a third full-size raster.
    // The source stays anchored at (0,0); the legend never covers phone pixels.
    data = Buffer.alloc(originalCanvas.width * originalCanvas.height * 4, Buffer.from(BLACK));
    for (let row = 0; row < height; row += 1) {
      data.set(decoded.data.subarray(row * width * 4, (row + 1) * width * 4), row * originalCanvas.width * 4);
    }
  } catch (cause) {
    invalid("image validation or decoding failed", cause);
  }
  paintTarget(data, width, height, x, y, originalCanvas.width);
  const cropWidth = Math.min(CROP_SIZE, width), cropHeight = Math.min(CROP_SIZE, height);
  const cropX = Math.max(0, Math.min(width - cropWidth, x - Math.floor(cropWidth / 2)));
  const cropY = Math.max(0, Math.min(height - cropHeight, y - Math.floor(cropHeight / 2)));
  const zoomWidth = cropWidth * ZOOM_SCALE, zoomHeight = cropHeight * ZOOM_SCALE;
  const zoomCanvas = captionCanvas(zoomWidth, zoomHeight, label);
  const zoom = Buffer.alloc(zoomCanvas.width * zoomCanvas.height * 4, Buffer.from(BLACK));
  for (let py = 0; py < zoomHeight; py += 1) {
    for (let px = 0; px < zoomWidth; px += 1) {
      const source = ((cropY + Math.floor(py / ZOOM_SCALE)) * originalCanvas.width + cropX + Math.floor(px / ZOOM_SCALE)) * 4;
      data.copy(zoom, (py * zoomCanvas.width + px) * 4, source, source + 4);
    }
  }
  paintCaption(data, originalCanvas, label); paintCaption(zoom, zoomCanvas, label);
  return { png: encodePng(originalCanvas.width, originalCanvas.height, data),
    zoomPng: encodePng(zoomCanvas.width, zoomCanvas.height, zoom),
    crop: { x: cropX, y: cropY, width: cropWidth, height: cropHeight, scale: ZOOM_SCALE }, simulatedTarget: true,
    annotation: { coordinateSpace: "originalPhonePixels", label, original: originalCanvas, zoom: zoomCanvas } };
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { PNG } from "pngjs";
import { JPEG_FIXTURE } from "./fixtures/jpeg.js";
import { MAX_SCREEN_FRAME_BYTES } from "./screen.js";
import { MAX_TARGET_PREVIEW_DIMENSION, MAX_TARGET_PREVIEW_PIXELS, renderTargetPreview } from "./target-preview.js";

function image(width: number, height: number): { png: Buffer; data: Buffer } {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = x % 251; data[offset + 1] = y % 251;
      data[offset + 2] = (x + y) % 251; data[offset + 3] = 255;
    }
  }
  const encoded = new PNG(); encoded.width = width; encoded.height = height; encoded.data = data;
  return { png: PNG.sync.write(encoded), data };
}

function chunk(type: string, data: Buffer): Buffer {
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length); output.write(type, 4, "ascii"); data.copy(output, 8);
  let crc = 0xffffffff;
  for (const byte of output.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
}

function interlacedPng(width: number, height: number, pixels: Buffer, inflateBomb = false): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6; header[12] = 1;
  const passes: Buffer[] = [];
  for (const [startX, startY, stepX, stepY] of [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
    [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const) {
    if (startX >= width || startY >= height) continue;
    for (let y = startY; y < height; y += stepY) {
      const row = Buffer.alloc(1 + Math.ceil((width - startX) / stepX) * 4);
      for (let x = startX, offset = 1; x < width; x += stepX, offset += 4) pixels.copy(row, offset, (y * width + x) * 4, (y * width + x) * 4 + 4);
      passes.push(row);
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(inflateBomb ? Buffer.alloc(1024 * 1024) : Buffer.concat(passes))), chunk("IEND", Buffer.alloc(0))]);
}

function pixel(data: Buffer, width: number, x: number, y: number): Buffer {
  const offset = (y * width + x) * 4;
  return data.subarray(offset, offset + 4);
}

test("target preview preserves the original PNG and center while marking a simulated target", () => {
  const source = image(300, 400), original = Buffer.from(source.png);
  const result = renderTargetPreview(source.png, "image/png", 300, 400, 180, 220);
  const full = PNG.sync.read(result.png), zoom = PNG.sync.read(result.zoomPng);
  assert.equal(result.simulatedTarget, true);
  assert.deepEqual({ width: full.width, height: full.height }, { width: 300, height: 400 });
  assert.deepEqual(result.crop, { x: 100, y: 140, width: 160, height: 160, scale: 2 });
  assert.deepEqual({ width: zoom.width, height: zoom.height }, { width: 320, height: 320 });
  assert.deepEqual(source.png, original);
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      assert.deepEqual(pixel(full.data, full.width, 180 + dx, 220 + dy), pixel(source.data, 300, 180 + dx, 220 + dy));
    }
  }
  assert.deepEqual(pixel(full.data, full.width, 180 + 10, 220), Buffer.from([0, 255, 255, 255]));
  assert.deepEqual(pixel(full.data, full.width, 180 + 18, 220 + 3), Buffer.from([255, 0, 255, 255]));
  assert.deepEqual(pixel(full.data, full.width, 2, 3), pixel(source.data, 300, 2, 3));
});

test("target preview zoom is exactly the same marked crop at 2x nearest-neighbor scale", () => {
  const source = image(260, 320);
  const result = renderTargetPreview(source.png, "image/png", 260, 320, 137, 157);
  const full = PNG.sync.read(result.png), zoom = PNG.sync.read(result.zoomPng);
  for (let y = 0; y < zoom.height; y += 1) {
    for (let x = 0; x < zoom.width; x += 1) {
      assert.deepEqual(pixel(zoom.data, zoom.width, x, y),
        pixel(full.data, full.width, result.crop.x + Math.floor(x / 2), result.crop.y + Math.floor(y / 2)));
    }
  }
  const targetZoomX = (137 - result.crop.x) * 2, targetZoomY = (157 - result.crop.y) * 2;
  assert.deepEqual(pixel(zoom.data, zoom.width, targetZoomX, targetZoomY), pixel(source.data, 260, 137, 157));
});

for (const [x, y] of [[0, 0], [199, 0], [0, 299], [199, 299]] as const) {
  test(`target preview clips marker and crop correctly at corner ${x},${y}`, () => {
    const source = image(200, 300);
    const result = renderTargetPreview(source.png, "image/png", 200, 300, x, y);
    const full = PNG.sync.read(result.png), zoom = PNG.sync.read(result.zoomPng);
    assert.deepEqual(result.crop, { x: x === 0 ? 0 : 40, y: y === 0 ? 0 : 140, width: 160, height: 160, scale: 2 });
    assert.deepEqual(pixel(full.data, full.width, x, y), pixel(source.data, 200, x, y));
    assert.deepEqual(pixel(zoom.data, zoom.width, (x - result.crop.x) * 2, (y - result.crop.y) * 2), pixel(source.data, 200, x, y));
  });
}

for (const [width, height, x, y] of [[1, 1, 0, 0], [7, 240, 6, 230], [240, 7, 230, 6], [15, 23, 7, 11]] as const) {
  test(`target preview supports narrow image ${width}x${height}`, () => {
    const source = image(width, height), original = Buffer.from(source.png);
    const result = renderTargetPreview(source.png, "image/png", width, height, x, y);
    const full = PNG.sync.read(result.png), zoom = PNG.sync.read(result.zoomPng);
    assert.equal(zoom.width, Math.min(width, 160) * 2);
    assert.equal(zoom.height, Math.min(height, 160) * 2);
    assert.deepEqual(pixel(full.data, width, x, y), pixel(source.data, width, x, y));
    assert.deepEqual(source.png, original);
  });
}

test("target preview accepts JPEG and returns two PNG images at declared original geometry", () => {
  const original = Buffer.from(JPEG_FIXTURE);
  const result = renderTargetPreview(JPEG_FIXTURE, "image/jpeg", 2, 3, 1, 2);
  const full = PNG.sync.read(result.png), zoom = PNG.sync.read(result.zoomPng);
  assert.deepEqual({ width: full.width, height: full.height }, { width: 2, height: 3 });
  assert.deepEqual({ width: zoom.width, height: zoom.height }, { width: 4, height: 6 });
  assert.deepEqual(result.crop, { x: 0, y: 0, width: 2, height: 3, scale: 2 });
  assert.deepEqual(JPEG_FIXTURE, original);
  assert.deepEqual(pixel(zoom.data, zoom.width, 2, 4), pixel(full.data, full.width, 1, 2));
});

test("target preview rejects mismatched MIME, dimensions and malformed image bytes", () => {
  const source = image(20, 30).png;
  assert.throws(() => renderTargetPreview(source, "image/jpeg", 20, 30, 5, 5), /validation or decoding failed/u);
  assert.throws(() => renderTargetPreview(JPEG_FIXTURE, "image/png", 2, 3, 1, 1), /validation or decoding failed/u);
  assert.throws(() => renderTargetPreview(source, "image/png", 30, 20, 5, 5), /validation or decoding failed/u);
  assert.throws(() => renderTargetPreview(Buffer.from("not an image"), "image/png", 20, 30, 5, 5), /validation or decoding failed/u);
  assert.throws(() => renderTargetPreview(source.subarray(0, -5), "image/png", 20, 30, 5, 5), /validation or decoding failed/u);
  assert.throws(() => renderTargetPreview(source, "image/gif" as "image/png", 20, 30, 5, 5), /only JPEG and PNG/u);
});

test("target preview rejects invalid coordinates and geometry before decoding", () => {
  const source = image(20, 30).png;
  for (const [width, height, x, y] of [[0, 30, 0, 0], [-1, 30, 0, 0], [20.1, 30, 0, 0], [20, NaN, 0, 0],
    [Infinity, 30, 0, 0], [Number.MAX_SAFE_INTEGER + 1, 30, 0, 0], [MAX_TARGET_PREVIEW_DIMENSION + 1, 1, 0, 0],
    [8192, 8192, 0, 0], [20, 30, -1, 0], [20, 30, 20, 0], [20, 30, 0, 30], [20, 30, 0.1, 2], [20, 30, NaN, 2],
    [20, 30, 2, Infinity]] as const) {
    assert.throws(() => renderTargetPreview(source, "image/png", width, height, x, y), /dimensions|coordinates/u);
  }
  assert.equal(MAX_TARGET_PREVIEW_PIXELS, 16 * 1024 * 1024);
});

test("target preview rejects empty, non-buffer and oversized encoded inputs", () => {
  assert.throws(() => renderTargetPreview(Buffer.alloc(0), "image/png", 1, 1, 0, 0), /encoded image/u);
  assert.throws(() => renderTargetPreview(new Uint8Array([1]) as Buffer, "image/png", 1, 1, 0, 0), /encoded image/u);
  assert.throws(() => renderTargetPreview(Buffer.alloc(MAX_SCREEN_FRAME_BYTES + 1), "image/png", 1, 1, 0, 0), /encoded image/u);
});

test("target preview rejects oversized encoded PNG dimensions before decoding", () => {
  const source = image(1, 1).png;
  source.writeUInt32BE(8192, 16); source.writeUInt32BE(8192, 20);
  assert.throws(() => renderTargetPreview(source, "image/png", 8192, 8192, 0, 0), /dimensions/u);
  assert.throws(() => renderTargetPreview(source, "image/png", 1, 1, 0, 0), /validation or decoding failed/u);
});

test("target preview supports valid Adam7 PNG pixels and preserves the center", () => {
  const source = image(43, 51);
  const png = interlacedPng(43, 51, source.data), original = Buffer.from(png);
  const result = renderTargetPreview(png, "image/png", 43, 51, 22, 25);
  const full = PNG.sync.read(result.png);
  assert.deepEqual(pixel(full.data, full.width, 22, 25), pixel(source.data, 43, 22, 25));
  assert.deepEqual(pixel(full.data, full.width, 2, 2), pixel(source.data, 43, 2, 2));
  assert.deepEqual(png, original);
});

test("target preview rejects interlaced PNG inflation beyond the declared pixel buffer", () => {
  const png = interlacedPng(1, 1, Buffer.from([1, 2, 3, 255]), true), original = Buffer.from(png);
  assert.throws(() => renderTargetPreview(png, "image/png", 1, 1, 0, 0), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /validation or decoding failed/u);
    assert.ok(error.cause instanceof Error);
    assert.equal((error.cause as Error & { code?: string }).code, "ERR_BUFFER_TOO_LARGE");
    return true;
  });
  assert.deepEqual(png, original);
});

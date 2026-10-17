import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Optional rendered-screen verification, using jsqr@1.4.0 supplied as an
// explicit local tool path. It does not add a firmware/runtime dependency.
const [decoderPath, outputPath, expectedUrl, ...images] = process.argv.slice(2);
if (!decoderPath || !outputPath || !expectedUrl || !images.length) {
  throw new Error("Usage: node test_qdd_qr.mjs <jsQR.js> <result.json> <expectedUrl> <screen.ppm>...");
}
const decoder = (await import(pathToFileURL(resolve(decoderPath)).href)).default;
const results = [];
for (const path of images) {
  const bytes = await readFile(path);
  const header = /^P6\n(\d+) (\d+)\n255\n/u.exec(bytes.subarray(0, 80).toString("ascii"));
  assert.ok(header, "Host renderer must produce a binary RGB PPM image.");
  const width = Number(header[1]), height = Number(header[2]);
  assert.equal(bytes.length, header[0].length + width * height * 3);
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    const source = header[0].length + index * 3, target = index * 4;
    pixels[target] = bytes[source]; pixels[target + 1] = bytes[source + 1];
    pixels[target + 2] = bytes[source + 2]; pixels[target + 3] = 255;
  }
  const decoded = decoder(pixels, width, height);
  assert.ok(decoded, `No QR code found in the actual LCD render: ${path}`);
  assert.equal(decoded.data, expectedUrl);
  results.push({ path, width, height, decodedUrl: decoded.data, corners: decoded.location });
}
const evidence = { result: "PASS", decoder: "jsqr@1.4.0", expectedUrl, images: results };
await writeFile(outputPath, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence));

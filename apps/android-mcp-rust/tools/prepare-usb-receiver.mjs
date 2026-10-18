import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transform, version } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const repo = resolve(root, "../..");
export const SOURCE_PATHS = ["assets/usb-receiver/index.html", "assets/usb-receiver/receiver.css", "assets/usb-receiver/receiver.js", "tools/prepare-usb-receiver.mjs", "tools/test-usb-receiver.mjs"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function auditHtml(html) {
  if (/<(?:base|iframe|object|embed|link)\b/i.test(html) || /<script\b[^>]*\bsrc\s*=/i.test(html)) throw new Error("External embedded content is forbidden.");
  if (/(?:\bfetch\s*\(|XMLHttpRequest|WebSocket|\bWorker\s*\(|\bimport\s*\(|\bimport\s+.*?\bfrom\b|@import|\burl\s*\()/i.test(html)) throw new Error("Network/runtime import is forbidden.");
  const hrefs = [...html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
  if (hrefs.length !== 1 || hrefs[0] !== "/qdd-usb-receiver.html") throw new Error("Only the fixed same-origin offline attachment link is permitted.");
  if (html.includes("__QDD_USB_") || !html.includes("connect-src 'none'") || !html.includes("设备USB接收.html")) throw new Error("Incomplete standalone page.");
}
export async function prepareUsbReceiver(output = resolve(root, "build/usb-browser/v55")) {
  if (version !== "0.28.2") throw new Error("Use the existing pinned esbuild 0.28.2.");
  const inputs = [];
  for (const path of SOURCE_PATHS) {
    const bytes = await readFile(join(root, path));
    inputs.push({ path: `apps/android-mcp-rust/${path}`, bytes: bytes.length, sha256: hash(bytes) });
  }
  const template = await readFile(join(root, SOURCE_PATHS[0]), "utf8");
  const css = (await transform(await readFile(join(root, SOURCE_PATHS[1]), "utf8"), { loader: "css", minify: true, charset: "utf8" })).code.trim();
  const js = (await transform(await readFile(join(root, SOURCE_PATHS[2]), "utf8"), { loader: "js", format: "iife", globalName: "QddUsbReceiver", minify: true, charset: "utf8", target: "chrome100" })).code.trim();
  for (const token of ["__QDD_USB_CSS__", "__QDD_USB_JS__"]) if (template.split(token).length !== 2) throw new Error("Standalone template token is not unique.");
  const html = template.replace("__QDD_USB_CSS__", () => css).replace("__QDD_USB_JS__", () => js);
  auditHtml(html); const bytes = Buffer.from(html, "utf8");
  if (bytes.length > 128 * 1024) throw new Error("Receiver HTML exceeds 128KiB.");
  const manifest = { schemaVersion: 1, platform: "browser", protocol: "QDDDRV/1", html: "设备USB接收.html", bytes: bytes.length, sha256: hash(bytes), selfContained: true,
    sourceInputs: inputs, minifier: { name: "esbuild", version, charset: "utf8" },
    boundary: "No real USB/device operation or browser compatibility acceptance is performed by this build; ordinary HTTP requires saving the HTML and opening locally." };
  await mkdir(output, { recursive: true });
  await writeFile(join(output, manifest.html), bytes);
  await writeFile(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { bytes, manifest };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) throw new Error("This scoped builder has no arbitrary input/output arguments.");
  const result = await prepareUsbReceiver();
  console.log(JSON.stringify(result.manifest, null, 2));
}

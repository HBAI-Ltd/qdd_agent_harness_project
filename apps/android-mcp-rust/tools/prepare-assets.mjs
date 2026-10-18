import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transform, version } from "esbuild";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const ASSET_NAMES = ["operator.html", "operator.css", "operator.js", "remote-channel.js", "screen-channel.js", "settings.html", "tools.json"];
export const OPTIONS = Object.freeze({ minify: true, charset: "utf8", target: "es2022", legalComments: "none" });
const structuralTags = new Set(["!doctype", "html", "head", "body", "main", "header", "footer", "section", "aside", "div", "p", "h1", "h2", "details", "form", "script", "style", "meta", "link"]);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function tagEnd(source, start) {
  let quote;
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index];
    if (quote) { if (char === quote) quote = undefined; }
    else if (char === "\"" || char === "'") quote = char;
    else if (char === ">") return index + 1;
  }
  throw new Error("Unterminated HTML tag.");
}

// Only structural indentation is removed. Text, attributes and whitespace in
// pre/textarea remain byte-for-byte; JS and CSS are handled by esbuild's parser.
export async function minifyHtml(source) {
  const tokens = [], lower = source.replace(/[A-Z]/g, (char) => char.toLowerCase());
  let cursor = 0;
  while (cursor < source.length) {
    if (source.startsWith("<!--", cursor)) {
      const end = source.indexOf("-->", cursor + 4);
      if (end < 0) throw new Error("Unterminated HTML comment.");
      tokens.push({ text: source.slice(cursor, end + 3) }); cursor = end + 3; continue;
    }
    if (source[cursor] !== "<") {
      const end = source.indexOf("<", cursor);
      tokens.push({ text: source.slice(cursor, end < 0 ? source.length : end), whitespace: true });
      cursor = end < 0 ? source.length : end; continue;
    }
    const end = tagEnd(source, cursor), text = source.slice(cursor, end);
    const name = /^<\/?\s*(!doctype|[a-z][a-z0-9-]*)\b/i.exec(text)?.[1].toLowerCase();
    if (!name) throw new Error("Unexpected HTML tag; keep this source explicit.");
    tokens.push({ text, name }); cursor = end;
    if (!text.startsWith("</") && ["script", "style", "pre", "textarea"].includes(name)) {
      let close = lower.indexOf(`</${name}`, cursor);
      while (close >= 0 && !/^[\s>]/.test(source[close + name.length + 2] ?? "")) close = lower.indexOf(`</${name}`, close + 2);
      if (close < 0) throw new Error(`Missing ${name} end tag.`);
      const body = source.slice(cursor, close);
      const executableScript = name === "script" && !/\bsrc\s*=/i.test(text) && !/\btype\s*=/i.test(text);
      const code = name === "style" || executableScript
        ? (await transform(body, { ...OPTIONS, loader: name === "style" ? "css" : "js" })).code.trim()
        : body;
      if ((name === "script" || name === "style") && code.toLowerCase().includes(`</${name}`)) throw new Error(`Unsafe inline ${name} terminator.`);
      tokens.push({ text: code }); cursor = close;
    }
  }
  return tokens.map((token, index) => token.whitespace && /^[\t\r\n ]+$/.test(token.text) && /[\r\n]/.test(token.text)
    && structuralTags.has(tokens[index - 1]?.name) && structuralTags.has(tokens[index + 1]?.name) ? "" : token.text).join("");
}

async function walk(root, directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await walk(root, name));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`Unsupported linked build input: ${name}`);
  }
  return files;
}

export function buildId(inputs) {
  let hash = 0xcbf29ce484222325n;
  for (const [name, bytes] of [...inputs].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    for (const byte of Buffer.concat([Buffer.from(name), bytes])) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `rust-${hash.toString(16).padStart(16, "0")}`;
}

export async function prepareAssets(root = ROOT) {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (version !== packageJson.devDependencies.esbuild) throw new Error(`Install pinned esbuild ${packageJson.devDependencies.esbuild}; found ${version}.`);
  const assets = new Map(), listing = [];
  for (const name of ASSET_NAMES) {
    const source = await readFile(join(root, "assets", name)), text = source.toString("utf8");
    const generated = name.endsWith(".html") ? await minifyHtml(text)
      : name.endsWith(".json") ? JSON.stringify(JSON.parse(text))
      : (await transform(text, { ...OPTIONS, loader: name.endsWith(".css") ? "css" : "js" })).code.trim();
    const bytes = Buffer.from(generated);
    if (name === "settings.html" && ["__QDD_SETTINGS_DATA__", "__QDD_SAVE_PATH__", "__QDD_DISCOVER_PATH__"].some((token) => text.split(token).length !== 2 || generated.split(token).length !== 2)) {
      throw new Error("Settings placeholders must each occur exactly once before and after minification.");
    }
    assets.set(name, bytes);
    listing.push({ path: `assets/${name}`, sourceBytes: source.length, sourceSha256: sha(source), bytes: bytes.length, sha256: sha(bytes) });
  }
  const manifest = { schemaVersion: 1, pipeline: "esbuild-and-structural-html-v1", minifier: { name: "esbuild", version, options: OPTIONS }, assets: listing };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const sources = [...await walk(root, "src"), ...await walk(root, "assets"), "Cargo.toml", "Cargo.lock", "build.rs", "package.json", "tools/prepare-assets.mjs"].sort();
  const inputs = new Map(), identityInputs = [];
  for (const name of sources) {
    const bytes = await readFile(join(root, name));
    inputs.set(name, bytes); identityInputs.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
  }
  inputs.set("@generated/asset-manifest.json", manifestBytes);
  for (const [name, bytes] of assets) inputs.set(`@generated/assets/${name}`, bytes);
  return { assets, manifest, manifestBytes, identityInputs, buildId: buildId(inputs) };
}

export async function writeAssets(output, root = ROOT) {
  const directory = resolve(output);
  if (directory === resolve(root) || directory === resolve(root, "assets") || directory === resolve(root, "src")) throw new Error("Generated assets require an independent output directory.");
  const result = await prepareAssets(root);
  await mkdir(join(directory, "assets"), { recursive: true });
  for (const [name, bytes] of result.assets) await writeFile(join(directory, "assets", name), bytes);
  await writeFile(join(directory, "asset-manifest.json"), result.manifestBytes);
  await writeFile(join(directory, "build-id.txt"), result.buildId);
  await writeFile(join(directory, "asset-build.json"), `${JSON.stringify({ buildId: result.buildId, identityInputs: result.identityInputs }, null, 2)}\n`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out-dir") throw new Error("Usage: node tools/prepare-assets.mjs --out-dir <generated-directory>");
  const result = await writeAssets(args[1]);
  console.log(JSON.stringify({ buildId: result.buildId, minifier: result.manifest.minifier, assets: result.manifest.assets }));
}

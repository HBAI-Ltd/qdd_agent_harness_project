import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { promisify } from "node:util";
import { inspectPe } from "./inspect-pe.mjs";
import { prepareAssets } from "./prepare-assets.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.env.QDD_RUST_OUTPUT_DIR ? resolve(process.env.QDD_RUST_OUTPUT_DIR) : join(root, "build", "windows");
const targetDirectory = process.env.CARGO_TARGET_DIR ? resolve(root, process.env.CARGO_TARGET_DIR) : join(root, "build", "cargo");
const release = join(targetDirectory, "release", process.platform === "win32" ? "qdd-android-mcp-rust.exe" : "qdd-android-mcp-rust");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("cargo", args, { cwd: root, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Cargo exited ${code}.`)));
  });
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// A single UTF-8-named entry, with actual ZIP framing included in the size.
function zip(name, bytes) {
  const filename = Buffer.from(name);
  const compressed = deflateRawSync(bytes, { level: 9 });
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  for (const [header, base] of [[local, 0], [central, 0]]) {
    const shift = header === central ? 2 : 0;
    header.writeUInt16LE(20, base + 4 + shift);
    header.writeUInt16LE(0x800, base + 6 + shift);
    header.writeUInt16LE(8, base + 8 + shift);
    header.writeUInt32LE(crc32(bytes), base + 14 + shift);
    header.writeUInt32LE(compressed.length, base + 18 + shift);
    header.writeUInt32LE(bytes.length, base + 22 + shift);
    header.writeUInt16LE(filename.length, base + 26 + shift);
  }
  local.writeUInt32LE(0x04034b50, 0);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4);
  local.writeUInt16LE(33, 12); central.writeUInt16LE(33, 14);
  const body = Buffer.concat([local, filename, compressed]);
  const directory = Buffer.concat([central, filename]);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, directory, end]);
}
async function size() {
  const bytes = await readFile(release);
  const executable = process.platform === "win32" ? "设备操作台.exe" : "qdd-android-mcp-rust";
  const archive = zip(executable, bytes);
  const baseline = JSON.parse(await readFile(join(root, "docs", "typescript-baseline.json"), "utf8"));
  const { stdout } = await promisify(execFile)(release, ["--self-test"], { windowsHide: true });
  const selfTest = JSON.parse(stdout);
  const prepared = await prepareAssets(root);
  if (prepared.buildId !== selfTest.buildId) throw new Error("Current source/minifier/generated assets do not match the release EXE; rebuild before packaging.");
  const embeddedAssets = prepared.manifest.assets.map((asset) => ({ ...asset,
    ...(!["assets/settings.html", "assets/tools.json"].includes(asset.path)
      ? { httpPath: asset.path === "assets/operator.html" ? "/" : `/${asset.path.slice(7)}` } : {}) }));
  const manifest = {
    builtAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`,
    buildId: selfTest.buildId, runtime: "rust", assetCompression: prepared.manifest.minifier, embeddedAssets,
    ...(process.platform === "win32" ? { pe: inspectPe(bytes) } : {}),
    executable, bytes: bytes.length, sha256: sha(bytes), zipBytes: archive.length, zipSha256: sha(archive),
    originalTypeScriptBaseline: baseline.capturedAt,
    cargoLockSha256: sha(await readFile(join(root, "Cargo.lock"))),
    flashBudgets: {
      currentAppHeadroomBytes: 1414176, currentAssetsPartitionBytes: 2097152,
      driverAssetsHeaderBytes: 4096,
      rawFitsCurrentAppHeadroom: bytes.length <= 1414176,
      rawFitsAssetsPartition: bytes.length <= 2097152,
      rawFitsAssetsWithHeader: bytes.length + 4096 <= 2097152,
      remainingDriverAssetsBytes: 2097152 - 4096 - bytes.length,
      zipFitsAssetsPartition: archive.length <= 2097152,
      note: "Measured v39 partition capacities, not authorization to write. Assets contents and download metadata/firmware growth must be budgeted separately.",
    },
  };
  await mkdir(output, { recursive: true });
  await copyFile(release, join(output, executable));
  await writeFile(join(output, "设备操作台.zip"), archive);
  await writeFile(join(output, "asset-manifest.json"), prepared.manifestBytes);
  await writeFile(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest, null, 2));
}
const command = process.argv[2] ?? "build";
try {
  if (command === "build") { await run(["build", "--release", "--locked"]); await size(); }
  else if (command === "size") await size();
  else if (command === "check") await run(["check", "--locked", "--all-targets"]);
  else if (command === "test") await run(["test", "--locked", ...process.argv.slice(3)]);
  else if (command === "run") await run(["run", "--locked", "--", ...process.argv.slice(3)]);
  else if (command === "clean") await run(["clean"]);
  else throw new Error(`Unknown Cargo command: ${command}`);
} catch (error) {
  console.error(error.message); process.exitCode = 1;
}

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzipSync, gunzipSync } from "node:zlib";
import { inspectPe } from "../inspect-pe.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL("./", import.meta.url));
const output = resolve(root, "../../build/usb-driver/v52");
const gcc = process.env.QDD_USB_CC || "gcc";
const executable = "设备USB下载器.exe";
const sources = ["windows.c", "protocol.c", "protocol.h", "transfer.c", "transfer.h", "hardware.c", "hardware.h", "build.mjs", "test-protocol.c", "test-transfer.c", "test-hardware.c", "README.md", "../inspect-pe.mjs"];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
await mkdir(output, { recursive: true });
const hostTests = [];
for (const [name, inputs] of [
  ["protocol", ["test-protocol.c", "protocol.c"]],
  ["transfer", ["test-transfer.c", "transfer.c", "protocol.c"]],
  ["hardware", ["test-hardware.c", "hardware.c"]],
]) {
  const testExecutable = join(output, `test-${name}.exe`);
  await run(gcc, ["-std=c11", "-Wall", "-Wextra", "-Werror", ...inputs, "-o", testExecutable], { cwd: root, windowsHide: true });
  const tested = await run(testExecutable, [], { windowsHide: true, timeout: 10000 });
  await writeFile(join(output, `test-${name}.log`), tested.stdout + tested.stderr);
  hostTests.push({ name, status: "pass", output: tested.stdout.trim() });
}
const args = ["-std=c11", "-Os", "-Wall", "-Wextra", "-Werror", "-fno-builtin", "-fno-ident",
  "-ffunction-sections", "-fno-asynchronous-unwind-tables", "-fno-unwind-tables",
  "-fno-stack-protector", "-nostdlib", "-Wl,--gc-sections", "-Wl,--no-insert-timestamp",
  "-Wl,-e,usb_main", "-Wl,--subsystem,console", "-s", "windows.c", "protocol.c", "transfer.c", "hardware.c",
  "-o", join(output, executable), "-lkernel32", "-lsetupapi", "-lbcrypt", "-ladvapi32", "-lcomdlg32", "-lshell32", "-luser32", "-luuid", "-lgcc"];
const compiled = await run(gcc, args, { cwd: root, windowsHide: true });
if (compiled.stderr) process.stderr.write(compiled.stderr);
const bytes = await readFile(join(output, executable));
if (bytes.length > 128 * 1024) throw new Error("USB helper exceeds the agreed 128KiB limit.");
const pe = inspectPe(bytes);
const allowed = new Set(["kernel32.dll", "setupapi.dll", "bcrypt.dll", "advapi32.dll", "comdlg32.dll", "shell32.dll", "user32.dll"]);
if (pe.imports.some((name) => !allowed.has(name.toLowerCase()))) throw new Error(`Non-system/runtime import: ${pe.imports.join(", ")}`);
const selfTest = await run(join(output, executable), ["--self-test"], { windowsHide: true, env: { ...process.env, PATH: "", Path: "" }, timeout: 10000 });
const self = JSON.parse(selfTest.stdout);
if (self.status !== "ok" || self.protocol !== "QDDDRV/1" || self.selfTest !== true || self.noOverwrite !== true || self.atomicFileFixture !== true) throw new Error("Native no-device BCrypt/protocol/file self-test failed.");
const gzip = gzipSync(bytes, { level: 9 });
if (!gunzipSync(gzip).equals(bytes)) throw new Error("Helper gzip roundtrip differs.");
await writeFile(join(output, `${executable}.gz`), gzip);
const inputs = [];
for (const path of sources) {
  const contents = await readFile(join(root, path)); inputs.push({ path: path === "../inspect-pe.mjs" ? "tools/inspect-pe.mjs" : `tools/usb-driver/${path}`, bytes: contents.length, sha256: sha(contents) });
}
const toolchain = (await run(gcc, ["--version"], { windowsHide: true })).stdout.split(/\r?\n/)[0];
const manifest = { platform: "win32-x64", executable, bytes: bytes.length, sha256: sha(bytes), protocol: "QDDDRV/1",
  gzip: { file: `${executable}.gz`, bytes: gzip.length, sha256: sha(gzip), exactRoundTrip: true },
  toolchain, arguments: args, sourceInputs: inputs, pe, hostTests, selfTest: { ...self, realDeviceInput: false,
    realBCryptObjectDoubleCleanup: true, emptyPath: true },
  boundary: "No USB/device transfer performed by this build. Helper uses only Win32 system DLLs, does not run the main EXE or change an existing service." };
await writeFile(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));

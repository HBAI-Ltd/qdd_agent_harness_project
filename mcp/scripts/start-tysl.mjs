import { spawn } from "node:child_process";
import { access, mkdir, open, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.TYSL_PORT || 8790);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid TYSL_PORT.");
const url = `http://127.0.0.1:${port}`;
async function health() {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}
const current = await health();
if (current && current.service !== "tysl") throw new Error("This port belongs to another service.");
if (!current) {
  const ffmpeg = process.env.TYSL_FFMPEG || path.join(root, "tools/node_modules/ffmpeg-static/ffmpeg.exe");
  await access(ffmpeg).catch(() => { throw new Error("FFmpeg is missing. Run npm run mcp:setup first."); });
  const state = path.join(root, ".local");
  await mkdir(state, { recursive: true });
  const out = await open(path.join(state, "tysl-service.out.log"), "a");
  const err = await open(path.join(state, "tysl-service.err.log"), "a");
  let child;
  try {
    child = spawn(process.execPath, [path.join(root, "apps/tysl-console/local/server.mjs")], {
      cwd: root, detached: true, windowsHide: true, stdio: ["ignore", out.fd, err.fd],
    });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    await writeFile(path.join(state, "tysl-service.pid"), `${child.pid}\n`);
    child.unref();
  } finally { await out.close(); await err.close(); }
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await health())?.service === "tysl") { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error("TYSL failed to start. See mcp/.local/tysl-service.err.log.");
}
console.log(`TYSL: ${url}/  MCP: ${url}/mcp`);

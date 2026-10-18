import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { getAsset, isSea } from "node:sea";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeDesktopConfig } from "./desktop-config.mjs";
import { configurationPage } from "./desktop-page.mjs";
import { discoverBoards } from "./desktop-discovery.mjs";
import { deviceBaseUrl, privateRequest } from "./desktop-network.mjs";

const buildId = __QDD_BUILD_ID__;
const runtimeVersion = __QDD_RUNTIME_VERSION__;
const localRoot = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "QDDAndroid");
const cacheRoot = join(localRoot || tmpdir(), "runtime", buildId);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let pendingSetup;

function unpackRuntime() {
  if (!isSea()) throw new Error("请运行构建后的设备操作台.exe。");
  const files = JSON.parse(getAsset("runtime-manifest.json", "utf8"));
  for (const file of files) {
    if (!/^(?:assets\/[a-z.-]+|native\/serialport\.node)$/.test(file.path)) throw new Error("应用资源清单不完整。");
    const destination = join(cacheRoot, file.path);
    if (existsSync(destination) && hash(readFileSync(destination)) === file.sha256) continue;
    const bytes = Buffer.from(getAsset(file.path));
    if (hash(bytes) !== file.sha256) throw new Error("应用资源校验失败，请重新下载 EXE。");
    mkdirSync(dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.tmp`;
    writeFileSync(temporary, bytes);
    try { renameSync(temporary, destination); }
    catch (error) {
      if (!existsSync(destination) || hash(readFileSync(destination)) !== file.sha256) throw error;
      unlinkSync(temporary);
    }
  }
  process.env.QDD_ANDROID_NATIVE_PATH = join(cacheRoot, "native", "serialport.node");
  process.env.QDD_ANDROID_BUILD_ID = buildId;
  globalThis.__QDD_MODULE_URL__ = pathToFileURL(join(cacheRoot, "dist", "index.js")).href;
  return files;
}

async function openBrowser(url, disabled = false) {
  if (disabled) return;
  await new Promise((resolveOpen) => {
    const child = spawn(join(process.env.SystemRoot || "C:\\Windows", "System32", "rundll32.exe"), ["url.dll,FileProtocolHandler", url], { stdio: "ignore", windowsHide: true });
    child.once("error", () => { console.error(`请在浏览器打开 ${url}`); resolveOpen(); });
    child.once("exit", () => resolveOpen());
  });
}

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(600), cache: "no-store", redirect: "error" });
    if (!response.ok) return undefined;
    return await response.json();
  } catch { return undefined; }
}

function saveConfiguration(path, config) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

async function readConfiguration(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 8192) throw new Error("配置内容过长。"); chunks.push(chunk); }
  return normalizeDesktopConfig(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

async function serveDiscovery(request, response, defaults) {
  if (request.method !== "GET") { response.writeHead(405); response.end(); return; }
  const controller = new AbortController();
  response.once("close", () => controller.abort());
  const hints = [defaults.ESP_SETUP_URL, defaults.ESP_HOST ? `http://${defaults.ESP_HOST}:3334` : ""].filter(Boolean);
  const boards = await discoverBoards({ hints, signal: controller.signal });
  if (!response.destroyed) { response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify({ boards })); }
}

function installSettings(path, config, configHash, url, restart) {
  let restarting = false;
  globalThis.__QDD_DESKTOP_SETTINGS__ = async (request, response) => {
    if (request.url === "/desktop/discover") { await serveDiscovery(request, response, config); return; }
    if (request.method === "GET") {
      let ports = [];
      try { ports = (await (await import("serialport")).SerialPort.list()).map((port) => port.path); } catch { /* Last saved port remains selectable. */ }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(configurationPage(config, ports, "/desktop/settings", "", "/desktop/discover")); return;
    }
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    try {
      if (restarting) throw new Error("连接设置正在应用，请稍候。");
      const next = await readConfiguration(request), nextHash = hash(JSON.stringify(next));
      if (restarting) throw new Error("连接设置正在应用，请稍候。");
      saveConfiguration(path, next);
      if (nextHash !== configHash) {
        restarting = true;
        response.once("finish", () => { void restart(next).catch(failDesktop); });
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ url: `${deviceBaseUrl(next.ANDROID_MCP_PORT)}/`, restart: nextHash !== configHash, configHash: nextHash }));
    } catch (error) {
      // A rejected concurrent request does not own the pending restart claim.
      response.writeHead(400, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: error.message }));
    }
  };
}

async function configure(path, defaults, noBrowser, problem = "") {
  let complete;
  const selected = new Promise((resolveConfig) => { complete = resolveConfig; });
  let ports = [];
  try { ports = (await (await import("serialport")).SerialPort.list()).map((port) => port.path); } catch { /* Manual COM5 remains available. */ }
  let waitingResponse;
  const server = createServer(async (request, response) => {
    if (!privateRequest(request)) { response.writeHead(403); response.end(); return; }
    if (request.url === "/discover") { await serveDiscovery(request, response, defaults); return; }
    if (request.url === "/" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(configurationPage(defaults, ports, "/config", problem)); return;
    }
    if (request.url !== "/config" || request.method !== "POST") { response.writeHead(404); response.end(); return; }
    try {
      const busy = () => {
        if (!waitingResponse) return false;
        response.writeHead(409, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: "正在启动，请稍候。" })); return true;
      };
      if (busy()) return;
      const config = await readConfiguration(request);
      if (busy()) return;
      saveConfiguration(path, config);
      waitingResponse = response;
      complete(config);
    } catch (error) { response.writeHead(400, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "0.0.0.0", resolveListen); });
  const address = server.address();
  const setupUrl = `${deviceBaseUrl(address.port)}/`;
  console.error(`连接设置：${setupUrl}`);
  await openBrowser(setupUrl, noBrowser);
  let finished = false;
  return { config: await selected, finish(url, error) {
    if (finished) return;
    finished = true;
    waitingResponse?.once("finish", () => { server.close(); server.closeAllConnections(); });
    waitingResponse?.writeHead(error ? 500 : 200, { "Content-Type": "application/json" });
    waitingResponse?.end(JSON.stringify(error ? { error } : { url }));
  } };
}

async function main() {
  const { values } = parseArgs({ options: { stdio: { type: "boolean" }, "no-browser": { type: "boolean" },
    configure: { type: "boolean" }, config: { type: "string" }, port: { type: "string" }, "self-test": { type: "boolean" }, help: { type: "boolean", short: "h" } } });
  if (values.help) { console.log("设备操作台\n双击启动操作台。--configure 打开连接设置；--stdio 供 MCP 客户端启动；--no-browser 不打开浏览器；--self-test 检查内置资源与串口驱动。"); return; }
  const files = unpackRuntime();
  if (values["self-test"]) {
    const ports = await (await import("serialport")).SerialPort.list();
    console.log(JSON.stringify({ status: "ok", buildId, node: process.versions.node, arch: process.arch,
      embeddedAssets: files.map((file) => file.path), serialPorts: ports.map((port) => port.path) })); return;
  }
  const sidecar = join(dirname(process.execPath), "qdd-android.json");
  const path = values.config ? resolve(values.config) : existsSync(sidecar) ? sidecar : join(localRoot, "config.json");
  let config, defaults = {};
  if (existsSync(path)) {
    try { defaults = JSON.parse(readFileSync(path, "utf8")); config = normalizeDesktopConfig(defaults); }
    catch (error) { console.error(`需要更新连接设置：${error.message}`); }
  }
  let setup;
  if (!config || values.configure) {
    if (values.stdio) throw new Error("请先双击 EXE 设置手机和控制板连接，再让 MCP 客户端使用 --stdio。");
    setup = await configure(path, defaults, values["no-browser"]);
    pendingSetup = setup;
    config = setup.config;
  }
  if (values.port) config = normalizeDesktopConfig({ ...config, ANDROID_MCP_PORT: values.port });
  const configHash = hash(JSON.stringify(config));
  process.env.QDD_ANDROID_CONFIG_HASH = configHash;
  const port = Number(config.ANDROID_MCP_PORT), url = `${deviceBaseUrl(port)}/`;
  if (!values.stdio) {
    const existing = await health(port);
    if (existing?.status === "ok" && existing.name === "qdd-android-hid") {
      if (existing.runtimeVersion === runtimeVersion && existing.desktopBuildId === buildId && existing.desktopConfigHash === configHash) {
        setup?.finish(url);
        await openBrowser(url, Boolean(setup) || values["no-browser"]); return;
      }
      if (typeof existing.desktopBuildId !== "string") throw new Error("另一个版本的设备操作台仍在运行，请关闭它的服务窗口后重新打开 EXE。");
      const stopped = await fetch(`http://127.0.0.1:${port}/desktop/quit`, { method: "POST", signal: AbortSignal.timeout(3000) });
      if (!stopped.ok) throw new Error("旧版设备操作台未能退出，请关闭旧窗口后重新打开 EXE。");
      for (let count = 0; count < 30 && await health(port); count++) await delay(100);
      if (await health(port)) throw new Error("旧版设备操作台仍在关闭，请稍后再打开 EXE。");
    }
  }
  const { startService } = await import("../src/index.js");
  let service, stopping = false, setupShown = Boolean(setup), transition = Promise.resolve();
  const apply = async (next) => {
    if (stopping) return;
    await service?.close();
    service = undefined;
    for (;;) {
      const nextHash = hash(JSON.stringify(next));
      process.env.QDD_ANDROID_CONFIG_HASH = nextHash;
      for (const [key, value] of Object.entries(next)) process.env[key] = value;
      try {
        service = await startService({ transport: values.stdio ? "stdio" : "http", screenUrl: next.ANDROID_SCREEN_URL,
          ...(next.ANDROID_DEVICE_ID ? { deviceId: next.ANDROID_DEVICE_ID } : {}), port: Number(next.ANDROID_MCP_PORT),
          espHost: next.ESP_HOST, espPort: next.ESP_PORT, espTcpPort: Number(next.ESP_TCP_PORT), setupUrl: next.ESP_SETUP_URL });
        const nextUrl = `${deviceBaseUrl(next.ANDROID_MCP_PORT)}/`;
        if (stopping) { await service.close(); service = undefined; return; }
        if (!values.stdio) installSettings(path, next, nextHash, nextUrl, restart);
        pendingSetup?.finish(nextUrl); pendingSetup = undefined;
        return nextUrl;
      } catch (error) {
        if (values.stdio || error.code !== "EADDRINUSE") throw error;
        setupShown = true;
        pendingSetup?.finish(undefined, error.message); pendingSetup = undefined;
        pendingSetup = await configure(path, next, values["no-browser"], error.message);
        next = pendingSetup.config;
      }
    }
  };
  const restart = (next) => { transition = transition.then(() => apply(next)); return transition; };
  const stop = () => {
    stopping = true;
    void transition.catch(() => {}).then(() => service?.close()).finally(() => { process.exitCode = 0; });
  };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const activeUrl = await restart(config);
  if (stopping) return;
  if (values.stdio) { process.stdin.once("end", stop); return; }
  console.error(`操作台：${activeUrl}\nMCP：${new URL("mcp", activeUrl).href}\n保持本窗口打开。按 Ctrl+C 关闭服务并释放键鼠。`);
  await openBrowser(activeUrl, setupShown || values["no-browser"]);
}

function failDesktop(error) {
  const message = error instanceof Error ? error.message : String(error);
  pendingSetup?.finish(undefined, message);
  console.error(message);
  process.exitCode = 1;
  // Failed startup must not retain a half-open phone stream or setup listener.
  setTimeout(() => process.exit(1), 100);
}
main().catch(failDesktop);

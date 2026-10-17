#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { deviceBaseUrl } from "./desktop-network.mjs";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = resolve(appRoot, "../..");
const entry = join(appRoot, "dist", "index.js");
const PROTOCOL_VERSION = "2025-03-26";

async function configuration() {
  let fileEnv;
  try { fileEnv = parseEnv(await readFile(join(appRoot, ".env"), "utf8")); }
  catch { throw new Error("请先将 apps/android-mcp/.env.example 复制为 .env，填写手机投屏地址与控制板地址（Wi-Fi 或 USB 串口）。"); }
  return validateConfiguration(fileEnv);
}

export function validateConfiguration(fileEnv, environment = process.env) {
  const env = { ...fileEnv, ...environment };
  const screenUrl = (env.ANDROID_SCREEN_URL ?? "").trim();
  if (!screenUrl) throw new Error("请在 apps/android-mcp/.env 中填写手机 App 显示的 ANDROID_SCREEN_URL 局域网地址。");
  let endpoint;
  try { endpoint = new URL(screenUrl); } catch { /* Report configuration without exposing its value. */ }
  if (!endpoint || !["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error("ANDROID_SCREEN_URL 必须是手机 App 显示的 HTTP 或 HTTPS 地址，且不能包含账号密码。");
  }
  const port = Number(env.ANDROID_MCP_PORT ?? 8790);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("ANDROID_MCP_PORT 必须是 1 到 65535 之间的整数。");
  const espHost = (env.ESP_HOST ?? "").trim();
  if (espHost) {
    const octets = espHost.split(".").map(Number);
    const ipv = isIP(espHost);
    const privateIp = ipv === 4 && (octets[0] === 10 || octets[0] === 127
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168));
    const hostname = !ipv && !/^[\d.]+$/.test(espHost) && espHost.length <= 253
      && espHost.split(".").every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label));
    if (!privateIp && !hostname) throw new Error("ESP_HOST 请只填写控制板的局域网 IP 或主机名，不要包含 http://、端口或路径。");
  }
  const espTcpPort = String(env.ESP_TCP_PORT ?? 3333).trim();
  if (!/^\d+$/.test(espTcpPort) || Number(espTcpPort) < 1 || Number(espTcpPort) > 65535) {
    throw new Error("ESP_TCP_PORT 必须是 1 到 65535 之间的整数，默认 3333。");
  }
  env.ESP_HOST = espHost;
  env.ESP_TCP_PORT = espTcpPort;
  env.ANDROID_SCREEN_URL = screenUrl;
  return { env, port, baseUrl: deviceBaseUrl(port) };
}

// This probe only talks to the local MCP service. It never calls a device tool.
async function probe(config) {
  const probeUrl = `http://127.0.0.1:${config.port}`;
  let sessionId = "";
  let protocolVersion = PROTOCOL_VERSION;
  try {
    const health = await fetch(`${probeUrl}/health`, { signal: AbortSignal.timeout(1200), cache: "no-store", redirect: "error" });
    if (!health.ok) return false;
    const state = await health.json();
    if (state.status !== "ok" || state.name !== "qdd-android-hid") return false;
    if (state.runtimeVersion !== 9) {
      const error = new Error("电脑上的旧版服务还没关闭。请先关闭旧服务，再双击 start-android.cmd 启动直接点击画面的新版操作台。");
      error.code = "STALE_RUNTIME";
      throw error;
    }
    const response = await fetch(`${probeUrl}/mcp`, {
      method: "POST", signal: AbortSignal.timeout(2000), cache: "no-store", redirect: "error",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "qdd-local-launcher", version: "1.0.0" },
      } }),
    });
    sessionId = response.headers.get("mcp-session-id") ?? "";
    if (!response.ok || !sessionId) return false;
    const message = await response.json();
    if (message.jsonrpc !== "2.0" || message.id !== 1 || message.error || typeof message.result?.protocolVersion !== "string") return false;
    protocolVersion = message.result.protocolVersion;
    const initialized = await fetch(`${probeUrl}/mcp`, {
      method: "POST", signal: AbortSignal.timeout(2000), cache: "no-store", redirect: "error",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId, "MCP-Protocol-Version": protocolVersion },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    await initialized.body?.cancel();
    return initialized.ok;
  } catch (error) { if (error?.code === "STALE_RUNTIME") throw error; return false; }
  finally {
    if (sessionId) {
      // This probe never owns input; closing it must not interrupt another controller.
      try {
        const response = await fetch(`${probeUrl}/mcp`, {
          method: "DELETE", signal: AbortSignal.timeout(2000), cache: "no-store", redirect: "error",
          headers: { "Mcp-Session-Id": sessionId, "MCP-Protocol-Version": protocolVersion },
        });
        await response.body?.cancel();
      } catch { /* A stopped service cannot retain this setup connection. */ }
    }
  }
}

function childCompletion(child) {
  return new Promise((resolveExit, reject) => {
    child.once("error", () => reject(new Error("无法启动 Node.js 子进程，请检查本地 Node.js 安装。")));
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

async function buildIfNeeded(env) {
  if (existsSync(entry)) return;
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    ...(env.PATH ?? env.Path ?? "").split(delimiter).map((folder) => join(folder, "node_modules", "npm", "bin", "npm-cli.js")),
  ];
  const npmCli = candidates.find((candidate) => candidate && candidate.endsWith("npm-cli.js") && existsSync(candidate));
  if (!npmCli) throw new Error("未找到 npm CLI。请使用 Node.js 24+ 与 npm 11+，或先在仓库根目录运行 npm run build。");
  console.log("正在构建设备操作台…");
  const result = await childCompletion(spawn(process.execPath, [npmCli, "run", "build", "--workspace", "@qdd/android-mcp"], {
    cwd: repoRoot, env, stdio: "inherit",
  }));
  if (result.code !== 0 || !existsSync(entry)) throw new Error("本地服务构建失败，请检查上方构建输出。");
}

async function openBrowser(config, noBrowser) {
  if (noBrowser) return;
  if (process.platform !== "win32") {
    console.log(`请在浏览器打开 ${config.baseUrl}/，页面会自动连接本机服务。`);
    return;
  }
  try {
    const result = await childCompletion(spawn("rundll32.exe", ["url.dll,FileProtocolHandler", `${config.baseUrl}/`], {
      stdio: "ignore", windowsHide: false,
    }));
    if (result.code !== 0) throw new Error("Browser did not open.");
  } catch {
    console.log(`浏览器未能自动打开，请手动访问 ${config.baseUrl}/，页面会自动连接。`);
  }
}

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("启动器需要 Node.js 24 或更新版本。");
  let values;
  try {
    ({ values } = parseArgs({ options: { "no-browser": { type: "boolean", default: false }, help: { type: "boolean", short: "h" } } }));
  } catch { throw new Error("启动参数无效。支持 --no-browser 和 --help。"); }
  if (values.help) {
    console.log("用法：start-android.cmd [--no-browser]\n读取 apps/android-mcp/.env，启动或复用本地操作台。手机、控制板和电脑连接同一 Wi-Fi。\n填写 ANDROID_SCREEN_URL 和 ESP_HOST，控制板默认端口 3333；ESP_HOST 留空时仍可使用 USB 串口 ESP_PORT。\n--no-browser  仅启动服务，不打开浏览器。\n按 Ctrl+C 关闭本启动器启动的服务。点击画面进入远控，按 Esc 退出。");
    return;
  }
  const config = await configuration();
  await buildIfNeeded(config.env);
  if (await probe(config)) {
    console.log(`已复用本地服务：${config.baseUrl}/。点击画面进入远控，按 Esc 退出。`);
    await openBrowser(config, values["no-browser"]);
    return;
  }
  console.log("正在启动设备操作台…");
  const child = spawn(process.execPath, ["--enable-source-maps", entry, "--transport", "http", "--port", String(config.port)], {
    cwd: repoRoot, env: config.env, stdio: "inherit",
  });
  let exited = false;
  let stopping = false;
  const completion = childCompletion(child).finally(() => { exited = true; });
  // Record an early spawn error until the readiness loop can report it.
  void completion.catch(() => {});
  const stop = (signal) => {
    if (stopping || exited) return;
    stopping = true;
    console.log("正在关闭本地服务并释放键鼠…");
    // On Windows the inherited console delivers Ctrl+C to both processes;
    // forwarding SIGTERM here would bypass the child's graceful SIGINT handler.
    if (process.platform !== "win32" || signal !== "SIGINT") child.kill("SIGTERM");
  };
  const onInterrupt = () => stop("SIGINT");
  const onTerminate = () => stop("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    const deadline = Date.now() + 15000;
    let ready = false;
    while (!exited && !stopping && Date.now() < deadline) {
      if (await probe(config)) { ready = true; break; }
      await delay(250);
    }
    if (ready && !stopping && !exited) {
      console.log(`操作台已就绪：${config.baseUrl}/。点击画面进入远控，按 Esc 退出；Ctrl+C 关闭服务。`);
      await openBrowser(config, values["no-browser"]);
    } else if (!exited && !stopping) {
      console.error("本地服务尚未通过健康检查，请检查上方输出及 .env 配置；按 Ctrl+C 关闭。");
    }
    const result = await completion;
    if (!stopping && (!ready || result.code !== 0)) throw new Error("本地服务未能运行，请检查上方输出、配置和端口占用。");
    process.exitCode = stopping ? 0 : result.code ?? 0;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "本地操作台启动失败。");
    process.exitCode = 1;
  });
}

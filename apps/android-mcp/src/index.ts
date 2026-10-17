#!/usr/bin/env node
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ScreenClient } from "./screen.js";
import { LiveScreenSource } from "./live.js";
import { InputController } from "./input.js";
import { AndroidTools, createMcpServer } from "./mcp.js";
import { SerialHidBridge } from "./serial.js";
import { parseEspTcpPort, TcpHidBridge } from "./tcp.js";
import { startHttpMcp } from "./http.js";
import { boardSetupOrigin, startBoardRegistration } from "./onboarding.js";

const environmentFile = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(environmentFile)) loadEnvFile(environmentFile);

export interface ServiceOptions {
  transport: "stdio" | "http";
  screenUrl: string;
  deviceId?: string;
  port?: number;
  espHost?: string;
  espPort?: string;
  espTcpPort?: number;
  setupUrl?: string;
}
export interface AndroidService { url?: string; close(): Promise<void> }

/** One owned runtime; desktop configuration reloads close it before creating another. */
export async function startService(options: ServiceOptions): Promise<AndroidService> {
  const espHost = (options.espHost ?? "").trim();
  const setupUrl = options.setupUrl?.trim() ? boardSetupOrigin(options.setupUrl.trim()) : "";
  const tcpPort = parseEspTcpPort(options.espTcpPort ?? 3333);
  const bridge = espHost
    ? new TcpHidBridge({ host: espHost, port: tcpPort })
    : new SerialHidBridge({ path: options.espPort ?? "" });
  const input = new InputController(bridge, { width: 1, height: 1, rotation: 0 });
  const screen = new ScreenClient({ endpoint: options.screenUrl, ...(options.deviceId ? { deviceId: options.deviceId } : {}) });
  const liveScreen = new LiveScreenSource(screen);
  const tools = new AndroidTools(liveScreen, input);
  liveScreen.subscribe((capture) => { void tools.observeLive(capture).catch(() => {}); },
    () => { void tools.visualLost().catch(() => {}); });
  let closing: Promise<void> | undefined;
  let closeTransport: (() => Promise<void>) | undefined;
  let registration: ReturnType<typeof startBoardRegistration> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      await input.stop().catch(() => {});
      await registration?.close().catch(() => {});
      await liveScreen.close().catch(() => {});
      await closeTransport?.().catch(() => {});
      await bridge.close().catch(() => {});
    })();
    return closing;
  };
  try {
    if (options.transport === "http") {
      const http = await startHttpMcp(tools, { port: options.port ?? 8790, liveScreen });
      closeTransport = http.close;
      if (setupUrl) registration = startBoardRegistration(setupUrl, options.port ?? 8790);
      return { url: http.url, close };
    }
    const mcp = createMcpServer(tools);
    closeTransport = () => mcp.close();
    mcp.onclose = () => { void close(); };
    await mcp.connect(new StdioServerTransport());
    return { close };
  } catch (error) {
    await close();
    if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") {
      throw Object.assign(new Error(`设备操作台端口 ${options.port ?? 8790} 已被其他程序占用，请在连接设置中换一个端口。`), { code: "EADDRINUSE" });
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    transport: { type: "string" }, port: { type: "string" },
    "esp-port": { type: "string" }, "esp-host": { type: "string" }, "esp-tcp-port": { type: "string" },
    "esp-setup-url": { type: "string" },
    "screen-url": { type: "string" }, device: { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    console.error("设备操作台 [--transport stdio|http] [--esp-host BOARD_LAN_IP] [--esp-tcp-port 3333] [--esp-port COM5] [--esp-setup-url http://BOARD_LAN_IP:3334] [--screen-url http://PHONE_LAN_IP:8791] [--device APP_ID] [--port 8790]\n手机打开设备投屏，手机、设备控制器和电脑连接同一 Wi-Fi。\nHTTP 服务监听 0.0.0.0，仅接受本机及私有局域网访问，无需令牌。\n点击实时画面进入远控，按 Esc 退出。");
    return;
  }
  const transport = values.transport ?? process.env.ANDROID_MCP_TRANSPORT ?? "stdio";
  if (transport !== "stdio" && transport !== "http") throw new Error("transport must be stdio or http.");
  const deviceId = values.device ?? process.env.ANDROID_DEVICE_ID;
  const espHost = (values["esp-host"] ?? process.env.ESP_HOST ?? "").trim();
  const service = await startService({ transport, screenUrl: values["screen-url"] ?? process.env.ANDROID_SCREEN_URL ?? "",
    ...(deviceId ? { deviceId } : {}), espHost, espPort: values["esp-port"] ?? process.env.ESP_PORT ?? "",
    espTcpPort: parseEspTcpPort(values["esp-tcp-port"] ?? process.env.ESP_TCP_PORT ?? 3333),
    setupUrl: values["esp-setup-url"] ?? process.env.ESP_SETUP_URL ?? "",
    port: Number(values.port ?? process.env.ANDROID_MCP_PORT ?? 8790) });
  const stop = () => { void service.close().finally(() => { process.exitCode = 0; }); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  if (transport === "stdio") process.stdin.once("end", stop);
  else console.error(`设备操作台已启动：${new URL("/", service.url!).href}\nMCP：${service.url}\n设备控制器使用${espHost ? ` Wi-Fi（${espHost}）` : " USB 串口"}，点击实时画面进入远控，按 Esc 退出。`);
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

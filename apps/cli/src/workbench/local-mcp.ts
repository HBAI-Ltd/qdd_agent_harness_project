import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LocalMcpProvider, McpServerConfig } from "@qdd/shared";
import type { HarnessPaths } from "../config.js";

/** 本地服务可用并不代表已安装；只有用户选择的厂商才会作为数据源启用。 */
export const LOCAL_MCP_PROVIDERS: Record<LocalMcpProvider, { name: string; type: "pos" | "camera" | "phone"; url: string; consoleUrl: string }> = {
  shouqianba: { name: "收钱吧", type: "pos", url: "http://127.0.0.1:8788/mcp", consoleUrl: "http://127.0.0.1:8788/" },
  haik: { name: "海康互联", type: "camera", url: "http://127.0.0.1:8787/mcp", consoleUrl: "http://127.0.0.1:8787/" },
  tysl: { name: "天翼视联", type: "camera", url: "http://127.0.0.1:8790/mcp", consoleUrl: "http://127.0.0.1:8790/" },
  ezviz: { name: "萤石", type: "camera", url: "http://127.0.0.1:8791/mcp", consoleUrl: "http://127.0.0.1:8791/" },
  android: { name: "Android 设备操作台", type: "phone", url: "http://127.0.0.1:8792/mcp", consoleUrl: "http://127.0.0.1:8792/" },
};

export function isLocalMcpProvider(provider: unknown): provider is LocalMcpProvider {
  return typeof provider === "string" && Object.hasOwn(LOCAL_MCP_PROVIDERS, provider);
}

/** 安装项沿用本地默认地址，也支持部署配置覆盖地址或鉴权来源。 */
export function localMcpServer(provider: LocalMcpProvider, root: string, override?: McpServerConfig): McpServerConfig {
  const config: McpServerConfig = {
    url: LOCAL_MCP_PROVIDERS[provider].url,
    ...(provider === "shouqianba" && !override?.bearerTokenEnv ? { bearerTokenFile: path.resolve(root, "mcp/.local/shouqianba/mcp-key") } : {}),
    ...override,
    allowWrite: false,
  };
  if (config.bearerTokenFile) config.bearerTokenFile = path.resolve(root, config.bearerTokenFile);
  return config;
}

/** 自定义 MCP 保留配置文件行为；内置厂商必须在连接器页安装后才启用。 */
export async function loadInstalledMcpServers(
  paths: Pick<HarnessPaths, "root" | "connectors">,
  configured: Record<string, McpServerConfig> = {},
): Promise<Record<string, McpServerConfig>> {
  const servers = Object.fromEntries(Object.entries(configured).filter(([name]) => !isLocalMcpProvider(name)));
  let entries: unknown;
  try {
    entries = (JSON.parse(await readFile(paths.connectors, "utf8")) as { connectors?: unknown }).connectors;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return servers;
    throw error;
  }
  if (!Array.isArray(entries)) return servers;
  for (const entry of entries as Record<string, unknown>[]) {
    if (!entry || typeof entry !== "object" || entry.mode !== "mcp" || !isLocalMcpProvider(entry.provider)) continue;
    const provider = entry.provider;
    if (entry.id !== `mcp:${provider}` || entry.type !== LOCAL_MCP_PROVIDERS[provider].type) continue;
    servers[provider] = localMcpServer(provider, paths.root, configured[provider]);
  }
  return servers;
}

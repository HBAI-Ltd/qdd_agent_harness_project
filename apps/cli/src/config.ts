import { readFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessConfig } from "@qdd/shared";

export const CONFIG_FILE = "harness.config.json";

export const DEFAULT_CONFIG: HarnessConfig = {
  workspace: "workspace",
  llm: {
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    maxSteps: 40,
    maxTokens: 8192,
    clarify: "required",
  },
  approvalTimeoutMin: 60,
  gateway: { host: "127.0.0.1", port: 5173, tokenEnv: "QDD_GATEWAY_TOKEN", corsOrigins: [] },
  cdnAllowlist: [
    "cdn.jsdelivr.net",
    "unpkg.com",
    "cdnjs.cloudflare.com",
    "fonts.googleapis.com",
    "fonts.gstatic.com",
  ],
  mcpServers: {},
  datasets: { refreshIntervalSec: 0 },
};

export interface HarnessPaths {
  root: string;
  workspace: string;
  site: string;
  pages: string;
  sessions: string;
  datasets: string;
  metrics: string;
  state: string;
  style: string;
  store: string;
  token: string;
  skills: string;
  schedules: string;
  connectors: string;
  secretKey: string;
}

export interface LoadedConfig {
  config: HarnessConfig;
  paths: HarnessPaths;
}

export async function loadConfig(root = process.cwd()): Promise<LoadedConfig> {
  let user: Partial<HarnessConfig> = {};
  try {
    user = JSON.parse(await readFile(path.join(root, CONFIG_FILE), "utf8")) as Partial<HarnessConfig>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`读取 ${CONFIG_FILE} 失败：${(error as Error).message}`);
    }
  }

  const config: HarnessConfig = {
    ...DEFAULT_CONFIG,
    ...user,
    llm: { ...DEFAULT_CONFIG.llm, ...user.llm },
    gateway: { ...DEFAULT_CONFIG.gateway, ...user.gateway },
    mcpServers: user.mcpServers ?? {},
    datasets: { ...DEFAULT_CONFIG.datasets, ...user.datasets },
  };
  for (const [name, server] of Object.entries(config.mcpServers)) {
    if (typeof server.url !== "string" || !/^https?:\/\//.test(server.url)) {
      throw new Error(`MCP 服务 ${name} 缺少 http(s) url（只支持 Streamable HTTP）`);
    }
  }

  const env = process.env;
  if (env.DEEPSEEK_BASE_URL) config.llm.baseUrl = env.DEEPSEEK_BASE_URL;
  if (env.DEEPSEEK_MODEL) config.llm.model = env.DEEPSEEK_MODEL;
  if (env.HOST) config.gateway.host = env.HOST;
  if (env.PORT) config.gateway.port = Number(env.PORT);
  if (!(config.approvalTimeoutMin > 0)) throw new Error("approvalTimeoutMin 必须大于 0。");
  if (!Number.isInteger(config.gateway.port) || config.gateway.port < 0 || config.gateway.port > 65535) {
    throw new Error("PORT 必须是 0-65535 之间的整数。");
  }

  const workspace = path.resolve(root, config.workspace);
  const site = path.join(workspace, "site");
  return {
    config,
    paths: {
      root,
      workspace,
      site,
      pages: path.join(site, "pages"),
      sessions: path.join(workspace, "sessions"),
      datasets: path.join(workspace, "datasets"),
      metrics: path.join(workspace, "metrics.json"),
      state: path.join(workspace, "state"),
      style: path.join(workspace, "style.md"),
      store: path.join(workspace, "store.json"),
      token: path.join(workspace, ".gateway-token"),
      skills: path.join(workspace, "skills"),
      schedules: path.join(workspace, "schedules.json"),
      connectors: path.join(workspace, "connectors.json"),
      secretKey: path.join(workspace, ".secret-key"),
    },
  };
}

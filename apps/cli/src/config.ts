import { readFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessConfig, ModelCatalog } from "@qdd/shared";
import { chatOptions, modelConfigs } from "./agent/chat-options.js";
import { parseMediaOrigins } from "./guard.js";

export { modelConfigs } from "./agent/chat-options.js";

export const CONFIG_FILE = "harness.config.json";

export const DEFAULT_CONFIG: HarnessConfig = {
  workspace: "workspace",
  llm: {
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    maxSteps: 40,
    maxTokens: 393216,
    clarify: "required",
    thinking: "enabled",
  },
  approvalTimeoutMin: 60,
  browser: { enabled: false, executablePath: "", permission: "confirm" },
  gateway: { host: "127.0.0.1", port: 5173, tokenEnv: "QDD_GATEWAY_TOKEN", corsOrigins: [] },
  cdnAllowlist: ["127.0.0.1", "localhost", "cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"],
  // External media is opt-in; HTTP origins are limited to explicit loopback hosts.
  mediaOrigins: [],
  mcpServers: {},
  datasets: { refreshIntervalSec: 0 },
};

type LlmConfig = HarnessConfig["llm"];

/** 按 id 得到完整 LLM 配置；未知或缺省 id 回退到默认模型。 */
export function resolveModel(llm: LlmConfig, id?: string): LlmConfig {
  const models = modelConfigs(llm);
  const picked = models.find((m) => m.id === id) ?? models[0]!;
  return {
    ...llm,
    model: picked.model,
    baseUrl: picked.baseUrl ?? llm.baseUrl,
    apiKeyEnv: picked.apiKeyEnv ?? llm.apiKeyEnv,
    maxTokens: picked.maxTokens ?? llm.maxTokens,
    thinking: picked.thinking ?? llm.thinking,
  };
}

export function modelCatalog(llm: LlmConfig): ModelCatalog {
  const models = modelConfigs(llm).map((m) => ({
    id: m.id,
    label: m.label ?? m.model,
    provider: m.provider ?? providerName(m.baseUrl ?? llm.baseUrl),
    model: m.model,
    available: Boolean(process.env[m.apiKeyEnv ?? llm.apiKeyEnv]),
  }));
  return { models, default: models[0]!.id };
}

export function hasModel(llm: LlmConfig, id: string): boolean {
  return modelConfigs(llm).some((m) => m.id === id);
}

function providerName(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname.replace(/^api\./, "");
    return host.split(".")[0] === "deepseek" ? "DeepSeek" : host;
  } catch {
    return "自定义";
  }
}

export interface HarnessPaths {
  root: string;
  workspace: string;
  site: string;
  pages: string;
  sessions: string;
  scheduleSessions: string;
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
  attachments: string;
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

  if (!user || typeof user !== "object" || Array.isArray(user)) throw new Error("配置必须是 JSON 对象。");
  for (const key of ["llm", "gateway", "datasets", "browser", "mcpServers"] as const) {
    const value = user[key];
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error(`${key} 必须是 JSON 对象。`);
  }
  const config: HarnessConfig = {
    ...DEFAULT_CONFIG,
    ...user,
    llm: { ...DEFAULT_CONFIG.llm, ...user.llm },
    gateway: { ...DEFAULT_CONFIG.gateway, ...user.gateway },
    mcpServers: user.mcpServers ?? {},
    datasets: { ...DEFAULT_CONFIG.datasets, ...user.datasets },
    browser: { ...DEFAULT_CONFIG.browser, ...user.browser },
    mediaOrigins: parseMediaOrigins(user.mediaOrigins === undefined ? [] : user.mediaOrigins),
  };
  for (const [name, server] of Object.entries(config.mcpServers)) {
    if (!server || typeof server !== "object" || Array.isArray(server) || !isHttpUrl(server.url)) {
      throw new Error(`MCP 服务 ${name} 缺少 http(s) url（只支持 Streamable HTTP）`);
    }
    if (server.allowTools !== undefined && (!Array.isArray(server.allowTools) || server.allowTools.some((tool) => typeof tool !== "string")))
      throw new Error(`MCP 服务 ${name} 的 allowTools 必须是字符串数组。`);
    if (server.allowWrite !== undefined && typeof server.allowWrite !== "boolean") throw new Error(`MCP 服务 ${name} 的 allowWrite 必须是布尔值。`);
    for (const field of ["bearerTokenEnv", "bearerTokenFile"] as const) {
      if (server[field] !== undefined && (typeof server[field] !== "string" || !server[field].trim())) {
        throw new Error(`MCP 服务 ${name} 的 ${field} 必须是非空字符串`);
      }
    }
    if (server.bearerTokenEnv !== undefined && server.bearerTokenFile !== undefined) {
      throw new Error(`MCP 服务 ${name} 的 bearerTokenEnv 与 bearerTokenFile 只能配置一个`);
    }
    if (server.bearerTokenFile !== undefined) server.bearerTokenFile = path.resolve(root, server.bearerTokenFile);
  }

  const env = process.env;
  if (env.DEEPSEEK_BASE_URL) config.llm.baseUrl = env.DEEPSEEK_BASE_URL;
  if (env.DEEPSEEK_MODEL) config.llm.model = env.DEEPSEEK_MODEL;
  if (env.HOST) config.gateway.host = env.HOST;
  if (env.PORT) config.gateway.port = Number(env.PORT);
  if (typeof config.workspace !== "string" || !config.workspace.trim()) throw new Error("workspace 必须是非空路径。");
  if (!isHttpUrl(config.llm.baseUrl)) throw new Error("llm.baseUrl 必须是有效的 http(s) URL。");
  if (typeof config.llm.apiKeyEnv !== "string" || !config.llm.apiKeyEnv.trim()) throw new Error("llm.apiKeyEnv 必须是非空环境变量名。");
  for (const key of ["maxTokens", "maxSteps"] as const) {
    if (!Number.isSafeInteger(config.llm[key]) || config.llm[key] <= 0) throw new Error(`llm.${key} 必须是正整数。`);
  }
  if (!["enabled", "disabled"].includes(config.llm.thinking)) throw new Error("llm.thinking 只能是 enabled 或 disabled。");
  if (typeof config.browser.enabled !== "boolean") throw new Error("browser.enabled 必须是布尔值。");
  if (typeof config.gateway.host !== "string" || !config.gateway.host.trim()) throw new Error("gateway.host 必须是非空字符串。");
  if (!Array.isArray(config.gateway.corsOrigins) || config.gateway.corsOrigins.some((origin) => !isHttpUrl(origin)))
    throw new Error("gateway.corsOrigins 必须是 http(s) 来源数组。");
  if (!Number.isFinite(config.datasets.refreshIntervalSec) || config.datasets.refreshIntervalSec < 0)
    throw new Error("datasets.refreshIntervalSec 必须是大于或等于 0 的有限数字。");
  if (!Array.isArray(config.cdnAllowlist) || config.cdnAllowlist.some((host) => typeof host !== "string" || !host.trim()))
    throw new Error("cdnAllowlist 必须是非空主机名数组。");
  chatOptions(config.llm);
  if (!["confirm", "auto"].includes(config.browser.permission)) throw new Error("browser.permission 只能是 confirm 或 auto。");
  if (!Number.isFinite(config.approvalTimeoutMin) || config.approvalTimeoutMin <= 0) throw new Error("approvalTimeoutMin 必须是大于 0 的有限数字。");
  if (!Number.isInteger(config.gateway.port) || config.gateway.port < 0 || config.gateway.port > 65535) {
    throw new Error("PORT 必须是 0-65535 之间的整数。");
  }

  const ids = new Set<string>();
  for (const m of config.llm.models ?? []) {
    if (typeof m?.id !== "string" || !m.id.trim() || (m.model !== undefined && (typeof m.model !== "string" || !m.model.trim())))
      throw new Error("llm.models 每项都需要 id，model 必须是非空字符串。");
    if (ids.has(m.id)) throw new Error(`llm.models 中 id ${m.id} 重复。`);
    if (m.maxTokens !== undefined && (!Number.isSafeInteger(m.maxTokens) || m.maxTokens <= 0))
      throw new Error(`模型 ${m.id} 的 maxTokens 必须是正整数。`);
    if (m.baseUrl !== undefined && !isHttpUrl(m.baseUrl)) throw new Error(`模型 ${m.id} 的 baseUrl 必须是有效的 http(s) URL。`);
    if (m.apiKeyEnv !== undefined && (typeof m.apiKeyEnv !== "string" || !m.apiKeyEnv.trim()))
      throw new Error(`模型 ${m.id} 的 apiKeyEnv 必须是非空环境变量名。`);
    if (m.thinking !== undefined && !["enabled", "disabled"].includes(m.thinking))
      throw new Error(`模型 ${m.id} 的 thinking 只能是 enabled 或 disabled。`);
    ids.add(m.id);
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
      scheduleSessions: path.join(workspace, "schedule-sessions"),
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
      attachments: path.join(workspace, "attachments"),
    },
  };
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

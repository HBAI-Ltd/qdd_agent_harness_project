import { readFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessConfig, ModelCatalog, ModelConfig } from "@qdd/shared";

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
    thinking: "enabled",
  },
  approvalTimeoutMin: 60,
  browser: { enabled: false, executablePath: "", permission: "confirm" },
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

type LlmConfig = HarnessConfig["llm"];

/** 可选模型列表：未配置 llm.models 时只有默认模型。第一项为默认。 */
export function modelConfigs(llm: LlmConfig): ModelConfig[] {
  const models = llm.models?.length ? llm.models : [{ id: llm.model, model: llm.model }];
  return models;
}

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

  const config: HarnessConfig = {
    ...DEFAULT_CONFIG,
    ...user,
    llm: { ...DEFAULT_CONFIG.llm, ...user.llm },
    gateway: { ...DEFAULT_CONFIG.gateway, ...user.gateway },
    mcpServers: user.mcpServers ?? {},
    datasets: { ...DEFAULT_CONFIG.datasets, ...user.datasets },
    browser: { ...DEFAULT_CONFIG.browser, ...user.browser },
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
  if (!["confirm", "auto"].includes(config.browser.permission)) throw new Error("browser.permission 只能是 confirm 或 auto。");
  if (!(config.approvalTimeoutMin > 0)) throw new Error("approvalTimeoutMin 必须大于 0。");
  if (!Number.isInteger(config.gateway.port) || config.gateway.port < 0 || config.gateway.port > 65535) {
    throw new Error("PORT 必须是 0-65535 之间的整数。");
  }

  const ids = new Set<string>();
  for (const m of config.llm.models ?? []) {
    if (typeof m?.id !== "string" || !m.id.trim() || typeof m.model !== "string" || !m.model.trim()) throw new Error("llm.models 每项都需要 id 与 model。");
    if (ids.has(m.id)) throw new Error(`llm.models 中 id ${m.id} 重复。`);
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

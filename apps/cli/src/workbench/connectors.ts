import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ConnectorCatalogEntry, ConnectorInput, ConnectorPermission, ConnectorStatus, ConnectorView, FeishuConnectorInput, LocalMcpConnectorInput, LocalMcpProvider, McpServerConfig } from "@qdd/shared";
import type { HarnessPaths } from "../config.js";
import { McpClient } from "../datasource/mcp-client.js";
import { writeAtomic } from "../web/site.js";
import { FeishuClient, FeishuError } from "./feishu.js";
import { isLocalMcpProvider, LOCAL_MCP_PROVIDERS, localMcpServer } from "./local-mcp.js";
import type { SecretBox } from "./secrets.js";
import { InvalidInput, Missing } from "./skills.js";

/** 前端「连接器」页展示的目录；available=false 的类型暂未开放。 */
export const CONNECTOR_CATALOG: ConnectorCatalogEntry[] = [
  { type: "pos", name: "收银系统", category: "数据", tags: ["销售", "订单"], available: true, modes: ["mcp"], providers: [{ id: "shouqianba", name: "收钱吧" }] },
  { type: "erp", name: "进销存 ERP", category: "数据", tags: ["库存", "采购"], available: false, modes: ["mcp"] },
  { type: "feishu", name: "飞书", category: "消息通知", tags: ["飞书", "群机器人", "应用"], available: true, modes: ["webhook", "app"] },
  { type: "wecom", name: "企业微信", category: "消息通知", tags: ["企业微信"], available: false, modes: ["webhook"] },
  { type: "camera", name: "门店摄像头", category: "设备", tags: ["客流统计", "货架识别"], available: true, modes: ["mcp"], providers: (["haik", "tysl", "ezviz"] as const).map((id) => ({ id, name: LOCAL_MCP_PROVIDERS[id].name })) },
  { type: "phone", name: "门店手机 · 助手操控", category: "设备", tags: ["小红书", "抖音", "大众点评"], available: true, modes: ["mcp"], providers: [{ id: "android", name: LOCAL_MCP_PROVIDERS.android.name }] },
  { type: "delivery", name: "外卖平台", category: "数据", tags: ["外卖订单", "评价"], available: false, modes: ["mcp"] },
];

const PERMISSIONS: ConnectorPermission[] = ["read", "confirm", "auto"];
const RECEIVE_ID_TYPES = ["chat_id", "open_id", "user_id", "union_id", "email"] as const;
const TEST_TEXT = "【钱多多】飞书连接器验证成功，之后的日报和提醒会发到这里。";

interface FeishuSecrets {
  webhookUrl?: string;
  signSecret?: string;
  appSecret?: string;
}

interface StoredConnectorBase {
  id: string;
  name: string;
  permission: ConnectorPermission;
  status: ConnectorStatus;
  detail: string;
  lastVerifiedAt: string | null;
  createdAt: string;
}

interface StoredFeishuConnector extends StoredConnectorBase {
  type: "feishu";
  mode: "webhook" | "app";
  appId?: string;
  receiveId?: string;
  receiveIdType?: (typeof RECEIVE_ID_TYPES)[number];
  /** SecretBox 加密的 FeishuSecrets */
  secrets: string;
}

interface StoredMcpConnector extends StoredConnectorBase {
  type: "pos" | "camera" | "phone";
  mode: "mcp";
  provider: LocalMcpProvider;
}

type StoredConnector = StoredFeishuConnector | StoredMcpConnector;

/** 配置文件中的 MCP 服务，作为只读连接器展示。 */
export interface McpConnectorInfo {
  name: string;
  allowWrite: boolean;
  error?: string | undefined;
}

export class ConnectorStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly paths: HarnessPaths,
    private readonly box: SecretBox,
    readonly feishu = new FeishuClient(),
    private readonly mcpServers: Record<string, McpServerConfig> = {},
  ) {}

  private async readAll(): Promise<StoredConnector[]> {
    try {
      return (JSON.parse(await readFile(this.paths.connectors, "utf8")) as { connectors: StoredConnector[] }).connectors;
    } catch {
      return [];
    }
  }

  /** 串行化读改写，避免并发安装/验证互相覆盖。 */
  private mutate<T>(fn: (all: StoredConnector[]) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const all = await this.readAll();
      const out = await fn(all);
      await writeAtomic(this.paths.connectors, JSON.stringify({ connectors: all }, null, 2));
      return out;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async stored(id: string): Promise<StoredConnector> {
    const c = (await this.readAll()).find((x) => x.id === id);
    if (!c) throw new Missing("连接器不存在");
    return c;
  }

  async list(mcp: McpConnectorInfo[] = []): Promise<ConnectorView[]> {
    const installed = await this.readAll();
    const installedIds = new Set(installed.map((c) => c.id));
    const servers = mcp.filter((s) => !isLocalMcpProvider(s.name) && !installedIds.has(`mcp:${s.name}`)).map(
      (s): ConnectorView => ({
        id: `mcp:${s.name}`,
        type: "mcp",
        name: s.name,
        origin: "mcp",
        permission: s.allowWrite ? "auto" : "confirm",
        status: s.error ? "error" : "connected",
        detail: s.error ?? "harness.config.json 中配置的 MCP 服务",
        config: {},
        lastVerifiedAt: null,
        createdAt: null,
      }),
    );
    return [...servers, ...installed.map((c) => {
      const view = this.view(c);
      const runtime = c.mode === "mcp" ? mcp.find((server) => server.name === c.provider) : undefined;
      return runtime?.error ? { ...view, status: "error" as const, detail: runtime.error } : view;
    })];
  }

  async get(id: string): Promise<ConnectorView> {
    return this.view(await this.stored(id));
  }

  /** 安装：先验证，通过后才保存。 */
  async install(raw: unknown): Promise<ConnectorView> {
    const input = parseInput(raw);
    if (input.mode === "mcp") return this.installMcp(input);
    const secrets = requireSecrets(input);
    const detail = await this.verifyFeishu(input.mode, secrets, input);
    const now = new Date().toISOString();
    const connector: StoredFeishuConnector = {
      id: randomUUID(),
      type: "feishu",
      name: input.name?.trim().slice(0, 30) || (input.mode === "webhook" ? "飞书群机器人" : "飞书应用"),
      permission: input.permission ?? "confirm",
      status: "connected",
      detail,
      mode: input.mode,
      ...(input.appId ? { appId: input.appId } : {}),
      ...(input.receiveId ? { receiveId: input.receiveId, receiveIdType: input.receiveIdType ?? "chat_id" } : {}),
      secrets: this.box.seal(secrets),
      lastVerifiedAt: now,
      createdAt: now,
    };
    await this.mutate(async (all) => all.push(connector));
    return this.view(connector);
  }

  /** 修改名称、权限或接收方；不修改凭据（换凭据请重新安装）。 */
  async update(id: string, raw: unknown): Promise<ConnectorView> {
    const body = (raw ?? {}) as Record<string, unknown>;
    if (body.permission !== undefined && !PERMISSIONS.includes(body.permission as ConnectorPermission)) throw new InvalidInput(`permission 只能是 ${PERMISSIONS.join("/")}`);
    if (body.receiveIdType !== undefined && !RECEIVE_ID_TYPES.includes(body.receiveIdType as never)) throw new InvalidInput(`receiveIdType 只能是 ${RECEIVE_ID_TYPES.join("/")}`);
    return this.mutate(async (all) => {
      const c = all.find((x) => x.id === id);
      if (!c) throw new Missing("连接器不存在");
      if (c.mode === "mcp") {
        if (Object.keys(body).some((key) => key !== "name")) throw new InvalidInput("MCP 连接器只能修改名称，厂商和权限由安装类型确定");
        if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) throw new InvalidInput("name 必须是非空字符串");
        if (typeof body.name === "string") c.name = body.name.trim().slice(0, 30);
        return this.view(c);
      }
      if (typeof body.name === "string" && body.name.trim()) c.name = body.name.trim().slice(0, 30);
      if (body.permission !== undefined) c.permission = body.permission as ConnectorPermission;
      if (typeof body.receiveId === "string") {
        if (c.mode !== "app") throw new InvalidInput("只有应用模式需要 receiveId");
        c.receiveId = body.receiveId.trim();
        c.receiveIdType = (body.receiveIdType as StoredFeishuConnector["receiveIdType"]) ?? c.receiveIdType ?? "chat_id";
      }
      return this.view(c);
    });
  }

  async remove(id: string): Promise<void> {
    await this.mutate(async (all) => {
      const i = all.findIndex((x) => x.id === id);
      if (i < 0) throw new Missing("连接器不存在");
      all.splice(i, 1);
    });
  }

  /** 重新验证凭据，并记录结果。webhook 模式会发送一条测试消息。 */
  async verify(id: string): Promise<ConnectorView> {
    const c = await this.stored(id);
    let status: ConnectorStatus = "connected";
    let detail: string;
    try {
      detail = c.mode === "mcp"
        ? await this.verifyMcp(c.provider)
        : await this.verifyFeishu(c.mode, this.box.open<FeishuSecrets>(c.secrets), c);
    } catch (error) {
      status = "error";
      detail = (error as Error).message;
    }
    return this.mutate(async (all) => {
      const target = all.find((x) => x.id === id);
      if (!target) throw new Missing("连接器不存在");
      Object.assign(target, { status, detail, lastVerifiedAt: new Date().toISOString() });
      return this.view(target);
    });
  }

  /** 推送一条文本消息。permission=read 的连接器不能推送。 */
  async send(id: string, text: string): Promise<void> {
    const c = await this.stored(id);
    if (c.mode === "mcp") throw new InvalidInput(`连接器「${c.name}」是数据源，不支持推送消息`);
    if (c.permission === "read") throw new InvalidInput(`连接器「${c.name}」只允许查看，不能推送消息`);
    const secrets = this.box.open<FeishuSecrets>(c.secrets);
    if (c.mode === "webhook") return this.feishu.sendWebhook({ webhookUrl: secrets.webhookUrl!, signSecret: secrets.signSecret }, text);
    if (!c.receiveId) throw new InvalidInput(`连接器「${c.name}」未设置接收方 receiveId，无法推送`);
    return this.feishu.sendApp({ appId: c.appId!, appSecret: secrets.appSecret! }, c.receiveIdType ?? "chat_id", c.receiveId, text);
  }

  /** 返回给 agent / 网关判断权限用的最小信息。 */
  async describe(id: string): Promise<{ id: string; name: string; permission: ConnectorPermission; status: ConnectorStatus }> {
    const c = await this.stored(id);
    if (c.mode === "mcp") throw new InvalidInput(`连接器「${c.name}」是数据源，不能作为消息通知连接器`);
    return { id: c.id, name: c.name, permission: c.permission, status: c.status };
  }

  private async installMcp(input: LocalMcpConnectorInput): Promise<ConnectorView> {
    return this.mutate(async (all) => {
      const id = `mcp:${input.provider}`;
      if (all.some((connector) => connector.id === id)) throw new InvalidInput(`「${LOCAL_MCP_PROVIDERS[input.provider].name}」已安装`);
      const detail = await this.verifyMcp(input.provider);
      const now = new Date().toISOString();
      const connector: StoredMcpConnector = {
        id,
        type: input.type,
        mode: "mcp",
        provider: input.provider,
        name: input.name?.trim().slice(0, 30) || LOCAL_MCP_PROVIDERS[input.provider].name,
        permission: input.type === "pos" ? "read" : "confirm",
        status: "connected",
        detail,
        lastVerifiedAt: now,
        createdAt: now,
      };
      all.push(connector);
      return this.view(connector);
    });
  }

  private async verifyMcp(provider: LocalMcpProvider): Promise<string> {
    let client: McpClient | undefined;
    try {
      client = new McpClient(provider, localMcpServer(provider, this.paths.root, this.mcpServers[provider]));
      await client.start();
      const tools = await client.listTools();
      if (provider === "android") {
        if (!["android_screenshot", "android_control"].every((name) => tools.some((tool) => tool.name === name))) {
          throw new Error("该地址不是兼容的 Android 设备操作台，请检查服务地址和端口");
        }
        return `Android MCP 已连接（${tools.length} 个工具）；请在设备操作台确认手机投屏和控制板连接，手机操作需店长确认`;
      }
      return `MCP 服务已连接（${tools.length} 个工具）；厂商账号请在登录控制台管理`;
    } catch (error) {
      throw new InvalidInput(`「${LOCAL_MCP_PROVIDERS[provider].name}」连接失败：${(error as Error).message}`);
    } finally {
      await client?.close();
    }
  }

  private async verifyFeishu(mode: "webhook" | "app", secrets: FeishuSecrets, target: { appId?: string | undefined; receiveId?: string | undefined; receiveIdType?: string | undefined }): Promise<string> {
    try {
      if (mode === "webhook") {
        await this.feishu.sendWebhook({ webhookUrl: secrets.webhookUrl!, signSecret: secrets.signSecret }, TEST_TEXT);
        return "已向群机器人发送测试消息";
      }
      const { botName } = await this.feishu.verifyApp({ appId: target.appId!, appSecret: secrets.appSecret! });
      const who = botName ? `机器人「${botName}」` : "应用凭据有效（未开启机器人能力，无法推送消息）";
      if (!target.receiveId) return `${who}；未设置接收方，暂不能推送`;
      await this.feishu.sendApp({ appId: target.appId!, appSecret: secrets.appSecret! }, target.receiveIdType ?? "chat_id", target.receiveId, TEST_TEXT);
      return `${who}，已向接收方发送测试消息`;
    } catch (error) {
      if (error instanceof FeishuError) throw new InvalidInput(error.message);
      throw error;
    }
  }

  private view(c: StoredConnector): ConnectorView {
    if (c.mode === "mcp") {
      return {
        id: c.id,
        type: c.type,
        name: c.name,
        origin: "installed",
        permission: c.type === "pos" ? "read" : "confirm",
        status: c.status,
        detail: c.detail,
        config: { mode: "mcp", provider: c.provider, consoleUrl: new URL(localMcpServer(c.provider, this.paths.root, this.mcpServers[c.provider]).url).origin + "/" },
        lastVerifiedAt: c.lastVerifiedAt,
        createdAt: c.createdAt,
      };
    }
    let secrets: FeishuSecrets = {};
    try {
      secrets = this.box.open<FeishuSecrets>(c.secrets);
    } catch {
      // 密钥变更后无法解密，只展示非敏感字段
    }
    const config: Record<string, string | boolean> = { mode: c.mode };
    if (c.mode === "webhook") {
      config.webhookUrl = secrets.webhookUrl ? `${secrets.webhookUrl.replace(/[^/]+$/, "")}****${secrets.webhookUrl.slice(-4)}` : "";
      config.signSecret = !!secrets.signSecret;
    } else {
      config.appId = c.appId ?? "";
      config.appSecret = !!secrets.appSecret;
      config.receiveId = c.receiveId ?? "";
      config.receiveIdType = c.receiveIdType ?? "chat_id";
    }
    return {
      id: c.id,
      type: c.type,
      name: c.name,
      origin: "installed",
      permission: c.permission,
      status: c.status,
      detail: c.detail,
      config,
      lastVerifiedAt: c.lastVerifiedAt,
      createdAt: c.createdAt,
    };
  }
}

function parseInput(raw: unknown): ConnectorInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  if (body.type === "pos" || body.type === "camera" || body.type === "phone") {
    if (body.mode !== "mcp") throw new InvalidInput("收银系统、门店摄像头与门店手机的 mode 必须是 mcp");
    if (!isLocalMcpProvider(body.provider) || LOCAL_MCP_PROVIDERS[body.provider].type !== body.type) throw new InvalidInput("请选择此连接器支持的厂商");
    if (Object.keys(body).some((key) => !["type", "mode", "provider", "name"].includes(key))) throw new InvalidInput("MCP 连接器只接受类型、厂商和名称；权限由安装类型确定");
    if (body.name !== undefined && typeof body.name !== "string") throw new InvalidInput("name 必须是字符串");
    return { type: body.type, mode: "mcp", provider: body.provider, ...(typeof body.name === "string" && body.name.trim() ? { name: body.name.trim() } : {}) };
  }
  if (body.type !== "feishu") {
    const entry = CONNECTOR_CATALOG.find((c) => c.type === body.type);
    throw new InvalidInput(entry ? `「${entry.name}」暂未开放安装` : "未知连接器类型");
  }
  if (body.mode !== "webhook" && body.mode !== "app") throw new InvalidInput("mode 只能是 webhook 或 app");
  if (body.permission !== undefined && !PERMISSIONS.includes(body.permission as ConnectorPermission)) throw new InvalidInput(`permission 只能是 ${PERMISSIONS.join("/")}`);
  if (body.receiveIdType !== undefined && !RECEIVE_ID_TYPES.includes(body.receiveIdType as never)) throw new InvalidInput(`receiveIdType 只能是 ${RECEIVE_ID_TYPES.join("/")}`);
  for (const k of ["name", "webhookUrl", "signSecret", "appId", "appSecret", "receiveId"]) {
    if (body[k] !== undefined && typeof body[k] !== "string") throw new InvalidInput(`${k} 必须是字符串`);
  }
  const trim = (k: string) => (typeof body[k] === "string" && (body[k] as string).trim() ? (body[k] as string).trim() : undefined);
  const out: FeishuConnectorInput = { type: "feishu", mode: body.mode };
  for (const k of ["name", "webhookUrl", "signSecret", "appId", "appSecret", "receiveId"] as const) {
    const v = trim(k);
    if (v) out[k] = v;
  }
  if (body.permission) out.permission = body.permission as ConnectorPermission;
  if (body.receiveIdType) out.receiveIdType = body.receiveIdType as NonNullable<FeishuConnectorInput["receiveIdType"]>;
  return out;
}

function requireSecrets(input: FeishuConnectorInput): FeishuSecrets {
  if (input.mode === "webhook") {
    if (!input.webhookUrl) throw new InvalidInput("webhook 模式需要 webhookUrl");
    return { webhookUrl: input.webhookUrl, ...(input.signSecret ? { signSecret: input.signSecret } : {}) };
  }
  if (!input.appId || !input.appSecret) throw new InvalidInput("应用模式需要 appId 与 appSecret");
  return { appSecret: input.appSecret };
}

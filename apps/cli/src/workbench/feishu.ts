import { createHmac } from "node:crypto";

/**
 * 飞书开放平台的最小客户端：自定义机器人 webhook 与企业自建应用。
 * 只做验证与发消息两件事；baseUrl / fetch 可注入以便测试。
 */
export const FEISHU_BASE_URL = "https://open.feishu.cn";
const LARK_BASE_URL = "https://open.larksuite.com";
const TIMEOUT_MS = 10_000;

export type Fetch = typeof fetch;

export interface FeishuOptions {
  baseUrl?: string;
  fetch?: Fetch;
}

export interface WebhookCredentials {
  webhookUrl: string;
  signSecret?: string | undefined;
}

export interface AppCredentials {
  appId: string;
  appSecret: string;
}

export class FeishuError extends Error {}

interface FeishuReply {
  code?: number;
  msg?: string;
  StatusCode?: number;
  StatusMessage?: string;
  tenant_access_token?: string;
  expire?: number;
  bot?: { app_name?: string; open_id?: string };
}

/** 自定义机器人签名：key = `${timestamp}\n${secret}`，对空串做 HmacSHA256 后 base64。 */
export function feishuSign(timestamp: number, secret: string): string {
  return createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
}

export class FeishuClient {
  private readonly baseUrl: string;
  private readonly fetch: Fetch;
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(options: FeishuOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.FEISHU_BASE_URL ?? FEISHU_BASE_URL).replace(/\/+$/, "");
    this.fetch = options.fetch ?? fetch;
  }

  /** webhook 只能指向飞书（或 Lark）机器人地址，避免把消息与签名发往任意主机。 */
  checkWebhookUrl(url: string): void {
    const ok = [this.baseUrl, FEISHU_BASE_URL, LARK_BASE_URL].some((b) => url.startsWith(`${b}/open-apis/bot/v2/hook/`));
    if (!ok || /\s/.test(url)) throw new FeishuError("webhook 地址必须是飞书自定义机器人地址：https://open.feishu.cn/open-apis/bot/v2/hook/…");
  }

  async sendWebhook({ webhookUrl, signSecret }: WebhookCredentials, text: string): Promise<void> {
    this.checkWebhookUrl(webhookUrl);
    const body: Record<string, unknown> = { msg_type: "text", content: { text } };
    if (signSecret) {
      const timestamp = Math.floor(Date.now() / 1000);
      body.timestamp = String(timestamp);
      body.sign = feishuSign(timestamp, signSecret);
    }
    const reply = await this.post(webhookUrl, body);
    const code = reply.code ?? reply.StatusCode ?? 0;
    if (code !== 0) throw new FeishuError(describe(code, reply.msg ?? reply.StatusMessage));
  }

  /** 企业自建应用：换取 tenant_access_token（带缓存，提前 5 分钟刷新）。 */
  async tenantToken({ appId, appSecret }: AppCredentials, fresh = false): Promise<string> {
    const cached = this.tokens.get(appId);
    if (!fresh && cached && cached.expiresAt > Date.now()) return cached.token;
    const reply = await this.post(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, { app_id: appId, app_secret: appSecret });
    if (reply.code !== 0 || !reply.tenant_access_token) throw new FeishuError(describe(reply.code ?? -1, reply.msg));
    this.tokens.set(appId, { token: reply.tenant_access_token, expiresAt: Date.now() + Math.max(60, (reply.expire ?? 7200) - 300) * 1000 });
    return reply.tenant_access_token;
  }

  /** 验证应用凭据并读取机器人信息（应用需开启机器人能力）。 */
  async verifyApp(credentials: AppCredentials): Promise<{ botName: string | null }> {
    const token = await this.tenantToken(credentials, true);
    const reply = await this.request(`${this.baseUrl}/open-apis/bot/v3/info`, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
    if (reply.code !== 0) return { botName: null };
    return { botName: reply.bot?.app_name ?? null };
  }

  async sendApp(credentials: AppCredentials, receiveIdType: string, receiveId: string, text: string): Promise<void> {
    const token = await this.tenantToken(credentials);
    const reply = await this.post(
      `${this.baseUrl}/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`,
      { receive_id: receiveId, msg_type: "text", content: JSON.stringify({ text }) },
      { Authorization: `Bearer ${token}` },
    );
    if (reply.code !== 0) throw new FeishuError(describe(reply.code ?? -1, reply.msg));
  }

  private post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<FeishuReply> {
    return this.request(url, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8", ...headers }, body: JSON.stringify(body) });
  }

  private async request(url: string, init: RequestInit): Promise<FeishuReply> {
    let res: Response;
    try {
      res = await this.fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new FeishuError(`无法连接飞书：${(error as Error).message}`);
    }
    const text = await res.text();
    let reply: FeishuReply;
    try {
      reply = JSON.parse(text) as FeishuReply;
    } catch {
      throw new FeishuError(`飞书返回 HTTP ${res.status}：${text.slice(0, 200)}`);
    }
    return reply;
  }
}

const HINTS: Record<number, string> = {
  19001: "webhook 地址无效或机器人已被移除",
  19021: "签名校验失败：请检查签名密钥，或确认服务器时间准确",
  19022: "IP 不在机器人白名单内",
  19024: "消息不含机器人设置的关键词",
  10003: "App ID 或 App Secret 错误",
  10014: "App Secret 错误",
  99991663: "tenant_access_token 无效",
  230002: "机器人不在该群中",
  230013: "机器人对该用户不可见（检查应用可用范围）",
};

function describe(code: number, msg: string | undefined): string {
  return `飞书错误 ${code}：${HINTS[code] ?? msg ?? "未知错误"}`;
}

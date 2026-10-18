import type { CameraAccountStatus, CameraProvider } from "@qdd/shared";
import type { HarnessConfig } from "@qdd/shared";
import { InvalidInput, Missing } from "./skills.js";

/**
 * 摄像头云账号登录：代理到本机 haik（海康互联）/ tysl（天翼视联）服务的登录接口。
 * 登录会话由这两个服务各自加密保存，网关不经手、不落盘任何令牌。
 */
export const CAMERA_PROVIDERS: Record<CameraProvider, { name: string }> = {
  haik: { name: "海康互联" },
  tysl: { name: "天翼视联" },
};

const PHONE_RE = /^1\d{10}$/;

class CameraServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class CameraLogin {
  constructor(private readonly config: HarnessConfig | (() => Readonly<HarnessConfig["mcpServers"]>)) {}

  /** mcpServers 中同名服务的地址；未配置返回 undefined。 */
  private origin(provider: CameraProvider): string | undefined {
    const servers = typeof this.config === "function" ? this.config() : this.config.mcpServers;
    const url = servers[provider]?.url;
    return url ? new URL(url).origin : undefined;
  }

  private require(provider: string): { provider: CameraProvider; origin: string } {
    if (!(provider in CAMERA_PROVIDERS)) throw new Missing("未知的摄像头平台");
    const origin = this.origin(provider as CameraProvider);
    if (!origin) throw new Missing(`harness.config.json 未配置 ${provider} MCP 服务`);
    return { provider: provider as CameraProvider, origin };
  }

  private async call<T>(origin: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${origin}${path}`, {
        method: body === undefined ? "GET" : "POST",
        // 本地服务只接受同源 Origin；由网关在服务端代为声明
        headers: body === undefined ? {} : { "Content-Type": "application/json", Origin: origin },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new CameraServiceError(502, "摄像头本地服务未启动或无法连接");
    }
    const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string; details?: unknown };
    if (!res.ok) throw new CameraServiceError(res.status >= 500 ? 502 : res.status, data.message || data.error || `摄像头服务返回 HTTP ${res.status}`, data.details);
    return data as T;
  }

  async status(): Promise<CameraAccountStatus[]> {
    return Promise.all(
      (Object.keys(CAMERA_PROVIDERS) as CameraProvider[]).map(async (provider): Promise<CameraAccountStatus> => {
        const base = { provider, name: CAMERA_PROVIDERS[provider].name };
        const origin = this.origin(provider);
        if (!origin) return { ...base, configured: false, reachable: false, connected: false };
        try {
          if (provider === "haik") {
            const s = await this.call<{ connected?: boolean; expired?: boolean }>(origin, "/api/camera?action=status");
            return { ...base, configured: true, reachable: true, connected: !!s.connected, ...(s.expired ? { detail: "登录已过期，请重新登录" } : {}) };
          }
          const s = await this.call<{ connected?: boolean; phoneMasked?: string; roleName?: string; cameraCount?: number }>(origin, "/api/status");
          return {
            ...base,
            configured: true,
            reachable: true,
            connected: !!s.connected,
            ...(s.phoneMasked ? { account: s.phoneMasked } : {}),
            ...(s.connected ? { detail: [s.roleName, typeof s.cameraCount === "number" ? `${s.cameraCount} 台设备` : ""].filter(Boolean).join(" · ") } : {}),
          };
        } catch (error) {
          return { ...base, configured: true, reachable: false, connected: false, detail: (error as Error).message };
        }
      }),
    );
  }

  /** 海康：人机验证通过后发送短信验证码。 */
  async haikSendCode(raw: unknown): Promise<{ sent: true }> {
    const { origin } = this.require("haik");
    const body = (raw ?? {}) as { phone?: unknown; captchaVerifyParam?: unknown };
    const phone = parsePhone(body.phone);
    if (typeof body.captchaVerifyParam !== "string" || !body.captchaVerifyParam || body.captchaVerifyParam.length > 12000) throw new InvalidInput("请先完成人机验证");
    await this.call(origin, "/api/camera", { action: "send_code", phone, captchaVerifyParam: body.captchaVerifyParam });
    return { sent: true };
  }

  /** 海康：手机号 + 短信验证码登录。 */
  async haikLogin(raw: unknown): Promise<{ ok: true }> {
    const { origin } = this.require("haik");
    const body = (raw ?? {}) as { phone?: unknown; code?: unknown };
    const phone = parsePhone(body.phone);
    if (typeof body.code !== "string" || !/^\d{4,8}$/.test(body.code.trim())) throw new InvalidInput("请输入短信验证码");
    await this.call(origin, "/api/camera", { action: "login", phone, code: body.code.trim() });
    return { ok: true };
  }

  /** 天翼：获取官方登录页地址；用户登录后把浏览器跳转到的完整地址交回 tyslComplete。 */
  async tyslStart(): Promise<{ url: string; state: string; expiresIn: number }> {
    const { origin } = this.require("tysl");
    return this.call(origin, "/api/action", { action: "login-start" });
  }

  async tyslComplete(raw: unknown): Promise<{ ok: true }> {
    const { origin } = this.require("tysl");
    const body = (raw ?? {}) as { state?: unknown; callbackUrl?: unknown };
    if (typeof body.state !== "string" || !/^[a-f0-9]{32}$/.test(body.state)) throw new InvalidInput("登录状态无效，请重新发起登录");
    if (typeof body.callbackUrl !== "string" || !body.callbackUrl.trim()) throw new InvalidInput("请粘贴官方登录完成后的完整返回地址");
    await this.call(origin, "/api/login/complete", { state: body.state, callbackUrl: body.callbackUrl.trim() });
    return { ok: true };
  }
}

function parsePhone(value: unknown): string {
  const phone = typeof value === "string" ? value.replace(/\s|-/g, "") : "";
  if (!PHONE_RE.test(phone)) throw new InvalidInput("请输入 11 位手机号");
  return phone;
}

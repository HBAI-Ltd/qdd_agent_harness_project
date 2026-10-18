import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { link, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { LoadedConfig } from "../config.js";

/** 网关 token：优先读环境变量，否则读取/生成工作区下的 .gateway-token（仅本人可读）。 */
export async function resolveGatewayToken({ config, paths }: LoadedConfig): Promise<{ token: string; source: string }> {
  const fromEnv = process.env[config.gateway.tokenEnv];
  if (fromEnv) {
    if (fromEnv.length < 16) throw new Error(`${config.gateway.tokenEnv} 至少需要 16 个字符`);
    return { token: fromEnv, source: `环境变量 ${config.gateway.tokenEnv}` };
  }
  try {
    const token = (await readFile(paths.token, "utf8")).trim();
    if (token) return { token, source: paths.token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // 首次运行
  }
  const token = randomBytes(24).toString("base64url");
  const temporary = `${paths.token}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${token}\n`, { mode: 0o600, flag: "wx" });
    // 完整文件就绪后原子发布，避免另一进程读到刚创建但尚未写完的 token。
    await link(temporary, paths.token);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = (await readFile(paths.token, "utf8")).trim();
    if (!existing) throw new Error(`网关 token 文件为空：${paths.token}`);
    return { token: existing, source: paths.token };
  } finally {
    await rm(temporary, { force: true });
  }
  return { token, source: `${paths.token}（新生成）` };
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class Auth {
  constructor(private readonly token: string) {}

  /** 页面级 token：只授权该页面声明的工具，泄露也拿不到网关 token。 */
  pageToken(slug: string): string {
    return createHmac("sha256", this.token).update(`page:${slug}`).digest("base64url").slice(0, 32);
  }

  /** 前端/管理调用：Authorization: Bearer <token>；EventSource 等无法设请求头的 GET 可用 ?access_token=。 */
  isAdmin(req: IncomingMessage, url: URL): boolean {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ") && safeEqual(header.slice(7).trim(), this.token)) return true;
    const query = url.searchParams.get("access_token");
    return req.method === "GET" && query !== null && safeEqual(query, this.token);
  }

  /** 页面运行时调用：X-QDD-Page + X-QDD-Page-Token。返回通过校验的页面 slug。 */
  pageOf(req: IncomingMessage): string | undefined {
    const slug = req.headers["x-qdd-page"];
    const token = req.headers["x-qdd-page-token"];
    if (typeof slug !== "string" || typeof token !== "string") return undefined;
    return safeEqual(token, this.pageToken(slug)) ? slug : undefined;
  }

  /** 静态页面访问：?page_token= 首次进入后写入路径级 cookie。 */
  pageCookieName(slug: string): string {
    return `qdd_pt_${slug}`;
  }

  pageCookie(req: IncomingMessage, slug: string): string | undefined {
    const name = this.pageCookieName(slug);
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === name) return v.join("=");
    }
    return undefined;
  }
}

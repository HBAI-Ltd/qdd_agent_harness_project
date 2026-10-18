import type { ConnectorView } from "@qdd/shared";
import type { DataSources } from "../datasource/registry.js";

export const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 10_000;
const CAPTURE_PATH = /^\/captures\/[a-f0-9]{32}\/frame_[0-9]{6}\.jpg$/;
const CAPTURE_PROVIDERS = ["haik", "tysl", "ezviz"] as const;

export class ChatImageError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** 只使用运行时已安装、已成功加载的摄像头连接器，不把配置或前端传入的地址视为授权。 */
export function chatImageOrigins(
  sources: Pick<DataSources, "mcpServers" | "tools" | "warnings">,
  connectors: readonly ConnectorView[],
): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const provider of CAPTURE_PROVIDERS) {
    const server = sources.mcpServers[provider];
    const connector = connectors.find((entry) => entry.id === `mcp:${provider}` && entry.type === "camera");
    if (!server || connector?.status !== "connected") continue;
    if (!sources.tools.some((tool) => tool.source === `mcp:${provider}`)) continue;
    if (sources.warnings.some((warning) => warning.startsWith(`MCP 服务 ${provider} 接入失败`))) continue;
    try {
      const url = new URL(server.url);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) origins.add(url.origin);
    } catch { /* 无效连接地址不提供图片读取权限。 */ }
  }
  return origins;
}

function captureUrl(body: unknown, origins: ReadonlySet<string>): URL {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ChatImageError(400, "图片请求必须包含 url");
  const value = (body as Record<string, unknown>).url;
  if (Object.keys(body).some((key) => key !== "url") || typeof value !== "string" || value.length > 2048) {
    throw new ChatImageError(400, "图片请求必须包含有效的 url");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ChatImageError(400, "截图地址格式不正确");
  }
  // 精确匹配原始地址，拒绝 URL 解析器会归一化的编码、斜杠、路径穿越与凭据。
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !CAPTURE_PATH.test(url.pathname) || value !== `${url.origin}${url.pathname}`) {
    throw new ChatImageError(400, "只支持摄像头采集的 JPEG 截图地址");
  }
  if (!origins.has(url.origin)) throw new ChatImageError(403, "该截图来源未连接或无权访问，请检查摄像头连接器");
  return url;
}

/** 管理端鉴权后读取有限的 JPEG 产物；不转发浏览器或 MCP 凭据，不跟随重定向。 */
export async function readChatImage(
  body: unknown,
  origins: ReadonlySet<string>,
  options: { timeoutMs?: number } = {},
): Promise<Buffer> {
  const url = captureUrl(body, origins);
  const signal = AbortSignal.timeout(options.timeoutMs ?? IMAGE_TIMEOUT_MS);
  let response: Response | undefined;
  try {
    response = await fetch(url, { headers: { Accept: "image/jpeg" }, redirect: "manual", signal });
    if (response.status === 404 || response.status === 410) throw new ChatImageError(404, "截图已不存在或已过期，请重新取图");
    if (response.status === 401 || response.status === 403) throw new ChatImageError(403, "摄像头源拒绝访问截图，请检查连接器登录状态");
    if (response.status !== 200) throw new ChatImageError(502, "摄像头源未返回有效截图");
    if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "image/jpeg" || !response.body) {
      throw new ChatImageError(502, "摄像头源返回的内容不是 JPEG 图片");
    }
    const declaredSize = Number(response.headers.get("content-length"));
    if (declaredSize > MAX_CHAT_IMAGE_BYTES) throw new ChatImageError(413, "截图超过 10 MiB，请降低采集分辨率");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_CHAT_IMAGE_BYTES) throw new ChatImageError(413, "截图超过 10 MiB，请降低采集分辨率");
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks, size);
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff
      || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
      throw new ChatImageError(502, "摄像头源返回的 JPEG 图片不完整或格式无效");
    }
    return bytes;
  } catch (error) {
    if (error instanceof ChatImageError) throw error;
    if (signal.aborted) throw new ChatImageError(504, "读取摄像头截图超时，请重试");
    throw new ChatImageError(502, "无法读取摄像头截图，请检查本地摄像头服务");
  } finally {
    await response?.body?.cancel().catch(() => {});
  }
}

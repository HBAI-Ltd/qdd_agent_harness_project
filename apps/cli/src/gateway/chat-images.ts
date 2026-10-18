import type { ConnectorView } from "@qdd/shared";
import type { DataSources } from "../datasource/registry.js";

export const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_CHAT_VIDEO_BYTES = 256 * 1024 * 1024;
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

function captureUrl(body: unknown, origins: ReadonlySet<string>, video = false): URL {
  const label = video ? "录像" : "图片";
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ChatImageError(400, `${label}请求必须包含 url`);
  const value = (body as Record<string, unknown>).url;
  if (Object.keys(body).some((key) => key !== "url") || typeof value !== "string" || value.length > 2048) {
    throw new ChatImageError(400, `${label}请求必须包含有效的 url`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ChatImageError(400, video ? "录像地址格式不正确" : "截图地址格式不正确");
  }
  // 精确匹配原始地址，拒绝 URL 解析器会归一化的编码、斜杠、路径穿越与凭据。
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !(video ? /^\/captures\/[a-f0-9]{32}\/recording\.mp4$/ : CAPTURE_PATH).test(url.pathname) || value !== `${url.origin}${url.pathname}`) {
    throw new ChatImageError(400, video ? "只支持摄像头采集的 MP4 录像地址" : "只支持摄像头采集的 JPEG 截图地址");
  }
  if (!origins.has(url.origin)) throw new ChatImageError(403, video ? "该录像来源未连接或无权访问，请检查摄像头连接器" : "该截图来源未连接或无权访问，请检查摄像头连接器");
  return url;
}

/** 管理端鉴权后读取有限的 JPEG / MP4 产物；不转发浏览器或 MCP 凭据，不跟随重定向。 */
async function readChatArtifact(
  body: unknown,
  origins: ReadonlySet<string>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
  video = false,
): Promise<Buffer> {
  const url = captureUrl(body, origins, video);
  const label = video ? "录像" : "截图";
  const limit = video ? MAX_CHAT_VIDEO_BYTES : MAX_CHAT_IMAGE_BYTES;
  const mime = video ? "video/mp4" : "image/jpeg";
  const timeout = AbortSignal.timeout(options.timeoutMs ?? (video ? 120_000 : IMAGE_TIMEOUT_MS));
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  let response: Response | undefined;
  try {
    response = await fetch(url, { headers: { Accept: mime }, redirect: "manual", signal });
    if (response.status === 404 || response.status === 410) throw new ChatImageError(404, video ? "录像已不存在或已过期，请重新采集" : "截图已不存在或已过期，请重新取图");
    if (response.status === 401 || response.status === 403) throw new ChatImageError(403, `摄像头源拒绝访问${label}，请检查连接器登录状态`);
    if (response.status !== 200) throw new ChatImageError(502, `摄像头源未返回有效${label}`);
    if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== mime || !response.body) {
      throw new ChatImageError(502, video ? "摄像头源返回的内容不是 MP4 录像" : "摄像头源返回的内容不是 JPEG 图片");
    }
    const declaredSize = Number(response.headers.get("content-length"));
    if (declaredSize > limit) throw new ChatImageError(413, video ? "录像超过 256 MiB，请缩短采集时长" : "截图超过 10 MiB，请降低采集分辨率");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new ChatImageError(413, video ? "录像超过 256 MiB，请缩短采集时长" : "截图超过 10 MiB，请降低采集分辨率");
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks, size);
    if (video) {
      if (bytes.length < 12 || bytes.toString("ascii", 4, 8) !== "ftyp") {
        throw new ChatImageError(502, "摄像头源返回的 MP4 录像格式无效");
      }
    } else if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff
      || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
      throw new ChatImageError(502, "摄像头源返回的 JPEG 图片不完整或格式无效");
    }
    return bytes;
  } catch (error) {
    if (error instanceof ChatImageError) throw error;
    if (signal.aborted) throw new ChatImageError(504, video ? "读取摄像头录像超时，请重试" : "读取摄像头截图超时，请重试");
    throw new ChatImageError(502, video ? "无法读取摄像头录像，请检查本地摄像头服务" : "无法读取摄像头截图，请检查本地摄像头服务");
  } finally {
    await response?.body?.cancel().catch(() => {});
  }
}

export function readChatImage(body: unknown, origins: ReadonlySet<string>, options: { timeoutMs?: number } = {}): Promise<Buffer> {
  return readChatArtifact(body, origins, options);
}

/** Only installed camera origins and their generated MP4 artifact are readable. */
export function readChatVideo(body: unknown, origins: ReadonlySet<string>, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Buffer> {
  return readChatArtifact(body, origins, options, true);
}

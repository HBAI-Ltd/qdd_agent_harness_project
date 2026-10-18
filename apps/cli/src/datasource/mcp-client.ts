import { readFile } from "node:fs/promises";
import { HARNESS_VERSION, SERVICE_NAME, type JsonObject, type McpServerConfig, type ToolSpec } from "@qdd/shared";
import { contentImages, type ImageReceiver } from "../tool-images.js";

export interface McpTool extends ToolSpec {
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

interface RpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { message: string };
}

const PROTOCOL_VERSION = "2025-06-18";
const TIMEOUT_MS = 60_000;

/** MCP Streamable HTTP 客户端：JSON-RPC over POST，响应可为 JSON 或 SSE。 */
export class McpClient {
  private sessionId: string | undefined;
  private nextId = 1;
  private readonly headers: Record<string, string>;

  constructor(
    readonly name: string,
    private readonly config: McpServerConfig,
  ) {
    if (config.bearerTokenEnv !== undefined && config.bearerTokenFile !== undefined) {
      throw new Error(`MCP 服务 ${name} 的 bearerTokenEnv 与 bearerTokenFile 只能配置一个`);
    }
    this.headers = { ...config.headers };
    if (config.bearerTokenEnv) {
      const token = process.env[config.bearerTokenEnv];
      if (!token) throw new Error(`缺少环境变量 ${config.bearerTokenEnv}`);
      this.headers.Authorization = `Bearer ${token}`;
    }
  }

  async start(): Promise<void> {
    this.sessionId = undefined;
    if (this.config.bearerTokenFile !== undefined) {
      delete this.headers.Authorization;
      let token: string;
      try {
        token = (await readFile(this.config.bearerTokenFile, "utf8")).trim();
      } catch {
        throw new Error(`MCP 服务 ${this.name} 无法读取 bearerTokenFile，请先启动本地服务并检查密钥文件`);
      }
      if (!/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) throw new Error(`MCP 服务 ${this.name} 的 bearerTokenFile 为空或格式无效`);
      this.headers.Authorization = `Bearer ${token}`;
    }
    await this.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: SERVICE_NAME, version: HARNESS_VERSION },
    });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = (await this.request("tools/list", cursor ? { cursor } : {})) as { tools: McpTool[]; nextCursor?: string };
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: JsonObject, onImages?: ImageReceiver): Promise<unknown> {
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: { type: string; text?: string }[];
      structuredContent?: unknown;
      isError?: boolean;
    };
    const text = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (result.isError) throw new Error(text || `MCP 工具 ${name} 返回错误`);
    if (onImages) onImages(contentImages(result.content));
    if (result.structuredContent !== undefined) return result.structuredContent;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    await fetch(this.config.url, { method: "DELETE", headers: this.requestHeaders(), signal: AbortSignal.timeout(3000) }).catch(() => {});
    this.sessionId = undefined;
  }

  /** 会话过期（404）时重新初始化一次。 */
  private async request(method: string, params: JsonObject): Promise<unknown> {
    try {
      return await this.rpc(method, params);
    } catch (error) {
      if (!(error instanceof SessionExpired)) throw error;
      await this.start();
      return this.rpc(method, params);
    }
  }

  private async rpc(method: string, params: JsonObject): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params });
    const message = await readResponse(res, id);
    if (!message) throw new Error(`MCP 服务 ${this.name} 未响应 ${method}`);
    if (message.error) throw new Error(`MCP ${this.name}: ${message.error.message}`);
    return message.result;
  }

  private requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    return headers;
  }

  private async post(body: JsonObject): Promise<Response> {
    const res = await fetch(this.config.url, {
      method: "POST",
      headers: this.requestHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404 && this.sessionId) throw new SessionExpired();
    if (!res.ok) throw new Error(`MCP 服务 ${this.name} 返回 HTTP ${res.status}：${(await res.text()).slice(0, 300)}`);
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    return res;
  }
}

class SessionExpired extends Error {}

async function readResponse(res: Response, id: number): Promise<RpcResponse | undefined> {
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = (await res.json()) as RpcResponse | RpcResponse[];
    return (Array.isArray(body) ? body : [body]).find((m) => m.id === id);
  }
  if (!type.includes("text/event-stream") || !res.body) return undefined;
  // SSE：逐个事件解析，直到拿到对应 id 的响应（服务端发来的通知/请求忽略）。
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true }).replace(/\r\n/g, "\n");
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        const message = JSON.parse(data) as RpcResponse;
        if (message.id === id && ("result" in message || "error" in message)) {
          await res.body.cancel().catch(() => {});
          return message;
        }
      } catch {
        // 忽略无法解析的事件
      }
    }
  }
  return undefined;
}

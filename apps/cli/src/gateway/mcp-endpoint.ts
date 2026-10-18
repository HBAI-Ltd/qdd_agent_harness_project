import { HARNESS_VERSION, SERVICE_NAME, type JsonObject } from "@qdd/shared";
import type { DataSources } from "../datasource/registry.js";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: JsonObject;
}

/**
 * 网关自带的 MCP 端点（Streamable HTTP，无状态，只返回 JSON）。
 * 对外暴露内置门店只读工具，供其它 agent / IDE 接入。返回 undefined 表示通知，无需响应体。
 */
export async function handleMcp(sources: DataSources, raw: unknown): Promise<JsonObject | undefined> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  const message = raw as RpcRequest;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string" || !message.method
    || (message.id !== undefined && message.id !== null && typeof message.id !== "string" && (typeof message.id !== "number" || !Number.isFinite(message.id)))
    || (message.params !== undefined && (!message.params || typeof message.params !== "object" || Array.isArray(message.params)))) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  }
  if (message.id === undefined) return undefined;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: message.id, result });
  const fail = (code: number, msg: string) => ({ jsonrpc: "2.0", id: message.id, error: { code, message: msg } });
  const tools = sources.tools.filter((t) => t.source === "store" && !t.mutating);

  switch (message.method) {
    case "initialize":
      return ok({
        protocolVersion: (message.params?.protocolVersion as string | undefined) ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: SERVICE_NAME, version: HARNESS_VERSION },
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: tools.map((t) => ({
          name: t.name.replace(/^store__/, ""),
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: true },
        })),
      });
    case "tools/call": {
      if (typeof message.params?.name !== "string" || (message.params.arguments !== undefined && (!message.params.arguments || typeof message.params.arguments !== "object" || Array.isArray(message.params.arguments)))) return fail(-32602, "Invalid tool arguments");
      const tool = tools.find((t) => t.name === `store__${String(message.params?.name)}`);
      if (!tool) return fail(-32602, `Unknown tool ${String(message.params?.name)}`);
      try {
        const data = await tool.call((message.params?.arguments as JsonObject | undefined) ?? {});
        return ok({ content: [{ type: "text", text: JSON.stringify(data) }] });
      } catch (error) {
        return ok({ content: [{ type: "text", text: (error as Error).message }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${message.method}`);
  }
}

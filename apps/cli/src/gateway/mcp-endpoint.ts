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
export async function handleMcp(sources: DataSources, message: RpcRequest): Promise<JsonObject | undefined> {
  if (message.id === undefined || message.id === null) return undefined;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: message.id, result });
  const fail = (code: number, msg: string) => ({ jsonrpc: "2.0", id: message.id, error: { code, message: msg } });
  const tools = sources.tools.filter((t) => t.source === "store");

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

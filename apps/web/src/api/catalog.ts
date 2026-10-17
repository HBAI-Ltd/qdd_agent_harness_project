import type { ToolInfo } from "@qdd/shared";
import { GatewayError, normalizeGatewayUrl } from "./workspace";

export async function listTools(base: string, token: string, signal?: AbortSignal): Promise<ToolInfo[]> {
  const response = await fetch(`${normalizeGatewayUrl(base)}/api/tools`, {
    headers: { Authorization: `Bearer ${token.trim()}` },
    signal: signal ?? null,
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error : `工具列表读取失败（HTTP ${response.status}）。`;
    throw new GatewayError(response.status, message);
  }
  return response.json() as Promise<ToolInfo[]>;
}

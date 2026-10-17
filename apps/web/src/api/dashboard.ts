import type { Overview, PendingItem } from "@qdd/shared";
import { gatewayJson } from "./workspace";

export function getOverview(base: string, token: string, signal?: AbortSignal): Promise<Overview> {
  return gatewayJson(base, token, "/api/overview", { signal: signal ?? null });
}

export function listPending(base: string, token: string, signal?: AbortSignal): Promise<PendingItem[]> {
  return gatewayJson(base, token, "/api/pending", { signal: signal ?? null });
}

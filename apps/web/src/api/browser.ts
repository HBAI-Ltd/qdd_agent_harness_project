import type { BrowserInput, BrowserSessionState, BrowserStreamEvent } from "@qdd/shared";
import { gatewayJson, gatewayStream } from "./workspace";

const browserPath = (id: string) => `/api/browser/${encodeURIComponent(id)}`;

export function getBrowser(base: string, token: string, id: string, signal: AbortSignal): Promise<BrowserSessionState> {
  return gatewayJson(base, token, browserPath(id), { signal });
}

export function closeBrowser(base: string, token: string, id: string, sessionId: string, signal?: AbortSignal): Promise<BrowserSessionState> {
  return gatewayJson(base, token, browserPath(id), { method: "DELETE", body: JSON.stringify({ sessionId }), signal: signal ?? null });
}

export function browserEvents(base: string, token: string, id: string, onEvent: (event: BrowserStreamEvent) => void, signal: AbortSignal): Promise<void> {
  return gatewayStream(base, token, `${browserPath(id)}/stream`, onEvent, signal);
}

export function browserInput(base: string, token: string, id: string, tabId: string, input: BrowserInput, signal?: AbortSignal): Promise<BrowserSessionState> {
  return gatewayJson(base, token, `${browserPath(id)}/input`, {
    method: "POST", body: JSON.stringify({ ...input, tabId }), signal: signal ?? null,
    ...(input.type === "release" ? { keepalive: true } : {}),
  });
}

import type {
  AnswerBody,
  ApprovalBody,
  ClarifyAnswers,
  CreateWishBody,
  GatewayEvent,
  PageView,
  SendMessageBody,
  SessionDetail,
  SessionEvent,
  SessionMeta,
} from "@qdd/shared";

export type { ClarifyAnswers, GatewayEvent, PageView, SessionDetail, SessionEvent, SessionMeta } from "@qdd/shared";

declare const __QDD_GATEWAY_URL__: string;

export const DEFAULT_GATEWAY_URL = typeof __QDD_GATEWAY_URL__ === "string"
  ? __QDD_GATEWAY_URL__ : "http://127.0.0.1:5173";

export class GatewayError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "GatewayError";
  }
}

export function normalizeGatewayUrl(base: string): string {
  let url: URL;
  try {
    url = new URL(base.trim());
  } catch {
    throw new Error("请输入完整网关地址，例如 http://127.0.0.1:5173。");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("网关地址须使用 HTTP 或 HTTPS，且不能包含账号、查询参数或锚点。");
  }
  return url.href.replace(/\/+$/, "");
}

async function request(base: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token.trim()}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${normalizeGatewayUrl(base)}${path}`, { ...init, headers });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error : `网关请求失败（HTTP ${response.status}）。`;
    throw new GatewayError(response.status, message);
  }
  return response;
}

async function json<T>(base: string, token: string, path: string, init: RequestInit = {}): Promise<T> {
  return (await request(base, token, path, init)).json() as Promise<T>;
}

export { json as gatewayJson };

export function listSessions(base: string, token: string, signal?: AbortSignal): Promise<SessionMeta[]> {
  return json(base, token, "/api/sessions", { signal: signal ?? null });
}

export function getSession(base: string, token: string, id: string, signal?: AbortSignal): Promise<SessionDetail> {
  return json(base, token, `/api/sessions/${encodeURIComponent(id)}`, { signal: signal ?? null });
}

export function listPages(base: string, token: string, signal?: AbortSignal): Promise<PageView[]> {
  return json(base, token, "/api/pages", { signal: signal ?? null });
}

export function setPagePinned(base: string, token: string, slug: string, pinned: boolean, signal?: AbortSignal): Promise<Pick<PageView, "slug" | "pinnedAt">> {
  return json(base, token, `/api/pages/${encodeURIComponent(slug)}/pin`, {
    method: pinned ? "PUT" : "DELETE", signal: signal ?? null,
  });
}

export function createWish(base: string, token: string, body: CreateWishBody, signal?: AbortSignal): Promise<SessionMeta> {
  return json(base, token, "/api/wishes", { method: "POST", body: JSON.stringify(body), signal: signal ?? null });
}

export function sendMessage(base: string, token: string, id: string, text: string, signal?: AbortSignal): Promise<SessionMeta> {
  const body: SendMessageBody = { text };
  return json(base, token, `/api/sessions/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify(body), signal: signal ?? null });
}

export async function answerQuestions(base: string, token: string, id: string, requestId: string, answers: ClarifyAnswers, signal?: AbortSignal): Promise<void> {
  const body: AnswerBody = { answers };
  await json(base, token, `/api/sessions/${encodeURIComponent(id)}/questions/${encodeURIComponent(requestId)}`, {
    method: "POST", body: JSON.stringify(body), signal: signal ?? null,
  });
}

export async function resolveApproval(base: string, token: string, id: string, requestId: string, approved: boolean, signal?: AbortSignal): Promise<void> {
  const body: ApprovalBody = { approved };
  await json(base, token, `/api/sessions/${encodeURIComponent(id)}/approvals/${encodeURIComponent(requestId)}`, {
    method: "POST", body: JSON.stringify(body), signal: signal ?? null,
  });
}

export function cancelSession(base: string, token: string, id: string, signal?: AbortSignal): Promise<SessionMeta> {
  return json(base, token, `/api/sessions/${encodeURIComponent(id)}/cancel`, { method: "POST", signal: signal ?? null });
}

// fetch 支持 Authorization 请求头，无需把管理 token 放进 SSE 的 URL。
async function stream<T>(base: string, token: string, path: string, onEvent: (event: T) => void, signal: AbortSignal, onOpen?: () => void): Promise<void> {
  // Live streams must not participate in the browser's response cache.
  const response = await request(base, token, path, { headers: { Accept: "text/event-stream" }, cache: "no-store", signal });
  if (!response.body || !response.headers.get("Content-Type")?.includes("text/event-stream")) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("网关未返回有效的事件流。");
  }
  const reader = response.body.getReader();
  // Cancel even a pending, silent read; cleanup cannot depend on the next SSE ping.
  const cancelReader = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancelReader, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const line = (value: string) => {
    if (!value) {
      if (data.length) onEvent(JSON.parse(data.join("\n")) as T);
      data = [];
    } else if (value.startsWith("data:")) {
      data.push(value.slice(5).replace(/^ /, ""));
    }
  };
  try {
    if (signal.aborted) return;
    onOpen?.();
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (signal.aborted) return;
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        line(buffer.slice(0, newline).replace(/\r$/, ""));
        buffer = buffer.slice(newline + 1);
      }
      if (chunk.done) {
        if (buffer) line(buffer.replace(/\r$/, ""));
        line("");
        break;
      }
    }
  } finally {
    signal.removeEventListener("abort", cancelReader);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export { stream as gatewayStream };

export function sessionEvents(base: string, token: string, id: string, since: number, onEvent: (event: SessionEvent) => void, signal: AbortSignal, onOpen?: () => void): Promise<void> {
  return stream(base, token, `/api/sessions/${encodeURIComponent(id)}/events?since=${since}`, onEvent, signal, onOpen);
}

export function gatewayEvents(base: string, token: string, onEvent: (event: GatewayEvent) => void, signal: AbortSignal, onOpen?: () => void): Promise<void> {
  return stream(base, token, "/api/events", onEvent, signal, onOpen);
}

export async function getStyle(base: string, token: string, signal?: AbortSignal): Promise<string> {
  return (await request(base, token, "/api/style", { signal: signal ?? null })).text();
}

export async function saveStyle(base: string, token: string, text: string, signal?: AbortSignal): Promise<string> {
  return (await request(base, token, "/api/style", { method: "PUT", headers: { "Content-Type": "text/plain; charset=utf-8" }, body: text, signal: signal ?? null })).text();
}

export async function resetStyle(base: string, token: string, signal?: AbortSignal): Promise<string> {
  return (await request(base, token, "/api/style", { method: "DELETE", signal: signal ?? null })).text();
}

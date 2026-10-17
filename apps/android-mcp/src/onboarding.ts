import { isIP } from "node:net";

/** Registration only advances the connection guide; it never opens an input lease. */
export function boardSetupOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("控制板引导地址无效，请重新自动查找。"); }
  const [a, b] = url.hostname.split(".").map(Number);
  const privateAddress = isIP(url.hostname) === 4 && (a === 10 || a === 127
    || (a === 192 && b === 168) || (a === 172 && b! >= 16 && b! <= 31));
  if (url.protocol !== "http:" || !privateAddress || url.username || url.password
    || url.search || url.hash || url.pathname !== "/") {
    throw new Error("控制板引导地址应为内网 HTTP 地址。");
  }
  return url.origin;
}

export function startBoardRegistration(setupUrl: string, port: number,
  options: { fetch?: typeof globalThis.fetch; intervalMs?: number; timeoutMs?: number } = {}): { close(): Promise<void> } {
  const endpoint = new URL("/api/pc", boardSetupOrigin(setupUrl));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("电脑服务端口无效。");
  const fetcher = options.fetch ?? globalThis.fetch;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: AbortController | undefined;
  let pending: Promise<void>;
  const register = async (): Promise<void> => {
    active = new AbortController();
    const timeout = setTimeout(() => active?.abort(), options.timeoutMs ?? 1200);
    timeout.unref();
    try {
      const response = await fetcher(endpoint, { method: "POST", redirect: "error", signal: active.signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ port }) });
      // No registration response is required; cancel it instead of accumulating an unbounded body.
      await response.body?.cancel();
    } catch { /* Wi-Fi reconnects independently; registration is advisory and retried. */ }
    finally {
      clearTimeout(timeout); active = undefined;
      if (!closed) { timer = setTimeout(() => { pending = register(); }, options.intervalMs ?? 5000); timer.unref(); }
    }
  };
  pending = register();
  return { async close() { closed = true; clearTimeout(timer); active?.abort(); await pending; } };
}

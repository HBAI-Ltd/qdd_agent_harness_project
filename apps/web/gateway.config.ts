interface GatewayAddress {
  host?: string;
  port?: number;
}

function validateOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash || url.href !== `${url.origin}/`) {
      throw new Error("Invalid gateway origin");
    }
    return url.origin;
  } catch {
    // Never echo the supplied URL: it may contain credentials or query tokens.
    throw new Error("网关地址无效，请使用不含账号、路径、查询参数或锚点的 HTTP(S) 源地址。");
  }
}

/** Resolve only the public gateway origin; callers retain ownership of env loading. */
export function resolveGatewayTarget(env: Record<string, string>, gateway: GatewayAddress = {}): string {
  if (env.API_PROXY_TARGET !== undefined) return validateOrigin(env.API_PROXY_TARGET);

  const portValue = env.PORT ?? gateway.port ?? 5173;
  const port = typeof portValue === "string" ? Number(portValue) : portValue;
  if ((typeof portValue === "string" && !portValue.trim())
    || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("网关端口无效，请将 PORT 或 gateway.port 设置为 0-65535 之间的整数。");
  }

  let host = env.HOST ?? gateway.host ?? "127.0.0.1";
  if (host === "0.0.0.0" || host === "::" || host === "[::]") host = "127.0.0.1";
  const displayHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return validateOrigin(`http://${displayHost}:${port}`);
}

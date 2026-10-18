import path from "node:path";

/**
 * 页面守卫：agent 写入的每个文件都要过这里。
 * 目标是「零后端、零 SQL、只用白名单在线包」，违规内容在落盘前被拒绝。
 */

const ALLOWED_EXT = new Set([".html", ".css", ".js", ".svg", ".json"]);
/** 由 harness 写入的数据快照目录，agent 不能直接写。 */
export const DATA_DIR = "data";
/** SVG/XML 命名空间等非网络引用。 */
const IMPLICIT_HOSTS = ["www.w3.org"];

const RULES: { re: RegExp; reason: string }[] = [
  { re: /\bfetch\s*\(/, reason: "禁止 fetch()：页面零后端，数据只能来自 data/*.js 快照" },
  { re: /\bXMLHttpRequest\b|\$\.(ajax|get|post|getJSON)\s*\(|\baxios\b/, reason: "禁止 Ajax 请求" },
  { re: /\b(WebSocket|EventSource|RTCPeerConnection|WebTransport)\b/, reason: "禁止长连接/实时通道" },
  { re: /\bsendBeacon\b/, reason: "禁止上报请求" },
  { re: /<form\b[^>]*\b(action|method)\s*=/i, reason: "禁止表单提交到服务端" },
  { re: /qdd-gaps/i, reason: "禁止改动 harness 注入的能力缺口说明" },
  { re: /\beval\s*\(|\bnew\s+Function\s*\(|\bimportScripts\s*\(/, reason: "禁止动态执行代码（无法审查）" },
  {
    re: /\b(CREATE\s+TABLE|INSERT\s+INTO|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|SELECT\s+[\w*,\s.()]{1,120}\s+FROM\s+\w+)/i,
    reason: "禁止 SQL：用 JavaScript 数组运算处理数据",
  },
  { re: /\b(sql\.js|sql-wasm|alasql|pglite|duckdb|wa-sqlite|absurd-sql|sqlite)\b/i, reason: "禁止浏览器内 SQL 引擎" },
  { re: /\b(firebase|supabase|pocketbase|leancloud|appwrite|cloudbase)\b/i, reason: "禁止接入 BaaS/云后端" },
  { re: /\b(require\s*\(\s*['"](http|express|fs|net|child_process)['"]|createServer\s*\(|process\.env)/, reason: "禁止服务端代码" },
];

function hostAllowed(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase();
  return [...allowlist, ...IMPLICIT_HOSTS].some((a) => h === a || h.endsWith(`.${a}`));
}

/** 校验相对页面目录的路径，返回规范化后的路径。 */
export function checkPath(rel: string): { path: string; violations: string[] } {
  const violations: string[] = [];
  if (!rel || path.isAbsolute(rel) || rel.includes("\\") || rel.includes("\0")) {
    return { path: rel, violations: ["路径必须是页面目录内的相对路径"] };
  }
  const normalized = path.posix.normalize(rel);
  if (normalized.startsWith("..") || normalized.split("/").some((seg) => seg.startsWith("."))) {
    violations.push("禁止写出页面目录或写入隐藏文件");
  }
  if (normalized === DATA_DIR || normalized.startsWith(`${DATA_DIR}/`)) {
    violations.push("data/ 由 harness 根据数据源快照生成，请使用 snapshot_data，不得手写或篡改数据");
  }
  if (!ALLOWED_EXT.has(path.posix.extname(normalized).toLowerCase())) {
    violations.push(`只允许静态文件 ${[...ALLOWED_EXT].join(" ")}（零后端）`);
  }
  return { path: normalized, violations };
}

export function checkContent(content: string, cdnAllowlist: string[]): string[] {
  const violations = RULES.filter((r) => r.re.test(content)).map((r) => r.reason);
  const hosts = new Set<string>();
  for (const m of content.matchAll(/\b(?:https?|wss?):\/\/([^\s"'`)<>/?#:]+)/gi)) hosts.add(m[1]!);
  for (const m of content.matchAll(/["'(]\/\/([^\s"'`)<>/?#:]+\.[a-z]{2,})/gi)) hosts.add(m[1]!);
  for (const host of hosts) {
    if (!hostAllowed(host, cdnAllowlist)) {
      violations.push(`外部地址 ${host} 不在在线包白名单（${cdnAllowlist.join(", ")}）`);
    }
  }
  return violations;
}

export function checkFile(rel: string, content: string, cdnAllowlist: string[]): { path: string; violations: string[] } {
  const result = checkPath(rel);
  result.violations.push(...checkContent(content, cdnAllowlist));
  return result;
}

/** 接受明确的 HTTPS 视频源，或单独的 "*" 全视频源开关；不接受 URL 通配符或 CSP 指令。 */
export function parseMediaOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("mediaOrigins 必须是 HTTPS origin 数组或 [\"*\"]");
  if (value.length === 1 && value[0] === "*") return ["*"];
  return [...new Set(value.map((entry: unknown, index: number) => {
    const invalid = () => new Error(`mediaOrigins 第 ${index + 1} 项必须是无路径、凭据或通配符的 HTTPS origin`);
    if (typeof entry !== "string" || !/^https:\/\/[^\s/?#@\\;'"<>*%]+\/?$/i.test(entry)) throw invalid();
    let url: URL;
    try { url = new URL(entry); } catch { throw invalid(); }
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw invalid();
    return url.origin;
  }))];
}

/** 浏览器侧兜底：视频来源按显式配置放行，业务请求及表单仍受守卫限制。 */
export function pageCsp(cdnAllowlist: string[], frameAncestors: string[] = [], mediaOrigins: string[] = []): string {
  const cdn = cdnAllowlist.map((h) => `https://${h}`).join(" ");
  const origins = parseMediaOrigins(mediaOrigins);
  const allMedia = origins.length === 1 && origins[0] === "*";
  const media = origins.join(" ");
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${media ? " 'wasm-unsafe-eval'" : ""} ${cdn}`.trim(),
    `style-src 'self' 'unsafe-inline' ${cdn}`,
    `font-src 'self' data: ${cdn}`,
    "img-src 'self' data: blob:",
    allMedia ? "connect-src 'self' http: https: ws: wss:" : `connect-src 'self' ${media}`.trim(),
    allMedia ? "media-src 'self' http: https: blob: data:" : `media-src 'self' blob: ${media}`.trim(),
    "worker-src 'self' blob:",
    "form-action 'none'",
    "frame-src 'self'",
    `frame-ancestors 'self' ${frameAncestors.join(" ")}`.trim(),
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ");
}

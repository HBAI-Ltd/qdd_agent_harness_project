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

/** 浏览器侧兜底：即使守卫被绕过，CSP 也会阻止页面联网与提交。 */
export function pageCsp(cdnAllowlist: string[], frameAncestors: string[] = []): string {
  const cdn = cdnAllowlist.map((h) => `https://${h}`).join(" ");
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' ${cdn}`,
    `style-src 'self' 'unsafe-inline' ${cdn}`,
    `font-src 'self' data: ${cdn}`,
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "form-action 'none'",
    "frame-src 'self'",
    `frame-ancestors 'self' ${frameAncestors.join(" ")}`.trim(),
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ");
}

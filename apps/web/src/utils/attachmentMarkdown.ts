export interface MarkdownAttachment {
  id: string;
  name: string;
  size: number;
  markdown: string;
}

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENT_MARKDOWN_BYTES = 512 * 1024;
// Gateway requests are limited to 1 MiB. Reserve room for session and model options.
export const MAX_MESSAGE_JSON_BYTES = 900 * 1024;
const MAX_PDF_PAGES = 100;

const CODE_LANGUAGES: Readonly<Record<string, string>> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  ts: "typescript", tsx: "tsx", py: "python", java: "java", c: "c",
  h: "c", cpp: "cpp", cs: "csharp", go: "go", rs: "rust", rb: "ruby",
  php: "php", swift: "swift", kt: "kotlin", sh: "bash", bash: "bash",
  ps1: "powershell", sql: "sql", html: "html", css: "css", scss: "scss",
  vue: "vue", xml: "xml", yaml: "yaml", yml: "yaml", toml: "toml",
  ini: "ini", json: "json", jsonl: "jsonl", log: "text", txt: "text",
};
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown"]);
export const ATTACHMENT_ACCEPT = [
  ...Object.keys(CODE_LANGUAGES), ...MARKDOWN_EXTENSIONS, "csv", "tsv", "pdf", "docx",
].map((extension) => `.${extension}`).join(",");

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, " ").trim() || "未命名附件";
}

function escapeInline(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\`*_[\]{}()#+.!|~-]/g, "\\$&");
}

function codeBlock(value: string, language: string): string {
  let longestFence = 2;
  for (const match of value.matchAll(/`+/g)) longestFence = Math.max(longestFence, match[0].length);
  const fence = "`".repeat(longestFence + 1);
  return `${fence}${language}\n${value}${value.endsWith("\n") ? "" : "\n"}${fence}`;
}

function decodeText(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  let value: string;
  try {
    value = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new Error("无法读取附件编码，请保存为 UTF-8 文本后重试。");
  }
  if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(value)) throw new Error("附件包含二进制内容，请选择文本、PDF 或 DOCX 文件。");
  return value.replace(/\r\n?/g, "\n");
}

function tableMarkdown(rows: readonly (readonly string[])[]): string {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (!width) return "";
  const rowMarkdown = (row: readonly string[]) => `| ${Array.from({ length: width }, (_, index) =>
    escapeInline(row[index] ?? "").replace(/\r\n?|\n/g, "<br>")).join(" | ")} |`;
  return [rowMarkdown(rows[0]!), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...rows.slice(1).map(rowMarkdown)].join("\n");
}

/** Parse quoted cells, embedded newlines and escaped quotes without losing columns. */
function delimitedMarkdown(value: string, delimiter: string): string {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closedQuote = false;
  const finishCell = () => { row.push(cell); cell = ""; closedQuote = false; };
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quoted) {
      if (char === '"' && value[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') { quoted = false; closedQuote = true; }
      else cell += char;
    } else if (char === delimiter) finishCell();
    else if (char === "\n") { finishCell(); rows.push(row); row = []; }
    else if (char === '"' && !cell && !closedQuote) quoted = true;
    else if (closedQuote && /\s/.test(char)) continue;
    else if (closedQuote || char === '"') throw new Error("CSV/TSV 引号格式不正确，请检查附件。");
    else cell += char;
  }
  if (quoted) throw new Error("CSV/TSV 引号未闭合，请检查附件。");
  if (cell || row.length || closedQuote) { finishCell(); rows.push(row); }
  return tableMarkdown(rows);
}

async function docxMarkdown(data: ArrayBuffer): Promise<string> {
  const [{ default: mammoth }, { default: TurndownService }] = await Promise.all([
    import("mammoth/mammoth.browser.js"), import("turndown"),
  ]);
  const result = await mammoth.convertToHtml({ arrayBuffer: data }, {
    externalFileAccess: false,
    // Attachments carry document text; avoid expanding embedded images into data URLs.
    convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
  });
  const converter = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  converter.remove(["img", "script", "style"]);
  converter.addRule("attachmentTables", {
    filter: "table",
    replacement: (_content, node) => {
      const rows = Array.from((node as HTMLElement).querySelectorAll("tr"), (row) =>
        Array.from(row.querySelectorAll("th, td"), (cell) => cell.textContent ?? ""));
      return `\n\n${tableMarkdown(rows)}\n\n`;
    },
  });
  return converter.turndown(result.value);
}

async function pdfMarkdown(data: ArrayBuffer): Promise<string> {
  const [pdfjs, { default: workerUrl }] = await Promise.all([
    import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url&no-inline"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(data) });
  try {
    const document = await loadingTask.promise;
    if (document.numPages > MAX_PDF_PAGES) throw new Error(`PDF 最多支持 ${MAX_PDF_PAGES} 页，请拆分后重试。`);
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const text = content.items.map((item) => "str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "")
          .join("").trim();
        if (text) pages.push(`### 第 ${pageNumber} 页\n\n${text}`);
        if (byteLength(pages.join("\n\n")) > MAX_ATTACHMENT_MARKDOWN_BYTES) {
          throw new Error("附件转换后的内容超过 512 KiB，请缩小或拆分文件。");
        }
      } finally { page.cleanup(); }
    }
    if (!pages.length) throw new Error("PDF 中未找到可提取的文字，扫描件请先进行 OCR 识别。");
    return pages.join("\n\n");
  } finally { await loadingTask.destroy(); }
}

/** Convert locally. The original file is never uploaded to the gateway. */
export async function fileToMarkdown(file: File): Promise<MarkdownAttachment> {
  if (file.size > MAX_ATTACHMENT_FILE_BYTES) throw new Error("单个附件不能超过 10 MiB。");
  if (!file.size) throw new Error("附件为空，请选择有内容的文件。");
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const codeLanguage = Object.hasOwn(CODE_LANGUAGES, extension) ? CODE_LANGUAGES[extension] : undefined;
  const isText = Boolean(codeLanguage) || MARKDOWN_EXTENSIONS.has(extension)
    || extension === "csv" || extension === "tsv" || file.type.startsWith("text/");
  if (!isText && extension !== "pdf" && extension !== "docx") {
    throw new Error("不支持此附件类型，请选择文本、Markdown、代码、CSV、PDF 或 DOCX 文件。图片与旧版 DOC 暂不支持。");
  }
  const data = await file.arrayBuffer();
  let markdown: string;
  try {
    if (extension === "pdf") markdown = await pdfMarkdown(data);
    else if (extension === "docx") markdown = await docxMarkdown(data);
    else {
      const text = decodeText(data);
      if (!text.trim()) throw new Error("附件中未找到可发送的文字。");
      if (byteLength(text) > MAX_ATTACHMENT_MARKDOWN_BYTES) throw new Error("附件文字超过 512 KiB，请缩小或拆分文件。");
      if (MARKDOWN_EXTENSIONS.has(extension)) markdown = text;
      else if (extension === "csv" || extension === "tsv") markdown = delimitedMarkdown(text, extension === "csv" ? "," : "\t");
      else if (extension === "json") {
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { throw new Error("JSON 附件格式不正确，请检查后重试。"); }
        markdown = codeBlock(JSON.stringify(parsed, null, 2), "json");
      } else markdown = codeBlock(text, codeLanguage ?? "text");
    }
  } catch (error) {
    if (extension === "pdf" || extension === "docx") {
      const reason = error instanceof Error ? error.message : "未知错误";
      throw new Error(`无法转换 ${extension.toUpperCase()} 附件：${reason}`);
    }
    throw error;
  }
  if (!markdown.trim()) throw new Error("附件中未找到可发送的文字。");
  if (byteLength(markdown) > MAX_ATTACHMENT_MARKDOWN_BYTES) {
    throw new Error("附件转换后的内容超过 512 KiB，请缩小或拆分文件。");
  }
  // randomUUID requires HTTPS; getRandomValues also works on local HTTP deployments.
  const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, "0")).join("");
  return { id, name: safeName(file.name), size: file.size, markdown };
}

/** Keep attachment boundaries readable and enforce the gateway JSON request budget. */
export function composeMessage(text: string, attachments: readonly MarkdownAttachment[]): string {
  if (attachments.length > MAX_ATTACHMENTS) throw new Error(`每条消息最多添加 ${MAX_ATTACHMENTS} 个附件。`);
  const content = [text.trim(), ...attachments.map((attachment) =>
    `## 附件：${escapeInline(safeName(attachment.name))}\n\n${attachment.markdown}`)]
    .filter(Boolean).join("\n\n---\n\n");
  if (byteLength(JSON.stringify({ message: content })) > MAX_MESSAGE_JSON_BYTES) {
    throw new Error("消息与附件内容过大，请减少文字或移除部分附件后重试。");
  }
  return content;
}

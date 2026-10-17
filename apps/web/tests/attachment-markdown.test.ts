import assert from "node:assert/strict";
import { test } from "node:test";
import { File } from "node:buffer";
import {
  ATTACHMENT_ACCEPT, MAX_ATTACHMENTS, MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENT_MARKDOWN_BYTES, MAX_MESSAGE_JSON_BYTES, composeMessage, fileToMarkdown,
} from "../src/utils/attachmentMarkdown.ts";
import { renderMarkdown } from "../src/utils/markdown.ts";
import { docxFixture } from "./attachment-fixtures.ts";

const file = (name: string, value: string | Uint8Array, type = "") => new File([value], name, { type });

test("keeps Markdown formatting and preserves code fences, indentation and line breaks", async () => {
  const markdown = await fileToMarkdown(file("说明.MD", "# 标题\r\n\r\n**内容**"));
  assert.equal(markdown.name, "说明.MD");
  assert.equal(markdown.markdown, "# 标题\n\n**内容**");
  assert.ok(markdown.id);
  const code = await fileToMarkdown(file("demo.ts", "const text = ` ``` `;\n  run(text);"));
  assert.equal(code.markdown, "````typescript\nconst text = ` ``` `;\n  run(text);\n````");
  assert.match(renderMarkdown(code.markdown), /<pre><code class="language-typescript">/);
});

test("formats JSON and rejects invalid JSON with an actionable error", async () => {
  const attachment = await fileToMarkdown(file("data.json", '{"销售额":12}'));
  assert.equal(attachment.markdown, '```json\n{\n  "销售额": 12\n}\n```');
  await assert.rejects(fileToMarkdown(file("data.json", "{bad}")), /JSON 附件格式不正确/);
});

test("CSV and TSV preserve quoted delimiters, embedded newlines, quotes and uneven rows", async () => {
  const csv = await fileToMarkdown(file("data.csv", '门店,备注\nA,"含,逗号\n第二行与""引号"""\nB,结尾,附加列\n'));
  assert.equal(csv.markdown, '| 门店 | 备注 |  |\n| --- | --- | --- |\n| A | 含,逗号<br>第二行与"引号" |  |\n| B | 结尾 | 附加列 |');
  const tsv = await fileToMarkdown(file("data.tsv", "门店\t销售额\nA\t120\n"));
  assert.match(tsv.markdown, /\| A \| 120 \|/);
  assert.match(renderMarkdown(tsv.markdown), /<table>/);
  await assert.rejects(fileToMarkdown(file("broken.csv", 'a,b\n1,"bad')), /引号未闭合/);
});

test("table values and filenames cannot create Markdown links or headings", async () => {
  const attachment = await fileToMarkdown(file("[打开](javascript:bad)\n##坏.md", "正文"));
  const message = composeMessage("分析", [attachment]);
  assert.match(message, /## 附件：\\\[打开\\\]\\\(javascript:bad\\\) \\#\\#坏\\\.md/);
  assert.doesNotMatch(renderMarkdown(message), /href="javascript:/);
  const csv = await fileToMarkdown(file("data.csv", "列名\n[链接](https://example.com)\n<script>|bad"));
  assert.match(csv.markdown, /\\\[链接\\\]\\\(https:\/\/example\\\.com\\\)/);
  assert.match(csv.markdown, /&lt;script&gt;\\\|bad/);
});

test("reads BOM-encoded UTF-16 and rejects unsupported, empty, oversized and binary input", async () => {
  const bytes = new Uint8Array([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]);
  const utf16 = await fileToMarkdown(file("中文.txt", bytes));
  assert.match(utf16.markdown, /中文/);
  await assert.rejects(fileToMarkdown(file("image.png", "fake")), /不支持此附件类型/);
  await assert.rejects(fileToMarkdown(file("unknown.constructor", "fake")), /不支持此附件类型/);
  await assert.rejects(fileToMarkdown(file("old.doc", "fake")), /旧版 DOC/);
  await assert.rejects(fileToMarkdown(file("empty.txt", "")), /附件为空/);
  await assert.rejects(fileToMarkdown(file("spaces.txt", "  \n")), /未找到可发送的文字/);
  await assert.rejects(fileToMarkdown(file("invalid.txt", new Uint8Array([0xff]))), /UTF-8/);
  await assert.rejects(fileToMarkdown(file("binary.txt", "a\0b")), /二进制内容/);
  await assert.rejects(fileToMarkdown(file("large.txt", "x".repeat(MAX_ATTACHMENT_MARKDOWN_BYTES + 1))), /512 KiB/);
  await assert.rejects(fileToMarkdown({ name: "large.pdf", size: MAX_ATTACHMENT_FILE_BYTES + 1 } as File), /10 MiB/);
});

test("composeMessage supports attachment-only messages and bounds JSON bytes including escapes", async () => {
  const attachment = await fileToMarkdown(file("说明.md", "# 附件正文"));
  assert.equal(composeMessage("  正文  ", []), "正文");
  assert.equal(composeMessage("", [attachment]), "## 附件：说明\\.md\n\n# 附件正文");
  assert.match(composeMessage("正文", [attachment]), /^正文\n\n---\n\n## 附件/);
  assert.throws(() => composeMessage("x", Array(MAX_ATTACHMENTS + 1).fill(attachment)), /最多添加 5/);
  assert.throws(() => composeMessage("中".repeat(Math.ceil(MAX_MESSAGE_JSON_BYTES / 3)), []), /内容过大/);
  assert.throws(() => composeMessage("\\".repeat(MAX_MESSAGE_JSON_BYTES / 2), []), /内容过大/);
  assert.ok(new TextEncoder().encode(JSON.stringify({ message: composeMessage("x".repeat(100), [attachment]) })).byteLength < MAX_MESSAGE_JSON_BYTES);
  assert.ok(ATTACHMENT_ACCEPT.includes(".pdf") && ATTACHMENT_ACCEPT.includes(".docx"));
});

test("converts a real DOCX into Markdown headings, emphasis and tables without a backend", async () => {
  const result = await fileToMarkdown(file("报告.docx", docxFixture()));
  assert.match(result.markdown, /# 报告标题/);
  assert.match(result.markdown, /\*\*销售增长\*\*/);
  assert.match(result.markdown, /\| 门店 \| 销售额 \|\n\| --- \| --- \|\n\| A \| 120 \|/);
  await assert.rejects(fileToMarkdown(file("bad.docx", "not a zip")), /无法转换 DOCX 附件/);
});

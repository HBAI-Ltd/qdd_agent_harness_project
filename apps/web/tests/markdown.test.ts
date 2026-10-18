import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownMedia, renderMarkdown } from "../src/utils/markdown.ts";
import { mediaKind, safeMediaUrl } from "../src/utils/media.ts";

test("renders assistant headings, formatting, lists, quotes and line breaks", () => {
  const html = renderMarkdown("## 销售分析\n\n**增长**与*趋势*，`revenue`。\n下一行\n\n- 门店 A\n- 门店 B\n\n1. 核对数据\n2. 生成报告\n\n> 仅供参考\n\n~~过期~~");
  assert.match(html, /<h2>销售分析<\/h2>/);
  assert.match(html, /<strong>增长<\/strong>与<em>趋势<\/em>，<code>revenue<\/code>。<br>\n下一行/);
  assert.match(html, /<ul>\n<li>门店 A<\/li>\n<li>门店 B<\/li>\n<\/ul>/);
  assert.match(html, /<ol>\n<li>核对数据<\/li>\n<li>生成报告<\/li>\n<\/ol>/);
  assert.match(html, /<blockquote>\n<p>仅供参考<\/p>\n<\/blockquote>/);
  assert.match(html, /<s>过期<\/s>/);
});

test("renders aligned tables and escaped fenced code without losing code whitespace", () => {
  const html = renderMarkdown("| 门店 | 销售额 |\n| :--- | ---: |\n| A | **120** |\n\n```ts\nconst value = \"<script>\";\n  run(value);\n```\n");
  assert.match(html, /<div class="markdown-table-scroll"><table>/);
  assert.match(html, /<th style="text-align:left">门店<\/th>/);
  assert.match(html, /<td style="text-align:right"><strong>120<\/strong><\/td>/);
  assert.match(html, /<pre><code class="language-ts">const value = &quot;&lt;script&gt;&quot;;\n  run\(value\);\n<\/code><\/pre>/);
  assert.doesNotMatch(html, /<script>/);
});

test("renders nested task lists with disabled checkboxes and preserves inline formatting", () => {
  const html = renderMarkdown("- [x] **已完成**\n  - [ ] 检查明细\n- 普通列表\n\n[x] 普通正文");
  assert.match(html, /<li class="task-list-item"><input type="checkbox" disabled="" aria-label="已完成" checked=""> <strong>已完成<\/strong>/);
  assert.match(html, /<li class="task-list-item"><input type="checkbox" disabled="" aria-label="未完成"> 检查明细/);
  assert.match(html, /<li>普通列表<\/li>/);
  assert.match(html, /<p>\[x\] 普通正文<\/p>/);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2);
});

test("safe external links open separately and anchors and email links stay usable", () => {
  const html = renderMarkdown("[网站](https://example.com/report?q=1&sort=2) [相对地址](/reports) [章节](#report) [邮件](mailto:help@example.com)\n\nhttps://example.com [外链](//example.com/report)");
  assert.match(html, /href="https:\/\/example.com\/report\?q=1&amp;sort=2" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /<a href="\/reports">相对地址<\/a>/);
  assert.match(html, /<a href="#report">章节<\/a>/);
  assert.match(html, /<a href="mailto:help@example.com">邮件<\/a>/);
  assert.match(html, /href="https:\/\/example.com" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /href="\/\/example.com\/report" target="_blank" rel="noopener noreferrer"/);
});

test("raw HTML and HTML inside code are displayed as text, including injection attributes", () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n<a href="javascript:alert(1)">danger</a>\n\n`<svg onload=alert(1)>`');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /<code>&lt;svg onload=alert\(1\)&gt;<\/code>/);
  assert.doesNotMatch(html, /<(?:script|img|svg|a)\b/i);
});

test("rejects unsafe protocols, including encoded schemes and image data URLs", () => {
  for (const destination of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "javascript&#58;alert(1)",
    "java&#x09;script:alert(1)",
    "vbscript:alert(1)",
    "file:///etc/passwd",
    "data:text/html;base64,PHNjcmlwdD4=",
    "custom-app:run",
  ]) {
    const html = renderMarkdown(`[打开](${destination})`);
    assert.doesNotMatch(html, /<a\b/, destination);
  }
  const image = renderMarkdown("![图片](data:image/png;base64,abc)\n\n![图片](https://example.com/image.png)");
  assert.doesNotMatch(image, /src="data:/);
  assert.match(image, /<img src="https:\/\/example.com\/image.png" alt="图片">/);
});

test("supports partial streamed Markdown and safely closes newly completed code blocks", () => {
  const partial = renderMarkdown("**分析中\n\n```json\n{\"sales\":");
  assert.match(partial, /\*\*分析中/);
  assert.match(partial, /<pre><code class="language-json">\{&quot;sales&quot;:/);
  const completed = renderMarkdown("**分析中**\n\n```json\n{\"sales\": 120}\n```\n\n完成");
  assert.match(completed, /<strong>分析中<\/strong>/);
  assert.match(completed, /<\/code><\/pre>\n<p>完成<\/p>/);
  assert.equal(renderMarkdown(""), "");
});

test("extracts media from Markdown images, links and autolinks, including signed and extensionless streams", () => {
  const content = '![门店](https://example.com/snapshot)\n\n[图片](/photo.JPG?signature=1)\n\nhttps://example.com/clip.MP4?token=abc\n\n[直播](https://example.com/live "application/vnd.apple.mpegurl")\n\n[FLV](https://example.com/live.flv)\n\n[重复](https://example.com/live.flv)';
  assert.deepEqual(markdownMedia(content).map(({ src, kind }) => ({ src, kind })), [
    { src: "https://example.com/snapshot", kind: "image" },
    { src: "/photo.JPG?signature=1", kind: "image" },
    { src: "https://example.com/clip.MP4?token=abc", kind: "video" },
    { src: "https://example.com/live", kind: "hls" },
    { src: "https://example.com/live.flv", kind: "flv" },
  ]);
  assert.match(renderMarkdown(content, true), /<a href="https:\/\/example.com\/snapshot"/);
  assert.doesNotMatch(renderMarkdown(content, true), /<img/);
});

test("media extraction excludes code, raw HTML, credentials and unsafe protocols", () => {
  assert.deepEqual(markdownMedia('`https://example.com/clip.mp4`\n\n```md\n![image](https://example.com/a.png)\n```\n\n<video src="https://example.com/a.mp4"></video>\n\n[bad](javascript:run.mp4)\n\n![bad](data:image/png;base64,abc)\n\n[private](https://user:pass@example.com/a.mp4)'), []);
  for (const url of ["javascript:run.mp4", "data:video/mp4;base64,abc", "file:///test.mp4", "https://u:p@example.com/x", "https://example.com\\x", " https://example.com/x"]) {
    assert.equal(safeMediaUrl(url), false, url);
  }
  assert.equal(mediaKind("clip.mp4", "video/x-flv"), "flv");
  assert.equal(mediaKind("stream", "application/vnd.apple.mpegurl"), "hls");
  assert.equal(mediaKind("file", "image/png"), "image");
  assert.equal(mediaKind("report.pdf"), undefined);
});

test("streaming Markdown only exposes completed media links and escapes image labels", () => {
  assert.deepEqual(markdownMedia("[直播](https://example.com/live.m3u8"), []);
  assert.equal(markdownMedia("[直播](https://example.com/live.m3u8)").length, 1);
  assert.match(renderMarkdown('![<script>](https://example.com/a.png)', true), /&lt;script&gt;/);
  const linkedImage = renderMarkdown("[![截图](/photo.png)](/clip.mp4)", true);
  assert.equal((linkedImage.match(/<a /g) ?? []).length, 1);
  assert.deepEqual(markdownMedia("[![截图](/photo.png)](/clip.mp4)").map((item) => item.kind), ["video", "image"]);
});

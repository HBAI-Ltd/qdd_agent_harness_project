// Production UI + real local gateway + fresh Chrome profile; no external model calls.
// npm run build && npm run build:web && node scripts/test-chat-composer-browser.mjs
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { loadConfig } from "../apps/cli/dist/config.js";
import { DataSources } from "../apps/cli/dist/datasource/registry.js";
import { startGateway } from "../apps/cli/dist/gateway/server.js";
import { ensureWorkspace } from "../apps/cli/dist/web/site.js";
import { docxFixture } from "../apps/web/tests/attachment-fixtures.ts";

function pdfFixture() {
  const text = "BT /F1 16 Tf 50 760 Td (PDF browser attachment 120) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

async function until(predicate, message) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await setTimeout(20);
  }
  assert.fail(message);
}

const dist = fileURLToPath(new URL("../apps/web/dist/", import.meta.url));
await readFile(path.join(dist, "index.html"));
const root = await mkdtemp(path.join(tmpdir(), "qdd-chat-composer-browser-"));
const token = "chat-composer-browser-test-token";
const files = ["notes.txt", "sales.csv", "report.docx", "report.pdf"].map((name) => path.join(root, name));
await Promise.all([
  writeFile(files[0], "附件上传浏览器验证\n库存 120 件。\n"),
  writeFile(files[1], '门店,销售额,备注\nA,120,"含,逗号"\n'),
  writeFile(files[2], docxFixture()),
  writeFile(files[3], pdfFixture()),
  writeFile(path.join(root, "harness.config.json"), JSON.stringify({
    llm: {
      model: "browser-base", reasoningEffort: "default",
      models: [
        { id: "browser-base", label: "基础模型", reasoningEfforts: ["default", "none", "low"], defaultReasoningEffort: "default" },
        { id: "browser-reasoning", label: "深度推理模型", reasoningEfforts: ["default", "low", "medium", "high"], defaultReasoningEffort: "low" },
      ],
    },
    browser: { enabled: false }, mcpServers: {},
  })),
]);

const mime = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const ui = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const requested = path.resolve(dist, `.${pathname}`);
  if (!requested.startsWith(dist)) return res.writeHead(403).end();
  let file = requested;
  let body = await readFile(file).catch(() => undefined);
  if (!body) {
    file = path.join(dist, "index.html");
    body = await readFile(file);
  }
  res.writeHead(200, { "Content-Type": mime[path.extname(file)] ?? "application/octet-stream" }).end(body);
});
await new Promise((resolve) => ui.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${ui.address().port}`;
const loaded = await loadConfig(root);
loaded.config.gateway = { ...loaded.config.gateway, host: "127.0.0.1", port: 0, corsOrigins: [origin] };
await ensureWorkspace(loaded.paths);
const sources = await DataSources.open(loaded);
const selections = [];
const histories = [];
const gateway = await startGateway(loaded, sources, {
  token, scheduler: false,
  chat: (llm) => {
    selections.push({ model: llm.model, reasoningEffort: llm.reasoningEffort });
    return async (messages) => {
      histories.push(messages.filter((message) => message.role === "user").map((message) => message.content ?? ""));
      return {
        role: "assistant", content: null,
        tool_calls: [{ id: `reply-${histories.length}`, type: "function", function: {
          name: "reply", arguments: JSON.stringify({ text: `浏览器验证完成 ${histories.length}`, gaps: [] }),
        } }],
      };
    };
  },
});
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1365, height: 1000, deviceScaleFactor: 1 });
  const errors = [];
  const sentRequests = [];
  const workerResponses = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/(wishes|sessions\/[^/]+\/messages)$/.test(new URL(request.url()).pathname)) {
      sentRequests.push(JSON.parse(request.postData()));
    }
  });
  page.on("response", (response) => {
    if (response.url().includes("pdf.worker")) workerResponses.push({ url: response.url(), status: response.status() });
  });
  await page.evaluateOnNewDocument((base, value) => {
    localStorage.setItem("harness-gateway-url", base);
    sessionStorage.setItem("harness-gateway-token", value);
  }, gateway.url, token);
  await page.goto(`${origin}/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('.chat-model-picker summary', { visible: true });
  await page.waitForFunction(() => document.body.innerText.includes("网关已连接"));

  const chooseFiles = async (paths, expectedCount) => {
    const [chooser] = await Promise.all([
      page.waitForFileChooser(),
      page.click('[aria-label="添加附件"]'),
    ]);
    await chooser.accept(paths);
    await page.waitForFunction((count) => document.querySelectorAll(".chat-attachment").length === count
      && !document.querySelector(".chat-attachment-progress"), { timeout: 15_000 }, expectedCount);
  };
  await chooseFiles(files, 4);
  assert.equal(await page.$eval("#message-input", (input) => input.value), "", "Selecting files must not insert their text into the textarea");
  await page.click('[aria-label="移除附件 sales.csv"]');
  assert.equal(await page.$$eval(".chat-attachment", (chips) => chips.length), 3);
  await chooseFiles([files[1]], 4);
  await page.screenshot({ path: path.join(root, "desktop-attachments.png"), fullPage: true });

  await page.click('[aria-label="发送消息"]');
  await until(() => histories.length === 1, "Attachment-only message never reached the fake chat");
  const sessionId = (await gateway.hub.list())[0].id;
  await gateway.hub.wait(sessionId);
  await page.waitForFunction(() => document.body.innerText.includes("浏览器验证完成 1") && !document.querySelector('[aria-label="停止回复"]'));
  assert.deepEqual(selections[0], { model: "browser-base", reasoningEffort: "default" });
  const first = histories[0][0];
  assert.match(first, /## 附件：notes\\\.txt\n\n```text\n附件上传浏览器验证/);
  assert.match(first, /## 附件：sales\\\.csv\n\n\| 门店 \| 销售额 \| 备注 \|/);
  assert.match(first, /\| A \| 120 \| 含,逗号 \|/);
  assert.match(first, /## 附件：report\\\.docx\n\n# 报告标题/);
  assert.match(first, /\*\*销售增长\*\*/);
  assert.match(first, /## 附件：report\\\.pdf\n\n### 第 1 页\n\nPDF browser attachment 120/);
  assert.equal(sentRequests.length, 1);
  assert.ok(first.startsWith(sentRequests[0].wish), "The fake chat receives the complete submitted Markdown before gateway instructions");
  assert.equal((await gateway.hub.detail(sessionId)).events.find((event) => event.type === "user").text, sentRequests[0].wish);
  assert.equal(Object.hasOwn(sentRequests[0], "attachments"), false, "Gateway receives Markdown text rather than uploaded binary files");
  assert.ok(workerResponses.some((response) => response.status === 200), "Production PDF worker must load as a separate asset");
  assert.equal(await page.$$eval(".chat-attachment", (chips) => chips.length), 0);

  await page.click('.chat-model-picker summary');
  await page.waitForSelector(".chat-model-panel", { visible: true });
  await page.click(".chat-model-panel .el-select");
  await page.waitForSelector(".el-select-dropdown__item", { visible: true });
  const options = await page.$$(".el-select-dropdown__item");
  let chosen = false;
  for (const option of options) {
    if ((await option.evaluate((element) => element.textContent)).trim() === "深度推理模型") {
      await option.click();
      chosen = true;
      break;
    }
  }
  assert.ok(chosen, "The production model dropdown must expose the second configured model");
  await page.waitForFunction(() => document.querySelector(".chat-model-name")?.textContent === "深度推理模型");
  const high = await page.$$(".chat-reasoning-options button");
  for (const button of high) if (await button.evaluate((element) => element.textContent === "高")) await button.click();
  await page.waitForFunction(() => document.querySelector(".chat-model-effort")?.textContent.includes("高"));
  assert.equal(await page.$eval('.chat-reasoning-options button[aria-pressed="true"]', (button) => button.textContent), "高");
  await page.screenshot({ path: path.join(root, "desktop-model-popover.png"), fullPage: true });
  await page.click('.chat-model-picker summary');
  await page.type("#message-input", "按高强度继续分析附件");
  await page.click('[aria-label="发送消息"]');
  await until(() => histories.length === 2, "Follow-up never reached the fake chat");
  await gateway.hub.wait(sessionId);
  await page.waitForFunction(() => document.body.innerText.includes("浏览器验证完成 2") && !document.querySelector('[aria-label="停止回复"]'));
  assert.deepEqual(selections[1], { model: "browser-reasoning", reasoningEffort: "high" });
  assert.match(histories[1].at(-1), /^按高强度继续分析附件/);
  assert.equal(sentRequests[1].model, "browser-reasoning");
  assert.equal(sentRequests[1].reasoningEffort, "high");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".chat-model-name")?.textContent === "深度推理模型"
    && document.querySelector(".chat-model-effort")?.textContent.includes("高")
    && document.body.innerText.includes("浏览器验证完成 2"));
  assert.equal(selections.length, 2, "Reload must restore the conversation without contacting a model");
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.click('.chat-model-picker summary');
  await page.waitForSelector(".chat-model-panel", { visible: true });
  const geometry = await page.evaluate(() => {
    const panel = document.querySelector(".chat-model-panel");
    const rect = panel.getBoundingClientRect();
    const point = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 20);
    return {
      viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
      left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      visible: !!point?.closest(".chat-model-panel"),
    };
  });
  assert.ok(geometry.documentWidth <= geometry.viewport, `Mobile page overflows horizontally: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.left >= 0 && geometry.right <= 390 && geometry.top >= 0 && geometry.bottom <= 844, `Mobile selector leaves the viewport: ${JSON.stringify(geometry)}`);
  assert.equal(geometry.visible, true, "Mobile model popover must not be clipped or covered");
  await page.screenshot({ path: path.join(root, "mobile-model-popover.png"), fullPage: true });
  await page.click('.chat-model-picker summary');
  await chooseFiles([files[0], files[1]], 2);
  await page.screenshot({ path: path.join(root, "mobile-attachments.png"), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Mobile attachment chips must not cause horizontal overflow");
  assert.deepEqual(errors, [], "The production chat page must have no uncaught browser exceptions");
  console.log(JSON.stringify({ passed: true, root, sessionId, models: selections, attachmentFormats: ["TXT", "CSV", "DOCX", "PDF"], mobile: geometry, screenshots: ["desktop-attachments.png", "desktop-model-popover.png", "mobile-model-popover.png", "mobile-attachments.png"] }, null, 2));
} catch (error) {
  const page = (await browser?.pages())?.at(-1);
  await page?.screenshot({ path: path.join(root, "failure.png"), fullPage: true }).catch(() => {});
  console.error(`Browser regression artifacts: ${root}`);
  throw error;
} finally {
  await browser?.close();
  await gateway.close();
  await sources.close();
  await new Promise((resolve) => ui.close(resolve));
}

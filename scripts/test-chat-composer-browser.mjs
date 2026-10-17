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
const keyEnv = "QDD_BROWSER_COMPOSER_KEY";
const missingKeyEnv = "QDD_BROWSER_COMPOSER_MISSING_KEY";
const previousKey = process.env[keyEnv];
const previousMissingKey = process.env[missingKeyEnv];
process.env[keyEnv] = "local-browser-regression-key";
delete process.env[missingKeyEnv];
const files = ["notes.txt", "sales.csv", "report.docx", "report.pdf"].map((name) => path.join(root, name));
await Promise.all([
  writeFile(files[0], "附件上传浏览器验证\n库存 120 件。\n"),
  writeFile(files[1], '门店,销售额,备注\nA,120,"含,逗号"\n'),
  writeFile(files[2], docxFixture()),
  writeFile(files[3], pdfFixture()),
  writeFile(path.join(root, "harness.config.json"), JSON.stringify({
    llm: {
      model: "browser-base", reasoningEffort: "default", apiKeyEnv: keyEnv,
      models: [
        { id: "browser-base", model: "browser-base-provider", provider: "基础服务", label: "基础模型", reasoningEfforts: ["default", "none", "low"], defaultReasoningEffort: "default" },
        { id: "browser-reasoning", model: "browser-reasoning-provider", provider: "推理服务", label: "深度推理模型", reasoningEfforts: ["default", "low", "medium", "high"], defaultReasoningEffort: "low" },
        { id: "browser-unavailable", model: "browser-unavailable-provider", provider: "未配置服务", label: "未配置模型", apiKeyEnv: missingKeyEnv },
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
const catalogResponse = await fetch(`${gateway.url}/api/models`, { headers: { Authorization: `Bearer ${token}` } });
assert.equal(catalogResponse.status, 200);
await writeFile(path.join(root, "model-catalog.json"), JSON.stringify(await catalogResponse.json(), null, 2));
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1365, height: 1000, deviceScaleFactor: 1 });
  const settleUi = () => page.waitForFunction(() => document.getAnimations().every((animation) =>
    animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity)
    && [...document.querySelectorAll('.el-select__popper[aria-hidden="false"]')].every((popper) =>
      getComputedStyle(popper).opacity === "1" && !/(?:enter|leave)-(?:active|from|to)/.test(popper.className)), { timeout: 5000 });
  const screenshot = async (name) => {
    await settleUi();
    await page.screenshot({ path: path.join(root, name), fullPage: true });
  };
  const errors = [];
  const sentRequests = [];
  const modelUpdates = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/(wishes|sessions\/[^/]+\/messages)$/.test(new URL(request.url()).pathname)) {
      sentRequests.push(JSON.parse(request.postData()));
    }
    if (request.method() === "PUT" && /\/api\/sessions\/[^/]+\/model$/.test(new URL(request.url()).pathname)) {
      modelUpdates.push(JSON.parse(request.postData()));
    }
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
      page.click('[aria-label="添加文件"]'),
    ]);
    await chooser.accept(paths);
    await page.waitForFunction((count) => document.querySelectorAll(".chat-composer-attachments .attachment-chip").length === count
      && !document.querySelector('.chat-composer-attachments [data-status="uploading"]')
      && !document.querySelector('.chat-composer-attachments [data-status="error"]'), { timeout: 15_000 }, expectedCount);
  };
  await chooseFiles(files, 4);
  assert.equal(await page.$eval("#message-input", (input) => input.value), "", "Selecting files must not insert their text into the textarea");
  const csvChip = await page.$('.chat-composer-attachments .attachment-main[title="sales.csv"]');
  await (await csvChip.evaluateHandle((button) => button.closest(".attachment-chip").querySelector('[aria-label="移除附件"]'))).click();
  assert.equal(await page.$$eval(".chat-composer-attachments .attachment-chip", (chips) => chips.length), 3);
  await chooseFiles([files[1]], 4);
  await screenshot("desktop-attachments.png");

  await page.click('[aria-label="发送消息"]');
  await until(() => histories.length === 1, "Attachment-only message never reached the fake chat");
  const sessionId = (await gateway.hub.list())[0].id;
  await gateway.hub.wait(sessionId);
  await page.waitForFunction(() => document.body.innerText.includes("浏览器验证完成 1") && !document.querySelector('[aria-label="停止回复"]'));
  assert.deepEqual(selections[0], { model: "browser-base-provider", reasoningEffort: "default" });
  const first = histories[0][0];
  assert.match(first, /请查看我上传的附件/);
  assert.match(first, /店长上传的附件，共 4 个/);
  assert.equal(sentRequests.length, 1);
  const user = (await gateway.hub.detail(sessionId)).events.find((event) => event.type === "user");
  assert.equal(user.text, sentRequests[0].wish);
  assert.equal(user.attachments.length, 4);
  assert.deepEqual(sentRequests[0].attachments, user.attachments.map((attachment) => attachment.id));
  for (const filename of files) {
    const attachment = user.attachments.find((item) => item.name === path.basename(filename));
    assert.ok(attachment, `Uploaded attachment missing: ${filename}`);
    assert.ok(first.includes(`id=${attachment.id}`), "The fake chat receives attachment references for on-demand reading");
    const original = await readFile(filename);
    assert.deepEqual((await gateway.hub.attachments.bytes(attachment.id)).bytes, original, "Gateway preserves the selected file bytes");
    const modelText = await gateway.hub.attachments.readForModel(attachment.id);
    if (attachment.name === "notes.txt") assert.match(modelText, /附件上传浏览器验证\n库存 120 件/);
    if (attachment.name === "sales.csv") assert.match(modelText, /门店,销售额,备注\nA,120/);
    if (attachment.name === "report.docx") assert.match(modelText, /二进制文件，无法直接读取文本内容/);
  }
  assert.equal(await page.$$eval(".chat-composer-attachments .attachment-chip", (chips) => chips.length), 0);

  await page.click('.chat-model-picker summary');
  await page.waitForSelector(".chat-model-panel", { visible: true });
  await page.click(".chat-model-panel .el-select");
  await page.waitForSelector(".el-select-dropdown__item", { visible: true, timeout: 5000 });
  assert.deepEqual(await page.$$eval(".el-select-group__title", (titles) => titles.map((title) => title.textContent.trim())), ["基础服务", "推理服务", "未配置服务"]);
  await page.type('.chat-model-panel input[role="combobox"]', "深度");
  await page.waitForFunction(() => {
    const groups = [...document.querySelectorAll(".el-select-group__wrap")].filter((group) => getComputedStyle(group).display !== "none");
    return groups.length === 1 && groups[0].querySelector(".el-select-group__title")?.textContent === "推理服务";
  }, { timeout: 5000 });
  await screenshot("desktop-model-search.png");
  await page.focus('.chat-model-panel input[role="combobox"]');
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await page.waitForFunction(() => [...document.querySelectorAll(".el-select-group__wrap")].filter((group) => getComputedStyle(group).display !== "none").length === 3);
  const unavailable = await page.$(".el-select-dropdown__item.is-disabled");
  assert.ok(unavailable, "The model lacking its API key must be disabled");
  assert.match(await unavailable.evaluate((item) => item.textContent), /未配置模型（未配置 Key）/);
  await unavailable.click();
  assert.equal(await page.$eval(".chat-model-name", (label) => label.textContent), "基础模型");
  assert.equal(modelUpdates.length, 0, "Disabled choices must never update the session model");
  await screenshot("desktop-model-catalog.png");
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
  await until(async () => (await gateway.hub.meta(sessionId)).model === "browser-reasoning", "The model selector must PUT the chosen model to the current session");
  await page.waitForFunction(() => !!document.querySelector('.chat-reasoning-options button:not([disabled])'));
  await page.waitForSelector(".el-select__popper", { hidden: true, timeout: 5000 });
  assert.deepEqual(modelUpdates, [{ model: "browser-reasoning" }]);
  const high = await page.$$(".chat-reasoning-options button");
  for (const button of high) if (await button.evaluate((element) => element.textContent.trim() === "高")) await button.click();
  await page.waitForFunction(() => document.querySelector(".chat-model-effort")?.textContent.includes("高"), { timeout: 5000 });
  assert.equal(await page.$eval('.chat-reasoning-options button[aria-pressed="true"]', (button) => button.textContent.trim()), "高");
  await screenshot("desktop-model-popover.png");
  await page.click('.chat-model-picker summary');
  await page.type("#message-input", "按高强度继续分析附件");
  await page.click('[aria-label="发送消息"]');
  await until(() => histories.length === 2, "Follow-up never reached the fake chat");
  await gateway.hub.wait(sessionId);
  await page.waitForFunction(() => document.body.innerText.includes("浏览器验证完成 2") && !document.querySelector('[aria-label="停止回复"]'));
  assert.deepEqual(selections[1], { model: "browser-reasoning-provider", reasoningEffort: "high" });
  assert.match(histories[1].at(-1), /^按高强度继续分析附件/);
  assert.equal(sentRequests[1].model, "browser-reasoning");
  assert.equal(sentRequests[1].reasoningEffort, "high");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".chat-model-name")?.textContent === "深度推理模型"
    && document.querySelector(".chat-model-effort")?.textContent.includes("高")
    && document.body.innerText.includes("浏览器验证完成 2"));
  assert.equal(selections.length, 2, "Reload must restore the conversation without contacting a model");
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.waitForFunction(() => document.querySelector("aside.sidebar")?.getBoundingClientRect().right <= 0, { timeout: 5000 });
  await settleUi();
  await page.click('.chat-model-picker summary');
  await page.waitForSelector(".chat-model-panel", { visible: true });
  const geometry = await page.evaluate(() => {
    const panel = document.querySelector(".chat-model-panel");
    const rect = panel.getBoundingClientRect();
    const visible = [rect.left + 8, rect.left + rect.width / 2, rect.right - 8].every((x) =>
      document.elementFromPoint(x, rect.top + 20)?.closest(".chat-model-panel"));
    return {
      viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
      left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      sidebarRight: document.querySelector("aside.sidebar")?.getBoundingClientRect().right,
      visible,
    };
  });
  assert.ok(geometry.documentWidth <= geometry.viewport, `Mobile page overflows horizontally: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.left >= 0 && geometry.right <= 390 && geometry.top >= 0 && geometry.bottom <= 844, `Mobile selector leaves the viewport: ${JSON.stringify(geometry)}`);
  assert.equal(geometry.visible, true, "Mobile model popover must not be clipped or covered");
  await screenshot("mobile-model-popover.png");
  await page.click('.chat-model-picker summary');
  await chooseFiles([files[0], files[1]], 2);
  await screenshot("mobile-attachments.png");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Mobile attachment chips must not cause horizontal overflow");
  assert.deepEqual(errors, [], "The production chat page must have no uncaught browser exceptions");
  console.log(JSON.stringify({ passed: true, root, sessionId, models: selections, modelUpdates, attachmentFormats: ["TXT", "CSV", "DOCX", "PDF"], attachmentMode: "gateway references with on-demand read_attachment", unavailableModelDisabled: true, providerGroups: ["基础服务", "推理服务", "未配置服务"], searchableProviderGroups: true, mobile: geometry, screenshots: ["desktop-attachments.png", "desktop-model-search.png", "desktop-model-catalog.png", "desktop-model-popover.png", "mobile-model-popover.png", "mobile-attachments.png"] }, null, 2));
} catch (error) {
  const page = (await browser?.pages())?.at(-1);
  await page?.screenshot({ path: path.join(root, "failure.png"), fullPage: true }).catch(() => {});
  if (page) {
    await writeFile(path.join(root, "failure.html"), await page.content());
    console.error(JSON.stringify(await page.evaluate(() => ({
      groups: [...document.querySelectorAll(".el-select-group__wrap")].map((group) => ({ text: group.textContent, display: getComputedStyle(group).display })),
      options: [...document.querySelectorAll(".el-select-dropdown__item")].map((option) => ({ text: option.textContent, display: getComputedStyle(option).display })),
    }))));
  }
  console.error(`Browser regression artifacts: ${root}`);
  throw error;
} finally {
  await browser?.close();
  await gateway.close();
  await sources.close();
  await new Promise((resolve) => ui.close(resolve));
  if (previousKey === undefined) delete process.env[keyEnv];
  else process.env[keyEnv] = previousKey;
  if (previousMissingKey === undefined) delete process.env[missingKeyEnv];
  else process.env[missingKeyEnv] = previousMissingKey;
}

// Production UI, a temporary real gateway, and delayed local uploads; no external services.
// npm run build && npm run build:web && node apps/web/tests/attachment-isolation-browser.smoke.mjs
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { loadConfig } from "../../cli/dist/config.js";
import { DataSources } from "../../cli/dist/datasource/registry.js";
import { startGateway } from "../../cli/dist/gateway/server.js";
import { ensureWorkspace } from "../../cli/dist/web/site.js";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), "qdd-attachment-isolation-"));
const token = "isolated-attachment-browser-token";
const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const files = await Promise.all(Array.from({ length: 7 }, async (_, index) => {
  const file = path.join(root, `private-${index}.txt`);
  await writeFile(file, `local adversarial attachment ${index}`);
  return file;
}));
const ui = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const target = path.resolve(dist, `.${pathname}`);
  if (!target.startsWith(`${path.resolve(dist)}${path.sep}`)) return res.writeHead(403).end();
  let file = target;
  let bytes = await readFile(file).catch(() => undefined);
  if (!bytes) { file = path.join(dist, "index.html"); bytes = await readFile(file); }
  const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".mjs": "text/javascript" }[path.extname(file)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type }).end(bytes);
});
await new Promise((resolve) => ui.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${ui.address().port}`;
const loaded = await loadConfig(root);
loaded.config.gateway = { ...loaded.config.gateway, host: "127.0.0.1", port: 0, corsOrigins: [origin] };
loaded.config.browser.enabled = false;
loaded.config.mcpServers = {};
await ensureWorkspace(loaded.paths);
await Promise.all(ids.map((id, index) => writeFile(path.join(loaded.paths.sessions, `${id}.meta.json`), JSON.stringify({
  id, title: `隔离测试 ${index ? "B" : "A"}`, summary: "", slug: null, status: "idle",
  createdAt: `2026-10-17T0${2 - index}:00:00.000Z`, updatedAt: `2026-10-17T0${2 - index}:00:00.000Z`,
}))));
const sources = await DataSources.open(loaded);
const gateway = await startGateway(loaded, sources, { token, scheduler: false, chat: () => { throw new Error("This regression must not call a model"); } });
let browser;
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const page = await browser.newPage();
  const errors = [];
  const uploads = [];
  const held = [];
  let delayUploads = false;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/attachments") {
      uploads.push({ authorization: request.headers().authorization, filename: request.headers()["x-file-name"] });
      if (delayUploads) { held.push(request); return; }
    }
    void request.continue().catch(() => undefined);
  });
  await page.evaluateOnNewDocument((base, value) => {
    localStorage.setItem("harness-gateway-url", base);
    sessionStorage.setItem("harness-gateway-token", value);
  }, gateway.url, token);
  await page.goto(`${origin}/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector(".conversation-select.active")?.textContent.includes("隔离测试 A"));
  const select = async (name) => {
    await page.click(`.conversation-select[aria-label^="隔离测试 ${name}，"]`);
    await page.waitForFunction((expected) => document.querySelector(".conversation-select.active")?.textContent.includes(`隔离测试 ${expected}`), {}, name);
  };
  const count = () => page.$$eval(".chat-composer-attachments .attachment-chip", (items) => items.length);
  const choose = async (paths) => {
    const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('[aria-label="添加文件"]')]);
    await chooser.accept(paths);
  };
  await choose([files[0]]);
  await page.waitForSelector('.chat-composer-attachments [data-status="done"]');
  await select("B");
  assert.equal(await count(), 0);
  await select("A");
  assert.equal(await count(), 1);
  await page.click('[aria-label="新建对话"]');
  await page.waitForFunction(() => !document.querySelector(".conversation-select.active"));
  assert.equal(await count(), 0);
  await choose([files[1]]);
  await page.waitForSelector('.chat-composer-attachments [data-status="done"]');
  await page.click('[aria-label="新建对话"]');
  assert.equal(await count(), 0, "repeated new drafts must isolate files even when their session ID is null");

  delayUploads = true;
  const before = uploads.length;
  await choose(files);
  await page.waitForFunction(() => document.querySelectorAll('.chat-composer-attachments [data-status="uploading"]').length === 7);
  await page.waitForNetworkIdle({ idleTime: 150, concurrency: 6 });
  assert.equal(uploads.length - before, 4, "the initial upload worker pool must be bounded");
  await page.click('[aria-label="工作空间设置"]');
  await page.waitForSelector("#settings-gateway-token");
  await page.$eval("#settings-gateway-token", (input) => { input.value = "replacement-invalid-identity"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.click(".settings-section form button[type=submit]");
  await page.waitForFunction(() => sessionStorage.getItem("harness-gateway-token") === "replacement-invalid-identity");
  for (const request of held) await request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "obsolete", path: "obsolete.txt", size: 1, mime: "text/plain" }) }).catch(() => undefined);
  await page.click('[aria-label="对话"]');
  await page.waitForSelector("#message-input");
  assert.equal(await count(), 0, "replacement identity must have no previous attachments");
  assert.equal(uploads.length - before, 4, "old queued files must never start with replacement credentials");
  assert.ok(uploads.every((item) => item.authorization === `Bearer ${token}`));
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(root, "attachment-isolation.png"), fullPage: true });
  console.log(JSON.stringify({ passed: true, root, conversationIsolation: true, repeatedDraftIsolation: true, delayedOldUploads: 4, queuedOldUploadsDiscarded: 3, wrongIdentityUploads: 0, uncaughtErrors: errors.length }));
} finally {
  await browser?.close();
  await gateway.close();
  await sources.close();
  await new Promise((resolve) => ui.close(resolve));
}

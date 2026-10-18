// Run after npm run build and npm run build:web, with the frontend preview running.
// QDD_WEB_URL defaults to http://127.0.0.1:4273.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { loadConfig } from "../apps/cli/dist/config.js";
import { DataSources } from "../apps/cli/dist/datasource/registry.js";
import { startGateway } from "../apps/cli/dist/gateway/server.js";
import { ensureWorkspace } from "../apps/cli/dist/web/site.js";

const origin = process.env.QDD_WEB_URL ?? "http://127.0.0.1:4273";
const root = await mkdtemp(path.join(tmpdir(), "qdd-schedule-history-browser-"));
const token = "schedule-history-browser-fixture-token";
let sources;
let gateway;
let browser;
try {
  const loaded = await loadConfig(root);
  loaded.config.gateway = { ...loaded.config.gateway, host: "127.0.0.1", port: 0, corsOrigins: [origin] };
  loaded.config.browser.enabled = false;
  loaded.config.mcpServers = {};
  await ensureWorkspace(loaded.paths);
  sources = await DataSources.open(loaded);
  gateway = await startGateway(loaded, sources, {
    token, scheduler: false, chat: () => { throw new Error("Browser history test must not call a model"); },
  });
  const schedule = await gateway.scheduler.create({ name: "经营日报", cron: "0 8 * * *", prompt: "整理日报", enabled: false });
  for (const [index, title] of ["今日经营日报", "昨日经营日报"].entries()) {
    const at = `2026-10-${18 - index}T00:00:00Z`;
    const id = randomUUID();
    const directory = index ? loaded.paths.sessions : loaded.paths.scheduleSessions;
    await writeFile(path.join(directory, `${id}.meta.json`), JSON.stringify({
      id, title, summary: `${title}结论`, slug: null, status: index ? "error" : "idle",
      origin: { kind: "schedule", scheduleId: schedule.id, scheduleName: schedule.name },
      createdAt: at, updatedAt: at,
    }));
    await writeFile(path.join(directory, `${id}.events.jsonl`), JSON.stringify({ type: "say", text: `${title}完整执行过程`, at }) + "\n");
  }
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluateOnNewDocument((base, value) => {
    localStorage.setItem("harness-gateway-url", base);
    sessionStorage.setItem("harness-gateway-token", value);
  }, gateway.url, token);
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(`${origin}/schedules`, { waitUntil: "domcontentloaded" });
  const clickText = async (text) => {
    const selector = `::-p-text(${text})`;
    await page.waitForSelector(selector, { visible: true });
    await page.click(selector);
  };
  await clickText("历史执行对话");
  await page.waitForSelector(".history-entry");
  assert.deepEqual(await page.$$eval(".history-entry h3", (nodes) => nodes.map((node) => node.textContent)), ["今日经营日报", "昨日经营日报"]);
  assert.equal(await page.$$(".conversation-select").then((nodes) => nodes.length), 0);
  await page.setViewport({ width: 390, height: 844 });
  const fits = await page.$eval(".el-dialog", (dialog) => {
    const rect = dialog.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth && dialog.scrollWidth <= dialog.clientWidth;
  });
  assert.equal(fits, true, "history dialog should fit a mobile viewport");
  const entries = await page.$$(".history-entry");
  await entries[1].$("button").then((button) => button.click());
  await page.waitForFunction(() => location.pathname === "/chat" && document.body.textContent.includes("昨日经营日报完整执行过程"));
  assert.equal(await page.$$(".conversation-select").then((nodes) => nodes.length), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, historyEntries: 2, legacyHistory: true, mobileWidth: 390, opensOlderConversation: true, normalHistoryUnchanged: true }));
} finally {
  await browser?.close();
  await gateway?.close();
  await sources?.close();
  await rm(root, { recursive: true, force: true });
}

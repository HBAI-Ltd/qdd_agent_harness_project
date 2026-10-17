// Production UI + real local gateway + fresh Chrome profile; no external APIs.
// npm run build && npm run build:web && node scripts/test-frontend-navigation.mjs
import assert from "node:assert/strict";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
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

const dist = fileURLToPath(new URL("../apps/web/dist/", import.meta.url));
await readFile(path.join(dist, "index.html"));
const root = await mkdtemp(path.join(tmpdir(), "qdd-frontend-navigation-"));
const token = "frontend-navigation-test-token";
const sessionId = "11111111-1111-4111-8111-111111111111";
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
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
loaded.config.browser.enabled = false;
loaded.config.mcpServers = {};
await ensureWorkspace(loaded.paths);
await writeFile(path.join(loaded.paths.sessions, `${sessionId}.meta.json`), JSON.stringify({
  id: sessionId, title: "连接回归对话", summary: "", slug: null, status: "idle",
  createdAt: "2026-10-17T00:00:00.000Z", updatedAt: "2026-10-17T00:00:00.000Z",
}));
const sources = await DataSources.open(loaded);
const gateway = await startGateway(loaded, sources, {
  token, scheduler: false, chat: () => { throw new Error("This regression must not call an LLM"); },
});
const streams = new Set();
let maxStreams = 0;
let requests = 0;
let streamsOpened = 0;
const diagnostics = ({ request, response }) => {
  if (request.headers.host !== new URL(gateway.url).host) return;
  requests++;
  if (!request.url.includes("/events")) return;
  streamsOpened++;
  streams.add(response);
  maxStreams = Math.max(maxStreams, streams.size);
  response.once("close", () => streams.delete(response));
};
subscribe("http.server.request.start", diagnostics);
const executablePath = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
let browser;
try {
  const health = await fetch(`${gateway.url}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");
  assert.equal((await fetch(`${gateway.url}/unknown-regression-route`)).status, 404);
  browser = await puppeteer.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  const waitForStreams = async (count) => {
    const deadline = performance.now() + 3000;
    while (streams.size !== count && performance.now() < deadline) await setTimeout(10);
    assert.equal(streams.size, count, "Only the current document may retain SSE connections");
  };
  await page.evaluateOnNewDocument((base, value) => {
    localStorage.setItem("harness-gateway-url", base);
    sessionStorage.setItem("harness-gateway-token", value);
  }, gateway.url, token);
  const failures = [];
  const durations = [];
  const routes = ["overview", "skills", "schedules", "tasks", "settings", "chat"];
  const rounds = Number(process.env.NAVIGATION_ROUNDS ?? 30);
  assert.ok(Number.isInteger(rounds) && rounds > 0, "NAVIGATION_ROUNDS must be a positive integer");
  for (let i = 0; i < rounds; i++) {
    const route = routes[i % routes.length];
    const started = performance.now();
    const receivedBefore = requests;
    await page.goto(`${origin}/${route}`, { waitUntil: "domcontentloaded" });
    const connected = await page.waitForFunction(() => document.body.innerText.includes("网关已连接"), { timeout: 3000 })
      .then(() => true, () => false);
    const elapsed = Math.round(performance.now() - started);
    durations.push(elapsed);
    if (!connected) failures.push({ round: i + 1, route, elapsed, streams: streams.size, gatewayRequests: requests - receivedBefore });
    if (connected) await waitForStreams(2);
    console.log(JSON.stringify({ round: i + 1, route, connected, elapsed, streams: streams.size, gatewayRequests: requests - receivedBefore }));
  }
  assert.equal(failures.length, 0, "Every full navigation must reconnect within 3 seconds");

  const labels = { overview: "工作台总览", skills: "技能", schedules: "定时任务", tasks: "任务", settings: "工作空间设置", chat: "对话" };
  const beforeSpa = streamsOpened;
  await page.evaluate(() => { window.navigationTestDocument = "same-document"; });
  for (let i = 0; i < 30; i++) {
    const route = routes[i % routes.length];
    const selector = route === "settings" ? `[aria-label="${labels[route]}"]` : `nav [aria-label="${labels[route]}"]`;
    await page.click(selector);
    await page.waitForFunction((expected) => location.pathname === `/${expected}`, { timeout: 3000 }, route);
    assert.equal(await page.evaluate(() => window.navigationTestDocument), "same-document");
    await waitForStreams(2);
  }
  assert.equal(streamsOpened, beforeSpa, "Router navigation must keep the existing subscriptions");

  for (let i = 0; i < 5; i++) {
    await page.goto(`${origin}/navigation-regression-away`, { waitUntil: "domcontentloaded" });
    await waitForStreams(0);
    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.body.innerText.includes("网关已连接"), { timeout: 3000 });
    await waitForStreams(2);
    await page.goForward({ waitUntil: "domcontentloaded" });
    await waitForStreams(0);
    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.body.innerText.includes("网关已连接"), { timeout: 3000 });
    await waitForStreams(2);
  }
  console.log(JSON.stringify({ rounds, spaNavigations: 30, documentExits: 5, historyTraversals: 15, failures, maxStreams, maxConnectionMs: Math.max(...durations) }));
  assert.ok(maxStreams <= 4, `Previous documents retained SSE streams: ${maxStreams}`);
} finally {
  await browser?.close();
  unsubscribe("http.server.request.start", diagnostics);
  await gateway.close();
  await sources.close();
  await new Promise((resolve) => ui.close(resolve));
}

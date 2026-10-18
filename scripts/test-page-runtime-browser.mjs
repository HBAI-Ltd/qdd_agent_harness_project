// Real Chrome + isolated gateway; no external model, business data, or messages.
// npm run build && node scripts/test-page-runtime-browser.mjs
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { loadConfig } from "../apps/cli/dist/config.js";
import { DataSources } from "../apps/cli/dist/datasource/registry.js";
import { defineRecord, parseRecordDefinition } from "../apps/cli/dist/datasets/records.js";
import { startGateway } from "../apps/cli/dist/gateway/server.js";
import { Auth } from "../apps/cli/dist/gateway/auth.js";
import { ensureWorkspace, upsertPage } from "../apps/cli/dist/web/site.js";

const browserEnv = Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value]));
const executablePath = [
  browserEnv.CHROME_PATH,
  ...[browserEnv.PROGRAMFILES, browserEnv["PROGRAMFILES(X86)"], browserEnv.LOCALAPPDATA].filter(Boolean).flatMap((directory) => [
    path.join(directory, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(directory, "Microsoft", "Edge", "Application", "msedge.exe"),
  ]),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium",
].find((candidate) => candidate && existsSync(candidate));
assert.ok(executablePath, "Chrome/Edge is required; set CHROME_PATH if needed.");

const root = await mkdtemp(path.join(tmpdir(), "qdd-page-runtime-browser-"));
const token = "isolated-page-runtime-test-token";
const auth = new Auth(token);
let sources;
let gateway;
let browser;
try {
  const loaded = await loadConfig(root);
  loaded.config.gateway.host = "127.0.0.1";
  loaded.config.gateway.port = 0;
  await ensureWorkspace(loaded.paths);
  sources = await DataSources.open(loaded);
  await defineRecord(sources.datasets, parseRecordDefinition({ name: "runtime", label: "Runtime fixture", fields: [{ name: "note", type: "string", required: true }] }));
  const at = new Date().toISOString();
  for (const slug of ["alpha", "beta"]) {
    const directory = path.join(loaded.paths.pages, slug);
    await mkdir(path.join(directory, "data"), { recursive: true });
    await writeFile(path.join(directory, "data", "fixture.js"), "window.QDD_DATA={fixture:[{value:7}]};");
    await writeFile(path.join(directory, "module.js"), "window.runtimeModuleReady=true;");
    await writeFile(path.join(directory, "index.html"), '<!doctype html><html><head><link rel="stylesheet" href="../../assets/theme.css"></head><body><script src="./data/fixture.js"></script><script type="module" src="./module.js"></script></body></html>');
    await upsertPage(loaded.paths, {
      slug, title: slug, wish: "Runtime fixture", summary: "", tools: ["store__get_store_info"], useAgent: true,
      records: ["runtime"], metrics: [], datasets: {}, version: 1, stale: null, gaps: [], sessionId: "fixture", createdAt: at, updatedAt: at,
    });
  }
  gateway = await startGateway(loaded, sources, { token, scheduler: false, chat: () => async () => ({ role: "assistant", content: "本地模拟回答" }) });
  browser = await puppeteer.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  const uncaught = [];
  page.on("pageerror", (error) => uncaught.push(error.message));
  // Establish both path cookies, matching a user opening two tasks in succession.
  for (const slug of ["beta", "alpha"]) {
    await page.goto(`${gateway.url}/pages/${slug}/?page_token=${auth.pageToken(slug)}`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => !!window.qdd && window.runtimeModuleReady === true);
  }
  const result = await page.evaluate(async () => {
    const store = await qdd.tool("store__get_store_info", {});
    const answer = await qdd.ask("本地运行检查");
    await qdd.state.set({ filter: "saved" });
    const state = await qdd.state.get();
    const [created] = await qdd.records.add("runtime", { note: "initial" });
    await qdd.records.update("runtime", created.id, { note: "updated" });
    const listed = await qdd.records.list("runtime");
    await qdd.records.remove("runtime", created.id);
    const removed = await qdd.records.list("runtime");
    return { store, answer, state, snapshot: qdd.snapshot("fixture"), listed: listed.rows, removed: removed.total,
      theme: getComputedStyle(document.documentElement).getPropertyValue("--qdd-bg").trim(), module: window.runtimeModuleReady };
  });
  assert.ok(result.store && typeof result.store === "object");
  assert.equal(result.answer, "本地模拟回答");
  assert.deepEqual(result.state, { filter: "saved" });
  assert.deepEqual(result.snapshot, [{ value: 7 }]);
  assert.equal(result.listed[0].note, "updated");
  assert.equal(result.removed, 0);
  assert.ok(result.theme);
  assert.equal(result.module, true);
  let siblingRequests = 0;
  let siblingResponses = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/pages/beta/")) siblingRequests++; });
  page.on("response", (response) => { if (new URL(response.url()).pathname.startsWith("/pages/beta/") && response.ok()) siblingResponses++; });
  const blocked = await page.evaluate(async () => {
    const fetchBlocked = await fetch("/pages/beta/").then(() => false, () => true);
    const scriptBlocked = await new Promise((resolve) => {
      const script = document.createElement("script");
      script.onload = () => resolve(false);
      script.onerror = () => resolve(true);
      script.src = "/pages/beta/data/fixture.js";
      document.body.appendChild(script);
    });
    const frameBlocked = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { document.removeEventListener("securitypolicyviolation", violation); reject(new Error("Missing frame CSP enforcement")); }, 3000);
      function violation(event) {
        if (event.effectiveDirective !== "frame-src") return;
        clearTimeout(timeout);
        document.removeEventListener("securitypolicyviolation", violation);
        resolve(true);
      }
      document.addEventListener("securitypolicyviolation", violation);
      const frame = document.createElement("iframe");
      frame.src = "/pages/beta/";
      document.body.appendChild(frame);
    });
    const popupBlocked = window.open("/pages/beta/") === null;
    return { fetchBlocked, scriptBlocked, frameBlocked, popupBlocked };
  });
  assert.deepEqual(blocked, { fetchBlocked: true, scriptBlocked: true, frameBlocked: true, popupBlocked: true });
  // Chromium emits request events for CSP-blocked attempts; response checks prove
  // no forbidden document or script was loaded successfully.
  assert.equal((await browser.pages()).length, 2);
  assert.equal(siblingResponses, 0);
  assert.deepEqual(uncaught, []);
  const attemptedSiblingRequests = siblingRequests;
  const shell = `<iframe sandbox="allow-scripts allow-downloads" src="/pages/alpha/?page_token=${auth.pageToken("alpha")}"></iframe>`
    + `<iframe sandbox="allow-scripts allow-downloads" src="/pages/beta/?page_token=${auth.pageToken("beta")}"></iframe>`;
  await writeFile(path.join(loaded.paths.site, "assets", "runtime-shell.html"), shell);
  await page.goto(`${gateway.url}/assets/runtime-shell.html`, { waitUntil: "networkidle0" });
  const alpha = page.frames().find((frame) => frame.url().includes("/pages/alpha~"));
  const beta = page.frames().find((frame) => frame.url().includes("/pages/beta~"));
  assert.ok(alpha && beta, "Both real gateway pages must finish their canonical navigation");
  await Promise.all([alpha, beta].map((frame) => frame.waitForFunction(() => !!window.qdd && window.runtimeModuleReady === true)));
  const isolation = await alpha.evaluate(async () => {
    let siblingDenied = false;
    let parentDenied = false;
    try { void parent.frames[1].document; } catch (error) { siblingDenied = error.name === "SecurityError"; }
    try { void parent.document; } catch (error) { parentDenied = error.name === "SecurityError"; }
    const store = await qdd.tool("store__get_store_info", {});
    return { siblingDenied, parentDenied, sandboxApi: !!store, module: window.runtimeModuleReady === true };
  });
  assert.deepEqual(isolation, { siblingDenied: true, parentDenied: true, sandboxApi: true, module: true });
  assert.deepEqual(uncaught, []);
  console.log(JSON.stringify({ runtime: "passed", tools: true, ask: true, state: true, records: true,
    ownSnapshot: true, ownModule: true, theme: true, ...blocked, ...isolation, uncaught: uncaught.length, attemptedSiblingRequests }));
} finally {
  await browser?.close();
  await gateway?.close();
  await sources?.close();
  await rm(root, { recursive: true, force: true });
}

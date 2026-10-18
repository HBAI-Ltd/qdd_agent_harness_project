// Run from the repository root: node scripts/test-frontend-dev-cache.mjs
// A separate Vite server, empty dependency cache, and fresh browser profile keep
// measurements independent of the user's development server and browser cache.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { createServer } from "vite";

const webRoot = fileURLToPath(new URL("../apps/web/", import.meta.url));
const browserEnv = Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value]));
const executablePath = [
  browserEnv.CHROME_PATH,
  ...[browserEnv.PROGRAMFILES, browserEnv["PROGRAMFILES(X86)"], browserEnv.LOCALAPPDATA]
    .filter(Boolean)
    .flatMap((directory) => [
      path.join(directory, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(directory, "Microsoft", "Edge", "Application", "msedge.exe"),
    ]),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((candidate) => candidate && existsSync(candidate));
assert.ok(executablePath, "未找到本机 Chrome/Edge；可通过 CHROME_PATH 指定浏览器路径。");

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "qdd-frontend-dev-cache-"));
const fixtureName = `dev-cache-probe-${randomUUID()}.js`;
const fixturePath = path.join(webRoot, fixtureName);
const probeSource = (version) => `export const version = ${JSON.stringify(version)};
window.__qddDevCacheProbe = version;
if (import.meta.hot) {
  import.meta.hot.accept((updated) => { window.__qddDevCacheProbe = updated.version; });
}
`;
const optimizedDependency = (url) => /\/deps\/[^/]+\.js$/.test(new URL(url).pathname);
const sourceModule = (request) => request.type === "Script"
  && /\/src\/.*\.(?:[cm]?[jt]sx?|vue)$/.test(new URL(request.url).pathname);
const wholeElementPlus = (url) => /\/(?:element-plus|element-plus_es)\.js$/.test(new URL(url).pathname)
  || /\/element-plus\/(?:es\/index\.mjs|lib\/index\.js|dist\/index\.full\.(?:mjs|js))$/.test(new URL(url).pathname);

let server;
let browser;
let fixtureCreated = false;
try {
  server = await createServer({
    root: webRoot,
    configFile: path.join(webRoot, "vite.config.ts"),
    cacheDir: path.join(temporaryRoot, "vite"),
    define: { __DEV_GATEWAY_TOKEN__: JSON.stringify("") },
    plugins: [{
      name: "dev-cache-health-fixture",
      configureServer(vite) {
        vite.middlewares.use("/health", (_request, response) => {
          response.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"ok"}');
        });
      },
    }],
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
  });
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    userDataDir: path.join(temporaryRoot, "browser"),
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
  const pageErrors = [];
  const moduleFailures = [];
  const allRequests = [];
  const requestById = new Map();
  let currentRound;
  let documentNavigations = 0;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) documentNavigations++;
  });
  cdp.on("Network.requestWillBeSent", ({ requestId, request, type }) => {
    if (!request.url.startsWith(origin)) return;
    const entry = { url: request.url, type, cached: false };
    requestById.set(requestId, entry);
    allRequests.push(entry);
    currentRound?.push(entry);
  });
  cdp.on("Network.requestServedFromCache", ({ requestId }) => {
    const entry = requestById.get(requestId);
    if (entry) entry.cached = true;
  });
  cdp.on("Network.responseReceived", ({ requestId, response }) => {
    const entry = requestById.get(requestId);
    if (!entry) return;
    entry.status = response.status;
    entry.cached ||= Boolean(response.fromDiskCache || response.fromPrefetchCache);
    if (entry.type === "Script" && response.status >= 400) {
      moduleFailures.push({ url: entry.url, status: response.status });
    }
  });
  // Chromium exposes the effective cached response as 200; ExtraInfo contains
  // the actual 304 status sent by Vite during source-module revalidation.
  cdp.on("Network.responseReceivedExtraInfo", ({ requestId, statusCode }) => {
    const entry = requestById.get(requestId);
    if (entry) entry.wireStatus = statusCode;
  });
  cdp.on("Network.loadingFailed", ({ requestId, errorText }) => {
    const entry = requestById.get(requestId);
    if (entry?.type === "Script") moduleFailures.push({ url: entry.url, error: errorText });
  });

  const rounds = [];
  for (let round = 0; round < 3; round++) {
    const requests = [];
    currentRound = requests;
    const started = performance.now();
    if (round === 0) await page.goto(`${origin}/chat`, { waitUntil: "domcontentloaded", timeout: 60000 });
    else await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    await Promise.all([
      page.waitForSelector(".chat-view", { timeout: 60000 }),
      page.waitForSelector(".sidebar", { timeout: 60000 }),
    ]);
    const readyMs = Math.round(performance.now() - started);
    await page.waitForNetworkIdle({ idleTime: 300, timeout: 60000 });
    const timing = await page.evaluate(() => {
      const entries = [
        ...performance.getEntriesByType("navigation"),
        ...performance.getEntriesByType("resource"),
      ].filter((entry) => entry.name.startsWith(location.origin));
      return {
        transferSize: entries.reduce((sum, entry) => sum + entry.transferSize, 0),
        decodedBodySize: entries.reduce((sum, entry) => sum + entry.decodedBodySize, 0),
      };
    });
    const dependencies = requests.filter((entry) => optimizedDependency(entry.url));
    const sources = requests.filter(sourceModule);
    const summary = {
      round: round === 0 ? "cold" : `reload-${round}`,
      requestCount: requests.length,
      ...timing,
      readyMs,
      elapsedMs: Math.round(performance.now() - started),
      dependencyRequests: dependencies.length,
      cachedDependencies: dependencies.filter((entry) => entry.cached).length,
      sourceRequests: sources.length,
      source304: sources.filter((entry) => entry.wireStatus === 304).length,
    };
    rounds.push(summary);
    console.log(JSON.stringify(summary));
    assert.ok(dependencies.length > 0, "The app must load optimized dependencies");
    assert.ok(sources.length > 0, "The app must load source modules");
    if (round > 0) {
      assert.equal(summary.cachedDependencies, dependencies.length, "Ordinary reloads must reuse every optimized dependency from browser cache");
      assert.ok(summary.source304 > 0, "Ordinary reloads must revalidate unchanged source modules with HTTP 304");
      assert.ok(timing.transferSize < rounds[0].transferSize, "Ordinary reloads must transfer less data than the cold load");
    }
  }
  currentRound = undefined;

  // A successful HTTP import does not prove Chokidar has finished adding a new
  // file. Wait for its add event so the first edit cannot be folded into that
  // initial filesystem observation instead of producing an HMR change event.
  let stopWaitingForFixture;
  const fixtureWatched = new Promise((resolve, reject) => {
    const onAdd = (file) => {
      if (path.resolve(file) === fixturePath) resolve();
    };
    const timeout = setTimeout(() => reject(new Error("Vite did not begin watching the HMR fixture within 15 seconds.")), 15000);
    stopWaitingForFixture = () => {
      clearTimeout(timeout);
      server.watcher.off("add", onAdd);
    };
    server.watcher.on("add", onAdd);
  });
  try {
    await Promise.all([
      fixtureWatched,
      writeFile(fixturePath, probeSource("initial"), { flag: "wx" }).then(() => { fixtureCreated = true; }),
    ]);
  } finally {
    stopWaitingForFixture();
  }
  const documentId = randomUUID();
  await page.evaluate(async (id, modulePath) => {
    window.__qddDevCacheDocument = id;
    await import(modulePath);
  }, documentId, `/${fixtureName}`);
  assert.equal(await page.evaluate(() => window.__qddDevCacheProbe), "initial");
  const navigationsBeforeHmr = documentNavigations;
  await writeFile(fixturePath, probeSource("updated"));
  await page.waitForFunction(() => window.__qddDevCacheProbe === "updated", { timeout: 15000 });
  assert.equal(await page.evaluate(() => window.__qddDevCacheDocument), documentId, "HMR must preserve the current document");
  assert.equal(documentNavigations, navigationsBeforeHmr, "HMR must not trigger document navigation");

  const routes = {
    skills: ".skills-page",
    schedules: ".schedules-page",
    connectors: ".connectors-page",
    settings: ".settings-panel",
    tasks: ".task-board",
    overview: ".store-overview",
    test: ".connectionPage",
    "dev-cache-missing-route": ".notFound",
    chat: ".chat-view",
  };
  for (const [route, selector] of Object.entries(routes)) {
    await page.evaluate(async (nextRoute) => {
      const { default: router } = await import("/src/router/index.ts");
      await router.push(nextRoute);
    }, `/${route}`);
    await page.waitForSelector(selector, { timeout: 60000 });
    await page.waitForNetworkIdle({ idleTime: 300, timeout: 60000 });
    assert.equal(await page.evaluate(() => window.__qddDevCacheDocument), documentId, `Opening /${route} must preserve the document`);
  }

  assert.deepEqual(allRequests.filter((entry) => wholeElementPlus(entry.url)).map((entry) => entry.url), [], "The browser must not request the entire Element Plus JavaScript library");
  assert.deepEqual(pageErrors, [], "The application and HMR must not produce uncaught browser errors");
  assert.deepEqual(moduleFailures, [], "Every JavaScript module request must succeed");
  console.log(JSON.stringify({ browser: await browser.version(), rounds: rounds.length, hmr: "same-document update passed", lazyRoutes: Object.keys(routes), pageErrors, moduleFailures }));
} finally {
  // Remove only this invocation's files after closing their browser/server owners.
  try {
    await browser?.close();
  } finally {
    try {
      await server?.close();
    } finally {
      if (fixtureCreated) await rm(fixturePath, { force: true });
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

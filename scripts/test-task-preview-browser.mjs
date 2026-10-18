import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { compileScript, parse } from "@vue/compiler-sfc";
import puppeteer from "puppeteer-core";
import { SDK_JS } from "../apps/cli/src/gateway/sdk.ts";

// Run from the repository root after installing dependencies and building shared.
// Bundle the actual component in production mode, then exercise real iframe loads.
const root = fileURLToPath(new URL("..", import.meta.url));
const browserEnv = Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value]));
const chrome = [
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
assert.ok(chrome, "未找到本机 Chrome/Edge；可通过 CHROME_PATH 指定浏览器路径。");

let shellOrigin;
let gatewayOrigin;
let bundle;
const requests = { normal: 0, hang: 0, nosdk: 0, victim: 0, attacker: 0, redirects: 0, modules: 0, api: 0 };
const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
};
const gateway = createServer((req, res) => {
  if (req.url === "/bundle.js") return res.writeHead(200, { "Content-Type": "text/javascript" }).end(bundle);
  if (req.url === "/same-shell") return res.writeHead(200, { "Content-Type": "text/html" }).end('<!doctype html><div id="app"></div><script src="/bundle.js"></script>');
  if (req.url === "/assets/theme.css") return res.writeHead(200, { "Content-Type": "text/css" }).end("body { --theme-loaded: yes; }");
  const route = /^\/pages\/([^/~]+)(~[^/]+)?\/(.*)$/.exec(req.url);
  const slug = route?.[1];
  if (slug === "hang") { requests.hang++; return; }
  if (req.url?.startsWith("/api/state/")) {
    res.setHeader("Access-Control-Allow-Origin", "null");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-QDD-Page, X-QDD-Page-Token");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    assert.equal(req.headers.origin, "null");
    assert.equal(req.headers["x-qdd-page-token"], "page-only-token");
    requests.api++;
    return res.writeHead(200, { "Content-Type": "application/json" }).end('{"state":{"ready":true}}');
  }
  if (["normal", "nosdk", "victim", "attacker"].includes(slug)) {
    if (!route[2]) {
      requests.redirects++;
      return res.writeHead(302, { Location: `/pages/${slug}~page-only-token/${route[3]}` }).end();
    }
    if (route[3] === "module.js" || route[3] === "dependency.js") {
      requests.modules++;
      res.setHeader("Access-Control-Allow-Origin", "null");
      return res.writeHead(200, { "Content-Type": "text/javascript" }).end(route[3] === "dependency.js"
        ? 'export const fixture = "loaded";'
        : 'import {fixture} from "./dependency.js"; document.body.dataset.module = fixture;');
    }
    requests[slug]++;
    const sdk = slug !== "nosdk" ? `<script>window.QDD_PAGE=${JSON.stringify({ slug, token: "page-only-token", hostOrigins: [shellOrigin, gatewayOrigin] })};window.__qddCompute={};</script><script>${SDK_JS}</script>` : "";
    const attack = slug === "attacker" ? `window.siblingReads=[]; for(let i=0;i<parent.length;i++){const sibling=parent.frames[i];if(sibling===window)continue;try{window.siblingReads.push(sibling.QDD_PAGE.token);}catch(error){window.siblingReads.push(error.name);}}try{parent.document.body;window.shellRead="allowed";}catch(error){window.shellRead=error.name;}` : "";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><head>${sdk}<link rel="stylesheet" href="../../assets/theme.css"></head><body>门店销售看板<script type="module" src="./module.js"></script><script>${attack}if(window.qdd){window.qdd.host.ready.then(()=>document.body.dataset.ready='yes');window.qdd.state.get().then(state=>document.body.dataset.api=String(state.ready));}</script></body>`);
    return;
  }
  res.writeHead(404).end();
});
const shell = createServer((req, res) => {
  if (req.url === "/bundle.js") return res.writeHead(200, { "Content-Type": "text/javascript" }).end(bundle);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end('<!doctype html><div id="app"></div><script src="/bundle.js"></script>');
});
let browser;
try {
  gatewayOrigin = await listen(gateway);
  shellOrigin = await listen(shell);
  const result = await build({
    stdin: {
      contents: `import {createApp,h,ref} from "vue"; import TaskPreview from "./apps/web/src/components/TaskPreview.vue";
        const active=ref(new URL(location.href).searchParams.get("slug")||"normal"); window.setPage=(slug)=>active.value=slug;
        const preview=(slug)=>h(TaskPreview,{page:{slug,title:"销售看板",version:1,kind:"once",schedules:[],pinnedAt:null,stale:null,url:${JSON.stringify(gatewayOrigin)}+"/pages/"+slug+"/index.html"},gatewayUrl:${JSON.stringify(gatewayOrigin)}});
        createApp({render:()=>new URL(location.href).searchParams.has("isolation")?h("div",[preview("victim"),preview("attacker")]):preview(active.value)}).mount("#app");`,
      resolveDir: root, loader: "js",
    },
    bundle: true, write: false, format: "iife", define: { "process.env.NODE_ENV": '"production"' },
    alias: { "@": path.join(root, "apps/web/src") },
    plugins: [{ name: "vue-sfc-check", setup(build) {
      build.onLoad({ filter: /\.vue$/ }, async ({ path: file }) => {
        const source = await readFile(file, "utf8");
        const { descriptor } = parse(source);
        return { contents: compileScript(descriptor, { id: file, inlineTemplate: true }).content, loader: "ts", resolveDir: path.dirname(file) };
      });
    } }],
  });
  bundle = result.outputFiles[0].contents;
  browser = await puppeteer.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  for (let i = 0; i < 30; i++) {
    await page.goto(`${shellOrigin}/?slug=normal&round=${i}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!document.querySelector("iframe") && !document.querySelector(".preview-loading"), { timeout: 5000 });
    assert.equal(await page.$eval(".preview-frame-container", (node) => node.getAttribute("aria-busy")), "false");
    assert.equal(await page.$(".preview-error"), null);
    const frame = page.frames().find((frame) => frame.url().startsWith(gatewayOrigin));
    assert.ok(frame);
    assert.ok(frame.url().includes("/pages/normal~page-only-token/"));
    assert.equal(await page.$eval("iframe", (node) => node.getAttribute("sandbox")), "allow-scripts allow-downloads");
    await frame.waitForFunction(() => document.body.dataset.module === "loaded" && document.body.dataset.api === "true");
    assert.equal(await frame.$eval("body", (body) => getComputedStyle(body).getPropertyValue("--theme-loaded").trim()), "yes");
    assert.equal(await frame.$eval("body", (body) => body.dataset.ready), "yes");
  }
  console.log("Normal iframe handshakes: 30/30");
  await page.goto(`${gatewayOrigin}/same-shell`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!document.querySelector("iframe") && !document.querySelector(".preview-loading"), { timeout: 5000 });
  const sameOriginFrame = page.frames().find((frame) => frame !== page.mainFrame() && frame.url().startsWith(gatewayOrigin));
  await sameOriginFrame.waitForFunction(() => document.body.dataset.module === "loaded" && document.body.dataset.api === "true");
  assert.equal(await page.$(".preview-error"), null);
  await page.goto(`${shellOrigin}/?isolation=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("iframe").length === 2 && !document.querySelector(".preview-loading"), { timeout: 5000 });
  const attacker = page.frames().find((frame) => frame.url().includes("/pages/attacker~"));
  assert.deepEqual(await attacker.evaluate(() => window.siblingReads), ["SecurityError"]);
  assert.equal(await attacker.evaluate(() => window.shellRead), "SecurityError");
  await page.goto(`${shellOrigin}/?slug=normal`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!document.querySelector("iframe") && !document.querySelector(".preview-loading"), { timeout: 5000 });
  await page.evaluate(() => window.setPage("hang"));
  await page.waitForSelector(".preview-error", { timeout: 20000 });
  assert.match(await page.$eval(".preview-error", (node) => node.textContent), /加载超时/);
  assert.equal(await page.$(".preview-loading"), null);
  await page.evaluate(() => window.setPage("nosdk"));
  await page.waitForSelector(".preview-error", { timeout: 12000 });
  assert.match(await page.$eval(".preview-error", (node) => node.textContent), /未建立通信/);
  assert.equal(await page.$(".preview-loading"), null);
  assert.deepEqual(consoleErrors, []);
  console.log(JSON.stringify({ chrome: await browser.version(), normalHandshakes: 30, canonicalRedirects: "passed", relativeModulesAndTheme: "passed", opaqueSdkApi: "passed", sameOriginGateway: "passed", siblingAndShellIsolation: "passed", pendingNavigationTimeout: "passed", missingSdkTimeout: "passed", consoleErrors, requests }));
} finally {
  await browser?.close();
  shell.closeAllConnections();
  gateway.closeAllConnections();
  await Promise.all([new Promise((resolve) => shell.close(resolve)), new Promise((resolve) => gateway.close(resolve))]);
}

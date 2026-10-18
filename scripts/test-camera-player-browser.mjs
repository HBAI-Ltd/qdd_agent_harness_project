// npm run build && node scripts/test-camera-player-browser.mjs
// Real gateway, sandboxed task page and player; all video bytes are synthetic.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { loadConfig } from "../apps/cli/dist/config.js";
import { DataSources } from "../apps/cli/dist/datasource/registry.js";
import { Auth } from "../apps/cli/dist/gateway/auth.js";
import { startGateway } from "../apps/cli/dist/gateway/server.js";
import { ensureWorkspace } from "../apps/cli/dist/web/site.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value]));
const chrome = [
  env.CHROME_PATH,
  ...[env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean).flatMap((directory) => [
    path.join(directory, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(directory, "Microsoft", "Edge", "Application", "msedge.exe"),
  ]),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
].find((candidate) => candidate && existsSync(candidate));
const ffmpeg = [
  env.FFMPEG_PATH,
  ...["mcp/tools/node_modules/ffmpeg-static", "node_modules/ffmpeg-static"].flatMap((directory) => [
    path.join(projectRoot, directory, "ffmpeg.exe"), path.join(projectRoot, directory, "ffmpeg"),
  ]),
].find((candidate) => candidate && existsSync(candidate));
assert.ok(chrome, "未找到 Chrome/Edge，可用 CHROME_PATH 指定。");
assert.ok(ffmpeg, "未找到 FFmpeg，请安装 mcp/tools 依赖或用 FFMPEG_PATH 指定。");

// An ephemeral self-signed certificate stays in memory; no local trust store is changed.
function fixtureCertificate() {
  const der = (tag, ...parts) => {
    const content = Buffer.concat(parts);
    const hex = content.length.toString(16).padStart(Math.ceil(content.length.toString(16).length / 2) * 2, "0");
    const size = content.length < 128 ? Buffer.from([content.length]) : Buffer.concat([Buffer.from([128 + hex.length / 2]), Buffer.from(hex, "hex")]);
    return Buffer.concat([Buffer.from([tag]), size, content]);
  };
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const algorithm = Buffer.from("300d06092a864886f70d01010b0500", "hex");
  const hostname = Buffer.from("media-fixture.example");
  const name = der(0x30, der(0x31, der(0x30, Buffer.from("0603550403", "hex"), der(0x0c, hostname))));
  const utc = (date) => der(0x17, Buffer.from(date.toISOString().replace(/\D/g, "").slice(2, 14) + "Z"));
  const validity = der(0x30, utc(new Date(Date.now() - 60_000)), utc(new Date(Date.now() + 86_400_000)));
  const extension = der(0xa3, der(0x30, der(0x30, Buffer.from("0603551d11", "hex"), der(0x04, der(0x30, der(0x82, hostname))))));
  const body = der(0x30, der(0xa0, Buffer.from("020102", "hex")), Buffer.from("020101", "hex"), algorithm,
    name, validity, name, publicKey.export({ type: "spki", format: "der" }), extension);
  const certificate = der(0x30, body, algorithm, der(0x03, Buffer.from([0]), sign("RSA-SHA256", body, privateKey)));
  return { key: privateKey.export({ type: "pkcs8", format: "pem" }),
    cert: `-----BEGIN CERTIFICATE-----\n${certificate.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n` };
}

let MEDIA_ORIGIN, MEDIA_URL, BLOCKED_URLS;
const SLUG = "synthetic-camera-player";
const TOKEN = "synthetic-camera-player-test-token";
const root = await mkdtemp(path.join(tmpdir(), "qdd-camera-player-"));
let browser, gateway, sources, encoder, shellOrigin, frameUrl, fixtureBytes;
const streamer = createHttpsServer(fixtureCertificate(), (_req, res) => {
  res.writeHead(200, { "Content-Type": "video/x-flv", "Access-Control-Allow-Origin": gateway.url, "Cache-Control": "no-store" });
  let offset = 0;
  const timer = setInterval(() => {
    if (offset >= fixtureBytes.length) return;
    const end = Math.min(offset + 5000, fixtureBytes.length);
    res.write(fixtureBytes.subarray(offset, end));
    offset = end;
    // Keep the synthetic live response open until the player explicitly stops.
  }, 50);
  res.once("close", () => clearInterval(timer));
});
const shell = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><html><head><title>Synthetic camera task</title></head><body>
    <iframe title="Synthetic task" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" style="width:640px;height:420px;border:0" src="${frameUrl}"></iframe>
  </body></html>`);
});

async function generateFixture(file) {
  await new Promise((resolve, reject) => {
    encoder = spawn(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10",
      "-t", "6", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
      "-pix_fmt", "yuv420p", "-g", "10", "-f", "flv", file,
    ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let diagnostic = "";
    encoder.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk).slice(-2000); });
    const deadline = setTimeout(() => { encoder.kill(); reject(new Error("合成视频生成超时")); }, 30_000);
    encoder.once("error", (error) => { clearTimeout(deadline); reject(error); });
    encoder.once("close", (code) => {
      clearTimeout(deadline);
      if (code === 0) resolve();
      else reject(new Error(`合成视频生成失败：${diagnostic}`));
    });
  });
}

const fixtureHtml = () => `<!doctype html><html><head><meta charset="utf-8">
  <link rel="stylesheet" href="/assets/camera-player/style.css">
  <script src="/assets/camera-player/index.js"></script>
  <style>body{margin:16px;background:#fff}#player{width:320px;height:180px;background:#111}</style>
</head><body><button id="start" onclick="startPlayer(true)">Play synthetic camera</button><div id="player"></div><script>
  window.fixture = { events: {}, violations: [], errors: [] };
  addEventListener("securitypolicyviolation", event => fixture.violations.push({directive:event.effectiveDirective,blocked:event.blockedURI}));
  window.startPlayer = useMSE => {
    window.fixturePlayer?.destroy();
    fixture.events = {};
    fixture.errors = [];
    document.querySelector("#player").replaceChildren();
    window.fixturePlayer = new EzuikitFlv({
      id: "player", url: ${JSON.stringify(MEDIA_URL)}, decoder: "/assets/camera-player/decoder.js",
      autoPlay: true, useMSE, autoWasm: true, muted: true, hasAudio: false, isEzviz: false,
      isLive: true, ignoreMonitor: true, disableColect: true,
      themeData: null, debug: false, loadingTimeoutReplayTimes: 0, heartTimeoutReplayTimes: 0,
    });
    for (const name of ["play", "playing", "videoFrame", "decoderWorkerInit", "loaded"])
      fixturePlayer.on(name, () => { fixture.events[name] = (fixture.events[name] || 0) + 1; });
    fixturePlayer.on("error", () => fixture.errors.push("player-error"));
    fixturePlayer.player?.decoderWorker?.decoderWorker?.addEventListener("error", event => fixture.errors.push(event.message || "worker-error"));
  };
</script></body></html>`;

try {
  const fixtureFile = path.join(root, "synthetic.flv");
  await generateFixture(fixtureFile);
  fixtureBytes = await readFile(fixtureFile);
  assert.equal(fixtureBytes.subarray(0, 3).toString("ascii"), "FLV");
  await new Promise((resolve) => shell.listen(0, "127.0.0.1", resolve));
  shellOrigin = `http://127.0.0.1:${shell.address().port}`;
  await new Promise((resolve) => streamer.listen(0, "127.0.0.1", resolve));
  const mediaPort = streamer.address().port;
  MEDIA_ORIGIN = `https://media-fixture.example:${mediaPort}`;
  MEDIA_URL = `${MEDIA_ORIGIN}/live.flv`;
  BLOCKED_URLS = [`https://unlisted-media.example:${mediaPort}/live.flv`, `https://media-fixture.example:${mediaPort === 65535 ? mediaPort - 1 : mediaPort + 1}/live.flv`];
  await writeFile(path.join(root, "harness.config.json"), JSON.stringify({
    gateway: { host: "127.0.0.1", port: 0, corsOrigins: [shellOrigin] },
    mediaOrigins: [MEDIA_ORIGIN], mcpServers: {},
  }));
  const loaded = await loadConfig(root);
  await ensureWorkspace(loaded.paths);
  const pageDirectory = path.join(loaded.paths.pages, SLUG);
  await mkdir(pageDirectory, { recursive: true });
  await writeFile(path.join(pageDirectory, "index.html"), fixtureHtml());
  sources = await DataSources.open(loaded);
  gateway = await startGateway(loaded, sources, {
    token: TOKEN, scheduler: false,
    chat: () => async () => { throw new Error("Browser fixture must not call an LLM"); },
  });
  frameUrl = `${gateway.url}/pages/${SLUG}/index.html?page_token=${new Auth(TOKEN).pageToken(SLUG)}`;
  for (const [asset, contentType] of [["index.js", "javascript"], ["style.css", "text/css"], ["decoder.js", "javascript"], ["decoder.wasm", "application/wasm"]]) {
    const response = await fetch(`${gateway.url}/assets/camera-player/${asset}`);
    assert.equal(response.status, 200, `${asset} is served by the actual gateway`);
    assert.ok(response.headers.get("content-type")?.includes(contentType));
    await response.arrayBuffer();
  }

  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: [
    "--autoplay-policy=no-user-gesture-required", "--enable-unsafe-swiftshader", "--ignore-certificate-errors", "--no-proxy-server",
    "--host-resolver-rules=EXCLUDE 127.0.0.1, MAP media-fixture.example 127.0.0.1, MAP unlisted-media.example 127.0.0.1, MAP * ~NOTFOUND",
  ] });
  const page = await browser.newPage();
  const uncaught = [];
  const consoleMessages = [];
  const network = { syntheticMediaRequests: 0, blockedOriginRequests: 0, unexpectedRequests: 0 };
  page.on("pageerror", (error) => uncaught.push(error.message));
  page.on("console", (message) => { if (["error", "warn"].includes(message.type())) consoleMessages.push(message.text().slice(0, 500)); });
  page.on("request", (request) => {
    const url = request.url();
    if (url === MEDIA_URL) {
      network.syntheticMediaRequests++;
    } else if (BLOCKED_URLS.includes(url)) {
      network.blockedOriginRequests++;
    } else if ([shellOrigin, gateway.url].includes(new URL(url).origin) || url.startsWith("blob:") || url.startsWith("data:")) {
      return;
    } else {
      network.unexpectedRequests++;
    }
  });
  await page.goto(shellOrigin, { waitUntil: "networkidle0" });
  const frame = page.frames().find((candidate) => candidate.url().startsWith(`${gateway.url}/pages/${SLUG}/`));
  assert.ok(frame, "The real task page is embedded across origins");
  await frame.waitForFunction(() => typeof window.EzuikitFlv === "function");
  assert.equal(await frame.evaluate(() => { try { void parent.document.body; return false; } catch { return true; } }), true);

  await frame.click("#start");
  try {
    await frame.waitForFunction(() => {
      const video = document.querySelector("#player video");
      return video?.videoWidth === 320 && video.videoHeight === 180 && video.readyState >= 2 && video.currentTime >= 0.2;
    }, { timeout: 15_000 });
  } catch (error) {
    console.error(JSON.stringify({ network, consoleMessages, uncaught, state: await frame.evaluate(() => ({
      events: fixture.events, errors: fixture.errors, violations: fixture.violations.map((item) => item.directive), state: fixturePlayer.getState(),
      video: [...document.querySelectorAll("video")].map((video) => ({ width: video.videoWidth, height: video.videoHeight, readyState: video.readyState, currentTime: video.currentTime, error: video.error?.message })),
    })) }));
    throw error;
  }
  const playback = await frame.evaluate(() => {
    const video = document.querySelector("#player video");
    return { events: { ...fixture.events }, errors: [...fixture.errors],
      video: { width: video.videoWidth, height: video.videoHeight, currentTime: video.currentTime } };
  });
  assert.deepEqual(playback.errors, []);

  const wasmCompiled = await frame.evaluate(async () => {
    await WebAssembly.compileStreaming(fetch("/assets/camera-player/decoder.wasm"));
    return true;
  });

  for (const url of BLOCKED_URLS) {
    const before = await frame.evaluate(() => fixture.violations.length);
    assert.equal(await frame.evaluate(async (target) => { try { await fetch(target); return false; } catch { return true; } }, url), true);
    await frame.waitForFunction((count) => fixture.violations.length > count, {}, before);
  }
  const blocked = await frame.evaluate((targets) => fixture.violations.filter((violation) => violation.directive === "connect-src"
    && targets.some((target) => violation.blocked === target || violation.blocked === new URL(target).origin)).length, BLOCKED_URLS);
  assert.equal(blocked, BLOCKED_URLS.length);
  assert.equal(network.blockedOriginRequests, 0, "CSP blocks unlisted origins and wrong ports before network dispatch");
  assert.equal(network.unexpectedRequests, 0, "No real external hosts may be contacted");
  assert.ok(network.syntheticMediaRequests >= 1);
  assert.deepEqual(uncaught, []);
  await frame.evaluate(() => { window.fixturePlayer.destroy(); window.fixturePlayer = null; });

  // Exercise the actual worker after the synthetic stream is closed. Avoid
  // Puppeteer request interception, which stalls dedicated decoder workers.
  const decoderWorkerInitialized = await frame.evaluate(async () => {
    const worker = new Worker("/assets/camera-player/decoder.js");
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Decoder worker initialization timed out")), 10_000);
        worker.addEventListener("message", (event) => { if (event.data?.cmd === "init") resolve(true); });
        worker.addEventListener("error", () => reject(new Error("Decoder worker initialization failed")));
      });
    } finally { clearTimeout(timer); worker.terminate(); }
  });
  assert.equal(decoderWorkerInitialized, true);
  assert.deepEqual(uncaught, []);
  assert.equal(network.unexpectedRequests, 0);
  console.log(JSON.stringify({ passed: true, browser: await browser.version(), msePlayback: playback, wasmCompiled, decoderWorkerInitialized,
    forcedWasmFramesVerified: false, cspBlockedOrigins: blocked, ...network, realVideoRequests: 0 }));
} finally {
  if (encoder && encoder.exitCode === null) encoder.kill();
  await Promise.allSettled([browser?.close(), gateway?.close(), sources?.close()]);
  shell.closeAllConnections();
  streamer.closeAllConnections();
  await Promise.all([new Promise((resolve) => shell.close(resolve)), new Promise((resolve) => streamer.close(resolve))]);
  assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith("qdd-camera-player-"));
  await rm(root, { recursive: true, force: true });
}

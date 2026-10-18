// node scripts/test-chat-media-browser.mjs
// Actual Vue components and local synthetic media; no model or external media requests.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { compileScript, compileStyle, parse } from "@vue/compiler-sfc";
import puppeteer from "puppeteer-core";

const root = fileURLToPath(new URL("..", import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value]));
const chrome = [
  env.CHROME_PATH,
  ...[env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean).flatMap((directory) => [
    path.join(directory, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(directory, "Microsoft", "Edge", "Application", "msedge.exe"),
  ]),
].find((file) => file && existsSync(file));
const ffmpeg = [env.FFMPEG_PATH, path.join(root, "mcp", "tools", "node_modules", "ffmpeg-static", "ffmpeg.exe")]
  .find((file) => file && existsSync(file));
assert.ok(chrome, "Set CHROME_PATH to Chrome/Edge.");
assert.ok(ffmpeg, "Set FFMPEG_PATH to FFmpeg.");
const temporary = await mkdtemp(path.join(tmpdir(), "qdd-chat-media-"));
let browser;
let bundle;
let css = "";
const requests = [];
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="teal"/></svg>';
const files = new Map();
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  requests.push({ path: url.pathname, auth: req.headers.authorization, query: url.search });
  if (url.pathname === "/bundle.js") return res.writeHead(200, { "Content-Type": "text/javascript" }).end(bundle);
  if (url.pathname === "/style.css") return res.writeHead(200, { "Content-Type": "text/css" }).end(css);
  if (url.pathname.startsWith("/api/attachments/")) {
    if (req.headers.authorization !== "Bearer fixture-only") return res.writeHead(401).end();
    const key = url.pathname.endsWith("/photo") ? "/photo.svg" : "/clip.mp4";
    const file = files.get(key);
    return res.writeHead(200, { "Content-Type": file.mime }).end(file.bytes);
  }
  const file = files.get(url.pathname);
  if (file) return res.writeHead(200, { "Content-Type": file.mime, "Content-Length": file.bytes.length }).end(file.bytes);
  if (url.pathname !== "/") return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end('<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/style.css"><div id="app"></div><script src="/bundle.js"></script>');
});

try {
  const mp4 = path.join(temporary, "clip.mp4");
  const flv = path.join(temporary, "live.flv");
  const hls = path.join(temporary, "live.m3u8");
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10",
    "-t", "4", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "10", "-movflags", "+faststart", mp4],
  { timeout: 30_000, windowsHide: true });
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", mp4, "-c", "copy", flv,
    "-c", "copy", "-hls_time", "1", "-hls_list_size", "0", hls], { timeout: 30_000, windowsHide: true });
  files.set("/photo.svg", { mime: "image/svg+xml", bytes: Buffer.from(svg) });
  for (const [name, mime] of [["clip.mp4", "video/mp4"], ["live.flv", "video/x-flv"], ["live.m3u8", "application/vnd.apple.mpegurl"],
    ...Array.from({ length: 4 }, (_, index) => [`live${index}.ts`, "video/mp2t"])]) {
    files.set(`/${name}`, { mime, bytes: await readFile(path.join(temporary, name)) });
  }
  const result = await build({
    stdin: { contents: `
      import {createApp,h,ref} from "vue";
      import MarkdownContent from "./apps/web/src/components/MarkdownContent.vue";
      import AttachmentList from "./apps/web/src/components/AttachmentList.vue";
      const visible=ref(true), content=ref(""), token=ref("fixture-only");
      window.setContent=value=>{content.value=value;visible.value=true};
      window.hideMedia=()=>visible.value=false;
      window.setToken=value=>token.value=value;
      const urls=new Set(); window.activeBlobUrls=urls;
      const create=URL.createObjectURL.bind(URL), revoke=URL.revokeObjectURL.bind(URL);
      URL.createObjectURL=blob=>{const url=create(blob);urls.add(url);return url};
      URL.revokeObjectURL=url=>{urls.delete(url);revoke(url)};
      createApp({render:()=>visible.value?h("main",[
        h(MarkdownContent,{content:content.value}),
        h(AttachmentList,{gatewayUrl:location.origin,token:token.value,items:[
          {key:"photo",id:"photo",path:"folder/photo.svg",size:100,mime:"image/svg+xml"},
          {key:"clip",id:"clip",path:"clip.mp4",size:100,mime:"video/mp4"}
        ]})
      ]):null}).mount("#app");`,
      resolveDir: root, loader: "js" },
    bundle: true, write: false, format: "iife", define: { "process.env.NODE_ENV": '"production"' },
    alias: { "@": path.join(root, "apps", "web", "src") },
    plugins: [{ name: "vue-media-test", setup(build) {
      build.onLoad({ filter: /\.vue$/ }, async ({ path: file }) => {
        const { descriptor } = parse(await readFile(file, "utf8"));
        for (const style of descriptor.styles) css += compileStyle({ source: style.content, filename: file, id: "media-test", scoped: false }).code;
        return { contents: compileScript(descriptor, { id: "media-test", inlineTemplate: true }).content, loader: "ts", resolveDir: path.dirname(file) };
      });
    } }],
  });
  bundle = result.outputFiles[0].contents;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin, { waitUntil: "networkidle0" });
  assert.equal(requests.filter((req) => req.path.startsWith("/api/attachments/")).length, 0);
  const setContent = (value) => page.evaluate((content) => window.setContent(content), value);
  await setContent(`![店内画面](${origin}/photo.svg)`);
  await page.waitForFunction(() => document.querySelector("img")?.naturalWidth === 320);
  for (const file of ["clip.mp4", "live.m3u8", "live.flv"]) {
    await setContent(`[播放](${origin}/${file}?signature=fixture)`);
    await page.waitForSelector(".markdown-content .chat-media button");
    assert.equal(requests.filter((req) => req.path === `/${file}`).length, 0, `${file}: no autoplay/download`);
    await page.click(".markdown-content .chat-media button");
    await page.waitForFunction(() => {
      const video = document.querySelector(".markdown-content video");
      return video?.videoWidth === 320 && video.currentTime > 0;
    }, { timeout: 20_000 });
    assert.equal(await page.$(".markdown-content .chat-media-error"), null, file);
    assert.ok(requests.some((req) => req.path === `/${file}` && req.query === "?signature=fixture"));
    const playingVideo = await page.$(".markdown-content video");
    await setContent(`[播放](${origin}/${file}?signature=fixture)\n\n后续回复仍在生成。`);
    assert.equal(await playingVideo.evaluate((video) => video === document.querySelector(".markdown-content video") && !video.paused), true);
    await playingVideo.dispose();
    await setContent("已停止");
    await page.waitForFunction(() => !document.querySelector("video"));
    console.log(`${file}: decoded frames and stopped on source removal`);
  }
  await page.click(".attachments .chat-media button");
  await page.waitForFunction(() => document.querySelector(".attachments img")?.naturalWidth === 320);
  assert.equal(await page.evaluate(() => window.activeBlobUrls.size), 1);
  assert.ok(requests.some((req) => req.path === "/api/attachments/photo" && req.auth === "Bearer fixture-only" && !req.query));
  await page.click(".attachments .chat-media:nth-of-type(2) button");
  await page.waitForFunction(() => document.querySelector(".attachments video")?.currentTime > 0);
  assert.equal(await page.evaluate(() => window.activeBlobUrls.size), 2);
  await page.evaluate(() => window.setToken("changed"));
  await page.waitForFunction(() => window.activeBlobUrls.size === 0 && !document.querySelector(".attachments video"));
  await page.click(".attachments .chat-media button");
  await page.waitForSelector(".attachments [role=alert]");
  await setContent(`![失效图片](${origin}/missing.png)`);
  await page.waitForSelector(".markdown-content [role=alert]");
  assert.match(await page.$eval(".markdown-content [role=alert]", (node) => node.textContent), /图片加载失败/);
  await setContent(`[失效视频](${origin}/missing.mp4)`);
  await page.waitForSelector(".markdown-content .chat-media button");
  await page.click(".markdown-content .chat-media button");
  await page.waitForSelector(".markdown-content [role=alert]");
  await setContent(`![画面](${origin}/photo.svg)\n\n[录像](${origin}/clip.mp4)`);
  await page.setViewport({ width: 375, height: 800 });
  await page.waitForFunction(() => document.querySelector(".markdown-content img")?.naturalWidth === 320);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 375), true);
  await page.evaluate(() => window.hideMedia());
  await page.waitForFunction(() => !document.querySelector(".chat-media") && window.activeBlobUrls.size === 0);
  assert.deepEqual(errors, []);
  console.log("Images, authenticated attachments, errors, credential cleanup, unmount and mobile layout passed.");
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(path.dirname(temporary), path.resolve(tmpdir()));
  assert.ok(path.basename(temporary).startsWith("qdd-chat-media-"));
  await rm(temporary, { recursive: true, force: true });
}

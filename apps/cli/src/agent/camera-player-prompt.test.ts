import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../config.js";
import { checkContent, pageCsp } from "../guard.js";
import { systemPrompt, type PromptInput } from "./prompt.js";

const input: PromptInput = {
  slug: "camera-test",
  style: "",
  theme: "",
  cdnAllowlist: DEFAULT_CONFIG.cdnAllowlist,
  pages: [],
  updating: undefined,
  metrics: {},
  datasets: [],
  sessions: [],
};

test("camera instructions use the installed FLV player and fixed-version whitelisted HLS", () => {
  const prompt = systemPrompt(input);
  assert.ok(prompt.includes("ezuikit-flv@2.1.1"));
  for (const asset of ["style.css", "index.js", "decoder.js"]) {
    assert.ok(prompt.includes(`/assets/camera-player/${asset}`));
    assert.deepEqual(checkContent(`<script src="/assets/camera-player/${asset}"></script>`, input.cdnAllowlist), []);
  }
  const hls = "https://cdn.jsdelivr.net/npm/hls.js@1.7.3/dist/hls.min.js";
  assert.ok(prompt.includes(hls));
  assert.deepEqual(checkContent(`<script src="${hls}"></script>`, input.cdnAllowlist), []);
  assert.notDeepEqual(checkContent(`<script src="${hls}"></script>`, []), []);
  assert.ok(prompt.includes("仅当 cdn.jsdelivr.net 在上面的在线包白名单内"));
  assert.ok(prompt.includes("enableWorker: false"));
  assert.ok(prompt.includes('video.canPlayType("application/vnd.apple.mpegurl")'));
  assert.ok(prompt.includes("Hls.isSupported()"));

  const flvExample = prompt.match(/`(const player = new EzuikitFlv\([^`]+)`/)?.[1];
  assert.ok(flvExample);
  assert.deepEqual(checkContent(flvExample, input.cdnAllowlist), []);
  assert.ok(flvExample.includes("disableColect: true"));
  assert.ok(flvExample.includes("autoPlay: false"));
});

test("camera instructions expose configured media policy without granting script or iframe permissions", () => {
  for (const origins of [[], ["https://media.example.test:8443"], ["*"]]) {
    const prompt = systemPrompt({ ...input, mediaOrigins: origins });
    assert.ok(prompt.includes(`当前配置 mediaOrigins：${JSON.stringify(origins)}`));
    const csp = pageCsp(input.cdnAllowlist, [], origins);
    assert.ok(csp.includes("frame-src 'self';"));
    assert.ok(csp.includes("form-action 'none';"));
    assert.notDeepEqual(checkContent('fetch("/business")', input.cdnAllowlist), []);
  }
  assert.ok(systemPrompt(input).includes("当前配置 mediaOrigins：[]"));
});

test("camera instructions require honest RTMP limitations, errors and resource cleanup", () => {
  const prompt = systemPrompt(input);
  for (const requirement of [
    "浏览器无法直接播放 RTMP，请提供转流后的 HLS (.m3u8) 或 HTTP-FLV (.flv) 地址",
    "rtmps://", "RTSP 同样需转流", "gaps 中声明 unsupported",
    "禁止把 rtmp:// 简单替换为 https://", "URL pathname",
    "player.destroy()", "hls.destroy()", "pagehide", "Hls.Events.ERROR",
    "CORS/CSP", "qdd.tool", "finish.tools", "不要把签名 URL 硬编码",
  ]) assert.ok(prompt.includes(requirement), requirement);
});

test("chat media instructions explain Markdown formats and keep credentials out of media URLs", () => {
  const prompt = systemPrompt(input);
  for (const requirement of [
    "## 对话中的图片与视频", "![说明](真实图片URL)", '[录像](URL "video/mp4")',
    '[实时画面](URL "application/vnd.apple.mpegurl")', '[实时画面](URL "video/x-flv")',
    "不要输出 HTML video/iframe", "不把网关 token 或服务端凭据拼到链接中",
    "能展示或播放不代表模型能理解图片或视频",
  ]) assert.ok(prompt.includes(requirement), requirement);
});

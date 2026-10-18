import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { HarnessConfig } from "@qdd/shared";
import { DEFAULT_CONFIG } from "../config.js";
import { CameraLogin } from "./cameras.js";

function mockCameraServices(t: TestContext) {
  const requests: { url: string; method: string; origin: string | null; body: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ url, method: init.method ?? "GET", origin: new Headers(init.headers).get("Origin"), body });
    if (url.endsWith("/api/status")) return Response.json({ connected: true, phoneMasked: "139****0000", roleName: "店长", cameraCount: 2 });
    if (url.endsWith("/api/camera?action=status")) return Response.json({ connected: true });
    if (body?.action === "login-start") return Response.json({ url: "https://login.example/fixture", state: "a".repeat(32), expiresIn: 600 });
    return Response.json({ ok: true });
  });
  return requests;
}

test("摄像头状态实时反映 MCP 服务的动态安装、卸载与地址更新", async (t) => {
  let servers: Readonly<HarnessConfig["mcpServers"]> = {};
  const cameras = new CameraLogin(() => servers);
  const requests = mockCameraServices(t);
  assert((await cameras.status()).every((status) => !status.configured && !status.connected));
  assert.equal(requests.length, 0);

  servers = {
    haik: { url: "http://127.0.0.1:18787/mcp" },
    tysl: { url: "http://127.0.0.1:18790/mcp" },
  };
  const installed = await cameras.status();
  assert(installed.every((status) => status.configured && status.reachable && status.connected));
  assert.equal(installed.find((status) => status.provider === "tysl")?.account, "139****0000");

  servers = { tysl: { url: "http://127.0.0.1:28790/mcp" } };
  const changed = await cameras.status();
  assert.equal(changed.find((status) => status.provider === "haik")?.configured, false);
  assert.equal(changed.find((status) => status.provider === "tysl")?.connected, true);
  assert.equal(requests.at(-1)?.url, "http://127.0.0.1:28790/api/status");

  const before = requests.length;
  servers = {};
  assert((await cameras.status()).every((status) => !status.configured && !status.reachable && !status.connected));
  assert.equal(requests.length, before);
});

test("动态安装的摄像头登录使用最新地址，卸载后停止代理登录", async (t) => {
  let servers: Readonly<HarnessConfig["mcpServers"]> = { tysl: { url: "http://127.0.0.1:18790/mcp" } };
  const cameras = new CameraLogin(() => servers);
  const requests = mockCameraServices(t);
  const started = await cameras.tyslStart();
  assert.equal(started.state, "a".repeat(32));
  assert.equal(requests.at(-1)?.url, "http://127.0.0.1:18790/api/action");
  servers = { tysl: { url: "http://127.0.0.1:28790/mcp" } };
  assert.deepEqual(await cameras.tyslComplete({ state: started.state, callbackUrl: "https://callback.example/fixture" }), { ok: true });
  assert.equal(requests.at(-1)?.url, "http://127.0.0.1:28790/api/login/complete");
  const before = requests.length;
  servers = {};
  await assert.rejects(cameras.tyslStart(), /未配置 tysl MCP 服务/);
  assert.equal(requests.length, before);
});

test("原 HarnessConfig 调用兼容海康短信登录及天翼官方授权代理", async (t) => {
  const config: HarnessConfig = {
    ...DEFAULT_CONFIG,
    mcpServers: {
      haik: { url: "http://127.0.0.1:18787/mcp" },
      tysl: { url: "http://127.0.0.1:18790/mcp" },
    },
  };
  const cameras = new CameraLogin(config);
  const requests = mockCameraServices(t);
  assert((await cameras.status()).every((status) => status.connected));
  requests.length = 0;
  assert.deepEqual(await cameras.haikSendCode({ phone: "139-0000-0000", captchaVerifyParam: "synthetic-captcha" }), { sent: true });
  assert.deepEqual(await cameras.haikLogin({ phone: "13900000000", code: " 123456 " }), { ok: true });
  const login = await cameras.tyslStart();
  assert.deepEqual(await cameras.tyslComplete({ state: login.state, callbackUrl: " https://callback.example/fixture " }), { ok: true });
  assert.deepEqual(requests.map(({ url, method, origin }) => ({ url, method, origin })), [
    { url: "http://127.0.0.1:18787/api/camera", method: "POST", origin: "http://127.0.0.1:18787" },
    { url: "http://127.0.0.1:18787/api/camera", method: "POST", origin: "http://127.0.0.1:18787" },
    { url: "http://127.0.0.1:18790/api/action", method: "POST", origin: "http://127.0.0.1:18790" },
    { url: "http://127.0.0.1:18790/api/login/complete", method: "POST", origin: "http://127.0.0.1:18790" },
  ]);
  assert.deepEqual(requests[0]?.body, { action: "send_code", phone: "13900000000", captchaVerifyParam: "synthetic-captcha" });
  assert.deepEqual(requests[1]?.body, { action: "login", phone: "13900000000", code: "123456" });
  assert.deepEqual(requests[3]?.body, { state: login.state, callbackUrl: "https://callback.example/fixture" });
});

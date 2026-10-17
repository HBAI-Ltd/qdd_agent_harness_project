import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDesktopConfig, safeDesktopDefaults } from "../tools/desktop-config.mjs";

test("desktop config accepts the phone's displayed address and keeps Wi-Fi and USB settings explicit", () => {
  const config = normalizeDesktopConfig({ ANDROID_SCREEN_URL: "10.65.201.94：8791", ESP_HOST: "10.65.201.147", ESP_PORT: "com5" });
  assert.equal(config.ANDROID_SCREEN_URL, "http://10.65.201.94:8791");
  assert.equal(config.ESP_HOST, "10.65.201.147");
  assert.equal(config.ESP_PORT, "COM5");
  assert.equal(config.ESP_TCP_PORT, "3333");
  assert.equal(config.ANDROID_MCP_PORT, "8790");
  assert.equal(normalizeDesktopConfig({ ...config, ESP_HOST: "" }).ESP_HOST, "");
  assert.equal(config.ESP_SETUP_URL, "");
  assert.equal(normalizeDesktopConfig({ ...config, ESP_HOST: "", ESP_SETUP_URL: "http://192.168.1.21:3334/" }).ESP_SETUP_URL, "http://192.168.1.21:3334");
});

test("desktop config rejects malformed endpoints and ports with actionable Chinese messages", () => {
  const valid = { ANDROID_SCREEN_URL: "192.168.1.20:8791", ESP_HOST: "192.168.1.21" };
  for (const change of [{ ANDROID_SCREEN_URL: "" }, { ANDROID_SCREEN_URL: "http://user:password@192.168.1.20:8791" },
    { ANDROID_SCREEN_URL: "http://192.168.1.20:8791/evil" }, { ESP_HOST: "8.8.8.8" },
    { ANDROID_SCREEN_URL: "https://public.example" }, { ANDROID_SCREEN_URL: "http://8.8.8.8:8791" },
    { ESP_HOST: "192.168.1.21:3333" }, { ESP_TCP_PORT: "0" }, { ANDROID_MCP_PORT: "65536" },
    { ESP_HOST: "", ESP_PORT: "garbage" }, { ANDROID_DEVICE_ID: "not-an-id" }, { ESP_SETUP_URL: "http://8.8.8.8:3334" },
    { ESP_SETUP_URL: "http://192.168.1.21:3334/api/status" }, { ESP_SETUP_URL: "http://user:password@192.168.1.21:3334" }]) {
    assert.throws(() => normalizeDesktopConfig({ ...valid, ...change }));
  }
});

test("portable defaults copy only explicit connection fields and never unrelated secrets", () => {
  assert.deepEqual(safeDesktopDefaults({ ANDROID_SCREEN_URL: "http://192.168.1.20:8791", ESP_PORT: "COM5",
    API_KEY: "must-not-copy", PASSWORD: "must-not-copy", WIFI_PASSWORD: "must-not-copy" }), {
    ANDROID_SCREEN_URL: "http://192.168.1.20:8791", ESP_PORT: "COM5",
  });
});

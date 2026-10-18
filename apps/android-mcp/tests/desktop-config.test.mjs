import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeDesktopConfig, safeDesktopDefaults, writePortableConfigIfAbsent } from "../tools/desktop-config.mjs";

async function configPath(context) {
  const prefix = join(tmpdir(), "qdd-desktop-config-");
  const directory = await mkdtemp(prefix);
  context.after(async () => { assert.ok(directory.startsWith(prefix)); await rm(directory, { recursive: true, force: true }); });
  return join(directory, "qdd-android.json");
}

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

test("copied controller addresses normalize an embedded port and correct download port 3334", () => {
  const defaults = { ANDROID_SCREEN_URL: "192.168.1.20:8791", ESP_TCP_PORT: "5555" };
  for (const ESP_HOST of ["192.168.1.21:4444", "192.168.1.21：4444"]) {
    const saved = normalizeDesktopConfig({ ...defaults, ESP_HOST });
    assert.equal(saved.ESP_HOST, "192.168.1.21"); assert.equal(saved.ESP_TCP_PORT, "4444");
  }
  for (const ESP_HOST of ["192.168.1.21:3334", "192.168.1.21：3334", "http://192.168.1.21:3334/", "http：//192.168.1.21：3334/"]) {
    const saved = normalizeDesktopConfig({ ...defaults, ESP_HOST });
    assert.equal(saved.ESP_HOST, "192.168.1.21"); assert.equal(saved.ESP_TCP_PORT, "3333");
  }
  assert.equal(normalizeDesktopConfig({ ...defaults, ESP_HOST: "192.168.1.21" }).ESP_TCP_PORT, "5555");
  assert.equal(normalizeDesktopConfig({ ...defaults, ESP_HOST: "192.168.1.21", ESP_TCP_PORT: "3334" }).ESP_TCP_PORT, "3333");
  for (const ESP_HOST of ["qdd.local", "localhost"]) assert.equal(normalizeDesktopConfig({ ...defaults, ESP_HOST }).ESP_HOST, ESP_HOST);
});

test("copied controller addresses reject credentials, public IPs, paths and invalid ports", () => {
  for (const ESP_HOST of ["8.8.8.8:3333", "http://8.8.8.8:3334/", "http://u:p@192.168.1.21:3334/",
    "http://192.168.1.21:3334/path", "http://192.168.1.21:3334/?x=1", "http://192.168.1.21:3334/#x",
    "https://192.168.1.21:3334/", "192.168.1.21:0", "192.168.1.21:65536", "http://0x7f000001:3334/"]) {
    assert.throws(() => normalizeDesktopConfig({ ANDROID_SCREEN_URL: "192.168.1.20:8791", ESP_HOST }));
  }
});

test("desktop config rejects malformed endpoints and ports with actionable Chinese messages", () => {
  const valid = { ANDROID_SCREEN_URL: "192.168.1.20:8791", ESP_HOST: "192.168.1.21" };
  for (const change of [{ ANDROID_SCREEN_URL: "" }, { ANDROID_SCREEN_URL: "http://user:password@192.168.1.20:8791" },
    { ANDROID_SCREEN_URL: "http://192.168.1.20:8791/evil" }, { ESP_HOST: "8.8.8.8" },
    { ANDROID_SCREEN_URL: "https://public.example" }, { ANDROID_SCREEN_URL: "http://8.8.8.8:8791" },
    { ESP_HOST: "192.168.1.21:invalid" }, { ESP_TCP_PORT: "0" }, { ANDROID_MCP_PORT: "65536" },
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

test("portable build seeds a real LAN host without forcing USB or copying unrelated secrets", async (context) => {
  const path = await configPath(context);
  assert.equal(await writePortableConfigIfAbsent(path, { ANDROID_SCREEN_URL: "192.168.1.20:8791",
    ESP_HOST: "192.168.1.21", ESP_PORT: "COM6", API_KEY: "must-not-copy" }), true);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.ESP_HOST, "192.168.1.21"); assert.equal(saved.ESP_PORT, "COM6");
  assert.equal(saved.API_KEY, undefined);
});

test("portable build preserves existing LAN and explicit USB sidecar choices exactly", async (context) => {
  for (const host of ["192.168.1.31", ""]) await context.test(host ? "LAN" : "USB", async (inner) => {
    const path = await configPath(inner);
    const original = `${JSON.stringify({ ANDROID_SCREEN_URL: "http://192.168.1.30:8791", ESP_HOST: host, ESP_PORT: "COM8" }, null, 2)}\n`;
    await writeFile(path, original);
    assert.equal(await writePortableConfigIfAbsent(path, { ANDROID_SCREEN_URL: "invalid", ESP_HOST: "192.168.1.99" }), false);
    assert.equal(await readFile(path, "utf8"), original);
  });
});

test("portable build without a LAN host leaves first setup unconfigured instead of silently choosing USB", async (context) => {
  const path = await configPath(context);
  for (const host of [undefined, ""]) {
    assert.equal(await writePortableConfigIfAbsent(path, { ANDROID_SCREEN_URL: "192.168.1.20:8791", ESP_HOST: host, ESP_PORT: "COM5" }), false);
    await assert.rejects(stat(path), { code: "ENOENT" });
  }
});

test("concurrent portable initialization cannot overwrite the first saved sidecar", async (context) => {
  const path = await configPath(context);
  const results = await Promise.all(["192.168.1.21", "192.168.1.22"].map((ESP_HOST) => writePortableConfigIfAbsent(path,
    { ANDROID_SCREEN_URL: "192.168.1.20:8791", ESP_HOST })));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(JSON.parse(await readFile(path, "utf8")).ESP_HOST, results[0] ? "192.168.1.21" : "192.168.1.22");
});

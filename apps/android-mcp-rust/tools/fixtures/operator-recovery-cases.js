import { bootSettingsHtml } from "./settings-fixture.mjs";

test("Rust reconnect reports completion after pausing the previous control generation", async () => {
  const app = fixture();
  try {
    await flush(); app.click("capture-button"); await flush();
    assert.equal(app.element("activity").textContent, "手机画面已更新。");
    assert.equal(app.calls.filter(({ name }) => name === "android_hid_arm").length, 0);
  } finally { await app.close(); }
});

test("Rust recovered video cannot erase a newer controller refusal", async () => {
  let refused = false;
  const message = "ESP_CONNECTION_ERROR: 设备控制器连接失败（192.168.1.8:3333）：os error 10061";
  const app = fixture(undefined, { toolResponse: (name) => refused && name === "android_hid_status"
    ? { isError: true, content: [{ type: "text", text: message }] } : undefined });
  try {
    await flush(); app.frame(); await flush();
    app.videoUnavailable("手机画面暂时中断"); await flush();
    refused = true; app.click("capture-button"); await flush();
    assert.equal(app.element("error-detail").textContent, message);
    app.frame("recovered-phone-only"); await flush();
    assert.equal(app.element("error-box").hidden, false, "phone frames do not prove the controller recovered");
    assert.equal(app.element("error-detail").textContent, message);
    assert.equal(app.element("connection-settings-link").hidden, false);
    assert.equal(app.remoteActive, false);
    assert.equal(app.calls.filter(({ name }) => name === "android_hid_arm").length, 0);
    refused = false; app.click("capture-button"); await flush();
    assert.equal(app.element("error-box").hidden, true);
  } finally { await app.close(); }
});

const recoverySettingsTemplate = await readFile(new URL("../assets/settings.html", import.meta.url), "utf8");
const recoveryDefaults = { ANDROID_SCREEN_URL: "http://192.168.1.5:8791", ANDROID_DEVICE_ID: "old-phone",
  ESP_HOST: "192.168.1.8", ESP_TCP_PORT: "3333", ESP_PORT: "COM6", ANDROID_MCP_PORT: "8790" };
const recoveryBoard = (suffix = 9) => ({ name: `Controller ${suffix}`, ip: `192.168.1.${suffix}`, tcpPort: 3333,
  boardUrl: `http://192.168.1.${suffix}:3334`, phone: { screenUrl: `http://192.168.1.${suffix + 10}:8791`, deviceId: `phone-${suffix}`, projecting: true } });
function recoverySettings(options = {}) {
  const payload = JSON.stringify({ defaults: recoveryDefaults, ports: ["COM6"], problem: "", mcpUrl: "http://127.0.0.1:8790/mcp" });
  return bootSettingsHtml(recoverySettingsTemplate.replaceAll("__QDD_SAVE_PATH__", "/fixture-save")
    .replaceAll("__QDD_DISCOVER_PATH__", "/fixture-find").replace("__QDD_SETTINGS_DATA__", payload), options);
}

test("Rust recovery offers settings after explicit reconnect and screen reconnect without replay", async () => {
  for (const button of ["connect-button", "capture-button"]) {
    for (const message of [
      "SCREEN_CONNECTION_ERROR: 手机画面连接失败（192.168.1.5:8791）：os error 10061",
      "ESP_CONNECTION_ERROR: 设备控制器连接失败（192.168.1.8:3333）：os error 10061",
      "No connection could be made because the target machine actively refused it. (os error 10061)",
    ]) {
      let failing = false;
      const failedTool = message.startsWith("ESP_") ? "android_hid_status" : "android_screenshot";
      const app = fixture(undefined, { toolResponse: (name) => failing && name === failedTool
        ? { isError: true, content: [{ type: "text", text: message }] } : undefined });
      try {
        await flush();
        app.element("typing-input").value = "保留尚未发送的内容";
        failing = true; app.click(button); await flush();
        assert.equal(app.element("error-box").hidden, false);
        const link = app.element("connection-settings-link");
        assert.equal(link.tagName, "A", "recovery must be a real clickable link");
        assert.equal(link.hidden, false);
        assert.equal(link.href, "/desktop/settings#discover");
        assert.match(link.textContent, /检查连接设置.*重新查找/u);
        assert.equal(app.element("error-detail").textContent, message);
        if (message.startsWith("SCREEN_")) assert.match(app.element("error-message").textContent, /手机画面连接失败/u);
        if (message.startsWith("ESP_")) assert.match(app.element("error-message").textContent, /设备控制器连接失败/u);
        assert.equal(app.element("typing-input").value, "保留尚未发送的内容");
        assert.equal(app.calls.filter(({ name }) => ["android_hid_arm", "android_type", "android_mouse_move"].includes(name)).length, 0);
        assert.equal(app.requests.filter(({ url }) => /desktop\/(?:settings|discover)/u.test(String(url))).length, 0);
        failing = false; app.click("capture-button"); await flush();
        assert.equal(link.hidden, true, "a fresh successful retry clears the recovery error");
      } finally { await app.close(); }
    }
  }
});

test("Rust recovery offers settings for unavailable MCP and stream failures", async () => {
  const offline = fixture(undefined, { serverAvailable: false });
  try {
    await flush();
    assert.equal(offline.element("connection-settings-link").href, "/desktop/settings#discover");
    assert.equal(offline.element("connection-settings-link").hidden, false);
  } finally { await offline.close(); }
  const app = fixture();
  try {
    await flush(); app.click("capture-button"); await flush(); app.videoError(); await flush();
    assert.equal(app.element("connection-settings-link").hidden, false);
    assert.equal(app.calls.filter(({ name }) => name === "android_hid_arm").length, 0);
  } finally { await app.close(); }
});

test("Rust recovery discovers once with existing addresses and saves only after explicit submit", async () => {
  const pending = deferred();
  const app = recoverySettings({ hash: "#discover", fetch: (url) => url === "/fixture-find" ? pending.promise
    : Promise.resolve({ ok: true, json: async () => ({ url: "http://127.0.0.1:8790/" }) }) });
  assert.equal(app.requests.length, 1, "the recovery entry must rediscover an old saved address");
  assert.equal(app.requests[0].url, "/fixture-find");
  assert.equal(app.requests[0].options.signal.aborted, false);
  app.elements.get("find").onclick();
  assert.equal(app.requests.length, 1, "concurrent discovery must remain bounded");
  assert.equal(app.elements.get("screen").value, recoveryDefaults.ANDROID_SCREEN_URL);
  pending.resolve({ ok: true, json: async () => ({ boards: [recoveryBoard()] }) }); await flush();
  assert.equal(app.elements.get("screen").value, recoveryBoard().phone.screenUrl);
  assert.equal(app.elements.get("host").value, recoveryBoard().ip);
  assert.equal(app.elements.get("boards").hidden, true);
  assert.equal(app.requests.length, 1, "discovery must not save or reconnect");
  assert.equal(app.context.location.href, "");
  await app.elements.get("form").onsubmit({ preventDefault() {} });
  assert.equal(app.requests.length, 2);
  const body = JSON.parse(app.requests[1].options.body);
  assert.equal(body.ANDROID_SCREEN_URL, recoveryBoard().phone.screenUrl);
  assert.equal(body.ANDROID_DEVICE_ID, recoveryBoard().phone.deviceId);
  assert.equal(body.ESP_HOST, recoveryBoard().ip);
});

test("Rust recovery keeps multiple boards and delayed discovery from choosing over edits", async () => {
  for (const edited of [false, true]) {
    const pending = deferred();
    const app = recoverySettings({ hash: "#discover", fetch: () => pending.promise });
    assert.equal(app.requests.length, 1);
    if (edited) {
      app.elements.get("screen").value = "http://192.168.1.40:8791"; app.elements.get("screen").oninput();
      app.elements.get("host").value = "192.168.1.41"; app.elements.get("host").oninput();
    }
    pending.resolve({ ok: true, json: async () => ({ boards: edited ? [recoveryBoard()] : [recoveryBoard(), recoveryBoard(10)] }) }); await flush();
    assert.equal(app.elements.get("screen").value, edited ? "http://192.168.1.40:8791" : recoveryDefaults.ANDROID_SCREEN_URL);
    assert.equal(app.elements.get("host").value, edited ? "192.168.1.41" : recoveryDefaults.ESP_HOST);
    assert.equal(app.elements.get("boards").hidden, false);
    assert.equal(app.requests.length, 1);
    app.elements.get("boards").value = "0"; app.elements.get("boards").onchange();
    assert.equal(app.elements.get("screen").value, recoveryBoard().phone.screenUrl);
    assert.equal(app.requests.length, 1, "selecting a candidate still requires Save");
  }
});

test("Rust recovery times discovery out once and ignores a late result after saving", async () => {
  const timers = new Map(); let sequence = 0;
  const timeout = recoverySettings({ hash: "#discover", fetch: () => new Promise(() => {}),
    setTimeout(callback, ms) { timers.set(++sequence, { callback, ms }); return sequence; }, clearTimeout(id) { timers.delete(id); } });
  assert.equal(timeout.requests.length, 1);
  assert.equal([...timers.values()][0].ms, 6000);
  [...timers.values()][0].callback(); await flush();
  assert.equal(timeout.requests[0].options.signal.aborted, true);
  assert.equal(timeout.elements.get("find").disabled, false);
  assert.match(timeout.elements.get("discovery-state").textContent, /稍后重试|手动/u);
  assert.equal(timeout.elements.get("screen").value, recoveryDefaults.ANDROID_SCREEN_URL);
  assert.equal(timeout.requests.length, 1);

  const pending = deferred();
  const app = recoverySettings({ hash: "#discover", fetch: (url) => url === "/fixture-find" ? pending.promise
    : Promise.resolve({ ok: true, json: async () => ({ url: "http://127.0.0.1:8790/" }) }) });
  await app.elements.get("form").onsubmit({ preventDefault() {} });
  pending.resolve({ ok: true, json: async () => ({ boards: [recoveryBoard()] }) }); await flush();
  assert.equal(app.elements.get("screen").value, recoveryDefaults.ANDROID_SCREEN_URL);
  assert.equal(app.elements.get("host").value, recoveryDefaults.ESP_HOST);
  assert.equal(JSON.parse(app.requests[1].options.body).ANDROID_SCREEN_URL, recoveryDefaults.ANDROID_SCREEN_URL);
});

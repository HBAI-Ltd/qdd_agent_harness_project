import assert from "node:assert/strict";
import vm from "node:vm";
import { setImmediate as tick } from "node:timers/promises";
import { test } from "node:test";
import { configurationPage } from "../tools/desktop-page.mjs";

test("invalid saved ports still render recovery settings with a valid LAN MCP address", () => {
  for (const port of ["-1", "65536", "invalid"]) {
    const html = configurationPage({ ANDROID_MCP_PORT: port }, []);
    assert.match(html, /:8790\/mcp/u);
    assert.match(html, /设备操作台/u);
  }
});

const phoneId = "44444444-4444-4444-8444-444444444444";
const board = (ip = "192.168.1.21") => ({ boardUrl: `http://${ip}:3334`, ip, tcpPort: 3333, name: "QDD 控制板",
  phone: { screenUrl: "http://192.168.1.20:8791", deviceId: phoneId, projecting: true } });
const flush = async () => { for (let index = 0; index < 8; index++) await tick(); };
function fixture(defaults = {}, boards = [board()], discovery, fixtureOptions = {}) {
  const elements = new Map(), calls = [], location = { href: "http://127.0.0.1:8790/desktop/settings" };
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { id, _value: "", textContent: "", hidden: id === "boards", disabled: false, children: [],
      get value() { return this._value; }, set value(value) { this._value = String(value); },
      append(option) { this.children.push(option); if (this.id === "serial" && !this.value) this.value = option.value; },
      replaceChildren() { this.children = []; this.value = ""; } });
    return elements.get(id);
  };
  const page = configurationPage(defaults, ["COM5", "COM6"], "/desktop/settings", "", "/desktop/discover");
  const script = /<script>([\s\S]*?)<\/script>/u.exec(page)[1];
  vm.runInNewContext(script, { document: { getElementById: element, createElement: () => ({ value: "", textContent: "" }) },
    location, URL, AbortController, performance: fixtureOptions.performance ?? performance,
    setTimeout: fixtureOptions.setTimeout ?? setTimeout, clearTimeout: fixtureOptions.clearTimeout ?? clearTimeout,
    fetch: async (url, options = {}) => {
      calls.push({ url, ...options });
      if (typeof fixtureOptions.fetch === "function") return fixtureOptions.fetch(url, options);
      if (url === "/desktop/discover") return discovery ? discovery() : Response.json({ boards });
      return Response.json({ url: "http://127.0.0.1:8790/", restart: false });
    } });
  return { element, calls, location, page, async save() { await element("form").onsubmit({ preventDefault() {} }); return JSON.parse(calls.findLast((call) => call.method === "POST").body); } };
}

test("first desktop setup automatically finds one board and only fills the form until Save", async () => {
  const app = fixture(); await flush();
  assert.equal(app.element("screen").value, board().phone.screenUrl); assert.equal(app.element("host").value, board().ip);
  assert.equal(app.element("mode").value, "wifi"); assert.equal(app.element("find").disabled, false);
  assert.deepEqual(app.calls.map((call) => call.url), ["/desktop/discover"]);
  const saved = await app.save();
  assert.equal(saved.ANDROID_DEVICE_ID, phoneId); assert.equal(saved.ESP_SETUP_URL, board().boardUrl);
  assert.equal(saved.ESP_HOST, board().ip); assert.equal(saved.ANDROID_MCP_PORT, "8790");
});

test("first setup without a saved board host defaults to LAN even when a USB port exists", async () => {
  const app = fixture({ ANDROID_SCREEN_URL: "http://192.168.1.20:8791", ESP_PORT: "COM5" }, []);
  await flush();
  assert.equal(app.element("mode").value, "wifi");
  assert.equal(app.element("wifi").hidden, false);
  assert.equal(app.element("host").value, "", "Never invent a board IP.");
  assert.equal(app.element("tcp").value, "3333");
  assert.equal(app.element("host").required, true);
  await app.element("form").onsubmit({ preventDefault() {} });
  assert.equal(app.calls.some((call) => call.method === "POST"), false, "An empty LAN host must not silently save USB.");
  assert.match(app.element("message").textContent, /设备控制器.*IP/u);
});

test("manually finding a LAN board changes saved USB mode to Wi-Fi while retaining the local MCP port", async () => {
  const app = fixture({ ANDROID_SCREEN_URL: "http://192.168.1.99:8791", ESP_HOST: "", ESP_PORT: "COM6", ANDROID_MCP_PORT: "9410" });
  await flush(); assert.equal(app.calls.length, 0);
  app.element("find").onclick(); await flush();
  assert.equal(app.element("mode").value, "wifi"); assert.equal(app.element("serial").value, "COM6");
  const saved = await app.save();
  assert.equal(saved.ESP_HOST, board().ip); assert.equal(saved.ESP_SETUP_URL, board().boardUrl);
  assert.equal(saved.ANDROID_SCREEN_URL, board().phone.screenUrl); assert.equal(saved.ANDROID_MCP_PORT, "9410");
});

test("a new board without phone registration preserves the user's screen address and identity", async () => {
  const app = fixture({ ANDROID_SCREEN_URL: "http://192.168.1.99:8791", ANDROID_DEVICE_ID: phoneId,
    ESP_HOST: "192.168.1.10", ESP_SETUP_URL: "http://192.168.1.10:3334" }, [{ ...board(), phone: null }]);
  app.element("find").onclick(); await flush();
  assert.equal(app.element("screen").value, "http://192.168.1.99:8791");
  const saved = await app.save(); assert.equal(saved.ANDROID_DEVICE_ID, phoneId);
  assert.equal(saved.ESP_HOST, board().ip); assert.equal(saved.ESP_SETUP_URL, board().boardUrl);
  assert.match(app.element("discovery-state").textContent, /保留/u);
});

test("automatic discovery preserves saved USB but an explicit board choice selects LAN", async () => {
  const app = fixture({ ESP_HOST: "", ESP_PORT: "COM6" }); await flush();
  assert.equal(app.element("mode").value, "usb");
  app.element("boards").value = "0"; app.element("boards").onchange();
  assert.equal(app.element("mode").value, "wifi");
});

test("this form's explicit USB choice remains USB after a manual LAN search", async () => {
  const app = fixture({ ANDROID_SCREEN_URL: "http://192.168.1.99:8791", ESP_HOST: "192.168.1.10" });
  app.element("mode").value = "usb"; app.element("mode").onchange();
  app.element("find").onclick(); await flush();
  assert.equal(app.element("mode").value, "usb"); assert.equal((await app.save()).ESP_HOST, "");
});

test("manual discovery cannot overwrite edits made while it was waiting", async () => {
  let complete;
  const app = fixture({ ANDROID_SCREEN_URL: "http://192.168.1.99:8791", ESP_HOST: "192.168.1.10" }, [],
    () => new Promise((done) => { complete = done; }));
  app.element("find").onclick(); app.element("host").value = "192.168.1.77"; app.element("host").oninput();
  complete(Response.json({ boards: [board()] })); await flush();
  assert.equal(app.element("host").value, "192.168.1.77"); assert.equal(app.element("boards").hidden, false);
  app.element("boards").value = "0"; app.element("boards").onchange();
  assert.equal(app.element("host").value, board().ip);
});

test("the form uses the API's copied-address rules and explains download versus control ports", async () => {
  const app = fixture({ ANDROID_SCREEN_URL: "http://192.168.1.99:8791", ESP_HOST: "192.168.1.10" });
  app.element("host").value = "192.168.1.22：4444"; app.element("tcp").value = "5555";
  let saved = await app.save(); assert.equal(saved.ESP_HOST, "192.168.1.22"); assert.equal(saved.ESP_TCP_PORT, "4444");
  app.element("host").value = "http：//192.168.1.22：3334/"; app.element("tcp").value = "5555";
  saved = await app.save(); assert.equal(saved.ESP_HOST, "192.168.1.22"); assert.equal(saved.ESP_TCP_PORT, "3333");
  assert.match(app.page, /3334.*下载/u); assert.match(app.page, /控制.*3333/u);
});

test("multiple boards require an explicit choice and the placeholder never selects the first device", async () => {
  const app = fixture({}, [board(), { ...board("192.168.1.22"), phone: { ...board().phone, deviceId: "55555555-5555-4555-8555-555555555555" } }]); await flush();
  assert.equal(app.element("boards").hidden, false); assert.equal(app.element("screen").value, "");
  app.element("boards").value = ""; app.element("boards").onchange(); assert.equal(app.element("screen").value, "");
  app.element("boards").value = "1"; app.element("boards").onchange();
  assert.equal((await app.save()).ESP_HOST, "192.168.1.22");
});

test("late automatic discovery does not overwrite manual edits or the user's selected USB mode", async () => {
  let complete;
  const waiting = new Promise((done) => { complete = done; });
  const app = fixture({}, [], () => waiting);
  app.element("screen").value = "192.168.1.77:8791"; app.element("screen").oninput();
  app.element("mode").value = "usb"; app.element("mode").onchange();
  complete(Response.json({ boards: [board()] })); await flush();
  assert.equal(app.element("screen").value, "192.168.1.77:8791");
  app.element("boards").value = "0"; app.element("boards").onchange();
  assert.equal(app.element("mode").value, "usb"); assert.equal(app.element("screen").value, board().phone.screenUrl);
});

test("manual phone changes clear a discovered UUID; a board without registered phone clears stale screen fields", async () => {
  const app = fixture(); await flush();
  app.element("screen").value = "192.168.1.88:8791"; app.element("screen").oninput();
  assert.equal((await app.save()).ANDROID_DEVICE_ID, "");
  const missingPhone = fixture({}, [{ ...board(), phone: null }]); await flush();
  assert.equal(missingPhone.element("screen").value, "");
  assert.match(missingPhone.element("discovery-state").textContent, /请先在手机 App 连接/);
});

test("failed discovery leaves manual connection available and defaults cannot inject page scripts", async () => {
  const app = fixture({}, [], () => { throw new Error("Network unavailable"); }); await flush();
  assert.equal(app.element("find").disabled, false); assert.match(app.element("discovery-state").textContent, /手动填写/);
  const html = configurationPage({ ANDROID_SCREEN_URL: "</script><script>alert(1)</script>" }, []);
  assert.equal((html.match(/<script>/gu) ?? []).length, 1);
});

function manualClock() {
  let now = 0, next = 0;
  const timers = new Map();
  return {
    timers, performance: { now: () => now },
    setTimeout(callback, ms) { const id = ++next; timers.set(id, { callback, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    step() {
      const entry = [...timers].sort((left, right) => left[1].at - right[1].at)[0];
      assert.ok(entry, "A stalled network request must retain a bounded deadline.");
      timers.delete(entry[0]); now = entry[1].at; entry[1].callback();
    },
  };
}

test("stalled desktop discovery times out and leaves manual settings available", async () => {
  const clock = manualClock();
  const app = fixture({}, [], undefined, { ...clock, fetch: () => new Promise(() => {}) });
  await flush();
  assert.equal(app.element("find").disabled, true);
  clock.step(); await flush();
  assert.equal(app.element("find").disabled, false);
  assert.match(app.element("discovery-state").textContent, /手动填写/u);
  assert.equal(app.element("save").disabled, false);
});

test("stalled desktop save restores the form and a late response cannot navigate", async () => {
  const clock = manualClock(); let finish;
  const app = fixture({ ANDROID_SCREEN_URL: "http://192.168.1.20:8791", ESP_HOST: "192.168.1.21" }, [], undefined,
    { ...clock, fetch: () => new Promise((resolve) => { finish = resolve; }) });
  const saving = app.element("form").onsubmit({ preventDefault() {} }); await flush();
  for (const id of ["save", "find", "screen", "host", "tcp", "mode", "serial", "local-port"]) {
    assert.equal(app.element(id).disabled, true, `${id} must not change while an accepted save is pending`);
  }
  clock.step(); await saving;
  assert.equal(app.element("save").disabled, false);
  assert.equal(app.element("host").disabled, false);
  assert.match(app.element("message").textContent, /超时/u);
  finish(Response.json({ url: "http://192.168.1.20:9999/", restart: false })); await flush();
  assert.equal(app.location.href, "http://127.0.0.1:8790/desktop/settings");
});

test("the desktop save deadline includes a stalled JSON response body", async () => {
  const clock = manualClock();
  const app = fixture({ ANDROID_SCREEN_URL: "http://192.168.1.20:8791", ESP_HOST: "192.168.1.21" }, [], undefined,
    { ...clock, fetch: () => new Response(new ReadableStream({ start() {} }), { headers: { "Content-Type": "application/json" } }) });
  const saving = app.element("form").onsubmit({ preventDefault() {} }); await flush();
  clock.step(); await saving;
  assert.match(app.element("message").textContent, /超时/u);
  assert.equal(app.element("save").disabled, false);
  assert.equal(app.location.href, "http://127.0.0.1:8790/desktop/settings");
});

test("restart readiness retains a total deadline when an individual status request never answers", async () => {
  const clock = manualClock();
  const app = fixture({ ANDROID_SCREEN_URL: "http://192.168.1.20:8791", ESP_HOST: "192.168.1.21" }, [], undefined, {
    ...clock, fetch: (_url, options) => options.method === "POST"
      ? Response.json({ url: "http://192.168.1.22:8790/", restart: true, configHash: "next" }) : new Promise(() => {}),
  });
  let settled = false;
  const saving = app.element("form").onsubmit({ preventDefault() {} }).finally(() => { settled = true; });
  await flush();
  for (let index = 0; !settled && index < 80; index++) { clock.step(); await flush(); }
  assert.equal(settled, true); await saving;
  assert.ok(clock.performance.now() <= 20000, "The whole restart wait must remain bounded, including request bodies.");
  assert.match(app.element("message").textContent, /尚未就绪/u);
  assert.equal(app.element("save").disabled, false);
  assert.equal(app.location.href, "http://127.0.0.1:8790/desktop/settings");
});

test("a repeated submit cannot launch a second save while the first response is pending", async () => {
  let finish;
  const app = fixture({ ANDROID_SCREEN_URL: "http://192.168.1.20:8791", ESP_HOST: "192.168.1.21" }, [], undefined,
    { fetch: () => new Promise((resolve) => { finish = resolve; }) });
  const first = app.element("form").onsubmit({ preventDefault() {} }); await flush();
  const second = app.element("form").onsubmit({ preventDefault() {} }); await flush();
  assert.equal(app.calls.filter((call) => call.method === "POST").length, 1);
  finish(Response.json({ url: "http://127.0.0.1:8790/", restart: false }));
  await Promise.all([first, second]);
});

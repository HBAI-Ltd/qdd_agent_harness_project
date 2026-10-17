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
function fixture(defaults = {}, boards = [board()], discovery) {
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
    location, URL, setTimeout,
    fetch: async (url, options = {}) => {
      calls.push({ url, ...options });
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

test("configured USB setup discovers changed phone address while preserving USB and the local MCP port", async () => {
  const app = fixture({ ANDROID_SCREEN_URL: "http://192.168.1.99:8791", ESP_HOST: "", ESP_PORT: "COM6", ANDROID_MCP_PORT: "9410" });
  await flush(); assert.equal(app.calls.length, 0);
  app.element("find").onclick(); await flush();
  assert.equal(app.element("mode").value, "usb"); assert.equal(app.element("serial").value, "COM6");
  const saved = await app.save();
  assert.equal(saved.ESP_HOST, ""); assert.equal(saved.ESP_SETUP_URL, board().boardUrl);
  assert.equal(saved.ANDROID_SCREEN_URL, board().phone.screenUrl); assert.equal(saved.ANDROID_MCP_PORT, "9410");
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

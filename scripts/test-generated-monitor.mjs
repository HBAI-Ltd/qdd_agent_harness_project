import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

// Run: node scripts/test-generated-monitor.mjs. No network or real camera access.
const page = new URL("../workspace/site/pages/p20261018-133825-ea93/", import.meta.url);
const [html, app, diagnostics] = await Promise.all(["index.html", "app.js", "diagnostics.js"].map((file) => readFile(new URL(file, page), "utf8")));
const camera = (id) => ({ id, name: id, online: true });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function harness(options = {}) {
  const elements = new Map(), calls = [], players = [], hlsPlayers = [], timers = new Map();
  let now = 0, timerId = 0;
  class Element {
    constructor(tag = "div", id = "") { this.tagName = tag; this.id = id; this.listeners = new Map(); this.textContent = ""; this._html = ""; this.paused = true; this.readyState = 0; this.classList = { add() {}, remove() {}, toggle() {} }; }
    set innerHTML(value) { this._html = value; parse(value); }
    get innerHTML() { return this._html; }
    addEventListener(name, callback) { const callbacks = this.listeners.get(name) || []; callbacks.push(callback); this.listeners.set(name, callbacks); }
    dispatch(name, event = {}) { return Promise.all((this.listeners.get(name) || []).map((callback) => callback(event))); }
    removeAttribute(name) { delete this[name]; }
    load() {}
    pause() { this.paused = true; void this.dispatch("pause"); }
    play() { if (options.playError) return Promise.reject(options.playError); this.paused = false; return Promise.resolve(); }
    canPlayType() { return options.nativeHls ? "probably" : ""; }
  }
  function parse(markup) {
    for (const match of markup.matchAll(/<([\w-]+)\b[^>]*\bid="([^"]+)"/g)) elements.set(match[2], new Element(match[1], match[2]));
  }
  parse(html);
  const document = new Element("document");
  document.getElementById = (id) => elements.get(id) || null;
  document.createElement = (tag) => new Element(tag);
  document.querySelector = () => null; // WASM renders to canvas; no SDK video exists.
  class FakeFlv {
    constructor(config) { this.config = config; this.events = new Map(); this.playing = false; this.destroyed = false; this.emitting = 0; players.push(this); }
    on(name, callback) { const callbacks = this.events.get(name) || []; callbacks.push(callback); this.events.set(name, callbacks); }
    emit(name, data) {
      this.emitting++;
      try { for (const callback of this.events.get(name) || []) callback(data); }
      finally { this.emitting--; }
    }
    getState() { return { playing: this.playing }; }
    destroy() { assert.equal(this.emitting, 0, "SDK teardown must happen after its event stack returns"); this.destroyed = true; }
  }
  class FakeHls {
    static Events = { MANIFEST_PARSED: "manifest", ERROR: "error" };
    static ErrorTypes = { MEDIA_ERROR: "mediaError" };
    static isSupported() { return options.hlsSupported !== false; }
    constructor(config) { this.config = config; this.events = new Map(); this.destroyed = false; hlsPlayers.push(this); }
    on(name, callback) { this.events.set(name, callback); }
    emit(name, data) { this.events.get(name)?.(name, data); }
    loadSource(url) { this.url = url; }
    attachMedia(video) { this.video = video; }
    recoverMediaError() { this.recovered = true; }
    destroy() { this.destroyed = true; }
  }
  const schedule = (fn, delay, interval = false) => { const id = ++timerId; timers.set(id, { fn, due: now + delay, interval: interval ? delay : 0 }); return id; };
  const windowEvents = new Element("window");
  const context = {
    URL, Date, Promise, document,
    EzuikitFlv: FakeFlv, Hls: options.noHls ? undefined : FakeHls,
    WebAssembly: {}, Worker: function () {}, MediaSource: { isTypeSupported: options.mseSupport || (() => true) },
    setTimeout: (fn, delay) => schedule(fn, delay), clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, delay) => schedule(fn, delay, true), clearInterval: (id) => timers.delete(id),
    addEventListener: windowEvents.addEventListener.bind(windowEvents), open() {},
    qdd: { async tool(name, args) {
      calls.push({ name, args });
      if (name === "mcp__haik__list_cameras") return { cameras: options.haik ?? [camera("cam-a"), camera("cam-b")] };
      if (name === "mcp__tysl__tysl_camera_list") return { cameras: options.tysl ?? [1, 2, 3, 4].map((n) => camera("t" + n)) };
      if (options.tool) { const result = options.tool(name, args); if (result !== undefined) return result; }
      if (name === "mcp__haik__get_live_stream") return { url: "https://camera.invalid/live.flv?token=fixture", protocol: "flv", expiresIn: 300 };
      if (name === "mcp__tysl__tysl_camera_preview") return { url: "http://127.0.0.1:9999/streams/fixture/index.m3u8", protocol: "hls", pageUrl: "http://127.0.0.1:9999/" };
      throw new Error("Unexpected tool");
    } },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(app, context, { filename: "generated-monitor/app.js" });
  vm.runInContext(diagnostics, context, { filename: "generated-monitor/diagnostics.js" });
  return {
    calls, players, hlsPlayers, elements,
    get: (id) => elements.get(id),
    async start() { await document.dispatch("DOMContentLoaded"); await flush(); },
    async click(action, key) { await elements.get("camGrid").dispatch("click", { target: { closest: () => ({ getAttribute: (name) => name === "data-act" ? action : key }) } }); await flush(); },
    async refresh() { await elements.get("btnRefresh").dispatch("click"); await flush(); },
    async diagnose() { await elements.get("btnDiag").dispatch("click"); await flush(); },
    async hide() { await windowEvents.dispatch("pagehide"); await flush(); },
    async advance(milliseconds) {
      const end = now + milliseconds;
      for (let count = 0; count < 2000; count++) {
        const next = [...timers.entries()].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
        if (!next) { now = end; await flush(); return; }
        const [id, timer] = next; now = timer.due;
        if (timer.interval) timer.due += timer.interval; else timers.delete(id);
        timer.fn(); await flush();
      }
      throw new Error("Timer loop did not settle");
    },
  };
}

test("startup keeps both Haik previews and diagnosis never acquires streams", async () => {
  const h = harness(); await h.start();
  assert.equal(h.players.length, 2);
  assert.equal(h.calls.filter((call) => call.name.endsWith("tysl_camera_preview")).length, 0);
  const streamCalls = h.calls.filter((call) => /get_live_stream|tysl_camera_preview/.test(call.name)).length;
  await h.diagnose();
  assert.equal(h.calls.filter((call) => /get_live_stream|tysl_camera_preview/.test(call.name)).length, streamCalls);
  assert.match(h.get("diagSummary").textContent, /不另开流/);
  assert.match(html, /src="\/assets\/camera-player\/hls.min.js"/);
});

test("Tysl selection replaces one preview and ignores the retired player's callbacks", async () => {
  const h = harness({ haik: [] }); await h.start();
  await h.click("replay", "tysl_t1");
  const old = h.hlsPlayers[0]; await old.video.dispatch("playing");
  assert.equal(h.get("kPlaying").textContent, 1);
  await h.click("replay", "tysl_t2");
  assert.equal(old.destroyed, true);
  assert.deepEqual(h.calls.filter((call) => call.name.endsWith("tysl_camera_preview")).map((call) => call.args.cameraId), ["t1", "t2"]);
  old.emit("error", { fatal: true, type: "networkError", details: "late" });
  await old.video.dispatch("playing");
  assert.equal(h.get("kPlaying").textContent, 0);
  await h.hlsPlayers[1].video.dispatch("playing");
  assert.equal(h.get("kPlaying").textContent, 1);
  await h.diagnose();
  assert.equal(h.calls.filter((call) => call.name.endsWith("tysl_camera_preview")).length, 2);
});

test("a superseded Tysl response cannot mount or replace the selected stream", async () => {
  const pending = deferred();
  const h = harness({ haik: [], tool: (name, args) => name.endsWith("tysl_camera_preview") && args.cameraId === "t1" ? pending.promise : undefined });
  await h.start(); await h.click("replay", "tysl_t1"); await h.click("replay", "tysl_t2");
  pending.resolve({ url: "https://camera.invalid/late.m3u8", protocol: "hls" }); await flush();
  assert.equal(h.hlsPlayers.length, 1);
  assert.match(h.get("msg-tysl_t1").innerHTML, /已切换/);
});

test("WASM canvas playback counts through SDK state and videoFrame events", async () => {
  const h = harness(); await h.start();
  h.players[0].playing = true; await h.advance(300);
  assert.equal(h.get("kPlaying").textContent, 1);
  h.players[1].emit("videoFrame");
  assert.equal(h.get("kPlaying").textContent, 2);
});

test("Haik starts WASM directly when neither HEVC MSE declaration is supported", async () => {
  const types = [];
  const h = harness({ haik: [camera("cam-a")], mseSupport: (type) => { types.push(type); return type.includes("avc1"); } });
  await h.start();
  assert.equal(h.players.length, 1); assert.equal(h.players[0].config.useMSE, false);
  assert.ok(types.some((type) => type.includes("hvc1"))); assert.ok(types.some((type) => type.includes("hev1")));
  h.players[0].emit("videoFrame"); assert.equal(h.get("kPlaying").textContent, 1);
  h.players[0].emit("error", { message: "fixture failure" }); await h.advance(0);
  assert.equal(h.players.length, 1); assert.equal(h.get("kBlocked").textContent, 1);
});

test("Haik retains MSE preference when the alternate HEVC declaration is supported", async () => {
  const h = harness({ haik: [camera("cam-a")], mseSupport: (type) => type.includes("hev1") }); await h.start();
  assert.equal(h.players[0].config.useMSE, true);
});

test("MSE falls back once; stopping invalidates queued and late callbacks", async () => {
  const h = harness({ haik: [camera("cam-a")] }); await h.start();
  const first = h.players[0]; first.emit("error", { message: "codec" }); first.emit("error", { message: "duplicate" });
  await h.advance(0);
  assert.equal(h.players.length, 2); assert.equal(h.players[1].config.useMSE, false);
  first.emit("error", { message: "retired" });
  await h.click("stop", "haik_cam-a");
  h.players[1].emit("videoFrame"); h.players[1].emit("error", { message: "late" });
  await h.advance(60000);
  assert.equal(h.players.length, 2); assert.equal(h.get("kPlaying").textContent, 0);
  assert.match(h.get("msg-haik_cam-a").innerHTML, /已停止/);
});

test("stopping before fallback fires prevents a new WASM instance", async () => {
  const h = harness({ haik: [camera("cam-a")] }); await h.start();
  h.players[0].emit("error", { message: "codec" }); await h.click("stop", "haik_cam-a"); await h.advance(0);
  assert.equal(h.players.length, 1);
});

test("FLV error and timeout handlers defer both fallback and final teardown", async () => {
  for (const event of ["error", "loadingTimeout", "heartTimeout"]) {
    const h = harness({ haik: [camera("cam-a")] }); await h.start();
    const mse = h.players[0];
    mse.emit(event, { message: "fixture failure" });
    assert.equal(mse.destroyed, false, "MSE remains valid until emit returns");
    assert.equal(h.players.length, 1);
    await h.advance(0);
    assert.equal(mse.destroyed, true); assert.equal(h.players.length, 2);
    const wasm = h.players[1];
    wasm.emit(event, { message: "fixture failure" });
    assert.equal(wasm.destroyed, false, "WASM remains valid until emit returns");
    assert.equal(h.get("kBlocked").textContent, 0);
    await h.advance(0);
    assert.equal(wasm.destroyed, true); assert.equal(h.get("kBlocked").textContent, 1);
  }
});

test("stopping before deferred WASM failure prevents its queued block", async () => {
  const h = harness({ haik: [camera("cam-a")] }); await h.start();
  h.players[0].emit("error", { message: "codec" }); await h.advance(0);
  const wasm = h.players[1]; wasm.emit("error", { message: "late failure" });
  assert.equal(wasm.destroyed, false);
  await h.click("stop", "haik_cam-a"); await h.advance(0);
  assert.equal(wasm.destroyed, true); assert.equal(h.get("kBlocked").textContent, 0);
  assert.match(h.get("msg-haik_cam-a").innerHTML, /已停止/);
});

test("stopping a pending Haik request ignores its later signed address", async () => {
  const pending = deferred();
  const h = harness({ haik: [camera("cam-a")], tool: (name) => name.endsWith("get_live_stream") ? pending.promise : undefined });
  const startup = h.start(); await flush();
  await h.click("stop", "haik_cam-a");
  pending.resolve({ url: "https://camera.invalid/late.flv?token=fixture", protocol: "flv" }); await startup;
  assert.equal(h.players.length, 0);
  assert.match(h.get("msg-haik_cam-a").innerHTML, /已停止/);
});

test("both decoder attempts time out into a terminal failure", async () => {
  const h = harness({ haik: [camera("cam-a")] }); await h.start(); await h.advance(30000);
  assert.equal(h.players.length, 2); assert.equal(h.get("kBlocked").textContent, 1);
  assert.match(h.get("msg-haik_cam-a").innerHTML, /15 秒内未渲染/);
  h.players[0].emit("playing"); h.players[1].emit("videoFrame");
  assert.equal(h.get("kPlaying").textContent, 0);
});

test("native HLS reports blocked autoplay, actual playing, and media errors", async () => {
  const h = harness({ haik: [], hlsSupported: false, nativeHls: true, playError: Object.assign(new Error("gesture required"), { name: "NotAllowedError" }) });
  await h.start(); await h.click("replay", "tysl_t1");
  assert.match(h.get("msg-tysl_t1").innerHTML, /点击播放器/);
  await h.advance(30000); assert.equal(h.get("kBlocked").textContent, 0);
  const video = h.get("v-tysl_t1"); await video.dispatch("playing"); assert.equal(h.get("kPlaying").textContent, 1);
  video.error = { code: 3, message: "decode failed" }; await video.dispatch("error"); assert.equal(h.get("kBlocked").textContent, 1);
});

test("manifest parsing is not counted as rendered video; native fallback is counted", async () => {
  const h = harness({ haik: [], nativeHls: true }); await h.start(); await h.click("replay", "tysl_t1");
  const first = h.hlsPlayers[0]; first.emit("manifest"); await flush();
  assert.equal(h.get("kPlaying").textContent, 0);
  first.emit("error", { fatal: true, type: "networkError", details: "manifestLoadError" });
  assert.equal(first.destroyed, true);
  await h.get("v-tysl_t1").dispatch("playing"); assert.equal(h.get("kPlaying").textContent, 1);
});

test("HLS recovery is bounded even after a previously rendered stream fails", async () => {
  const h = harness({ haik: [] }); await h.start(); await h.click("replay", "tysl_t1");
  const player = h.hlsPlayers[0]; await player.video.dispatch("playing");
  player.emit("error", { fatal: true, type: "mediaError", details: "decodeError" });
  assert.equal(player.recovered, true); assert.equal(h.get("kPlaying").textContent, 0);
  await h.advance(20000);
  assert.equal(h.get("kBlocked").textContent, 1); assert.equal(player.destroyed, true);
});

test("protocol inference uses pathname despite a signed query suffix", async () => {
  const h = harness({ haik: [], tool: (name) => name.endsWith("tysl_camera_preview") ? { url: "https://camera.invalid/video.m3u8?signature=fixture.flv" } : undefined });
  await h.start(); await h.click("replay", "tysl_t1");
  assert.equal(h.hlsPlayers.length, 1); assert.equal(h.players.length, 0);
  assert.doesNotMatch(h.get("detailBody").innerHTML, /signature=|fixture\.flv/);
});

test("RTMP is rejected without loading a browser player", async () => {
  const h = harness({ haik: [], tool: (name) => name.endsWith("tysl_camera_preview") ? { url: "rtmp://camera.invalid/live", protocol: "rtmp" } : undefined });
  await h.start(); await h.click("replay", "tysl_t1");
  assert.equal(h.hlsPlayers.length, 0); assert.equal(h.get("kBlocked").textContent, 1);
  assert.match(h.get("msg-tysl_t1").innerHTML, /无法直接播放 RTMP\/RTSP/);
});

test("pagehide cancels fallback and refresh only restores the selected Tysl route", async () => {
  const h = harness({ haik: [camera("cam-a")] }); await h.start(); await h.click("replay", "tysl_t3"); await h.refresh();
  assert.deepEqual(h.calls.filter((call) => call.name.endsWith("tysl_camera_preview")).map((call) => call.args.cameraId), ["t3", "t3"]);
  const player = h.players.at(-1); player.emit("error", { message: "codec" });
  const count = h.players.length; await h.hide(); await h.advance(60000);
  player.emit("playing"); assert.equal(h.players.length, count);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate as tick } from "node:timers/promises";
import { test } from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../assets/operator.js", import.meta.url), "utf8");
const screenSource = await readFile(new URL("../assets/screen-channel.js", import.meta.url), "utf8");
const remoteSource = await readFile(new URL("../assets/remote-channel.js", import.meta.url), "utf8");
const html = await readFile(new URL("../assets/operator.html", import.meta.url), "utf8");
const css = await readFile(new URL("../assets/operator.css", import.meta.url), "utf8");
const httpSource = await readFile(new URL("../src/http.ts", import.meta.url), "utf8");
const serverRuntimeVersion = Number(/runtimeVersion:\s*(\d+)/.exec(httpSource)?.[1]);
assert.ok(Number.isInteger(serverRuntimeVersion), "Operator fixtures must use the actual HTTP server runtime version.");
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
async function flush() { for (let i = 0; i < 8; i++) await tick(); }

function fixture(runtimeVersion = serverRuntimeVersion, options = {}) {
  const pageLocation = options.locationHref ?? "http://127.0.0.1:8790/";
  const advertisedOperatorUrl = options.operatorUrl ?? pageLocation;
  const elements = new Map(), documentEvents = new Map(), windowEvents = new Map(), timers = new Map(), animations = new Map();
  const calls = [], videos = [], requests = [], locks = [], livenessChannels = [], remoteSockets = [];
  let serverAvailable = options.serverAvailable !== false;
  let screenProfile = options.profile ?? "standard", nextProfileGet, nextProfilePost;
  const geometry = { width: 1080, height: 2400, rotation: 0, deviceSerial: "28c16ea2-c6ee-4b5d-8307-29b20df14bab" };
  let timerId = 0, frameId = 0, armed = options.externalController === true, nextDecode, nextInputResponse, nextLeaseResponse, nextArmResponse, nextStatusResponse, nextPauseResponse;
  let calibrated = options.calibrated !== false;
  let pointer = options.pointerKnown === false ? null : { x: 0, y: 0 };
  let heldKey = options.externalController ? 4 : 0, heldModifier = 0, heldButtons = options.externalController ? 1 : 0, lockRequests = 0;
  let animationId = 0, layoutReads = 0;
  let leaseSequence = 0, leaseRound = null;
  let holdRemoteAcks = false;
  const remoteAcks = [];
  let bounds = { left: 0, top: 0, right: 270, bottom: 600, width: 270, height: 600 };
  let style = { objectFit: "fill", objectPosition: "50% 50%" };
  const bodyClasses = new Set();
  const fire = (listeners, type, values = {}) => {
    const event = { stopped: false, preventDefault() {}, stopImmediatePropagation() { this.stopped = true; }, ...values };
    for (const callback of listeners.get(type) ?? []) { if (event.stopped) break; callback(event); }
    return event;
  };
  const add = (listeners, type, callback) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(callback);
  };
  const document = { hidden: false, activeElement: null, pointerLockElement: null,
    body: { classList: { toggle(name, active) { if (active) bodyClasses.add(name); else bodyClasses.delete(name); } } },
    getElementById: element,
    addEventListener(type, callback) { add(documentEvents, type, callback); },
    exitPointerLock() { this.pointerLockElement = null; fire(documentEvents, "pointerlockchange"); },
  };
  function element(id) {
    if (["arm-button", "pause-button", "remote-button", "control-hint", "estimate-badge", "status-armed"].includes(id)) return null;
    if (!elements.has(id)) elements.set(id, { id, textContent: "", value: id.startsWith("scale-") ? "1" : "", disabled: false,
      hidden: ["phone-screen", "screen-state", "error-box", "remote-button"].includes(id), dataset: {}, style: {}, listeners: new Map(), src: "",
      focus(options) {
        this.focusOptions = options;
        const previous = document.activeElement;
        if (previous !== this) {
          document.activeElement = this;
          if (previous) fire(previous.listeners, "blur", { relatedTarget: this });
        }
      },
      getBoundingClientRect() { layoutReads++; return bounds; },
      scrollIntoView(options) { this.scrollOptions = options; },
      addEventListener(type, callback) { add(this.listeners, type, callback); },
      requestPointerLock() {
        lockRequests++; requests.push({ url: "pointer-lock" });
        if (options.pointerLock === "success") { document.pointerLockElement = this; fire(documentEvents, "pointerlockchange"); return Promise.resolve(); }
        if (options.pointerLock === "deferred") { const pending = deferred(); locks.push(pending); return pending.promise; }
        if (options.pointerLock === "legacy") return undefined;
        return Promise.reject(new Error("Unsupported browser capture."));
      },
    });
    if (id === "phone-screen" && options.pointerLock === "missing") elements.get(id).requestPointerLock = undefined;
    return elements.get(id);
  }
  const status = () => ({ connected: true, encrypted: true, ready: true, locked: options.locked === true, armed, name: "Mock board",
    input: { armed, calibrated, positionEstimated: true, pointer, screen: { width: geometry.width, height: geometry.height, rotation: geometry.rotation } } });
  const release = () => { armed = false; heldKey = heldModifier = heldButtons = 0; pointer = null; leaseRound = null; };
  class WebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    bufferedAmount = 0;
    listeners = new Map();
    constructor(url) {
      this.url = url; remoteSockets.push(this);
      requests.push({ url: "/remote/socket", method: "UPGRADE", socket: this });
      queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; fire(this.listeners, "open"); } });
    }
    addEventListener(type, callback) { add(this.listeners, type, callback); }
    emit(data) { fire(this.listeners, "message", { data: JSON.stringify(data) }); }
    send(text) {
      const message = JSON.parse(text);
      requests.push({ url: "/remote/socket", method: "WS", message, socket: this, round: this.round });
      if (message.type === "hello") {
        this.round = message.round;
        queueMicrotask(() => this.emit({ type: "ready", round: message.round }));
      } else if (message.type === "ping") {
        const wait = nextLeaseResponse; nextLeaseResponse = null;
        void Promise.resolve(wait?.promise).then(() => this.emit({ type: "pong" }));
      } else if (message.type === "report") {
        const { kind, ...args } = message.report;
        calls.push({ name: kind === "key" ? "android_key_report" : "android_mouse_move", args });
        if (kind === "key") { heldKey = args.keycode; heldModifier = args.modifier; }
        else { heldButtons = args.buttons; pointer = null; }
        const wait = nextInputResponse; nextInputResponse = null;
        const acknowledge = () => this.emit({ type: "ack", sequence: message.sequence, state: status().input });
        if (holdRemoteAcks) remoteAcks.push(acknowledge);
        else void Promise.resolve(wait?.promise).then(acknowledge);
      } else if (message.type === "stop" && this.round === leaseRound) release();
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (this.round === leaseRound) release();
      fire(this.listeners, "close");
    }
  }
  const fetcher = async (url, options) => {
    requests.push({ url, method: options.method, body: options.body, signal: options.signal, headers: { ...options.headers } });
    if (url === "/screen/profile") {
      if (options.method === "GET") {
        const actual = screenProfile, wait = nextProfileGet; nextProfileGet = null;
        const outcome = await wait?.promise;
        if (outcome?.status) return outcome.error !== undefined ? Response.json({ error: outcome.error }, { status: outcome.status }) :
          new Response(outcome.body ?? null, { status: outcome.status, headers: outcome.contentType ? { "Content-Type": outcome.contentType } : {} });
        return Response.json({ profile: actual });
      }
      const desired = JSON.parse(options.body).profile, wait = nextProfilePost; nextProfilePost = null;
      const outcome = await wait?.promise;
      if (outcome?.status) return outcome.error !== undefined ? Response.json({ error: outcome.error }, { status: outcome.status }) :
        new Response(outcome.body ?? null, { status: outcome.status, headers: outcome.contentType ? { "Content-Type": outcome.contentType } : {} });
      screenProfile = desired;
      return Response.json({ profile: screenProfile });
    }
    if (url === "/screen/stream") {
      const stream = new ReadableStream({ start(controller) {
        const video = { closed: false, emit(type, data = {}) {
          if (this.closed) return;
          if (type === "error") { this.closed = true; controller.error(new Error("Video connection lost.")); return; }
          const { image: ignored, ...metadata } = data;
          const json = Buffer.from(JSON.stringify({ type, ...metadata }));
          const image = type === "frame" ? Buffer.from(data.image ?? "jpeg") : Buffer.alloc(0);
          const prefix = Buffer.alloc(8);
          prefix.writeUInt32BE(json.length); prefix.writeUInt32BE(image.length, 4);
          controller.enqueue(new Uint8Array(Buffer.concat([prefix, json, image])));
        } };
        videos.push(video);
        options.signal.addEventListener("abort", () => { if (!video.closed) { video.closed = true; controller.close(); } }, { once: true });
      } });
      return new Response(stream, { headers: { "Content-Type": "application/x-qdd-screen" } });
    }
    if (url === "/health") {
      if (!serverAvailable) throw new TypeError("Network unavailable");
      return Response.json({ status: "ok", name: "qdd-android-hid", runtimeVersion,
        operatorUrl: advertisedOperatorUrl });
    }
    if (url === "/remote/lease") {
      const expectedRound = options.headers?.["X-Remote-Round"];
      if (options.method === "DELETE") {
        if (expectedRound && expectedRound !== leaseRound) return new Response(null, { status: 409 });
        release(); return new Response(null, { status: 204 });
      }
      if (expectedRound && expectedRound !== leaseRound) return new Response(null, { status: 409 });
      if (!leaseRound && armed) leaseRound = `fixture-round-${++leaseSequence}`;
      const responseRound = leaseRound;
      const wait = nextLeaseResponse; nextLeaseResponse = null;
      if (wait) await wait.promise;
      return new Response(null, { status: armed ? 204 : 409, headers: { "X-Remote-Round": responseRound ?? "" } });
    }
    if (url === "/remote/input") {
      const report = JSON.parse(options.body);
      const { kind, ...args } = report;
      calls.push({ name: kind === "key" ? "android_key_report" : "android_mouse_move", args });
      if (kind === "key") { heldKey = args.keycode; heldModifier = args.modifier; }
      else heldButtons = args.buttons;
      const wait = nextInputResponse; nextInputResponse = null;
      if (wait) await wait.promise;
      if (kind === "mouse") pointer = null;
      return Response.json(status().input);
    }
    if (options.method === "GET") {
      const body = new ReadableStream({ start(controller) {
        const channel = { closed: false, lose() { if (!this.closed) { this.closed = true; controller.error(new Error("Lost MCP session")); } } };
        livenessChannels.push(channel);
        options.signal.addEventListener("abort", () => { if (!channel.closed) { channel.closed = true; controller.close(); } }, { once: true });
      } });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    if (options.method === "DELETE") return new Response(null, { status: 204 });
    const message = JSON.parse(options.body), name = message.method === "tools/call" ? message.params.name : message.method;
    const args = message.params?.arguments ?? {};
    calls.push({ name, args });
    const headers = { "content-type": "application/json" };
    let result;
    if (name === "initialize") { headers["mcp-session-id"] = "fixture-session"; result = { protocolVersion: "2025-03-26" }; }
    else if (name === "notifications/initialized") return new Response(null, { status: 202 });
    else {
      if (name === "android_hid_status") {
        const wait = nextStatusResponse; nextStatusResponse = null;
        if (wait) await wait.promise;
      }
      if (name === "android_hid_arm") {
        armed = true;
        const wait = nextArmResponse; nextArmResponse = null;
        if (wait) await wait.promise;
      }
      if (name === "android_hid_pause") {
        release();
        const wait = nextPauseResponse; nextPauseResponse = null;
        if (wait) await wait.promise;
      }
      if (name === "android_calibrate_pointer") { calibrated = true; pointer = null; }
      let data = status(), image;
      if (name === "android_screenshot") {
        data = { frameId: `snapshot-${++frameId}`, ...geometry, input: data.input };
        image = { type: "image", mimeType: "image/jpeg", data: "fixture-jpeg" };
      }
      result = { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }, ...(image ? [image] : [])] };
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), { headers });
  };
  class EventSource {
    constructor() { this.listeners = new Map(); this.closed = false; videos.push(this); }
    addEventListener(type, callback) { add(this.listeners, type, callback); }
    close() { this.closed = true; }
    emit(type, data) { fire(this.listeners, type, { data: JSON.stringify(data) }); }
  }
  vm.runInNewContext(screenSource + "\n" + remoteSource + "\n" + source, { document, window: { addEventListener(type, callback) { add(windowEvents, type, callback); } },
    fetch: fetcher, EventSource, getComputedStyle: () => style, performance, Image: class {
      naturalWidth = 1080; naturalHeight = 2400;
      decode() { const wait = nextDecode; nextDecode = null; return wait?.promise ?? Promise.resolve(); }
    }, Error, TypeError, Promise, AbortSignal, AbortController, Date, Headers, Uint8Array, DataView, TextDecoder, Blob, URL, WebSocket,
    location: { href: pageLocation }, queueMicrotask,
    setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms, interval: true }); return id; },
    clearInterval(id) { timers.delete(id); },
    requestAnimationFrame(callback) { const id = ++animationId; animations.set(id, callback); return id; },
    cancelAnimationFrame(id) { animations.delete(id); },
  });
  return {
    element, calls, requests,
    click(id) {
      const target = element(id);
      if (!target || target.disabled || target.hidden) return;
      fire(documentEvents, "mousedown", { target, buttons: 1 });
      fire(documentEvents, "mouseup", { target, buttons: 0 });
      const event = fire(documentEvents, "click", { target });
      if (!event.stopped) fire(target.listeners, "click", event);
    },
    change(id, value) {
      const target = element(id);
      if (!target || target.disabled || target.hidden) return;
      target.value = value;
      fire(target.listeners, "change", { target });
    },
    input(type, event) { fire(documentEvents, type, type === "mousemove" ? { movementX: 1, movementY: 1, ...event } : event); },
    imageEvent(type, event) { fire(element("phone-screen").listeners, type, event); },
    hide() { document.hidden = true; fire(documentEvents, "visibilitychange"); },
    resolveLock(index) { document.pointerLockElement = element("phone-screen"); fire(documentEvents, "pointerlockchange"); locks[index].resolve(); },
    rejectLock(index) { locks[index].reject(new Error("An earlier capture request failed.")); fire(documentEvents, "pointerlockerror"); },
    window(type) { fire(windowEvents, type); },
    loseMcp() { livenessChannels.at(-1).lose(); },
    loseRemote() { remoteSockets.at(-1).close(); },
    setServerAvailable(value) { serverAvailable = value; },
    externalController() { armed = true; heldKey = 4; heldButtons = 1; },
    show() { document.hidden = false; fire(documentEvents, "visibilitychange"); },
    escape() { fire(documentEvents, "keydown", { code: "Escape", repeat: false }); },
    setBounds(value) { bounds = { ...bounds, ...value }; },
    setStyle(value) { style = { ...style, ...value }; },
    frame(id = `video-${++frameId}`, extra = {}) {
      videos.at(-1).emit("frame", { mimeType: "image/jpeg", image: id, sourceFrameId: id,
        ...geometry, frameAgeMs: 100, sentAt: Date.now(), ...extra });
    },
    videoError() { videos.at(-1).emit("error"); },
    blockDecode() { nextDecode = deferred(); return nextDecode; },
    blockInputResponse() { nextInputResponse = deferred(); return nextInputResponse; },
    blockAllInputs() { holdRemoteAcks = true; return { resolve() { holdRemoteAcks = false; for (const acknowledge of remoteAcks.splice(0)) acknowledge(); } }; },
    blockLeaseResponse() { nextLeaseResponse = deferred(); return nextLeaseResponse; },
    blockArmResponse() { nextArmResponse = deferred(); return nextArmResponse; },
    blockStatusResponse() { nextStatusResponse = deferred(); return nextStatusResponse; },
    blockPauseResponse() { nextPauseResponse = deferred(); return nextPauseResponse; },
    blockProfileGet() { nextProfileGet = deferred(); return nextProfileGet; },
    blockProfilePost() { nextProfilePost = deferred(); return nextProfilePost; },
    async ready() {
      await flush(); this.frame(); await flush(); this.click("phone-screen"); await flush();
      if (!options.skipEntry) { this.input("mousemove", { clientX: 135, clientY: 300, movementX: 0, movementY: 0 }); await this.pump(); }
    },
    async align() { this.input("mousemove", { clientX: 135, clientY: 300 }); await this.pump(); },
    animationFrame() {
      for (const [id, callback] of [...animations]) {
        if (!animations.has(id)) continue;
        animations.delete(id); callback(performance.now());
      }
    },
    async pump() {
      for (let i = 0; i < 40; i++) {
        await flush();
        if (!animations.size) return;
        this.animationFrame();
      }
    },
    fireTimer(ms) {
      const pending = [...timers.entries()].find(([, timer]) => timer.ms === ms);
      if (!pending) return false;
      if (!pending[1].interval) timers.delete(pending[0]);
      pending[1].callback(); return true;
    },
    hasTimer(ms) { return [...timers.values()].some((timer) => timer.ms === ms); },
    async close() { this.escape(); await flush(); this.click("disconnect-button"); await flush(); },
    get reports() { return calls.filter(({ name }) => name === "android_mouse_move").map(({ args }) => args); },
    get lockRequests() { return lockRequests; },
    get locked() { return document.pointerLockElement === element("phone-screen"); },
    get remoteActive() { return bodyClasses.has("remote-active"); },
    get leaseRound() { return leaseRound; },
    get layoutReads() { return layoutReads; },
    get held() { return { key: heldKey, modifier: heldModifier, buttons: heldButtons }; },
  };
}

test("one picture click enters remote control without forwarding the entering click to the phone", async () => {
  const app = fixture(); await app.ready();
  assert.equal(app.element("remote-button"), null);
  assert.equal(app.reports.length, 0);
  assert.equal(app.remoteActive, true);
  app.input("mousemove", { clientX: 135, clientY: 300, movementX: 10, movementY: -5 }); await app.pump();
  assert.equal(app.element("phone-screen").focusOptions.preventScroll, true);
  assert.equal(app.element("screen-stage").scrollOptions?.block, "center", "Entry must bring the whole picture into view before capturing input.");
  app.input("mousedown", { clientX: 202.5, clientY: 450, buttons: 1 });
  app.input("mouseup", { clientX: 202.5, clientY: 450, buttons: 0 }); await app.pump();
  assert.deepEqual(app.reports.map(({ dx, dy, buttons }) => [dx, dy, buttons]), [[40, -20, 0], [0, 0, 1], [0, 0, 0]]);
  assert.deepEqual(app.reports[0], { dx: 40, dy: -20, buttons: 0, wheel: 0 });
  assert.equal(app.element("phone-screen").style.cursor, "none");
  assert.equal(app.lockRequests, 1);
  assert.equal(app.calls.filter(({ name }) => name === "android_screenshot").length, 1);
  assert.equal(app.requests.filter(({ url, method }) => url === "/remote/lease" && method === "POST").length, 1);
  await app.close();
});

test("a focused live picture accepts Enter or Space without sending the activation key to the phone", async () => {
  for (const code of ["Enter", "Space"]) {
    const app = fixture(); await flush(); app.frame(); await flush();
    app.element("phone-screen").focus({ preventScroll: true });
    app.input("keydown", { code, repeat: false }); await flush();
    assert.equal(app.remoteActive, true, `${code} must use the same remote entry as a picture click`);
    assert.equal(app.lockRequests, 1);
    app.input("keydown", { code, repeat: true });
    app.input("keyup", { code }); await app.pump();
    assert.equal(app.calls.filter(({ name }) => name === "android_key_report").length, 0,
      "The key used to enter remote control must remain on the computer.");
    app.input("keydown", { code, repeat: false }); app.input("keyup", { code }); await app.pump();
    assert.deepEqual(app.calls.filter(({ name }) => name === "android_key_report").map(({ args }) => args.keycode),
      [code === "Enter" ? 0x28 : 0x2c, 0]);
    app.escape(); await flush(); assert.equal(app.remoteActive, false); await app.close();
  }
});

test("keyboard remote entry requires focused fresh picture and does not steal toolbar keys", async () => {
  const app = fixture(); await flush();
  app.element("phone-screen").focus(); app.input("keydown", { code: "Enter", repeat: false }); await flush();
  assert.equal(app.calls.filter(({ name }) => name === "android_hid_arm").length, 0);
  app.frame(); await flush(); app.element("typing-input").focus();
  app.input("keydown", { code: "Space", repeat: false }); await flush();
  assert.equal(app.calls.filter(({ name }) => name === "android_hid_arm").length, 0);
  assert.equal(app.remoteActive, false); await app.close();
});

test("a LAN page displays the advertised access address and derives its realtime socket from that origin", async () => {
  const url = "http://192.168.100.160:8790/";
  const app = fixture(undefined, { locationHref: url, operatorUrl: url }); await app.ready();
  assert.equal(app.element("access-url").textContent, url);
  assert.equal(app.element("access-url").href, url);
  assert.equal(app.requests.find(({ url, method }) => url === "/remote/socket" && method === "UPGRADE").socket.url,
    "ws://192.168.100.160:8790/remote/socket");
  assert.ok(app.requests.some(({ url }) => url === "/screen/stream"));
  assert.ok(app.requests.some(({ url }) => url === "/mcp"));
  assert.equal(app.remoteActive, true);
  await app.close();
});

test("a physical stop overrides BLE readiness and directs unlocking only to the controller menu", async () => {
  const app = fixture(undefined, { locked: true }); await flush(); app.frame(); await flush();
  assert.equal(app.element("status-ready").textContent, "已紧急停止");
  assert.equal(app.element("status-ready").dataset.locked, "true");
  assert.equal(app.element("status-ready").dataset.active, "false");
  app.click("phone-screen"); await flush();
  assert.equal(app.remoteActive, false);
  assert.match(app.element("error-message").textContent, /选择“取消急停”并确认/u);
  assert.equal(app.calls.some(({ name }) => name === "android_hid_arm"), false);
  await app.close();
});

test("relative control needs no coordinate calibration, homing or known pointer", async () => {
  const app = fixture(undefined, { calibrated: false });
  app.element("scale-x").value = "1.25"; app.element("scale-y").value = "1.5";
  await app.ready(); await app.align();
  const calibrations = app.calls.filter(({ name }) => name === "android_calibrate_pointer");
  assert.equal(calibrations.length, 0);
  assert.equal(app.calls.filter(({ name }) => name === "android_pointer_home").length, 0);
  app.input("mousemove", { clientX: 150, clientY: 320 }); await app.pump();
  assert.equal(app.calls.filter(({ name }) => name === "android_calibrate_pointer").length, 0);
  await app.close();
});

test("relative movement uses contain picture scale even when the pointer is outside its visible pixels", async () => {
  const app = fixture(undefined, { skipEntry: true }); await app.ready();
  app.setBounds({ width: 300, right: 300 });
  app.setStyle({ objectFit: "contain", objectPosition: "50% 50%" });
  app.input("mousemove", { clientX: 10, clientY: 300 }); await app.pump();
  assert.equal(app.reports.length, 0);
  app.input("mousemove", { clientX: 15, clientY: 0 }); await app.pump();
  app.input("mousemove", { clientX: 150, clientY: 300 }); await app.pump();
  assert.deepEqual(app.reports.map(({ dx, dy }) => [dx, dy]), [[4, 4], [4, 4]]);
  await app.close();
});

test("cover picture scaling retains fractional relative counts across frames", async () => {
  const app = fixture(undefined, { skipEntry: true }); await app.ready();
  app.setBounds({ left: 100, top: 50, width: 300, height: 600, right: 400, bottom: 650 });
  app.setStyle({ objectFit: "cover", objectPosition: "50% 50%" });
  app.input("mousemove", { clientX: 250, clientY: 50, movementX: 0, movementY: 0 }); await app.pump();
  app.input("mousemove", { clientX: 250, clientY: 50 }); await app.pump();
  assert.deepEqual(app.reports.map(({ dx, dy }) => [dx, dy]), [[3, 3]]);
  app.setStyle({ objectPosition: "0% 0%" });
  app.input("mousemove", { clientX: 100, clientY: 50 }); await app.pump();
  assert.deepEqual([app.reports[1].dx, app.reports[1].dy], [4, 4]);
  await app.close();
});

test("relative motion sums while down/up, wheel and keyboard remain ordered barriers", async () => {
  const app = fixture(); await app.ready();
  const delayed = app.blockInputResponse();
  app.input("mousemove", { clientX: 27, clientY: 120 }); app.animationFrame(); await flush();
  app.input("mousemove", { clientX: 54, clientY: 120 });
  app.input("mousemove", { clientX: 81, clientY: 120 });
  app.input("mousedown", { clientX: 81, clientY: 120, buttons: 1 });
  app.input("mousemove", { clientX: 100, clientY: 120 });
  app.input("mousemove", { clientX: 135, clientY: 120 });
  app.input("keydown", { code: "KeyA", repeat: false });
  app.input("mouseup", { clientX: 135, clientY: 120, buttons: 0 });
  app.input("wheel", { clientX: 135, clientY: 120, deltaY: 100 });
  app.input("keyup", { code: "KeyA", repeat: false });
  delayed.resolve(); await app.pump();
  const reports = app.calls.filter(({ name }) => ["android_mouse_move", "android_key_report"].includes(name));
  assert.deepEqual(reports.map(({ name, args }) => name === "android_mouse_move" ? [args.dx, args.buttons, args.wheel] : ["key", args.keycode]),
    [[4, 0, 0], [8, 0, 0], [0, 1, 0], [8, 1, 0], ["key", 4], [0, 0, 0], [0, 0, -1], ["key", 0]]);
  assert.deepEqual(app.held, { key: 0, modifier: 0, buttons: 0 });
  await app.close();
});

test("rAF batches hover layout reads and splits summed relative motion into bounded HID reports", async () => {
  const app = fixture(); await app.ready();
  const initialReads = app.layoutReads;
  const delayed = app.blockInputResponse();
  app.input("mousemove", { clientX: 1, clientY: 120 }); app.animationFrame(); await flush();
  for (let x = 2; x <= 250; x++) app.input("mousemove", { clientX: x, clientY: 120 });
      assert.ok(app.reports.length >= 1);
  delayed.resolve(); await app.pump();
  assert.equal(app.reports.length, 9);
  assert.equal(app.reports.reduce((total, report) => total + report.dx, 0), 1000);
  assert.ok(app.reports.every(({ dx, dy }) => Math.abs(dx) <= 127 && Math.abs(dy) <= 127));
  assert.equal(app.layoutReads - initialReads, 2);
  assert.equal(app.hasTimer(20), false);
  await app.close();
});

test("a high-DPI swipe before one animation frame stays connected with bounded relative reports", async () => {
  const app = fixture(); await app.ready();
  for (let index = 0; index < 100; index++) app.input("mousemove", { movementX: 100, movementY: -50 });
  await app.pump();
  assert.equal(app.remoteActive, true);
  assert.equal(app.calls.some(({ name }) => name === "android_hid_pause"), false);
  assert.ok(app.reports.length > 0 && app.reports.length <= 33);
  assert.ok(app.reports.every(({ dx, dy }) => Number.isInteger(dx) && Number.isInteger(dy) && dx >= 0 && dy <= 0 && Math.abs(dx) <= 127 && Math.abs(dy) <= 127));
  await app.close();
});

test("a swipe enlarged by the picture scale coalesces instead of triggering emergency stop", async () => {
  const app = fixture(); await app.ready();
  app.input("mousemove", { movementX: 1100, movementY: 0 }); await app.pump();
  assert.equal(app.remoteActive, true);
  assert.equal(app.calls.some(({ name }) => name === "android_hid_pause"), false);
  assert.ok(app.reports.length > 0 && app.reports.length <= 33);
  await app.close();
});

test("rapid swipes behind four blocked ACKs stay bounded and retain mouse/key release edges", async () => {
  const app = fixture(); await app.ready();
  const held = app.blockAllInputs();
  app.input("mousemove", { movementX: 511, movementY: 0 }); app.animationFrame(); await flush();
  assert.equal(app.reports.length, 4);
  for (let index = 0; index < 20; index++) {
    app.input("mousemove", { movementX: 300, movementY: 0 }); app.animationFrame(); await flush();
  }
  app.input("mousedown", { buttons: 1 }); app.input("keydown", { code: "KeyA", repeat: false });
  app.input("mouseup", { buttons: 0 }); app.input("keyup", { code: "KeyA", repeat: false });
  await flush();
  assert.equal(app.remoteActive, true);
  assert.equal(app.reports.length, 4, "full transport window must apply backpressure before writing another report");
  held.resolve(); await app.pump();
  assert.equal(app.remoteActive, true);
  assert.equal(app.calls.some(({ name }) => name === "android_hid_pause"), false);
  assert.ok(app.reports.length <= 40, "obsolete hover cannot create an unbounded replay backlog");
  const edges = app.calls.filter(({ name, args }) => name === "android_key_report" || (name === "android_mouse_move" && args.dx === 0 && args.dy === 0));
  assert.deepEqual(edges.map(({ name, args }) => name === "android_key_report" ? ["key", args.keycode] : ["button", args.buttons]), [["button", 1], ["key", 4], ["button", 0], ["key", 0]]);
  assert.deepEqual(app.held, { key: 0, modifier: 0, buttons: 0 });
  await app.close();
});

test("relative input immediately accepts clicks at the phone cursor and renews its independent lease", async () => {
  const app = fixture(undefined, { pointerKnown: false }); await app.ready();
  const delayed = app.blockInputResponse();
  app.input("mousemove", { clientX: 135, clientY: 300 }); app.animationFrame(); await flush();
  assert.doesNotMatch(app.element("coordinate-info").textContent, /正在对齐鼠标/u);
  assert.equal(app.hasTimer(1500), true);
  assert.equal(app.fireTimer(250), true); await flush();
  assert.equal(app.requests.filter(({ url, method }) => url === "/remote/lease" && method === "POST").length, 1);
  assert.equal(app.requests.filter(({ message }) => message?.type === "ping").length, 1);
  assert.equal(app.requests.filter(({ url }) => url === "/remote/input").length, 0);
  app.input("mousedown", { clientX: 200, clientY: 400, buttons: 1 });
  app.input("mouseup", { clientX: 200, clientY: 400, buttons: 0 });
  app.input("keydown", { code: "KeyA", repeat: false });
  app.input("mousemove", { clientX: 210, clientY: 420 });
  assert.equal(app.reports.length, 3, "click edges are submitted without waiting for the first motion ACK");
  delayed.resolve(); await app.pump();
  assert.ok(app.reports.some(({ buttons }) => buttons === 1));
  assert.equal(app.calls.filter(({ name }) => name === "android_key_report").length, 1);
  assert.doesNotMatch(app.element("coordinate-info").textContent, /正在对齐/u);
  app.input("mousedown", { clientX: 210, clientY: 420, buttons: 1 });
  app.input("mouseup", { clientX: 210, clientY: 420, buttons: 0 }); await app.pump();
  assert.deepEqual(app.reports.slice(-2).map(({ buttons }) => buttons), [1, 0]);
  await app.close();
});

test("key-down and key-up retain a final zero key and modifier report", async () => {
  const app = fixture(); await app.ready(); await app.align();
  app.input("keydown", { code: "KeyA", repeat: false, shiftKey: true });
  app.input("keyup", { code: "KeyA", repeat: false, shiftKey: true });
  app.input("keyup", { code: "ShiftLeft", repeat: false, shiftKey: false }); await app.pump();
  assert.deepEqual(app.calls.filter(({ name }) => name === "android_key_report").map(({ args }) => [args.modifier, args.keycode]), [[2, 4], [2, 0], [0, 0]]);
  assert.deepEqual(app.held, { key: 0, modifier: 0, buttons: 0 });
  await app.close();
});

test("leaving the image and crossing page coordinates keeps relative movement and held input active", async () => {
  const app = fixture(); await app.ready(); await app.align();
  app.input("mousedown", { clientX: 135, clientY: 300, buttons: 1 });
  app.input("keydown", { code: "KeyA", repeat: false }); await app.pump();
  assert.deepEqual(app.held, { key: 4, modifier: 0, buttons: 1 });
  app.input("mousemove", { clientX: 271, clientY: 300 }); await app.pump();
  app.imageEvent("mouseleave"); app.element("typing-input").focus();
  app.input("mousemove", { clientX: -1000, clientY: 5000, movementX: 5, movementY: -2 }); await app.pump();
  assert.deepEqual(app.held, { key: 4, modifier: 0, buttons: 1 });
  assert.deepEqual([app.reports.at(-1).dx, app.reports.at(-1).dy, app.reports.at(-1).buttons], [20, -8, 1]);
  assert.equal(app.remoteActive, true);
  assert.equal(app.requests.some(({ url, method }) => url === "/remote/lease" && method === "DELETE"), false);
  await app.close();
});

test("window blur, hidden page, offline and Escape still release held input internally", async () => {
  for (const reason of ["blur", "offline", "hidden", "pagehide", "Escape"]) {
    const app = fixture(); await app.ready(); await app.align();
    app.input("mousedown", { clientX: 135, clientY: 300, buttons: 1 });
    app.input("keydown", { code: "KeyA", repeat: false }); await app.pump();
    if (reason === "blur" || reason === "pagehide") app.window(reason);
    else if (reason === "offline") app.window("offline");
    else if (reason === "hidden") app.hide();
    else app.input("keydown", { code: "Escape", repeat: false });
    await flush();
    assert.equal(app.calls.at(-1).name, "android_hid_pause", reason);
    assert.deepEqual(app.held, { key: 0, modifier: 0, buttons: 0 }, reason);
    assert.equal(app.remoteActive, false, reason);
    await app.close();
  }
});

test("a read-only observer hiding, unloading or losing its network cannot pause another controller", async () => {
  for (const reason of ["hidden", "pagehide", "offline"]) {
    const app = fixture(undefined, { externalController: true }); await flush(); app.frame(); await flush();
    assert.equal(app.calls.some(({ name }) => name === "android_hid_arm"), false);
    if (reason === "hidden") app.hide(); else app.window(reason);
    await flush();
    assert.equal(app.calls.filter(({ name }) => name === "android_hid_pause").length, 0, reason);
    assert.deepEqual(app.held, { key: 4, modifier: 0, buttons: 1 }, reason);
    await app.close();
  }
});

test("closing or reconnecting a read-only MCP observer does not claim input for cleanup", async () => {
  for (const reason of ["disconnect", "lost-mcp", "reconnect"]) {
    const app = fixture(undefined, { externalController: true }); await flush(); app.frame(); await flush();
    if (reason === "disconnect") app.click("disconnect-button");
    else if (reason === "reconnect") app.click("connect-button");
    else app.loseMcp();
    await flush();
    assert.equal(app.calls.filter(({ name }) => name === "android_hid_pause").length, 0, reason);
    assert.deepEqual(app.held, { key: 4, modifier: 0, buttons: 1 }, reason);
    await app.close();
  }
});

test("a read-only observer's broken or refreshed picture does not stop other input", async () => {
  for (const reason of ["video-error", "refresh"]) {
    const app = fixture(undefined, { externalController: true }); await flush(); app.frame(); await flush();
    if (reason === "video-error") app.videoError(); else app.click("capture-button");
    await flush();
    assert.equal(app.calls.filter(({ name }) => name === "android_hid_pause").length, 0, reason);
    assert.deepEqual(app.held, { key: 4, modifier: 0, buttons: 1 }, reason);
    await app.close();
  }
});

test("a former operator observing a new controller after Escape cannot pause it on hide", async () => {
  const app = fixture(); await app.ready(); app.escape(); await flush();
  const pauses = app.calls.filter(({ name }) => name === "android_hid_pause").length;
  app.externalController(); assert.equal(app.fireTimer(1000), true); await flush();
  app.hide(); await flush();
  assert.equal(app.calls.filter(({ name }) => name === "android_hid_pause").length, pauses);
  assert.deepEqual(app.held, { key: 4, modifier: 0, buttons: 1 });
  await app.close();
});

test("pausing closes the input socket and ignores its late acknowledgement", async () => {
  const app = fixture(undefined, { pointerKnown: false }); await app.ready();
  const delayed = app.blockInputResponse(); app.input("mousemove", { clientX: 135, clientY: 300 }); app.animationFrame(); await flush();
  const request = app.requests.findLast(({ message }) => message?.type === "report");
  assert.equal(request.socket.readyState, 1);
  app.escape(); await flush();
  assert.equal(request.socket.readyState, 3);
  delayed.resolve(); await flush();
  assert.deepEqual(app.held, { key: 0, modifier: 0, buttons: 0 });
  assert.equal(app.remoteActive, false);
  assert.doesNotMatch(app.element("coordinate-info").textContent, /正在对齐/u);
  await app.close();
});

test("queued click edges cannot execute after a pause during a blocked pointer movement", async () => {
  const app = fixture(); await app.ready();
  const delayed = app.blockInputResponse(); app.input("mousemove", { clientX: 135, clientY: 300 }); app.animationFrame(); await flush();
  app.input("mousedown", { clientX: 150, clientY: 320, buttons: 1 });
  app.input("mouseup", { clientX: 150, clientY: 320, buttons: 0 });
  const submittedBeforeEscape = app.reports.length;
  app.escape(); await flush(); delayed.resolve(); await app.pump();
  assert.equal(app.reports.length, submittedBeforeEscape, "Escape cannot submit any additional reports");
  assert.equal(app.reports[0].buttons, 0);
  assert.deepEqual(app.held, { key: 0, modifier: 0, buttons: 0 });
  await app.close();
});

test("an overflowing click-edge queue pauses instead of dropping a held-button release", async () => {
  const app = fixture(); await app.ready();
  const delayed = app.blockInputResponse(); app.input("mousemove", { clientX: 135, clientY: 300 }); app.animationFrame(); await flush();
  for (let index = 0; index < 38; index++) app.input(index % 2 ? "mouseup" : "mousedown", { clientX: 150, clientY: 320, buttons: index % 2 ? 0 : 1 });
  await flush(); delayed.resolve(); await app.pump();
  assert.equal(app.reports.length, 4, "only the bounded four-report window can have been submitted before the stop");
  assert.deepEqual(app.held, { key: 0, modifier: 0, buttons: 0 });
  assert.equal(app.remoteActive, false);
  await app.close();
});

test("late ARM or lease completion after pause cannot start or restore remote input", async () => {
  for (const kind of ["arm", "lease"]) {
    const app = fixture(); await flush(); app.frame(); await flush();
    const delayed = kind === "arm" ? app.blockArmResponse() : app.blockLeaseResponse();
    app.click("phone-screen"); await flush(); app.escape(); await flush();
    delayed.resolve(); await flush();
    app.input("mousemove", { clientX: 135, clientY: 300 }); await app.pump();
    assert.equal(app.reports.length, 0, kind);
    assert.equal(app.remoteActive, false, kind);
    await app.close();
  }
});

test("video loss while decoding cannot revive the old image or re-enable control", async () => {
  const app = fixture(); await app.ready(); await app.align();
  app.input("mousedown", { clientX: 135, clientY: 300, buttons: 1 }); await app.pump();
  const previous = app.element("phone-screen").src;
  const delayed = app.blockDecode(); app.frame("old-inflight"); await flush();
  app.videoError(); await flush(); delayed.resolve(); await flush();
  assert.equal(app.element("phone-screen").src, previous);
  assert.equal(app.element("screen-stage").dataset.stale, "true");
  assert.deepEqual(app.held, { key: 0, modifier: 0, buttons: 0 });
  app.frame("recovered"); await flush();
  assert.equal(app.remoteActive, false);
  app.input("mousemove", { clientX: 135, clientY: 300 }); await app.pump();
  assert.equal(app.calls.filter(({ name }) => name === "android_hid_arm").length, 1);
  assert.equal(app.reports.length, 2);
  await app.close();
});

test("a changed phone geometry pauses control before any new coordinate can be sent", async () => {
  const app = fixture(); await app.ready(); await app.align();
  app.frame("rotated", { width: 2400, height: 1080, rotation: 1 }); await flush();
  const count = app.reports.length;
  app.input("mousemove", { clientX: 135, clientY: 300 }); await app.pump();
  assert.equal(app.reports.length, count);
  assert.equal(app.remoteActive, false);
  await app.close();
});

test("preview quality changes retain physical movement scale and do not exit active remote control", async () => {
  const app = fixture(); await app.ready();
  const round = app.leaseRound;
  const pauses = app.calls.filter(({ name }) => name === "android_hid_pause").length;
  for (const [id, width, height] of [["small", 360, 800], ["standard", 720, 1600], ["original", 1080, 2400]]) {
    app.frame(id, { width, height, deviceWidth: 1080, deviceHeight: 2400 }); await flush();
    assert.equal(app.remoteActive, true, id);
    assert.equal(app.leaseRound, round, id);
    assert.match(app.element("frame-info").textContent, new RegExp(`${width} × ${height}`, "u"));
    app.input("mousemove", { movementX: 10, movementY: -5 }); await app.pump();
    assert.deepEqual([app.reports.at(-1).dx, app.reports.at(-1).dy], [40, -20], id);
  }
  app.frame("full-resolution-snapshot", { width: 1080, height: 2400 }); await flush();
  assert.equal(app.remoteActive, true, "original-resolution frames share the same physical geometry");
  assert.equal(app.calls.filter(({ name }) => name === "android_hid_pause").length, pauses);
  assert.equal(app.element("screen-profile").disabled, true);
  assert.match(app.element("screen-profile-state").textContent, /Esc/u);
  await app.close();
});

test("the four quality choices read the phone setting and use independent HTTP without touching input ownership", async () => {
  const app = fixture(undefined, { profile: "fast", externalController: true }); await flush();
  assert.equal(app.element("screen-profile").value, "fast");
  assert.deepEqual(app.held, { key: 4, modifier: 0, buttons: 1 });
  const inputCalls = app.calls.filter(({ name }) => /android_hid_arm|android_hid_pause|android_calibrate_pointer/u.test(name)).length;
  for (const profile of ["turbo", "fast", "standard", "original"]) {
    app.change("screen-profile", profile); await flush();
    assert.equal(app.element("screen-profile").value, profile);
    assert.match(app.element("screen-profile-state").textContent, /已切换/u);
  }
  assert.deepEqual(app.requests.filter(({ url, method }) => url === "/screen/profile" && method === "POST").map(({ body }) => JSON.parse(body)),
    ["turbo", "fast", "standard", "original"].map((profile) => ({ profile })));
  assert.equal(app.calls.filter(({ name }) => /android_hid_arm|android_hid_pause|android_calibrate_pointer/u.test(name)).length, inputCalls);
  assert.deepEqual(app.held, { key: 4, modifier: 0, buttons: 1 });
  await app.close();
});

test("live preview profiles follow external changes and clear obsolete notices without touching control", async () => {
  const app = fixture(undefined, { profile: "turbo", externalController: true }); await flush();
  const inputCalls = app.calls.length, requests = app.requests.length;
  app.frame("external-standard", { width: 720, height: 1600, deviceWidth: 1080, deviceHeight: 2400, previewProfile: "standard" }); await flush();
  assert.equal(app.element("screen-profile").value, "standard");
  assert.match(app.element("screen-profile-state").textContent, /标准画质/u);
  assert.equal(app.requests.length, requests, "observing a profile must make no request");
  assert.equal(app.calls.length, inputCalls);
  assert.deepEqual(app.held, { key: 4, modifier: 0, buttons: 1 });
  app.change("screen-profile", "turbo"); await flush();
  assert.match(app.element("screen-profile-state").textContent, /已切换为极速/u);
  const afterChange = app.requests.length;
  app.frame("external-fast", { previewProfile: "fast" }); await flush();
  assert.equal(app.element("screen-profile").value, "fast");
  assert.match(app.element("screen-profile-state").textContent, /快速画质/u);
  assert.doesNotMatch(app.element("screen-profile-state").textContent, /极速/u);
  app.frame("legacy-without-profile"); await flush();
  app.frame("unsupported-profile", { previewProfile: "unknown" }); await flush();
  assert.equal(app.element("screen-profile").value, "fast");
  assert.equal(app.requests.length, afterChange);
  assert.equal(app.calls.length, inputCalls);
  assert.deepEqual(app.held, { key: 4, modifier: 0, buttons: 1 });
  await app.close();
});

test("live preview profiles received during a local change cannot overwrite its desired value after late decode", async () => {
  const app = fixture(undefined, { profile: "turbo" }); await flush();
  const pending = app.blockProfilePost(); app.change("screen-profile", "original"); await flush();
  const decode = app.blockDecode(); app.frame("old-during-change", { previewProfile: "turbo" }); await flush();
  assert.equal(app.element("screen-profile").value, "original");
  assert.equal(app.element("screen-profile-state").dataset.busy, "true");
  pending.resolve(); await flush();
  assert.equal(app.element("screen-profile-state").dataset.busy, "false");
  decode.resolve(); await flush();
  assert.equal(app.element("screen-profile").value, "original", "a frame received while busy remains obsolete after the ACK");
  app.frame("new-original", { previewProfile: "original" }); await flush();
  assert.equal(app.element("screen-profile").value, "original");
  assert.equal(app.requests.filter(({ url, method }) => url === "/screen/profile" && method === "POST").length, 1);
  await app.close();
});

test("live preview profiles supersede a delayed initial phone-setting response", async () => {
  const app = fixture(undefined, { profile: "turbo" });
  const initial = app.blockProfileGet(); await flush();
  app.frame("current-standard", { previewProfile: "standard" }); await flush();
  assert.equal(app.element("screen-profile").value, "standard");
  initial.resolve(); await flush();
  assert.equal(app.element("screen-profile").value, "standard");
  assert.match(app.element("screen-profile-state").textContent, /标准画质/u);
  await app.close();
});

test("live preview profiles decoding across a newer local selection cannot restore an older setting", async () => {
  const app = fixture(undefined, { profile: "turbo" }); await flush();
  const decode = app.blockDecode(); app.frame("old-before-change", { previewProfile: "turbo" }); await flush();
  app.change("screen-profile", "fast"); await flush();
  decode.resolve(); await flush();
  assert.equal(app.element("screen-profile").value, "fast");
  assert.match(app.element("screen-profile-state").textContent, /快速画质/u);
  app.frame("new-fast", { previewProfile: "fast" }); await flush();
  assert.equal(app.element("screen-profile").value, "fast");
  await app.close();
});

test("rapid quality selections serialize requests and retain only the newest pending choice", async () => {
  const app = fixture(); await flush();
  const first = app.blockProfilePost();
  app.change("screen-profile", "turbo"); await flush();
  assert.match(app.element("screen-profile-state").textContent, /正在切换/u);
  app.change("screen-profile", "fast"); app.change("screen-profile", "original"); await flush();
  assert.equal(app.requests.filter(({ url, method }) => url === "/screen/profile" && method === "POST").length, 1);
  assert.equal(app.element("screen-profile").value, "original");
  const newest = app.blockProfilePost(); first.resolve(); await flush();
  assert.equal(app.element("screen-profile").value, "original", "the obsolete turbo reply cannot restore its selection");
  assert.equal(app.element("screen-profile-state").dataset.busy, "true");
  newest.resolve(); await flush();
  assert.deepEqual(app.requests.filter(({ url, method }) => url === "/screen/profile" && method === "POST").map(({ body }) => JSON.parse(body).profile), ["turbo", "original"]);
  assert.equal(app.element("screen-profile").value, "original");
  assert.equal(app.element("screen-profile-state").dataset.busy, "false");
  await app.close();
});

test("late initial quality reads cannot overwrite a newer applied selection", async () => {
  const app = fixture(undefined, { profile: "original" });
  const initial = app.blockProfileGet(); await flush();
  app.change("screen-profile", "fast"); await flush();
  assert.equal(app.element("screen-profile").value, "fast");
  initial.resolve(); await flush();
  assert.equal(app.element("screen-profile").value, "fast");
  await app.close();
});

test("failed quality changes restore the phone's confirmed setting without pausing existing input", async () => {
  const app = fixture(undefined, { profile: "fast", externalController: true }); await flush();
  const failed = app.blockProfilePost();
  app.change("screen-profile", "turbo"); await flush();
  failed.resolve({ status: 502, error: "请更新手机投屏 App，旧版不支持切换画质。" }); await flush();
  assert.equal(app.element("screen-profile").value, "fast");
  assert.equal(app.element("screen-profile-state").dataset.error, "true");
  assert.match(app.element("screen-profile-state").textContent, /切换失败/u);
  assert.match(app.element("screen-profile-state").textContent, /请更新手机投屏 App/u);
  assert.match(app.element("screen-profile-state").textContent, /已恢复快速画质/u);
  assert.equal(app.calls.some(({ name }) => name === "android_hid_pause"), false);
  assert.deepEqual(app.held, { key: 4, modifier: 0, buttons: 1 });
  await app.close();
});

test("profile errors display at most 160 characters as plain text and reject oversized or non-JSON bodies", async () => {
  const upgrade = "请更新手机投屏 App <script>ignored()</script> " + "升级说明".repeat(100);
  for (const [outcome, expected] of [
    [{ status: 502, error: upgrade }, upgrade.slice(0, 160)],
    [{ status: 502, error: "超长错误".repeat(2000) }, "画质请求失败（HTTP 502）"],
    [{ status: 502, body: "<h1>HTML error</h1>", contentType: "text/html" }, "画质请求失败（HTTP 502）"],
  ]) {
    const app = fixture(); await flush();
    const failed = app.blockProfilePost(); app.change("screen-profile", "turbo"); await flush();
    failed.resolve(outcome); await flush();
    assert.equal(app.element("screen-profile-state").textContent, `切换失败：${expected}。已恢复标准画质`);
    assert.equal(app.element("screen-profile").value, "standard");
    assert.equal(app.calls.some(({ name }) => name === "android_hid_pause" || name === "android_hid_arm"), false);
    await app.close();
  }
});

test("an obsolete failed profile request cannot display its upgrade error after a newer choice", async () => {
  const app = fixture(); await flush();
  const obsolete = app.blockProfilePost(); app.change("screen-profile", "turbo"); await flush();
  app.change("screen-profile", "fast"); await flush();
  obsolete.resolve({ status: 502, error: "请更新手机投屏 App" }); await flush();
  assert.equal(app.element("screen-profile").value, "fast");
  assert.equal(app.element("screen-profile-state").dataset.error, "false");
  assert.equal(app.element("screen-profile-state").textContent.includes("请更新"), false);
  await app.close();
});

test("an upgrade error from a disconnected profile request cannot replace the reconnected state", async () => {
  const app = fixture(); await flush();
  const obsolete = app.blockProfilePost(); app.change("screen-profile", "turbo"); await flush();
  app.click("disconnect-button"); await flush(); app.click("connect-button"); await flush();
  const message = app.element("screen-profile-state").textContent;
  obsolete.resolve({ status: 502, error: "请更新手机投屏 App" }); await flush();
  assert.equal(app.element("screen-profile-state").textContent, message);
  assert.equal(app.element("screen-profile-state").dataset.error, "false");
  assert.equal(app.element("screen-profile").value, "standard");
  await app.close();
});

test("a quality reply from a disconnected context cannot overwrite the reconnected selector or image", async () => {
  const app = fixture(); await flush(); app.frame("before-quality"); await flush();
  const late = app.blockProfilePost(); app.change("screen-profile", "turbo"); await flush();
  app.click("disconnect-button"); await flush();
  assert.equal(app.element("screen-profile").disabled, true);
  app.click("connect-button"); await flush(); app.frame("after-reconnect"); await flush();
  const image = app.element("phone-screen").src;
  assert.equal(app.element("screen-profile").value, "standard");
  late.resolve(); await flush();
  assert.equal(app.element("screen-profile").value, "standard");
  assert.equal(app.element("phone-screen").src, image);
  assert.equal(app.remoteActive, false);
  await app.close();
});

test("SSE browser queue age counts toward freshness and cannot enable control", async () => {
  const app = fixture(); await flush();
  app.frame("delayed-in-browser", { sentAt: Date.now() - 3500, frameAgeMs: 100 }); await flush();
  assert.equal(app.element("screen-stage").dataset.stale, "true");
  assert.equal(app.remoteActive, false);
  assert.equal(app.element("phone-screen").hidden, true);
  await app.close();
});

test("polling and relative-only runtimes cannot enable direct pointer input", async () => {
  for (const version of [1, 2, 3, 4, 5]) {
    const app = fixture(version); await flush();
    assert.match(app.element("error-detail").textContent, /操作台需要更新/u);
    assert.match(app.element("error-message").textContent, /重新打开设备操作台\.exe/u);
    assert.equal(app.remoteActive, false);
    assert.equal(app.calls.length, 0);
    await app.close();
  }
});

test("a poll rejection from before Escape cannot display an error or pause a second time", async () => {
  const app = fixture(); await app.ready(); await app.align();
  const delayed = app.blockStatusResponse(); assert.equal(app.fireTimer(1000), true); await flush();
  app.input("keydown", { code: "Escape", repeat: false }); await flush();
  const pauses = app.calls.filter(({ name }) => name === "android_hid_pause").length;
  delayed.reject(new Error("HID operation cancelled")); await flush();
  assert.equal(app.element("error-box").hidden, true);
  assert.equal(app.calls.filter(({ name }) => name === "android_hid_pause").length, pauses);
  await app.close();
});

test("a poll rejection from before a new ARM revision cannot pause that explicit control round", async () => {
  const app = fixture(); await flush(); app.frame(); await flush();
  const delayed = app.blockStatusResponse(); assert.equal(app.fireTimer(1000), true); await flush();
  app.click("phone-screen"); await flush();
  delayed.reject(new Error("Queued HID operation cancelled")); await flush();
  assert.equal(app.element("error-box").hidden, true);
  assert.equal(app.element("home-button").disabled, false);
  assert.equal(app.calls.filter(({ name }) => name === "android_hid_pause").length, 0);
  await app.close();
});

test("an old refresh STATUS rejection cannot pause a newer ARM revision", async () => {
  const app = fixture(); await app.ready(); app.escape(); await flush();
  const delayed = app.blockStatusResponse(); app.click("capture-button"); await flush();
  app.frame("refresh-frame"); await flush();
  app.click("phone-screen"); await flush();
  const pauses = app.calls.filter(({ name }) => name === "android_hid_pause").length;
  delayed.reject(new Error("Queued HID operation cancelled")); await flush();
  assert.equal(app.element("error-box").hidden, true);
  assert.equal(app.element("home-button").disabled, false);
  assert.equal(app.calls.filter(({ name }) => name === "android_hid_pause").length, pauses);
  await app.close();
});

test("same-round STATUS failures report the problem and only the current operator requests pause", async () => {
  for (const kind of ["poll", "refresh"]) {
    const app = fixture(); await app.ready(); await app.align();
    const delayed = app.blockStatusResponse();
    if (kind === "poll") assert.equal(app.fireTimer(1000), true);
    else { app.escape(); await flush(); app.click("capture-button"); }
    await flush();
    const pauses = app.calls.filter(({ name }) => name === "android_hid_pause").length;
    delayed.reject(new Error("HID operation cancelled")); await flush();
    assert.equal(app.element("error-box").hidden, false, kind);
    assert.equal(app.element("error-message").textContent, "远控已退出，点击画面即可重新进入。", kind);
    assert.equal(app.remoteActive, false, kind);
    assert.equal(app.calls.filter(({ name }) => name === "android_hid_pause").length, pauses + (kind === "poll" ? 1 : 0), kind);
    await app.close();
  }
});

test("first window entry ignores an outside-to-picture jump without swallowing its first click", async () => {
  const app = fixture(undefined, { skipEntry: true }); await app.ready();
  app.input("mousemove", { clientX: 135, clientY: 300, movementX: 8000, movementY: 6000 }); await app.pump();
  assert.equal(app.reports.length, 0);
  assert.equal(app.element("home-button").disabled, false);
  app.input("mousedown", { clientX: 135, clientY: 300, buttons: 1 });
  app.input("mouseup", { clientX: 135, clientY: 300, buttons: 0 }); await app.pump();
  assert.deepEqual(app.reports.map(({ dx, dy, buttons }) => [dx, dy, buttons]), [[0, 0, 1], [0, 0, 0]]);
  assert.equal(app.lockRequests, 1);
  app.input("mousemove", { clientX: 140, clientY: 300, movementX: 5, movementY: 0 }); await app.pump();
  assert.equal(app.reports.at(-1).dx, 20);
  await app.close();
});

test("synchronous ARM capture gates inputs until ARM completes and ignores the first capture warp", async () => {
  const app = fixture(undefined, { pointerLock: "success", skipEntry: true }); await flush(); app.frame(); await flush();
  const delayed = app.blockArmResponse(); app.click("phone-screen");
  assert.equal(app.locked, true); assert.equal(app.lockRequests, 1);
  await flush(); app.input("mousemove", { movementX: 25, movementY: 25 }); await app.pump();
  assert.equal(app.reports.length, 0);
  delayed.resolve(); await flush();
  assert.equal(app.element("phone-screen").style.cursor, "none");
  app.input("mousemove", { movementX: 8000, movementY: 6000 }); await app.pump();
  assert.equal(app.reports.length, 0);
  app.input("mousemove", { movementX: 5, movementY: -2 }); await app.pump();
  assert.deepEqual([app.reports.at(-1).dx, app.reports.at(-1).dy], [20, -8]);
  app.input("mousedown", { buttons: 1 }); app.input("mouseup", { buttons: 0 }); await app.pump();
  app.input("keydown", { code: "Escape", repeat: false }); await flush();
  assert.equal(app.locked, false);
  assert.equal(app.element("phone-screen").style.cursor, "");
  assert.deepEqual(app.held, { key: 0, modifier: 0, buttons: 0 });
  await app.close();
});

test("late capture success after pause exits immediately and cannot restart the phone", async () => {
  const app = fixture(undefined, { pointerLock: "deferred" }); await app.ready();
  app.escape(); await flush(); app.resolveLock(0); await flush();
  assert.equal(app.locked, false);
  assert.equal(app.element("phone-screen").style.cursor, "");
  app.input("mousemove", { movementX: 10, movementY: 10 }); await app.pump();
  assert.equal(app.reports.length, 0);
  await app.close();
});

test("leaving before the first animation frame does not exit, and the next document move controls the phone", async () => {
  const app = fixture(undefined, { skipEntry: true }); await app.ready();
  app.input("mousemove", { clientX: 135, clientY: 300, movementX: 50, movementY: 50 });
  app.imageEvent("mouseleave"); await flush(); app.animationFrame(); await app.pump();
  assert.equal(app.reports.length, 0);
  assert.equal(app.remoteActive, true);
  assert.equal(app.element("phone-screen").style.cursor, "none");
  app.input("mousemove", { clientX: 5000, clientY: 5000, movementX: 1, movementY: 1 }); await app.pump();
  assert.deepEqual([app.reports.at(-1).dx, app.reports.at(-1).dy], [4, 4]);
  await app.close();
});

test("Esc cancels pending ARM even when browser capture is unavailable", async () => {
  const app = fixture(); await flush(); app.frame(); await flush();
  const delayed = app.blockArmResponse(); app.click("phone-screen"); await flush();
  app.input("keydown", { code: "Escape", repeat: false }); await flush();
  delayed.resolve(); await flush();
  assert.equal(app.remoteActive, false);
  assert.equal(app.element("phone-screen").style.cursor, "");
  assert.equal(app.requests.filter(({ url, method }) => url === "/remote/lease" && method === "POST").length, 0);
  assert.equal(app.reports.length, 0);
  await app.close();
});

test("remote clicks are captured before page toolbar actions, and Escape restores the toolbar", async () => {
  const app = fixture(); await app.ready();
  assert.equal(app.element("home-button").disabled, false);
  const count = app.reports.length;
  app.click("home-button"); await app.pump();
  assert.equal(app.calls.filter(({ name }) => name === "android_home").length, 0);
  assert.deepEqual(app.reports.slice(count).map(({ buttons }) => buttons), [1, 0]);
  assert.equal(app.element("phone-screen").focusOptions.preventScroll, true);
  app.escape(); await flush();
  assert.equal(app.remoteActive, false);
  assert.equal(app.element("home-button").disabled, false);
  app.click("home-button"); await flush();
  assert.equal(app.calls.filter(({ name }) => name === "android_home").length, 1);
  assert.equal(app.remoteActive, false);
  await app.close();
});

test("the panel has no start, capture-mouse or pause controls and hides the cursor across the page", () => {
  assert.doesNotMatch(html, /id="(?:arm-button|pause-button|remote-button|control-hint|status-armed)"/u);
  assert.doesNotMatch(html, /开始控制|接管鼠标|暂停操作|移出画面/u);
  assert.match(html, /点击画面操作，Esc 退出/u);
  assert.match(html, /设备控制器连 Wi-Fi：用上下键选择设置，再按确认键进入 Wi-Fi 并输入密码/u);
  assert.match(html, /<title>设备操作台<\/title>/u);
  assert.doesNotMatch(html, /ESP|QDD|钱多多|安卓|Android|长按/u);
  assert.match(css, /color-scheme:\s*dark/u);
  assert.match(css, /--accent:\s*#d4380d/u);
  assert.match(css, /body\.remote-active, body\.remote-active \*\s*\{\s*cursor:\s*none\s*!important/u);
});

test("an older poll cannot schedule STATUS while an explicit exit is still releasing input", async () => {
  const app = fixture(); await app.ready();
  const oldStatus = app.blockStatusResponse(); assert.equal(app.fireTimer(1000), true); await flush();
  const stopping = app.blockPauseResponse(); app.escape(); await flush();
  oldStatus.resolve(); await flush();
  assert.equal(app.hasTimer(1000), false);
  const requests = app.calls.filter(({ name }) => name === "android_hid_status").length;
  assert.equal(app.fireTimer(1000), false);
  assert.equal(app.calls.filter(({ name }) => name === "android_hid_status").length, requests);
  stopping.resolve(); await flush();
  assert.equal(app.hasTimer(1000), true);
  await app.close();
});

test("a real same-round STATUS timeout remains visible until the user explicitly presses Escape", async () => {
  const app = fixture(); await app.ready();
  const status = app.blockStatusResponse(); assert.equal(app.fireTimer(1000), true); await flush();
  status.reject(new Error("ESP32 STATUS acknowledgement timed out; action was not retried.")); await flush();
  assert.equal(app.remoteActive, false);
  assert.equal(app.element("error-box").hidden, false);
  assert.match(app.element("error-detail").textContent, /STATUS acknowledgement timed out/u);
  const pauses = app.calls.filter(({ name }) => name === "android_hid_pause").length;
  app.escape(); await flush();
  assert.equal(app.element("error-box").hidden, true);
  assert.equal(app.element("activity").textContent, "远控已退出。");
  assert.equal(app.calls.filter(({ name }) => name === "android_hid_pause").length, pauses);
  await app.close();
});

test("a late renewal response from the previous remote round cannot overwrite a newly entered round", async () => {
  const app = fixture(); await app.ready();
  const previousRound = app.leaseRound;
  const oldRenewal = app.blockLeaseResponse();
  assert.equal(app.fireTimer(250), true); await flush();
  app.escape(); await flush();
  app.click("phone-screen"); await flush();
  const newRound = app.leaseRound;
  assert.ok(previousRound && newRound && previousRound !== newRound);
  assert.equal(app.remoteActive, true);
  oldRenewal.resolve(); await flush();
  assert.equal(app.fireTimer(250), true); await flush();
  assert.equal(app.remoteActive, true);
  assert.equal(app.element("error-box").hidden, true);
  const latestRenewal = app.requests.findLast(({ message }) => message?.type === "ping");
  assert.equal(latestRenewal.round, newRound);
  app.input("mousemove", { movementX: 0, movementY: 0 }); await app.pump();
  app.input("mousemove", { movementX: 2, movementY: 0 }); await app.pump();
  const input = app.requests.findLast(({ message }) => message?.type === "report");
  assert.equal(input.round, newRound);
  await app.close();
});

test("Escape sends STOP only on the socket bound to the active remote round", async () => {
  const app = fixture(); await app.ready();
  const firstRound = app.leaseRound;
  app.escape(); await flush();
  const firstStop = app.requests.findLast(({ message }) => message?.type === "stop");
  assert.equal(firstStop.round, firstRound);
  app.click("phone-screen"); await flush();
  const secondRound = app.leaseRound;
  assert.notEqual(secondRound, firstRound);
  app.escape(); await flush();
  const secondStop = app.requests.findLast(({ message }) => message?.type === "stop");
  assert.equal(secondStop.round, secondRound);
  assert.equal(app.remoteActive, false);
  assert.deepEqual(app.held, { key: 0, modifier: 0, buttons: 0 });
  await app.close();
});

test("four blocked report ACKs do not occupy HTTP requests or block the lease ping", async () => {
  const app = fixture(); await app.ready();
  const pending = app.blockAllInputs();
  app.input("mousemove", { movementX: 2, movementY: 0 }); app.animationFrame();
  app.input("mousedown", { buttons: 1 }); app.input("keydown", { code: "KeyA", repeat: false }); app.input("mouseup", { buttons: 0 });
  await flush();
  assert.equal(app.requests.filter(({ message }) => message?.type === "report").length, 4);
  assert.equal(app.fireTimer(250), true); await flush();
  assert.equal(app.requests.filter(({ message }) => message?.type === "ping").length, 1);
  assert.equal(app.requests.filter(({ url }) => url === "/remote/input").length, 0);
  assert.equal(app.requests.filter(({ url, method }) => url === "/remote/lease" && method === "POST").length, 1);
  assert.equal(app.hasTimer(900), false, "the immediate pong clears its deadline while all input ACKs remain blocked");
  assert.equal(app.remoteActive, true);
  pending.resolve(); await app.pump(); await app.close();
});

test("lost input socket releases held input and requires another picture click without replay", async () => {
  const app = fixture(); await app.ready();
  app.input("mousedown", { buttons: 1 }); await app.pump();
  const reports = app.reports.length;
  app.loseRemote(); await flush();
  assert.equal(app.remoteActive, false);
  assert.deepEqual(app.held, { key: 0, modifier: 0, buttons: 0 });
  app.frame(); await flush();
  assert.equal(app.requests.filter(({ method }) => method === "UPGRADE").length, 1);
  app.click("phone-screen"); await flush();
  assert.equal(app.requests.filter(({ method }) => method === "UPGRADE").length, 2);
  assert.equal(app.remoteActive, true);
  assert.equal(app.reports.length, reports);
  await app.close();
});

test("an old socket ACK after a new explicit round cannot revive held reports or pause that round", async () => {
  const app = fixture(); await app.ready();
  const pending = app.blockInputResponse();
  app.input("mousemove", { movementX: 2, movementY: 0 }); app.animationFrame(); await flush();
  app.escape(); await flush(); app.click("phone-screen"); await flush();
  const newRound = app.leaseRound;
  pending.resolve(); await flush();
  assert.equal(app.remoteActive, true);
  assert.equal(app.leaseRound, newRound);
  assert.equal(app.reports.length, 1);
  assert.equal(app.element("error-box").hidden, true);
  await app.close();
});

test("Escape during an initial lease cannot send an unbound DELETE that stops a newer round", async () => {
  const app = fixture(); await flush(); app.frame(); await flush();
  const pending = app.blockLeaseResponse();
  app.click("phone-screen"); await flush(); app.escape(); await flush();
  app.click("phone-screen"); await flush();
  const newRound = app.leaseRound;
  assert.equal(app.remoteActive, true);
  pending.resolve(); await flush();
  assert.equal(app.remoteActive, true);
  assert.equal(app.leaseRound, newRound);
  assert.equal(app.requests.some(({ url, method, headers }) => url === "/remote/lease" && method === "DELETE" && !headers?.["X-Remote-Round"]), false);
  await app.close();
});

test("lost MCP viewing connection reconnects automatically without replaying held inputs", async () => {
  const app = fixture(); await app.ready();
  app.input("mousedown", { buttons: 1 }); await app.pump();
  app.loseMcp(); await flush();
  assert.equal(app.remoteActive, false);
  assert.deepEqual(app.held, { key: 0, modifier: 0, buttons: 0 });
  const arms = app.calls.filter(({ name }) => name === "android_hid_arm").length;
  assert.equal(app.fireTimer(500), true); await flush();
  assert.equal(app.calls.filter(({ name }) => name === "initialize").length, 2);
  app.frame(); await flush();
  assert.equal(app.remoteActive, false);
  assert.equal(app.calls.filter(({ name }) => name === "android_hid_arm").length, arms);
  assert.equal(app.element("error-box").hidden, true);
  await app.close();
});

test("initial server outage retries with backoff, but manual disconnect cancels recovery", async () => {
  const app = fixture(undefined, { serverAvailable: false }); await flush();
  assert.equal(app.fireTimer(500), true); await flush();
  assert.equal(app.calls.filter(({ name }) => name === "initialize").length, 0);
  app.setServerAvailable(true);
  assert.equal(app.fireTimer(1000), true); await flush();
  app.frame(); await flush();
  assert.equal(app.calls.filter(({ name }) => name === "initialize").length, 1);
  app.click("disconnect-button"); await flush();
  app.window("online"); await flush();
  assert.equal(app.fireTimer(500), false);
  assert.equal(app.calls.filter(({ name }) => name === "initialize").length, 1);
});

test("hidden pages defer automatic recovery until they become visible", async () => {
  const app = fixture(); await app.ready(); app.hide(); await flush();
  app.loseMcp(); await flush();
  assert.equal(app.fireTimer(500), false);
  app.show(); await flush();
  assert.equal(app.fireTimer(500), true); await flush();
  app.frame(); await flush();
  assert.equal(app.calls.filter(({ name }) => name === "initialize").length, 2);
  assert.equal(app.remoteActive, false);
  await app.close();
});

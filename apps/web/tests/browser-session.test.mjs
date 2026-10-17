import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";
import { setImmediate } from "node:timers/promises";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../api/browser" && context.parentURL?.endsWith("/browserSession.ts")) return { url: new URL("../src/api/browser.ts", import.meta.url).href, shortCircuit: true };
    if (specifier === "./workspace" && context.parentURL?.endsWith("/api/browser.ts")) return { url: new URL("../src/api/workspace.ts", import.meta.url).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { createBrowserViewer, emptyBrowserViewer, frameCoordinates } = await import("../src/components/browserSession.ts");
const { browserEvents, browserInput, getBrowser } = await import("../src/api/browser.ts");
const originalFetch = globalThis.fetch;
const stateFor = (id = "browser-1", tabId = "tab-1") => ({ browserSessionId: id, tabId, url: "https://example.com/", title: "示例页面", canGoBack: false, canGoForward: false, status: "running" });
const frameFor = (session = stateFor()) => ({ type: "frame", sessionId: session.browserSessionId, tabId: session.tabId, data: "/9j/AA==", mimeType: "image/jpeg", width: 1280, height: 800 });
const active = [];

function fixture() {
  let session = stateFor();
  let nextResponse;
  const streams = [];
  const calls = [];
  const state = emptyBrowserViewer();
  const transport = {
    async getBrowser() { return session; },
    browserEvents(base, token, id, onEvent, signal) {
      streams.push({ onEvent, signal, base, token, id });
      onEvent({ type: "state", session });
      onEvent(frameFor(session));
      return new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    },
    async browserInput(base, token, id, tabId, input, signal) {
      calls.push({ base, token, id, tabId, input, signal });
      if (input.type !== "release" && nextResponse) {
        const response = nextResponse;
        nextResponse = undefined;
        return response;
      }
      return session;
    },
  };
  const viewer = createBrowserViewer(state, () => ({ base: "https://gateway.example/qdd", token: "browser-token" }), transport);
  active.push(viewer);
  return {
    viewer, state, calls, streams,
    async start() { void viewer.start(session); await setImmediate(); },
    emit(event) { if (event.type === "state") session = event.session; streams.at(-1).onEvent(event); },
    hold() {
      let resolve;
      let reject;
      nextResponse = new Promise((yes, no) => { resolve = yes; reject = no; });
      return { resolve, reject };
    },
  };
}
afterEach(() => {
  for (const viewer of active.splice(0)) viewer.stop();
  globalThis.fetch = originalFetch;
});

test("frame coordinates use the actual image bounds and reject clipped or invalid points", () => {
  const bounds = { left: 20, top: 40, width: 640, height: 400 };
  const frame = { width: 1280, height: 800 };
  assert.deepEqual(frameCoordinates(340, 240, bounds, frame), { x: 640, y: 400 });
  assert.deepEqual(frameCoordinates(659.9, 439.9, bounds, frame), { x: 1279, y: 799 });
  assert.equal(frameCoordinates(19, 100, bounds, frame), undefined);
  assert.equal(frameCoordinates(660, 100, bounds, frame), undefined);
  assert.equal(frameCoordinates(30, 50, { ...bounds, width: 0 }, frame), undefined);
  assert.equal(frameCoordinates(NaN, 50, bounds, frame), undefined);
});

test("watching remains read-only until manual control is explicitly enabled", async () => {
  const f = fixture();
  await f.start();
  assert.equal(f.state.online, true);
  assert.equal(f.state.manual, false);
  assert.equal(await f.viewer.input({ type: "text", text: "不应发送" }), false);
  assert.equal(f.calls.length, 0);
  f.viewer.setManual(true);
  assert.equal(await f.viewer.input({ type: "click", x: 640, y: 400 }), true);
  assert.deepEqual(f.calls[0].input, { type: "click", x: 640, y: 400 });
  assert.equal(f.calls[0].tabId, "tab-1");
});

test("rapid text and editing keys stay ordered while the first request is pending", async () => {
  const f = fixture();
  await f.start();
  f.viewer.setManual(true);
  const held = f.hold();
  const first = f.viewer.queueKeyboard({ type: "text", text: "a" });
  const second = f.viewer.queueKeyboard({ type: "text", text: "b" });
  const enter = f.viewer.queueKeyboard({ type: "key", key: "Enter", event: "press" });
  assert.deepEqual(f.calls.map((call) => call.input), [{ type: "text", text: "a" }]);
  f.emit({ type: "state", session: { ...stateFor(), title: "输入中的页面" } });
  held.resolve(stateFor());
  assert.deepEqual(await Promise.all([first, second, enter]), [true, true, true]);
  assert.deepEqual(f.calls.map((call) => call.input), [
    { type: "text", text: "a" }, { type: "text", text: "b" }, { type: "key", key: "Enter", event: "press" },
  ]);
  assert.equal(f.state.inputBusy, false);
});

test("typing queued behind a pending pointer request is delivered without dropping characters", async () => {
  const f = fixture();
  await f.start();
  f.viewer.setManual(true);
  const held = f.hold();
  const click = f.viewer.input({ type: "click", x: 10, y: 20 });
  const first = f.viewer.queueKeyboard({ type: "text", text: "你" });
  const second = f.viewer.queueKeyboard({ type: "text", text: "好" });
  assert.equal(f.calls.length, 1);
  held.resolve(stateFor());
  assert.deepEqual(await Promise.all([click, first, second]), [true, true, true]);
  assert.deepEqual(f.calls.map((call) => call.input.type === "text" ? call.input.text : call.input.type), ["click", "你", "好"]);
});

test("409 discards buffered keys and never replays them when a fresh frame arrives", async () => {
  const f = fixture();
  await f.start();
  f.viewer.setManual(true);
  const held = f.hold();
  const first = f.viewer.queueKeyboard({ type: "text", text: "a" });
  const second = f.viewer.queueKeyboard({ type: "text", text: "b" });
  held.reject(Object.assign(new Error("页面已变化"), { status: 409 }));
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  f.emit(frameFor());
  f.viewer.setManual(true);
  assert.equal(await f.viewer.queueKeyboard({ type: "text", text: "c" }), true);
  assert.deepEqual(f.calls.filter((call) => call.input.type === "text").map((call) => call.input.text), ["a", "c"]);
});

test("page navigation clears queued keys and ignores the old input response", async () => {
  const f = fixture();
  await f.start();
  f.viewer.setManual(true);
  const held = f.hold();
  const first = f.viewer.queueKeyboard({ type: "text", text: "a" });
  const second = f.viewer.queueKeyboard({ type: "text", text: "b" });
  const next = { ...stateFor(), url: "https://example.com/next" };
  f.emit({ type: "state", session: next });
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(f.calls[0].signal.aborted, true);
  f.emit(frameFor(next));
  f.viewer.setManual(true);
  assert.equal(await f.viewer.queueKeyboard({ type: "text", text: "c" }), true);
  held.resolve(stateFor());
  await setImmediate();
  assert.equal(f.state.session.url, next.url);
  assert.deepEqual(f.calls.filter((call) => call.input.type === "text").map((call) => call.input.text), ["a", "c"]);
});

test("releasing input clears its queue immediately and old requests do not block new typing", async () => {
  const f = fixture();
  await f.start();
  f.viewer.setManual(true);
  const held = f.hold();
  const first = f.viewer.queueKeyboard({ type: "text", text: "a" });
  const second = f.viewer.queueKeyboard({ type: "text", text: "b" });
  f.viewer.releaseInput();
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(await f.viewer.queueKeyboard({ type: "text", text: "c" }), true);
  held.resolve(stateFor());
  await setImmediate();
  assert.deepEqual(f.calls.filter((call) => call.input.type === "text").map((call) => call.input.text), ["a", "c"]);
  assert.equal(f.state.inputBusy, false);
});

test("buffered input cannot move into a newly selected browser session", async () => {
  const f = fixture();
  await f.start();
  f.viewer.setManual(true);
  const held = f.hold();
  const first = f.viewer.queueKeyboard({ type: "text", text: "a" });
  const second = f.viewer.queueKeyboard({ type: "text", text: "b" });
  const next = stateFor("browser-2", "tab-2");
  f.emit({ type: "state", session: next });
  void f.viewer.start(next);
  await setImmediate();
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  f.viewer.setManual(true);
  assert.equal(await f.viewer.queueKeyboard({ type: "text", text: "c" }), true);
  held.resolve(stateFor());
  await setImmediate();
  const textCalls = f.calls.filter((call) => call.input.type === "text");
  assert.deepEqual(textCalls.map((call) => [call.id, call.tabId, call.input.text]), [["browser-1", "tab-1", "a"], ["browser-2", "tab-2", "c"]]);
  assert.equal(f.state.session.browserSessionId, "browser-2");
});

test("frames from other sessions or obsolete tabs cannot replace the current image", async () => {
  const f = fixture();
  await f.start();
  const original = f.state.frame;
  f.emit(frameFor(stateFor("another")));
  f.emit(frameFor(stateFor("browser-1", "obsolete-tab")));
  f.emit({ ...frameFor(), mimeType: "image/svg+xml" });
  assert.equal(f.state.frame, original);
  f.viewer.setManual(true);
  f.emit({ type: "state", session: stateFor("browser-1", "tab-2") });
  assert.equal(f.state.manual, false);
  assert.equal(f.state.frame, undefined);
  assert.equal(f.calls.at(-1).tabId, "tab-1");
  assert.equal(f.calls.at(-1).input.type, "release");
  f.emit(frameFor());
  assert.equal(f.state.frame, undefined);
  f.emit(frameFor(stateFor("browser-1", "tab-2")));
  f.viewer.setManual(true);
  await f.viewer.input({ type: "key", key: "Enter", event: "press" });
  assert.equal(f.calls.at(-1).tabId, "tab-2");
});

test("pause aborts streams and pending input, releases keys, and ignores late emissions", async () => {
  const f = fixture();
  await f.start();
  f.viewer.setManual(true);
  const held = f.hold();
  const input = f.viewer.input({ type: "key", key: "Shift", event: "down" });
  const pending = f.calls[0];
  f.viewer.stop();
  assert.equal(pending.signal.aborted, true);
  assert.equal(f.streams[0].signal.aborted, true);
  assert.equal(f.calls.at(-1).input.type, "release");
  held.resolve(stateFor());
  assert.equal(await input, false);
  f.emit(frameFor());
  assert.equal(f.state.frame, undefined);
  assert.equal(f.state.manual, false);
  assert.equal(f.state.inputBusy, false);
});

test("409 stops manual control and invalidates the frame without retrying the input", async () => {
  const f = fixture();
  await f.start();
  f.viewer.setManual(true);
  const held = f.hold();
  const input = f.viewer.input({ type: "text", text: "一次输入" });
  held.reject(Object.assign(new Error("标签已切换"), { status: 409 }));
  assert.equal(await input, false);
  assert.equal(f.state.frame, undefined);
  assert.equal(f.state.manual, false);
  assert.match(f.state.error, /未重试/);
  f.emit(frameFor());
  assert.equal(await f.viewer.input({ type: "text", text: "不应自动重试" }), false);
  assert.equal(f.calls.filter((call) => call.input.type === "text").length, 1);
});

test("a state event outranks a delayed input response and closed events end only their own session", async () => {
  const f = fixture();
  await f.start();
  f.viewer.setManual(true);
  const held = f.hold();
  const input = f.viewer.input({ type: "click", x: 20, y: 30 });
  f.emit({ type: "state", session: { ...stateFor(), title: "更新后的标题" } });
  held.resolve(stateFor());
  assert.equal(await input, true);
  assert.equal(f.state.session.title, "更新后的标题");
  f.emit({ type: "closed", sessionId: "another" });
  assert.equal(f.state.online, true);
  f.emit({ type: "closed", sessionId: "browser-1" });
  assert.equal(f.state.session.status, "closed");
  assert.equal(f.state.online, false);
  assert.equal(f.streams[0].signal.aborted, true);
});

test("a mismatched initial state and stream errors cannot leave manual control active", async () => {
  const f = fixture();
  await f.viewer.start(stateFor("unexpected-session"));
  assert.match(f.state.error, /不匹配/);
  assert.equal(f.streams.length, 0);
  assert.equal(f.state.online, false);
  await f.start();
  f.viewer.setManual(true);
  f.emit({ type: "error", message: "浏览器已断开" });
  assert.equal(f.state.manual, false);
  assert.equal(f.state.frame, undefined);
  assert.equal(f.state.error, "浏览器已断开");
  assert.equal(f.calls.at(-1).input.type, "release");
});

test("browser endpoints preserve bearer authentication, latest tab identity, and release keepalive", async () => {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(stateFor()), { headers: { "Content-Type": "application/json" } });
  };
  const signal = new AbortController().signal;
  await getBrowser("https://gateway.example/qdd", " secret-token ", "browser/id", signal);
  await browserInput("https://gateway.example/qdd", "secret-token", "browser/id", "latest-tab", { type: "text", text: "中文" }, signal);
  await browserInput("https://gateway.example/qdd", "secret-token", "browser/id", "latest-tab", { type: "release" });
  assert.equal(calls[0].url, "https://gateway.example/qdd/api/browser/browser%2Fid");
  assert.deepEqual(JSON.parse(calls[1].init.body), { type: "text", text: "中文", tabId: "latest-tab" });
  assert.equal(calls[2].init.keepalive, true);
  for (const call of calls) {
    assert.equal(new Headers(call.init.headers).get("Authorization"), "Bearer secret-token");
    assert.equal(call.url.includes("secret-token"), false);
  }
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frameFor())}\n\n`)); controller.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
  };
  const events = [];
  await browserEvents("https://gateway.example/qdd", "secret-token", "browser/id", (event) => events.push(event), signal);
  assert.equal(calls.at(-1).url, "https://gateway.example/qdd/api/browser/browser%2Fid/stream");
  assert.equal(new Headers(calls.at(-1).init.headers).get("Authorization"), "Bearer secret-token");
  assert.deepEqual(events, [frameFor()]);
});

test("pointer input stays read-only until manual control is enabled", async () => {
  const f = fixture();
  await f.start();
  assert.equal(await f.viewer.queuePointer({ type: "mouse", event: "move", x: 10, y: 20 }), false);
  assert.equal(await f.viewer.queuePointer({ type: "mouse", event: "down", x: 10, y: 20, button: "left" }), false);
  assert.equal(f.calls.length, 0);
});

test("drag input is ordered with keys and coalesces a burst of moves without losing the release", async () => {
  const f = fixture();
  await f.start();
  f.viewer.setManual(true);
  const held = f.hold();
  const down = f.viewer.queuePointer({ type: "mouse", event: "down", x: 10, y: 20, button: "left", clickCount: 1 });
  const moves = Array.from({ length: 1000 }, (_, x) => f.viewer.queuePointer({ type: "mouse", event: "move", x, y: 30 }));
  const up = f.viewer.queuePointer({ type: "mouse", event: "up", x: 999, y: 30, button: "left", clickCount: 1 });
  const key = f.viewer.queueKeyboard({ type: "key", key: "Enter", event: "press" });
  assert.equal(f.calls.length, 1);
  held.resolve(stateFor());
  assert.deepEqual(await Promise.all([down, up, key]), [true, true, true]);
  const moveResults = await Promise.all(moves);
  assert.equal(moveResults.filter(Boolean).length, 1);
  assert.equal(moveResults.at(-1), true);
  assert.deepEqual(f.calls.map((call) => call.input), [
    { type: "mouse", event: "down", x: 10, y: 20, button: "left", clickCount: 1 },
    { type: "mouse", event: "move", x: 999, y: 30 },
    { type: "mouse", event: "up", x: 999, y: 30, button: "left", clickCount: 1 },
    { type: "key", key: "Enter", event: "press" },
  ]);
});

test("move coalescing never crosses a key or mouse press boundary", async () => {
  const f = fixture();
  await f.start();
  f.viewer.setManual(true);
  const held = f.hold();
  const first = f.viewer.queuePointer({ type: "mouse", event: "move", x: 1, y: 1 });
  const before = f.viewer.queuePointer({ type: "mouse", event: "move", x: 2, y: 2 });
  const key = f.viewer.queueKeyboard({ type: "key", key: "Shift", event: "down" });
  const after = f.viewer.queuePointer({ type: "mouse", event: "move", x: 3, y: 3 });
  held.resolve(stateFor());
  assert.deepEqual(await Promise.all([first, before, key, after]), [true, true, true, true]);
  assert.deepEqual(f.calls.map((call) => call.input.type === "mouse" ? call.input.x : call.input.key), [1, 2, "Shift", 3]);
});

test("pointer release aborts the active drag and discards all unsent input", async () => {
  const f = fixture();
  await f.start();
  f.viewer.setManual(true);
  const held = f.hold();
  const down = f.viewer.queuePointer({ type: "mouse", event: "down", x: 10, y: 20, button: "left" });
  const move = f.viewer.queuePointer({ type: "mouse", event: "move", x: 100, y: 200 });
  const up = f.viewer.queuePointer({ type: "mouse", event: "up", x: 100, y: 200, button: "left" });
  f.viewer.releaseInput();
  assert.deepEqual(await Promise.all([down, move, up]), [false, false, false]);
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.calls.at(-1).input.type, "release");
  assert.equal(await f.viewer.queuePointer({ type: "mouse", event: "move", x: 5, y: 6 }), true);
  held.resolve(stateFor());
  await setImmediate();
  assert.deepEqual(f.calls.map((call) => call.input.type === "mouse" ? call.input.event : call.input.type), ["down", "release", "move"]);
});

test("a drag conflict releases input and never replays queued movement or mouse-up", async () => {
  const f = fixture();
  await f.start();
  f.viewer.setManual(true);
  const held = f.hold();
  const down = f.viewer.queuePointer({ type: "mouse", event: "down", x: 10, y: 20, button: "left" });
  const move = f.viewer.queuePointer({ type: "mouse", event: "move", x: 100, y: 200 });
  const up = f.viewer.queuePointer({ type: "mouse", event: "up", x: 100, y: 200, button: "left" });
  held.reject(Object.assign(new Error("页面已变化"), { status: 409 }));
  assert.deepEqual(await Promise.all([down, move, up]), [false, false, false]);
  assert.equal(f.state.manual, false);
  assert.equal(f.state.frame, undefined);
  assert.equal(f.calls.at(-1).input.type, "release");
  f.emit(frameFor());
  f.viewer.setManual(true);
  assert.equal(await f.viewer.queuePointer({ type: "mouse", event: "move", x: 5, y: 6 }), true);
  assert.deepEqual(f.calls.map((call) => call.input.type === "mouse" ? call.input.event : call.input.type), ["down", "release", "move"]);
});

test("switching tabs isolates active and buffered pointer input from the new tab", async () => {
  const f = fixture();
  await f.start();
  f.viewer.setManual(true);
  const held = f.hold();
  const down = f.viewer.queuePointer({ type: "mouse", event: "down", x: 10, y: 20, button: "left" });
  const up = f.viewer.queuePointer({ type: "mouse", event: "up", x: 10, y: 20, button: "left" });
  const next = stateFor("browser-1", "tab-2");
  f.emit({ type: "state", session: next });
  assert.deepEqual(await Promise.all([down, up]), [false, false]);
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.calls.at(-1).tabId, "tab-1");
  assert.equal(f.calls.at(-1).input.type, "release");
  f.emit(frameFor(next));
  f.viewer.setManual(true);
  assert.equal(await f.viewer.queuePointer({ type: "mouse", event: "move", x: 5, y: 6 }), true);
  held.resolve(stateFor());
  await setImmediate();
  assert.deepEqual(f.calls.filter((call) => call.input.type === "mouse").map((call) => [call.tabId, call.input.event]), [["tab-1", "down"], ["tab-2", "move"]]);
});

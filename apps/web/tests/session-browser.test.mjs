import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { compileScript, parse } from "@vue/compiler-sfc";
import { createRenderer, h, nextTick, reactive } from "vue";

const vueUrl = import.meta.resolve("vue");
const controls = "data:text/javascript,export const ElAlert={},ElButton={},ElDialog={},ElInput={},ElSwitch={},ElTag={}";
const context = "data:text/javascript," + encodeURIComponent('import { ref } from "vue"; export function useWorkspaceContext() { return { workspace: { gatewayUrl: ref("https://gateway.example"), token: ref("test-token") } }; }');
registerHooks({
  resolve(specifier, contextInfo, nextResolve) {
    if (contextInfo.parentURL?.startsWith("data:text/javascript,")) {
      if (specifier === "vue") return { url: vueUrl, shortCircuit: true };
      if (specifier.startsWith("element-plus/es/components/")) return { url: controls, shortCircuit: true };
      if (specifier === "@/components/AgentIcon.vue") return { url: "data:text/javascript,export default {}", shortCircuit: true };
      if (specifier === "@/composables/workspaceContext") return { url: context, shortCircuit: true };
      if (specifier === "./browserSession") return { url: new URL("../src/components/browserSession.ts", import.meta.url).href, shortCircuit: true };
      if (specifier === "@/api/browser") return { url: new URL("../src/api/browser.ts", import.meta.url).href, shortCircuit: true };
    }
    if (specifier === "../api/browser" && contextInfo.parentURL?.endsWith("/browserSession.ts")) return { url: new URL("../src/api/browser.ts", import.meta.url).href, shortCircuit: true };
    if (specifier === "./workspace" && contextInfo.parentURL?.endsWith("/api/browser.ts")) return { url: new URL("../src/api/workspace.ts", import.meta.url).href, shortCircuit: true };
    return nextResolve(specifier, contextInfo);
  },
});
const source = await readFile(new URL("../src/components/SessionBrowser.vue", import.meta.url), "utf8");
const { descriptor } = parse(source);
const script = compileScript(descriptor, { id: "session-browser-test" });
const { default: SessionBrowser } = await import("data:text/javascript," + encodeURIComponent(stripTypeScriptTypes(script.content, { mode: "strip" })));
SessionBrowser.render = () => h("div");

test("the actual screen key handler preserves rapid typing during an in-flight HTTP request", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, "document", { configurable: true, value: Object.assign(new EventTarget(), { visibilityState: "visible" }) });
  const browser = { browserSessionId: "browser-1", tabId: "tab-1", url: "https://example.com/", title: "输入页面", canGoBack: false, canGoForward: false, status: "running" };
  const frame = { type: "frame", sessionId: "browser-1", tabId: "tab-1", data: "/9j/AA==", mimeType: "image/jpeg", width: 1280, height: 800 };
  const calls = [];
  let releaseFirst;
  const json = () => new Response(JSON.stringify(browser), { headers: { "Content-Type": "application/json" } });
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/stream")) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "state", session: browser })}\n\ndata: ${JSON.stringify(frame)}\n\n`));
          init.signal.addEventListener("abort", () => { try { controller.close(); } catch {} }, { once: true });
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    }
    if (init.body) {
      const input = JSON.parse(init.body);
      calls.push(input);
      if (input.type === "text" && input.text === "a") return new Promise((resolve) => { releaseFirst = () => resolve(json()); });
    }
    return json();
  };
  const renderer = createRenderer({
    patchProp() {}, insert() {}, remove() {}, setText() {}, setElementText() {},
    createElement: (tag) => ({ tag }), createText: (text) => ({ text }), createComment: (text) => ({ text }),
    parentNode: () => null, nextSibling: () => null,
  });
  const app = renderer.createApp(SessionBrowser, { browser, sessionId: "conversation-1" });
  try {
    app.mount({});
    const setup = app._instance.setupState;
    for (let index = 0; index < 20 && !setup.state.frame; index++) await setImmediate();
    assert.ok(setup.state.frame);
    setup.displayedFrame = setup.state.frame.sequence;
    setup.viewer.setManual(true);
    let prevented = 0;
    const event = (key) => ({ key, isComposing: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault() { prevented++; }, stopPropagation() {} });
    setup.key(event("a"));
    assert.equal(setup.state.inputBusy, true);
    setup.key(event("b"));
    assert.equal(prevented, 2);
    assert.deepEqual(calls.filter((input) => input.type === "text").map((input) => input.text), ["a"]);
    releaseFirst();
    for (let index = 0; index < 20 && calls.filter((input) => input.type === "text").length < 2; index++) await setImmediate();
    assert.deepEqual(calls.filter((input) => input.type === "text").map((input) => [input.text, input.tabId]), [["a", "tab-1"], ["b", "tab-1"]]);
  } finally {
    app.unmount();
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

async function mountBrowser(t, visibilityState = "visible") {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const browserWindow = new EventTarget();
  const browserDocument = Object.assign(new EventTarget(), { visibilityState });
  Object.defineProperty(globalThis, "window", { configurable: true, value: browserWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, value: browserDocument });
  const props = reactive({
    browser: { browserSessionId: "browser-1", tabId: "tab-1", url: "https://example.com/", title: "浏览器页面", canGoBack: false, canGoForward: false, status: "running" },
    sessionId: "conversation-1",
  });
  const inputs = [];
  const requests = [];
  const streams = [];
  let heldInput;
  const frame = () => ({ type: "frame", sessionId: props.browser.browserSessionId, tabId: props.browser.tabId, data: "/9j/AA==", mimeType: "image/jpeg", width: 1280, height: 800 });
  globalThis.fetch = async (url, init = {}) => {
    requests.push(String(url));
    if (String(url).endsWith("/stream")) {
      return new Response(new ReadableStream({
        start(controller) {
          const stream = {
            signal: init.signal,
            send(event) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); },
          };
          streams.push(stream);
          stream.send({ type: "state", session: props.browser });
          stream.send(frame());
          init.signal.addEventListener("abort", () => { try { controller.close(); } catch {} }, { once: true });
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    }
    if (init.body) {
      const input = JSON.parse(init.body);
      inputs.push(input);
      if (input.type !== "release" && heldInput) {
        const held = heldInput;
        heldInput = undefined;
        return new Promise((resolve) => { held.resolve = () => resolve(new Response(JSON.stringify(props.browser), { headers: { "Content-Type": "application/json" } })); });
      }
    }
    return new Response(JSON.stringify(props.browser), { headers: { "Content-Type": "application/json" } });
  };
  const renderer = createRenderer({
    patchProp() {}, insert() {}, remove() {}, setText() {}, setElementText() {},
    createElement: (tag) => ({ tag }), createText: (text) => ({ text }), createComment: (text) => ({ text }),
    parentNode: () => null, nextSibling: () => null,
  });
  const app = renderer.createApp({ render: () => h(SessionBrowser, props) });
  let mounted = true;
  app.mount({});
  const setup = app._instance.subTree.component.setupState;
  const settle = async () => { for (let index = 0; index < 5; index++) await setImmediate(); };
  const unmount = () => { if (mounted) { app.unmount(); mounted = false; } };
  t.after(() => {
    unmount();
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  });
  await settle();
  return {
    setup, props, inputs, requests, streams, frame, settle, unmount,
    hold() {
      const held = {};
      heldInput = held;
      return held;
    },
    blur() { browserWindow.dispatchEvent(new Event("blur")); },
    pagehide() { browserWindow.dispatchEvent(new Event("pagehide")); },
    pageshow() { browserWindow.dispatchEvent(new Event("pageshow")); },
    visibility(value) {
      browserDocument.visibilityState = value;
      browserDocument.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

test("window blur releases manual input while the live browser keeps receiving frames", async (t) => {
  const fixture = await mountBrowser(t);
  const { setup, streams, inputs } = fixture;
  assert.ok(setup.state.frame);
  setup.viewer.setManual(true);
  assert.equal(setup.state.manual, true);
  const sequence = setup.state.frame.sequence;
  fixture.blur();
  assert.equal(setup.state.manual, false);
  assert.equal(setup.state.online, true);
  assert.equal(streams[0].signal.aborted, false);
  assert.equal(inputs.at(-1).type, "release");
  streams[0].send(fixture.frame());
  await fixture.settle();
  assert.ok(setup.state.frame.sequence > sequence);
  assert.equal(streams.length, 1);
});

test("enlarging and returning to the inline preview reuse the stream and release manual input", async (t) => {
  const fixture = await mountBrowser(t);
  const { setup, streams, inputs } = fixture;
  const frame = setup.state.frame;
  setup.expanded = true;
  await nextTick();
  setup.viewer.setManual(true);
  assert.equal(setup.state.manual, true);
  setup.expanded = false;
  await nextTick();
  assert.equal(setup.state.manual, false);
  assert.equal(inputs.at(-1).type, "release");
  assert.equal(streams.length, 1);
  assert.equal(streams[0].signal.aborted, false);
  assert.equal(setup.state.frame, frame);
});

test("a hidden browser pauses and resumes a fresh stream in read-only mode when visible", async (t) => {
  const fixture = await mountBrowser(t);
  const { setup, streams } = fixture;
  setup.viewer.setManual(true);
  fixture.visibility("hidden");
  assert.equal(streams[0].signal.aborted, true);
  assert.equal(setup.state.manual, false);
  assert.equal(setup.state.online, false);
  assert.equal(setup.state.frame, undefined);
  fixture.visibility("visible");
  await fixture.settle();
  assert.equal(streams.length, 2);
  assert.equal(streams[1].signal.aborted, false);
  assert.equal(setup.state.online, true);
  assert.ok(setup.state.frame);
  assert.equal(setup.state.manual, false);
});

test("pagehide stops the live stream even while visible and pageshow resumes read-only once", async (t) => {
  const fixture = await mountBrowser(t);
  const { setup, streams, inputs } = fixture;
  setup.viewer.setManual(true);
  fixture.pagehide();
  assert.equal(streams[0].signal.aborted, true);
  assert.equal(setup.state.manual, false);
  assert.equal(setup.state.online, false);
  assert.equal(setup.state.frame, undefined);
  assert.equal(inputs.at(-1).type, "release");
  fixture.visibility("visible");
  await fixture.settle();
  assert.equal(streams.length, 1);
  fixture.pageshow();
  await fixture.settle();
  assert.equal(streams.length, 2);
  assert.equal(streams[1].signal.aborted, false);
  assert.equal(setup.state.online, true);
  assert.ok(setup.state.frame);
  assert.equal(setup.state.manual, false);
  fixture.pageshow();
  await fixture.settle();
  assert.equal(streams.length, 2);
});

test("pageshow waits for document visibility before restoring the latest browser session", async (t) => {
  const fixture = await mountBrowser(t);
  fixture.pagehide();
  assert.equal(fixture.streams[0].signal.aborted, true);
  const requests = fixture.requests.length;
  fixture.props.sessionId = "conversation-2";
  fixture.props.browser = { ...fixture.props.browser, browserSessionId: "browser-2", tabId: "tab-2" };
  await nextTick();
  assert.equal(fixture.streams.length, 1);
  assert.equal(fixture.requests.length, requests);
  fixture.visibility("hidden");
  fixture.pageshow();
  await fixture.settle();
  assert.equal(fixture.streams.length, 1);
  fixture.visibility("visible");
  await fixture.settle();
  assert.equal(fixture.streams.length, 2);
  assert.equal(fixture.setup.state.session.browserSessionId, "browser-2");
  assert.equal(fixture.setup.state.frame.tabId, "tab-2");
  assert.equal(fixture.setup.state.manual, false);
});

test("closed or unmounted browser viewers cannot reconnect on pageshow", async (t) => {
  const fixture = await mountBrowser(t);
  fixture.streams[0].send({ type: "closed", sessionId: "browser-1" });
  await fixture.settle();
  fixture.pagehide();
  fixture.pageshow();
  await fixture.settle();
  assert.equal(fixture.streams.length, 1);
  fixture.unmount();
  fixture.pagehide();
  fixture.pageshow();
  await fixture.settle();
  assert.equal(fixture.streams.length, 1);
});

test("mounting and changing sessions while hidden waits for visibility before watching the current browser", async (t) => {
  const fixture = await mountBrowser(t, "hidden");
  assert.equal(fixture.requests.length, 0);
  fixture.props.sessionId = "conversation-2";
  fixture.props.browser = { ...fixture.props.browser, browserSessionId: "browser-2", tabId: "tab-2" };
  await nextTick();
  assert.equal(fixture.requests.length, 0);
  fixture.visibility("visible");
  await fixture.settle();
  assert.equal(fixture.streams.length, 1);
  assert.equal(fixture.setup.state.session.browserSessionId, "browser-2");
  assert.equal(fixture.setup.state.frame.tabId, "tab-2");
  assert.ok(fixture.requests.every((url) => url.includes("/browser-2")));
});

test("a browser closed by the stream does not reconnect on later visibility changes", async (t) => {
  const fixture = await mountBrowser(t);
  fixture.streams[0].send({ type: "closed", sessionId: "browser-1" });
  await fixture.settle();
  assert.equal(fixture.setup.state.session.status, "closed");
  fixture.visibility("hidden");
  fixture.visibility("visible");
  await fixture.settle();
  assert.equal(fixture.streams.length, 1);
  assert.equal(fixture.setup.state.online, false);
});

test("closing a paused browser through its props prevents visibility from reconnecting", async (t) => {
  const fixture = await mountBrowser(t);
  fixture.visibility("hidden");
  fixture.props.browser = { ...fixture.props.browser, status: "closed" };
  await nextTick();
  fixture.visibility("visible");
  await fixture.settle();
  assert.equal(fixture.streams.length, 1);
  assert.equal(fixture.setup.state.session.status, "closed");
});

test("unmounting a paused browser removes visibility listeners and prevents reconnection", async (t) => {
  const fixture = await mountBrowser(t);
  fixture.visibility("hidden");
  fixture.unmount();
  fixture.visibility("visible");
  fixture.setup.visibility();
  await fixture.settle();
  assert.equal(fixture.streams.length, 1);
  assert.equal(fixture.setup.state.online, false);
});

function enableMouse(setup) {
  setup.image = {
    complete: true, currentSrc: setup.source, naturalWidth: 1280,
    getBoundingClientRect: () => ({ left: 20, top: 40, width: 640, height: 400 }),
  };
  setup.displayedFrame = setup.state.frame.sequence;
  setup.viewer.setManual(true);
}

function mouseEvent(overrides = {}) {
  return {
    clientX: 340, clientY: 240, button: 0, buttons: 1, detail: 1,
    ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
    currentTarget: { focus() {} }, preventDefault() {},
    ...overrides,
  };
}

test("the actual mouse handlers preserve a drag while its HTTP request is pending", async (t) => {
  const f = await mountBrowser(t);
  enableMouse(f.setup);
  const held = f.hold();
  f.setup.mouse(mouseEvent(), "down");
  assert.equal(f.setup.state.inputBusy, true);
  f.setup.mouse(mouseEvent({ clientX: 350 }), "move");
  f.setup.mouse(mouseEvent({ clientX: 360 }), "move");
  f.setup.mouse(mouseEvent({ clientX: 360, buttons: 0 }), "up");
  assert.equal(f.inputs.length, 1);
  held.resolve();
  await f.settle();
  assert.deepEqual(f.inputs, [
    { type: "mouse", event: "down", x: 640, y: 400, button: "left", clickCount: 1, modifiers: [], tabId: "tab-1" },
    { type: "mouse", event: "move", x: 680, y: 400, modifiers: [], tabId: "tab-1" },
    { type: "mouse", event: "up", x: 680, y: 400, button: "left", clickCount: 1, modifiers: [], tabId: "tab-1" },
  ]);
});

test("double-click sends exactly two mouse press/release pairs and keeps modifiers and button", async (t) => {
  const f = await mountBrowser(t);
  enableMouse(f.setup);
  for (const detail of [1, 2]) {
    const event = mouseEvent({ detail, ctrlKey: true });
    f.setup.mouse(event, "down");
    f.setup.mouse({ ...event, buttons: 0 }, "up");
  }
  await f.settle();
  assert.deepEqual(f.inputs.map(({ type, event, button, clickCount, modifiers }) => ({ type, event, button, clickCount, modifiers })), [
    { type: "mouse", event: "down", button: "left", clickCount: 1, modifiers: ["Control"] },
    { type: "mouse", event: "up", button: "left", clickCount: 1, modifiers: ["Control"] },
    { type: "mouse", event: "down", button: "left", clickCount: 2, modifiers: ["Control"] },
    { type: "mouse", event: "up", button: "left", clickCount: 2, modifiers: ["Control"] },
  ]);
  const screenBindings = source.match(/<div\s+class="browser-screen"[\s\S]*?@blur="releasePointer">/)[0];
  assert.match(screenBindings, /@click\.stop\.prevent\s/);
  assert.match(screenBindings, /@dblclick\.stop\.prevent\s/);
  assert.doesNotMatch(screenBindings, /@(?:click|dblclick)=["']/);
});

test("hover maps the image bounds and readonly or undisplayed frames block pointer input", async (t) => {
  const f = await mountBrowser(t);
  enableMouse(f.setup);
  f.setup.mouse(mouseEvent({ buttons: 0, detail: 0 }), "move");
  await f.settle();
  assert.deepEqual(f.inputs[0], { type: "mouse", event: "move", x: 640, y: 400, modifiers: [], tabId: "tab-1" });
  f.setup.displayedFrame = 0;
  f.setup.mouse(mouseEvent(), "down");
  f.setup.mouse(mouseEvent({ buttons: 0 }), "move");
  assert.equal(f.inputs.length, 1);
  f.setup.displayedFrame = f.setup.state.frame.sequence;
  f.setup.viewer.setManual(false);
  const count = f.inputs.length;
  f.setup.mouse(mouseEvent(), "down");
  f.setup.mouse(mouseEvent({ buttons: 0 }), "move");
  f.setup.mouse(mouseEvent({ buttons: 0 }), "up");
  f.setup.releasePointer();
  assert.equal(f.inputs.length, count);
});

test("leaving the image aborts a drag and does not send its buffered mouse-up", async (t) => {
  const f = await mountBrowser(t);
  enableMouse(f.setup);
  const held = f.hold();
  f.setup.mouse(mouseEvent(), "down");
  f.setup.mouse(mouseEvent({ clientX: 360 }), "move");
  f.setup.releasePointer();
  f.setup.mouse(mouseEvent({ buttons: 0 }), "up");
  held.resolve();
  await f.settle();
  assert.deepEqual(f.inputs.map((input) => input.type === "mouse" ? input.event : input.type), ["down", "release"]);
  assert.match(source, /@mouseleave="releasePointer"/);
  assert.match(source, /@blur="releasePointer"/);
});

test("releasing over a newer undisplayed frame still releases the held mouse", async (t) => {
  const f = await mountBrowser(t);
  enableMouse(f.setup);
  f.setup.mouse(mouseEvent(), "down");
  await f.settle();
  f.setup.displayedFrame = 0;
  f.setup.mouse(mouseEvent({ buttons: 0 }), "up");
  assert.deepEqual(f.inputs.map((input) => input.type === "mouse" ? input.event : input.type), ["down", "release"]);
});

test("the address handler navigates only after manual control and keeps the active tab identity", async (t) => {
  const fixture = await mountBrowser(t);
  fixture.setup.address = "https://example.com/next?q=store";
  fixture.setup.navigate();
  await fixture.settle();
  assert.equal(fixture.inputs.length, 0);
  enableMouse(fixture.setup);
  fixture.setup.navigate();
  await fixture.settle();
  assert.deepEqual(fixture.inputs[0], { type: "navigate", url: "https://example.com/next?q=store", tabId: "tab-1" });
  assert.match(source, /:readonly="!state.manual"/);
  assert.match(source, /native-type="submit" :disabled="!canControl">前往/);
});

test("invalid and credential-bearing addresses show a local explanation without browser input", async (t) => {
  const fixture = await mountBrowser(t);
  enableMouse(fixture.setup);
  fixture.setup.address = "example.com";
  fixture.setup.navigate();
  assert.match(fixture.setup.state.error, /请输入完整的 HTTP 或 HTTPS 地址/);
  for (const address of ["javascript:alert(1)", "https://user:secret@example.com/"]) {
    fixture.setup.address = address;
    fixture.setup.navigate();
    assert.match(fixture.setup.state.error, /只支持不含账号密码的 HTTP 或 HTTPS 地址/);
  }
  assert.equal(fixture.inputs.length, 0);
});

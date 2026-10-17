import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { compileScript, parse } from "@vue/compiler-sfc";
import { createRenderer, h } from "vue";

const vueUrl = import.meta.resolve("vue");
const controls = "data:text/javascript,export const ElAlert={},ElButton={},ElInput={},ElSwitch={},ElTag={}";
const context = "data:text/javascript," + encodeURIComponent('import { ref } from "vue"; export function useWorkspaceContext() { return { workspace: { gatewayUrl: ref("https://gateway.example"), token: ref("test-token") } }; }');
registerHooks({
  resolve(specifier, contextInfo, nextResolve) {
    if (contextInfo.parentURL?.startsWith("data:text/javascript,")) {
      if (specifier === "vue") return { url: vueUrl, shortCircuit: true };
      if (specifier === "element-plus") return { url: controls, shortCircuit: true };
      if (specifier === "@/components/AgentIcon.vue") return { url: "data:text/javascript,export default {}", shortCircuit: true };
      if (specifier === "@/composables/workspaceContext") return { url: context, shortCircuit: true };
      if (specifier === "./browserSession") return { url: new URL("../src/components/browserSession.ts", import.meta.url).href, shortCircuit: true };
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
  Object.defineProperty(globalThis, "document", { configurable: true, value: new EventTarget() });
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

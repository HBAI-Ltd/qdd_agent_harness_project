import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { compileScript, parse } from "@vue/compiler-sfc";
import { createRenderer, h, markRaw, nextTick, reactive } from "vue";

const moduleUrl = (source) => "data:text/javascript," + encodeURIComponent(source);
const controlsUrl = moduleUrl(`
  import { h } from "vue";
  export const ElButton = { setup: (_, { attrs, slots }) => () => h("button", attrs, slots.default?.()) };
  export const ElTag = { setup: (_, { slots }) => () => h("span", slots.default?.()) };
`);
const iconUrl = moduleUrl('export default { render() { return null; } };');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith("data:text/javascript,")) {
      if (specifier === "vue") return { url: import.meta.resolve("vue"), shortCircuit: true };
      if (specifier === "element-plus") return { url: controlsUrl, shortCircuit: true };
      if (specifier === "@/components/AgentIcon.vue") return { url: iconUrl, shortCircuit: true };
      if (specifier === "@/utils/taskPageBridge") return { url: new URL("../src/utils/taskPageBridge.ts", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const source = await readFile(new URL("../src/components/TaskPreview.vue", import.meta.url), "utf8");
const { descriptor } = parse(source);
const script = compileScript(descriptor, { id: "task-preview-lifecycle-test", inlineTemplate: true });
const { default: TaskPreview } = await import(moduleUrl(stripTypeScriptTypes(script.content, { mode: "strip" })));

function remove(node) {
  if (!node.parent) return;
  const index = node.parent.children.indexOf(node);
  if (index !== -1) node.parent.children.splice(index, 1);
  node.parent = null;
}
function find(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children) {
    const result = find(child, predicate);
    if (result) return result;
  }
}
const textContent = (node) => (node.text ?? "") + node.children.map(textContent).join("");
const hasClass = (name) => (node) => (node.props?.class ?? "").split(" ").includes(name);

function mount(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const browserWindow = Object.assign(new EventTarget(), { location: { origin: "https://frontend.example" } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: browserWindow });
  const root = { children: [] };
  const messages = [];
  const props = reactive({
    page: {
      slug: "sales-report", title: "销售看板", version: 1, kind: "once", schedules: [], pinnedAt: null, stale: null,
      url: "https://gateway.example/pages/sales-report/index.html?token=page-token",
    },
    gatewayUrl: "https://gateway.example",
    onMessage: (message) => messages.push(message),
  });
  const renderer = createRenderer({
    patchProp: (node, key, _previous, value) => { node.props[key] = value; },
    insert(node, parent, anchor = null) {
      remove(node);
      node.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index === -1 ? parent.children.length : index, 0, node);
    },
    remove,
    createElement(tag) {
      const node = { tag, props: {}, children: [], parent: null };
      if (tag === "iframe") {
        node.sent = [];
        node.contentWindow = { postMessage: (message, origin) => node.sent.push({ message, origin }) };
      }
      return markRaw(node);
    },
    createText: (text) => ({ text, children: [], parent: null }),
    createComment: (comment) => ({ comment, children: [], parent: null }),
    setText: (node, text) => { node.text = text; },
    setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: (node) => node.parent,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  });
  const app = renderer.createApp({ setup: () => () => h(TaskPreview, props) });
  app.mount(root);
  let mounted = true;
  const unmount = () => { if (mounted) { app.unmount(); mounted = false; } };
  t.after(() => {
    unmount();
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const frame = () => find(root, (node) => node.tag === "iframe");
  return {
    root, props, messages, unmount, frame,
    loading: () => !!find(root, hasClass("preview-loading")),
    error: () => textContent(find(root, hasClass("preview-error")) ?? { children: [] }),
    load(node = frame()) { node.props.onLoad({ currentTarget: node, target: node }); },
    respond(node = frame(), type = "page:ready", payload = null) {
      const initial = node.sent.at(-1)?.message;
      assert.ok(initial, "the host has initialized the frame");
      browserWindow.dispatchEvent(Object.assign(new Event("message"), {
        data: { ...initial, type, payload }, origin: "https://gateway.example", source: node.contentWindow,
      }));
    },
    reload() { find(root, (node) => node.tag === "button" && textContent(node).includes("重新加载")).props.onClick(); },
    async tick(ms) { t.mock.timers.tick(ms); await nextTick(); },
  };
}

test("a pending iframe request stops showing loading and reports a retryable timeout", async (t) => {
  const f = mount(t);
  assert.equal(f.loading(), true);
  await f.tick(15000);
  assert.equal(f.loading(), false);
  assert.match(f.error(), /加载超时/);
  assert.equal(f.frame().sent.length, 0, "a pending navigation has not started its handshake");
});

test("load establishes the real bridge and readiness clears both deadlines", async (t) => {
  const f = mount(t);
  await f.tick(10000);
  f.load();
  assert.equal(f.frame().sent.length, 1);
  assert.equal(f.frame().sent[0].origin, "https://gateway.example");
  assert.equal(f.frame().sent[0].message.type, "host:init");
  f.respond();
  await nextTick();
  assert.equal(f.loading(), false);
  assert.equal(f.error(), "");
  await f.tick(30000);
  assert.equal(f.error(), "");
  assert.equal(f.messages[0].type, "page:ready");
});

test("a loaded document without an SDK acknowledgement reports a handshake timeout", async (t) => {
  const f = mount(t);
  f.load();
  await f.tick(7999);
  assert.equal(f.loading(), true);
  await f.tick(1);
  assert.equal(f.loading(), false);
  assert.match(f.error(), /未建立通信/);
});

test("a document that finishes loading after its timeout can still recover", async (t) => {
  const f = mount(t);
  await f.tick(15000);
  assert.match(f.error(), /加载超时/);
  f.load();
  f.respond();
  await nextTick();
  assert.equal(f.loading(), false);
  assert.equal(f.error(), "");
});

test("reload replaces the frame and rejects stale readiness while starting a fresh deadline", async (t) => {
  const f = mount(t);
  f.load();
  const previous = f.frame();
  await f.tick(4000);
  f.reload();
  await nextTick();
  assert.notEqual(f.frame(), previous);
  f.respond(previous);
  await nextTick();
  assert.equal(f.loading(), true);
  assert.equal(f.messages.length, 0);
  await f.tick(14999);
  assert.equal(f.loading(), true);
  await f.tick(1);
  assert.match(f.error(), /加载超时/);
});

test("invalid URLs and frame errors finish loading immediately", async (t) => {
  const f = mount(t);
  f.frame().props.onError({ currentTarget: f.frame(), target: f.frame() });
  await nextTick();
  assert.equal(f.loading(), false);
  assert.match(f.error(), /加载失败/);
  await f.tick(30000);
  assert.match(f.error(), /加载失败/);
  f.props.page.url = "https://other.example/pages/sales-report/";
  await nextTick();
  assert.equal(f.frame(), undefined);
  assert.equal(f.loading(), false);
  assert.match(f.error(), /地址无效/);
});

test("unmount removes the message listener and pending deadlines", async (t) => {
  const f = mount(t);
  f.load();
  const frame = f.frame();
  f.unmount();
  f.respond(frame);
  await f.tick(30000);
  assert.equal(f.messages.length, 0);
});

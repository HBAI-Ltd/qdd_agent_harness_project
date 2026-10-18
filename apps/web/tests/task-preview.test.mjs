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
      if (specifier.startsWith("element-plus/es/components/")) return { url: controlsUrl, shortCircuit: true };
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
    respond(node = frame(), type = "page:ready", payload = null, origin = props.gatewayUrl === browserWindow.location.origin ? "null" : new URL(props.page.url).origin, source = node.contentWindow) {
      const initial = node.sent.at(-1)?.message;
      assert.ok(initial, "the host has initialized the frame");
      browserWindow.dispatchEvent(Object.assign(new Event("message"), {
        data: { ...initial, type, payload }, origin, source,
      }));
    },
    reload() { find(root, (node) => node.tag === "button" && textContent(node).includes("重新加载")).props.onClick(); },
    async tick(ms) { t.mock.timers.tick(ms); await nextTick(); },
  };
}

test("cross-origin preview permits external popups and preserves the gateway origin", (t) => {
  const f = mount(t);
  assert.deepEqual(new Set(f.frame().props.sandbox.split(/\s+/)), new Set([
    "allow-scripts", "allow-downloads", "allow-same-origin", "allow-popups", "allow-popups-to-escape-sandbox",
  ]));
});

test("same-origin preview permits external popups while keeping the frame opaque", async (t) => {
  const f = mount(t);
  f.props.gatewayUrl = "https://frontend.example";
  f.props.page.url = "https://frontend.example/pages/sales-report/index.html";
  await nextTick();
  assert.deepEqual(new Set(f.frame().props.sandbox.split(/\s+/)), new Set([
    "allow-scripts", "allow-downloads", "allow-popups", "allow-popups-to-escape-sandbox",
  ]));
});

test("a pending iframe request stops showing loading and reports a retryable timeout", async (t) => {
  const f = mount(t);
  assert.equal(f.loading(), true);
  await f.tick(15000);
  assert.equal(f.loading(), false);
  assert.match(f.error(), /加载超时/);
  assert.equal(f.frame().sent.length, 0, "a pending navigation has not started its handshake");
});

test("declared record sets open their manager while preserving the active page frame", async (t) => {
  const f = mount(t);
  const originalFrame = f.frame();
  const opened = [];
  f.props.onRecords = (name) => opened.push(name);
  f.props.page.records = ["loss_log", "patrol_log"];
  await nextTick();
  const recordButton = (name) => find(f.root, (node) => node.tag === "button" && node.props["aria-label"] === `管理登记记录：${name}`);
  assert.ok(recordButton("patrol_log"));
  recordButton("loss_log").props.onClick();
  assert.deepEqual(opened, ["loss_log"]);
  assert.equal(f.frame(), originalFrame);
  f.props.page.records = [];
  await nextTick();
  assert.equal(recordButton("loss_log"), undefined);
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

test("repeated page-list snapshots preserve the ready frame and bridge while updating metadata", async (t) => {
  const f = mount(t);
  f.load();
  f.respond();
  await nextTick();
  const originalFrame = f.frame();
  const readyMessage = f.messages[0];
  for (let i = 0; i < 20; i++) {
    f.props.page = JSON.parse(JSON.stringify(f.props.page));
    await nextTick();
    assert.ok(f.frame() === originalFrame, "unchanged page identity must not recreate the iframe");
    assert.equal(f.loading(), false);
    assert.equal(f.error(), "");
  }
  f.props.page = {
    ...f.props.page,
    title: "更新后的销售看板",
    kind: "scheduled",
    schedules: [{ id: "daily", name: "每日销售更新", enabled: false }],
    pinnedAt: "2026-10-18T06:00:00Z",
    stale: "请复核销售数据",
    records: ["sales_log"],
  };
  await nextTick();
  assert.ok(f.frame() === originalFrame, "metadata updates must preserve the iframe");
  assert.equal(f.loading(), false);
  assert.equal(originalFrame.props.title, "更新后的销售看板 — 任务页面");
  assert.match(textContent(f.root), /每日销售更新\s*已暂停/);
  assert.match(textContent(f.root), /取消置顶/);
  assert.match(textContent(f.root), /请复核销售数据/);
  assert.match(textContent(f.root), /sales_log/);
  assert.equal(originalFrame.sent.length, 1, "metadata updates must not restart the handshake");
  assert.equal(readyMessage.reply("host:received", { type: "page:ready" }), true);
  assert.equal(originalFrame.sent.at(-1).message.bridgeId, originalFrame.sent[0].message.bridgeId);
});

test("page-list snapshots do not restart a pending document's load deadline", async (t) => {
  const f = mount(t);
  const originalFrame = f.frame();
  for (let i = 0; i < 3; i++) {
    await f.tick(4000);
    f.props.page = { ...f.props.page };
    await nextTick();
    assert.ok(f.frame() === originalFrame, "list snapshots must preserve the pending document");
  }
  await f.tick(2999);
  assert.equal(f.loading(), true);
  await f.tick(1);
  assert.equal(f.loading(), false);
  assert.match(f.error(), /加载超时/);
});

test("page-list snapshots preserve a pending SDK handshake and its deadline", async (t) => {
  const f = mount(t);
  f.load();
  const originalFrame = f.frame();
  await f.tick(7000);
  f.props.page = { ...f.props.page };
  await nextTick();
  assert.ok(f.frame() === originalFrame, "list snapshots must preserve the pending handshake");
  assert.equal(originalFrame.sent.length, 1);
  await f.tick(999);
  assert.equal(f.loading(), true);
  await f.tick(1);
  assert.equal(f.loading(), false);
  assert.match(f.error(), /未建立通信/);
  f.respond(originalFrame);
  await nextTick();
  assert.equal(f.loading(), false);
  assert.equal(f.error(), "");
});

for (const [name, update] of [
  ["page version", (props) => { props.page.version++; }],
  ["page URL", (props) => { props.page.url = "/pages/sales-report/index.html?token=new-page-token"; }],
  ["active page", (props) => { props.page = { ...props.page, slug: "stock-report", url: "/pages/stock-report/" }; }],
  ["gateway URL", (props) => { props.gatewayUrl = "https://new-gateway.example"; }],
]) {
  test(`a changed ${name} replaces the frame and establishes a fresh bridge`, async (t) => {
    const f = mount(t);
    f.props.page.url = "/pages/sales-report/";
    await nextTick();
    f.load();
    f.respond(f.frame(), "page:ready", null, f.props.gatewayUrl);
    await nextTick();
    const originalFrame = f.frame();
    const readyMessage = f.messages[0];
    update(f.props);
    await nextTick();
    assert.notEqual(f.frame(), originalFrame);
    assert.equal(f.frame().props.src, new URL(f.props.page.url, f.props.gatewayUrl).href);
    assert.equal(f.loading(), true);
    assert.equal(readyMessage.reply("host:received"), false);
    f.load();
    f.respond(f.frame(), "page:ready", null, f.props.gatewayUrl);
    await nextTick();
    assert.equal(f.loading(), false);
    assert.equal(f.error(), "");
    assert.notEqual(f.frame().sent[0].message.bridgeId, originalFrame.sent[0].message.bridgeId);
  });
}

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

test("cross-origin task frames preserve their gateway origin and reject opaque origins and sibling sources", async (t) => {
  const f = mount(t);
  assert.ok(f.frame().props.sandbox.includes("allow-same-origin"));
  f.load();
  f.respond(f.frame(), "page:ready", null, "null");
  f.respond(f.frame(), "page:ready", null, "https://gateway.example", {});
  await nextTick();
  assert.equal(f.loading(), true);
  assert.equal(f.messages.length, 0);
  f.respond();
  await nextTick();
  assert.equal(f.loading(), false);
  assert.equal(f.messages.length, 1);
});

test("same-origin gateways use the same opaque bridge and remain supported without warnings", async (t) => {
  const f = mount(t);
  f.props.gatewayUrl = "https://frontend.example";
  f.props.page.url = "https://frontend.example/pages/sales-report/?page_token=page-token";
  await nextTick();
  assert.ok(!f.frame().props.sandbox.includes("allow-same-origin"));
  f.load();
  assert.equal(f.frame().sent[0].origin, "*");
  f.respond();
  await nextTick();
  assert.equal(f.loading(), false);
  assert.equal(f.error(), "");
  assert.doesNotMatch(textContent(f.root), /实时取数可能受限/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { afterEach, test } from "node:test";
import { compileScript, parse } from "@vue/compiler-sfc";
import { createRenderer, h, nextTick, ref } from "vue";

const dataModule = (source) => "data:text/javascript," + encodeURIComponent(source);
const contextUrl = dataModule(`
  let current;
  export function setContext(context) { current = context; }
  export function useWorkspaceContext() { return current; }
`);
const controlsUrl = dataModule(`
  import { h } from "vue";
  export const ElButton = {
    inheritAttrs: false,
    props: ["disabled", "loading"],
    setup: (props, { attrs, slots }) => () => h("button", { ...attrs, disabled: props.disabled, "data-loading": props.loading }, slots.default?.()),
  };
  const wrapper = { setup: (_, { slots }) => () => h("div", slots.default?.()) };
  export const ElCard = wrapper, ElMenu = wrapper, ElMenuItem = wrapper, ElScrollbar = wrapper, ElSkeleton = wrapper;
  export const ElTag = { setup: (_, { slots }) => () => h("span", slots.default?.()) };
  export const ElEmpty = {
    props: ["description"],
    setup: (props, { slots }) => () => h("div", [props.description, slots.default?.()]),
  };
  export const ElInput = {
    inheritAttrs: false,
    props: ["modelValue"],
    emits: ["update:modelValue"],
    setup: (props, { attrs, emit, expose }) => {
      expose({ focus() {} });
      return () => h("input", { ...attrs, value: props.modelValue, onInput: (event) => emit("update:modelValue", event.target.value) });
    },
  };
`);
const iconUrl = dataModule('import { h } from "vue"; export default { props: ["name"], setup: (props) => () => h("svg", { "data-icon": props.name }) };');
const previewStubUrl = dataModule('import { h } from "vue"; export default { setup: () => () => h("div") };');
const bridgeUrl = dataModule(`
  export const TASK_PAGE_MESSAGE_EVENT = "task-page-message";
  export function createTaskPageBridge() {
    return { reset() {}, postMessage() {}, receive() {}, initialize() { return true; }, isReady() { return true; } };
  }
`);
const dependencies = new Map([
  ["vue", import.meta.resolve("vue")],
  ["@/composables/workspaceContext", contextUrl],
  ["@/components/AgentIcon.vue", iconUrl],
  ["@/components/TaskPreview.vue", previewStubUrl],
  ["@/utils/taskPageBridge", bridgeUrl],
]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith("data:text/javascript,")) {
      const url = specifier.startsWith("element-plus/es/components/") ? controlsUrl : dependencies.get(specifier);
      if (url) return { url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

async function component(path, id) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id, inlineTemplate: true });
  return (await import(dataModule(stripTypeScriptTypes(script.content, { mode: "strip" })))).default;
}
const TasksView = await component("../src/views/tasks/index.vue", "tasks-view-test");
const TaskPreview = await component("../src/components/TaskPreview.vue", "task-preview-test");
const WorkspaceSidebar = await component("../src/components/WorkspaceSidebar.vue", "task-sidebar-test");
const { setContext } = await import(contextUrl);
const mounted = [];
const page = (slug, extra = {}) => ({
  slug, title: slug, summary: "页面摘要", wish: "经营分析", version: 1,
  url: `https://gateway.example/pages/${slug}/index.html`,
  updatedAt: "2026-10-17T03:00:00Z", stale: null, kind: "once", schedules: [], pinnedAt: null, ...extra,
});

function remove(node) {
  if (!node.parent) return;
  const index = node.parent.children.indexOf(node);
  if (index !== -1) node.parent.children.splice(index, 1);
  node.parent = null;
}

function mount(Component, props = {}) {
  const root = { children: [] };
  const renderer = createRenderer({
    patchProp: (node, key, _previous, value) => { node.props[key] = value; },
    insert(node, parent, anchor = null) {
      remove(node);
      node.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index === -1 ? parent.children.length : index, 0, node);
    },
    remove,
    createElement: (tag) => ({ tag, props: {}, style: {}, children: [], parent: null }),
    createText: (text) => ({ text, children: [], parent: null }),
    createComment: (comment) => ({ comment, children: [], parent: null }),
    setText: (node, text) => { node.text = text; },
    setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: (node) => node.parent,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  });
  const app = renderer.createApp({ setup: () => () => h(Component, props) });
  app.mount(root);
  mounted.push(app);
  return root;
}

function context(entries) {
  const calls = { pin: [], view: [], page: [], records: [] };
  const workspace = {
    pages: ref(entries), activePageSlug: ref(null), activePage: ref(null),
    preferences: ref({ theme: "light" }), gatewayUrl: ref("https://gateway.example"),
    connected: ref(true), loadingPages: ref(false), pendingPagePins: ref(new Set()),
    sessions: ref([]), activeSessionId: ref(null), token: ref("test-token"), loadingSessions: ref(false),
    loadWorkspace() {},
    async setPagePinned(slug, pinned) { calls.pin.push([slug, pinned]); return true; },
  };
  setContext({
    workspace, overview: { data: ref() }, draft: ref(""), notify() {},
    navigation: {
      async newConversation() {}, async editPage() { return true; },
      async openPage(slug) { calls.page.push(slug); },
      async openRecords(name) { calls.records.push(name); },
      async openView(view) { calls.view.push(view); },
    },
  });
  return { workspace, calls };
}
function findAll(root, predicate) {
  return [...(predicate(root) ? [root] : []), ...root.children.flatMap((child) => findAll(child, predicate))];
}
const hasClass = (name) => (node) => (node.props?.class ?? "").split(" ").includes(name);
const textContent = (node) => (node.text ?? "") + node.children.map(textContent).join("");
const buttons = (root) => findAll(root, (node) => node.tag === "button");
const labeled = (root, label) => buttons(root).find((node) => node.props["aria-label"] === label);
const titles = (root) => findAll(root, hasClass("task-title-button")).map(textContent);

afterEach(() => { for (const app of mounted.splice(0)) app.unmount(); });

test("task pages keep gateway order and filter by kind and associated schedule name", async () => {
  const { calls } = context([
    page("置顶日报", { kind: "scheduled", pinnedAt: "2026-10-16T00:00:00Z", schedules: [{ id: "daily", name: "每日营业汇总", enabled: true }] }),
    page("一次性分析"),
    page("暂停周报", { kind: "scheduled", schedules: [{ id: "weekly", name: "每周复盘", enabled: false }] }),
  ]);
  const root = mount(TasksView);
  assert.deepEqual(titles(root), ["置顶日报", "一次性分析", "暂停周报"]);
  assert.match(textContent(root), /已置顶/);
  assert.match(textContent(root), /每日营业汇总已启用/);
  assert.match(textContent(root), /每周复盘已暂停/);
  await labeled(root, "管理定时任务：每周复盘，已暂停").props.onClick();
  assert.deepEqual(calls.view, ["schedules"]);
  buttons(root).find((node) => textContent(node) === "定时任务2").props.onClick();
  await nextTick();
  assert.deepEqual(titles(root), ["置顶日报", "暂停周报"]);
  assert.equal(buttons(root).find((node) => textContent(node) === "定时任务2").props["aria-pressed"], true);
  findAll(root, (node) => node.tag === "input")[0].props.onInput({ target: { value: "每周复盘" } });
  await nextTick();
  assert.deepEqual(titles(root), ["暂停周报"]);
  buttons(root).find((node) => textContent(node) === "一次性任务1").props.onClick();
  await nextTick();
  assert.deepEqual(titles(root), []);
  assert.match(textContent(root), /没有找到相关页面/);
});

test("each task page pins independently and pending or disconnected pages disable pin actions", async () => {
  const { workspace, calls } = context([page("日报", { pinnedAt: "2026-10-16T00:00:00Z" }), page("库存")]);
  const root = mount(TasksView);
  await labeled(root, "取消置顶：日报").props.onClick();
  await labeled(root, "置顶：库存").props.onClick();
  assert.deepEqual(calls.pin, [["日报", false], ["库存", true]]);
  workspace.pendingPagePins.value.add("日报");
  await nextTick();
  assert.equal(labeled(root, "取消置顶：日报").props.disabled, true);
  assert.equal(labeled(root, "取消置顶：日报").props["data-loading"], true);
  assert.equal(labeled(root, "置顶：库存").props.disabled, false);
  workspace.connected.value = false;
  await nextTick();
  assert.equal(labeled(root, "置顶：库存").props.disabled, true);
});

test("sidebar labels pinned task pages and keeps server ordering", () => {
  context([page("置顶周报", { kind: "scheduled", pinnedAt: "2026-10-16T00:00:00Z" }), page("新分析")]);
  const root = mount(WorkspaceSidebar, { view: "tasks", collapsed: false, mobileOpen: false, isMobile: false });
  const entries = findAll(root, hasClass("task-select"));
  assert.deepEqual(entries.map((node) => node.props["aria-label"]), ["打开已置顶定时任务页面：置顶周报", "打开一次性任务页面：新分析"]);
  assert.match(textContent(entries[0]), /置顶/);
  assert.equal(findAll(entries[0], (node) => node.props?.["data-icon"] === "clock").length, 1);
});

test("task cards find declared record sets and open their manager without changing page data", async () => {
  const entries = [page("报损登记", { records: ["loss_log"] }), page("库存分析")];
  const { calls } = context(entries);
  const root = mount(TasksView);
  findAll(root, (node) => node.tag === "input")[0].props.onInput({ target: { value: "loss_log" } });
  await nextTick();
  assert.deepEqual(titles(root), ["报损登记"]);
  await labeled(root, "管理登记记录：loss_log").props.onClick();
  assert.deepEqual(calls.records, ["loss_log"]);
  assert.deepEqual(calls.pin, []);
  assert.deepEqual(calls.page, []);
  assert.deepEqual(entries[0].records, ["loss_log"]);
});

test("preview exposes pin and schedule navigation without changing the page frame", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const fakeWindow = new EventTarget();
  fakeWindow.location = { origin: "https://frontend.example" };
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  try {
    const pins = [];
    let scheduleOpens = 0;
    const root = mount(TaskPreview, {
      page: page("日报", { kind: "scheduled", pinnedAt: "2026-10-16T00:00:00Z", schedules: [{ id: "daily", name: "营业日报", enabled: false }] }),
      gatewayUrl: "https://gateway.example", onPin: (pinned) => pins.push(pinned), onSchedules: () => { scheduleOpens++; },
    });
    const frame = findAll(root, (node) => node.tag === "iframe")[0];
    assert.equal(frame.props.src, "https://gateway.example/pages/日报/index.html".replace("日报", encodeURIComponent("日报")));
    await labeled(root, "取消置顶：日报").props.onClick();
    await labeled(root, "管理定时任务：营业日报，已暂停").props.onClick();
    await nextTick();
    assert.deepEqual(pins, [false]);
    assert.equal(scheduleOpens, 1);
    assert.equal(findAll(root, (node) => node.tag === "iframe")[0], frame);
    for (const app of mounted.splice(0)) app.unmount();
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

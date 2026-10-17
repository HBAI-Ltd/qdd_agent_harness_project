import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { afterEach, test } from "node:test";
import { compileScript, parse } from "@vue/compiler-sfc";
import { createRenderer, nextTick, ref } from "vue";

const moduleUrl = (source) => "data:text/javascript," + encodeURIComponent(source);
const vueUrl = import.meta.resolve("vue");
const contextUrl = moduleUrl(`
  let current;
  export function setContext(value) { current = value; }
  export function useWorkspaceContext() { return current; }
  export function useGatewayResource(key) { return current.resources[key]; }
`);
const helpersUrl = moduleUrl(stripTypeScriptTypes(await readFile(new URL("../src/api/schedules.ts", import.meta.url), "utf8"), { mode: "strip" }));
const apiUrl = moduleUrl(`
  let handlers;
  export function setApi(value) { handlers = value; }
  export const listSkills = () => Promise.resolve([]);
  export const listConnectors = () => Promise.resolve({ connectors: [], catalog: [] });
  export const listSchedules = () => Promise.resolve([]);
  export const gatewayJson = () => Promise.resolve([]);
  export const createSchedule = (...args) => handlers.create(...args);
  export const updateSchedule = (...args) => handlers.update(...args);
  export const deleteSchedule = (...args) => handlers.remove(...args);
  export const runSchedule = (...args) => handlers.run(...args);
  export { canNotify, scheduleCron, scheduleInput } from ${JSON.stringify(helpersUrl)};
`);
const controlsUrl = moduleUrl(`
  import { h } from "vue";
  const container = (tag) => ({ setup: (_, { attrs, slots }) => () => h(tag, attrs, slots.default?.()) });
  export const ElButton = {
    inheritAttrs: false, props: ["disabled", "loading"],
    setup: (props, { attrs, slots }) => () => h("button", { ...attrs, disabled: props.disabled || props.loading }, slots.default?.()),
  };
  export const ElInput = {
    inheritAttrs: false, props: ["modelValue", "type", "disabled"], emits: ["update:modelValue"],
    setup: (props, { attrs, emit }) => () => h(props.type === "textarea" ? "textarea" : "input", {
      ...attrs, value: props.modelValue, disabled: props.disabled,
      onInput: (event) => emit("update:modelValue", event.target.value),
    }),
  };
  export const ElDialog = {
    props: ["modelValue", "title"],
    setup: (props, { slots }) => () => props.modelValue ? h("dialog", { open: true }, [h("h2", props.title), slots.default?.(), slots.footer?.()]) : null,
  };
  export const ElAlert = { props: ["title"], setup: (props) => () => h("p", { role: "alert" }, props.title) };
  export const ElEmpty = { props: ["description"], setup: (props, { slots }) => () => h("div", [props.description, slots.default?.()]) };
  export const ElForm = container("form");
  export const ElFormItem = container("label");
  export const ElCard = container("div");
  export const ElTag = container("span");
  export const ElSkeleton = container("div");
  export const ElSelect = container("select");
  export const ElTimePicker = container("input");
  export const ElSwitch = container("input");
  export const ElMessageBox = { async confirm() {} };
`);
const iconUrl = moduleUrl('import { h } from "vue"; export default { setup: () => () => h("svg") };');
const optionUrl = moduleUrl('import { h } from "vue"; export default { props: ["value", "label"], setup: (props) => () => h("option", { value: props.value }, props.label) };');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith("data:text/javascript,")) {
      if (specifier === "vue") return { url: vueUrl, shortCircuit: true };
      if (specifier.startsWith("element-plus/es/components/")) return { url: controlsUrl, shortCircuit: true };
      if (specifier === "@/components/AgentIcon.vue") return { url: iconUrl, shortCircuit: true };
      if (specifier === "@/components/StringSelectOption") return { url: optionUrl, shortCircuit: true };
      if (specifier.startsWith("@/composables/")) return { url: contextUrl, shortCircuit: true };
      if (specifier.startsWith("@/api/") || specifier === "./workspace") return { url: apiUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

// Render the real view and invoke its controls; the real input/cron helpers validate requests.
const source = await readFile(new URL("../src/views/schedules/index.vue", import.meta.url), "utf8");
const { descriptor } = parse(source);
const script = compileScript(descriptor, { id: "schedules-view-test", inlineTemplate: true });
const { default: SchedulesView } = await import(moduleUrl(stripTypeScriptTypes(script.content, { mode: "strip" })));
const { setContext } = await import(contextUrl);
const { setApi } = await import(apiUrl);
const mounted = [];
const schedule = (id, name, extra = {}) => ({
  id, name, prompt: "检查库存并整理补货建议", cron: "0 8 * * *", enabled: true,
  createdAt: "2026-10-17T03:00:00Z", updatedAt: "2026-10-17T03:00:00Z", nextRunAt: null, ...extra,
});

function remove(node) {
  if (!node.parent) return;
  const index = node.parent.children.indexOf(node);
  if (index >= 0) node.parent.children.splice(index, 1);
  node.parent = null;
}
const renderer = createRenderer({
  patchProp: (node, key, _previous, value) => { node.props[key] = value; },
  insert(node, parent, anchor = null) {
    remove(node);
    node.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
  },
  remove,
  createElement: (tag) => ({ tag, props: {}, children: [], parent: null }),
  createText: (text) => ({ text, children: [], parent: null }),
  createComment: (text) => ({ comment: text, children: [], parent: null }),
  setText: (node, text) => { node.text = text; },
  setElementText: (node, text) => { node.text = text; node.children = []; },
  parentNode: (node) => node.parent,
  nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
});

async function mount({ schedules = [schedule("inventory", "库存检查")], connected = true } = {}) {
  const root = { children: [] };
  const calls = { create: [], update: [], notices: [], refresh: 0 };
  const resources = {
    schedules: { data: ref(schedules), loading: ref(false), error: ref(""), async refresh() { calls.refresh++; } },
    skills: { data: ref([]), loading: ref(false), error: ref(""), async refresh() {} },
    connectors: { data: ref({ connectors: [], catalog: [] }), loading: ref(false), error: ref(""), async refresh() {} },
  };
  const workspace = { connected: ref(connected), gatewayUrl: ref("http://fixture.test"), token: ref("fixture-token"), pages: ref([]), sessions: ref([]) };
  const api = {
    async create(base, token, input, signal) { calls.create.push({ base, token, input, signal }); return schedule("created", input.name, input); },
    async update(base, token, id, input, signal) { calls.update.push({ base, token, id, input, signal }); return schedule(id, input.name, input); },
    async remove() {},
    async run() { return { sessionId: "run-session" }; },
  };
  setApi(api);
  setContext({ workspace, navigation: {}, resources, notify(value) { calls.notices.push(value); } });
  const app = renderer.createApp(SchedulesView);
  app.mount(root);
  mounted.push(app);
  await nextTick();
  return { root, workspace, resources, calls, api };
}

function findAll(root, predicate) {
  return [...(predicate(root) ? [root] : []), ...root.children.flatMap((child) => findAll(child, predicate))];
}
const textContent = (node) => (node.text ?? "") + node.children.map(textContent).join("");
const button = (root, label) => findAll(root, (node) => node.tag === "button" && textContent(node).trim() === label)[0];
const field = (root, placeholder) => findAll(root, (node) => node.props?.placeholder === placeholder)[0];
const nameInput = (root) => field(root, "例如：每天的经营日报");
const promptInput = (root) => field(root, "描述需要检查的数据、分析内容和提醒条件");
async function click(root, label) {
  const target = button(root, label);
  assert.ok(target, `button exists: ${label}`);
  assert.notEqual(target.props.disabled, true, `button enabled: ${label}`);
  await target.props.onClick();
  await nextTick();
}
async function input(node, value) {
  node.props.onInput({ target: { value } });
  await nextTick();
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
});

test("schedule creation reports success only after the request succeeds", async () => {
  const { root, calls, api } = await mount();
  const create = api.create;
  api.create = async () => { throw new TypeError("network unavailable"); };
  await click(root, "新建定时任务");
  await input(nameInput(root), "每日库存检查");
  await input(promptInput(root), "检查库存并整理补货建议");
  await click(root, "保存任务");
  assert.match(textContent(root), /暂时无法连接工作空间/);
  assert.equal(nameInput(root).props.value, "每日库存检查");
  assert.deepEqual(calls.notices, []);
  api.create = create;
  await click(root, "保存任务");
  assert.equal(calls.create[0].input.name, "每日库存检查");
  assert.equal(calls.create[0].input.cron, "0 8 * * *");
  assert.deepEqual(calls.notices, ["定时任务已创建"]);
  assert.equal(nameInput(root), undefined);
});

test("disconnect keeps the schedule editor and draft, and explains an offline save", async () => {
  const { root, workspace, calls } = await mount();
  await click(root, "编辑");
  await input(nameInput(root), "断连时保留的定时任务");
  workspace.connected.value = false;
  await nextTick();
  assert.equal(nameInput(root)?.props.value, "断连时保留的定时任务");
  assert.match(textContent(root), /未连接.*编辑内容已保留/);
  await click(root, "保存任务");
  assert.deepEqual(calls.update, []);
  assert.deepEqual(calls.notices, []);
  workspace.connected.value = true;
  await nextTick();
  await click(root, "保存任务");
  assert.equal(calls.update[0].id, "inventory");
  assert.equal(calls.update[0].input.name, "断连时保留的定时任务");
  assert.deepEqual(calls.notices, ["定时任务已更新"]);
});

test("disconnect during schedule creation aborts the request and ignores a late success", async () => {
  const { root, workspace, calls, api } = await mount();
  const create = api.create;
  let complete;
  let signal;
  api.create = (...args) => {
    signal = args[3];
    return new Promise((resolve) => { complete = resolve; });
  };
  await click(root, "新建定时任务");
  await input(nameInput(root), "保存中断的任务");
  await input(promptInput(root), "检查库存");
  const pending = click(root, "保存任务");
  workspace.connected.value = false;
  await nextTick();
  assert.equal(signal.aborted, true);
  assert.match(textContent(root), /保存结果.*未确认/);
  assert.equal(nameInput(root)?.props.value, "保存中断的任务");
  complete(schedule("late", "不应当显示为成功"));
  await pending;
  assert.deepEqual(calls.notices, []);
  assert.equal(calls.refresh, 0);
  workspace.connected.value = true;
  await nextTick();
  assert.match(textContent(root), /保存结果.*未确认/);
  api.create = create;
  await click(root, "保存任务");
  assert.equal(calls.create[0].input.name, "保存中断的任务");
  assert.deepEqual(calls.notices, ["定时任务已创建"]);
});

for (const key of ["gatewayUrl", "token"]) {
  test(`schedule drafts cannot be silently written after ${key} changes`, async () => {
    const { root, workspace, calls } = await mount();
    await click(root, "编辑");
    await input(nameInput(root), "原工作空间的任务草稿");
    const original = workspace[key].value;
    workspace[key].value = "changed-connection";
    await nextTick();
    assert.equal(nameInput(root)?.props.value, "原工作空间的任务草稿");
    await click(root, "保存任务");
    assert.match(textContent(root), /连接配置已更改/);
    assert.deepEqual(calls.update, []);
    assert.deepEqual(calls.notices, []);
    workspace[key].value = original;
    await nextTick();
    await click(root, "保存任务");
    assert.equal(calls.update[0].input.name, "原工作空间的任务草稿");
  });
}

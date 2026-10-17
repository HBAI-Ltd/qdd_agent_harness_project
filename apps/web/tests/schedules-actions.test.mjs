import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { afterEach, test } from "node:test";
import { compileScript, parse } from "@vue/compiler-sfc";
import { createRenderer, nextTick, ref } from "vue";

const moduleUrl = (source) => "data:text/javascript," + encodeURIComponent(source);
const vueUrl = import.meta.resolve("vue");
const scheduleApiUrl = new URL("../src/api/schedules.ts", import.meta.url).href;
const contextUrl = moduleUrl(`
  let current;
  export function setContext(value) { current = value; }
  export function useWorkspaceContext() { return current; }
  export function useGatewayResource(key) { return current.resources[key]; }
`);
const apiUrl = moduleUrl(`
  export { canNotify, scheduleCron, scheduleInput } from ${JSON.stringify(scheduleApiUrl)};
  let handlers;
  export function setApi(value) { handlers = value; }
  export const listSkills = () => Promise.resolve([]);
  export const listConnectors = () => Promise.resolve([]);
  export const listSchedules = () => Promise.resolve([]);
  export const createSchedule = (...args) => handlers.create(...args);
  export const updateSchedule = (...args) => handlers.update(...args);
  export const deleteSchedule = (...args) => handlers.remove(...args);
  export const runSchedule = (...args) => handlers.run(...args);
`);
const controlsUrl = moduleUrl(`
  import { h } from "vue";
  const container = (tag) => ({ setup: (_, { attrs, slots }) => () => h(tag, attrs, slots.default?.()) });
  export const ElButton = {
    inheritAttrs: false, props: ["disabled", "loading"],
    setup: (props, { attrs, slots }) => () => h("button", { ...attrs, disabled: !!(props.disabled || props.loading) }, slots.default?.()),
  };
  export const ElInput = {
    inheritAttrs: false, props: ["modelValue", "type", "disabled"], emits: ["update:modelValue"],
    setup: (props, { attrs, emit }) => () => h(props.type === "textarea" ? "textarea" : "input", {
      ...attrs, value: props.modelValue, disabled: props.disabled, onInput: (event) => emit("update:modelValue", event.target.value),
    }),
  };
  export const ElSelect = {
    inheritAttrs: false, props: ["modelValue", "disabled"], emits: ["update:modelValue"],
    setup: (props, { attrs, emit, slots }) => () => h("select", {
      ...attrs, value: props.modelValue, disabled: props.disabled, onChange: (event) => emit("update:modelValue", event.target.value),
    }, slots.default?.()),
  };
  export const ElTimePicker = ElInput;
  export const ElSwitch = {
    inheritAttrs: false, props: ["modelValue", "disabled", "loading"], emits: ["update:modelValue", "change"],
    setup: (props, { attrs, emit }) => () => h("input", {
      ...attrs, type: "checkbox", checked: props.modelValue, disabled: props.disabled || props.loading,
      onChange(event) { emit("update:modelValue", event.target.checked); emit("change", event.target.checked); },
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
  export const ElMessageBox = { async confirm() {} };
`);
const iconUrl = moduleUrl('import { h } from "vue"; export default { setup: () => () => h("svg") };');
const optionUrl = moduleUrl('import { h } from "vue"; export default { props: ["value", "label", "disabled"], setup: (props) => () => h("option", { value: props.value, disabled: props.disabled }, props.label) };');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith("data:text/javascript,")) {
      if (specifier === "vue") return { url: vueUrl, shortCircuit: true };
      if (specifier.startsWith("element-plus/es/components/")) return { url: controlsUrl, shortCircuit: true };
      if (specifier === "@/components/AgentIcon.vue") return { url: iconUrl, shortCircuit: true };
      if (specifier === "@/components/StringSelectOption") return { url: optionUrl, shortCircuit: true };
      if (specifier.startsWith("@/composables/")) return { url: contextUrl, shortCircuit: true };
      if (specifier.startsWith("@/api/")) return { url: apiUrl, shortCircuit: true };
    }
    if (specifier === "./workspace" && context.parentURL === scheduleApiUrl) {
      return { url: new URL("../src/api/workspace.ts", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const source = await readFile(new URL("../src/views/schedules/index.vue", import.meta.url), "utf8");
const { descriptor } = parse(source);
const script = compileScript(descriptor, { id: "schedules-actions-test", inlineTemplate: true });
const { default: SchedulesView } = await import(moduleUrl(stripTypeScriptTypes(script.content, { mode: "strip" })));
const { setContext } = await import(contextUrl);
const { setApi } = await import(apiUrl);
const mounted = [];
const at = "2026-10-17T03:00:00Z";
const schedule = (extra = {}) => ({
  id: "daily", name: "经营日报", cron: "0 8 * * *", prompt: "整理昨日经营数据", enabled: true,
  nextRunAt: "2026-10-18T00:00:00Z", createdAt: at, updatedAt: at, ...extra,
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
async function mount({ schedules = [schedule()], sessions = [] } = {}) {
  const root = { children: [] };
  const calls = { create: [], update: [], remove: [], run: [], sessions: [], pages: [], notices: [], refresh: 0 };
  const resources = {
    schedules: { data: ref(schedules), loading: ref(false), error: ref(""), async refresh() { calls.refresh++; } },
    skills: { data: ref([]), loading: ref(false), error: ref(""), async refresh() {} },
    connectors: { data: ref({ connectors: [], catalog: [] }), loading: ref(false), error: ref(""), async refresh() {} },
  };
  const workspace = {
    connected: ref(true), gatewayUrl: ref("http://fixture.test"), token: ref("fixture-token"),
    pages: ref([]), sessions: ref(sessions),
  };
  const navigation = { openSession(id) { calls.sessions.push(id); }, openPage(slug) { calls.pages.push(slug); }, openView() {} };
  const api = {
    async create(base, token, input, signal) { calls.create.push({ base, token, input, signal }); return schedule(input); },
    async update(base, token, id, input, signal) { calls.update.push({ base, token, id, input, signal }); return schedule(input); },
    async remove(base, token, id, signal) { calls.remove.push({ base, token, id, signal }); },
    async run(base, token, id, signal) { calls.run.push({ base, token, id, signal }); return { sessionId: "launched-session" }; },
  };
  setApi(api);
  setContext({ workspace, navigation, resources, notify(value) { calls.notices.push(value); } });
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
const field = (root, key, value) => findAll(root, (node) => node.props?.[key] === value)[0];
async function click(root, label) {
  const target = button(root, label);
  assert.ok(target, `button exists: ${label}`);
  assert.equal(target.props.disabled, false, `button enabled: ${label}`);
  await target.props.onClick();
  await nextTick();
}
async function input(node, value) { node.props.onInput({ target: { value } }); await nextTick(); }
async function select(node, value) { node.props.onChange({ target: { value } }); await nextTick(); }
afterEach(() => { for (const app of mounted.splice(0)) app.unmount(); });

test("pause and enable submit partial updates, then refresh and show the actual outcome", async () => {
  const { root, resources, calls } = await mount();
  const pause = field(root, "aria-label", "暂停经营日报");
  pause.props.onChange({ target: { checked: false } });
  await nextTick();
  await nextTick();
  assert.equal(calls.update[0].id, "daily");
  assert.deepEqual(calls.update[0].input, { enabled: false });
  assert.ok(calls.update[0].signal instanceof AbortSignal);
  assert.equal(calls.notices[0], "已暂停后续定时执行");
  resources.schedules.data.value = [schedule({ enabled: false })];
  await nextTick();
  const enable = field(root, "aria-label", "启用经营日报");
  enable.props.onChange({ target: { checked: true } });
  await nextTick();
  await nextTick();
  assert.deepEqual(calls.update[1].input, { enabled: true });
  assert.equal(calls.notices[1], "已启用定时执行");
  assert.equal(calls.refresh, 2);
});

test("agent-created schedules link to their creation conversation separately from execution", async () => {
  const { root, calls, resources } = await mount({ schedules: [schedule({
    createdBy: { kind: "agent", sessionId: "creation-session" },
    lastRun: { sessionId: "execution-session", at, status: "ok", message: "完成" },
  })] });
  assert.match(textContent(root), /助手经确认创建/);
  await click(root, "查看创建对话");
  await click(root, "查看执行对话");
  assert.deepEqual(calls.sessions, ["creation-session", "execution-session"]);
  resources.schedules.data.value = [schedule()];
  await nextTick();
  assert.equal(button(root, "查看创建对话"), undefined);
  assert.doesNotMatch(textContent(root), /助手经确认创建/);
});

test("execution links and waiting state use schedule runtime data independently of conversation history", async () => {
  const { root, workspace, resources, calls } = await mount({ schedules: [schedule({ slug: "daily-page" })] });
  await click(root, "立即运行");
  assert.equal(calls.run[0].id, "daily");
  assert.equal(calls.notices[0], "任务已开始执行");
  await click(root, "查看执行对话");
  assert.deepEqual(calls.sessions, ["launched-session"]);
  await click(root, "打开关联页面");
  assert.deepEqual(calls.pages, ["daily-page"]);
  resources.schedules.data.value = [schedule({ currentRun: { sessionId: "active-session", status: "running" } })];
  await nextTick();
  assert.match(textContent(root), /正在执行/);
  assert.equal(button(root, "立即运行").props.disabled, true);
  resources.schedules.data.value = [schedule({ currentRun: { sessionId: "active-session", status: "waiting" } })];
  await nextTick();
  assert.match(textContent(root), /等待确认/);
  assert.equal(button(root, "立即运行").props.disabled, true);
  await click(root, "查看执行对话");
  assert.equal(calls.sessions.at(-1), "active-session");
  assert.deepEqual(workspace.sessions.value, []);
  resources.schedules.data.value = [schedule({ lastRun: { sessionId: "launched-session", at, status: "ok", message: "完成" } })];
  await nextTick();
  await click(root, "查看执行对话");
  assert.equal(calls.sessions.at(-1), "launched-session");
});

test("run failures are visible and pending operations prevent duplicate submission", async () => {
  const { root, api, calls } = await mount();
  const run = api.run;
  let reject;
  api.run = (...args) => {
    calls.run.push(args);
    return new Promise((_resolve, fail) => { reject = fail; });
  };
  const pending = button(root, "立即运行").props.onClick();
  await nextTick();
  assert.equal(button(root, "立即运行").props.disabled, true);
  assert.equal(button(root, "编辑").props.disabled, true);
  await button(root, "立即运行").props.onClick();
  assert.equal(calls.run.length, 1);
  reject(new Error("该任务已有对话正在执行"));
  await pending;
  await nextTick();
  assert.match(textContent(root), /该任务已有对话正在执行/);
  assert.equal(button(root, "立即运行").props.disabled, false);
  api.run = run;
  await click(root, "立即运行");
  assert.doesNotMatch(textContent(root), /该任务已有对话正在执行/);
  assert.equal(calls.notices.at(-1), "任务已开始执行");
});

test("editing retains a custom cron and submits explicit detach values for optional links", async () => {
  const { root, calls } = await mount({ schedules: [schedule({ cron: "15 7,19 * * 1-5" })] });
  assert.match(textContent(root), /自定义执行规则/);
  await click(root, "编辑");
  assert.equal(field(root, "id", "schedule-frequency").props.value, "custom");
  const cron = field(root, "placeholder", "分 时 日 月 周，例如：0 8 * * *");
  assert.equal(cron.props.value, "15 7,19 * * 1-5");
  await input(cron, "  30 6,18 * * 1-6  ");
  await click(root, "保存任务");
  assert.equal(calls.update[0].input.cron, "30 6,18 * * 1-6");
  assert.deepEqual({ skillId: calls.update[0].input.skillId, slug: calls.update[0].input.slug, notify: calls.update[0].input.notify }, { skillId: null, slug: null, notify: null });
});

test("creating a weekly task sends the selected weekday and gateway-time cron", async () => {
  const { root, calls } = await mount({ schedules: [] });
  await click(root, "新建定时任务");
  await input(field(root, "placeholder", "例如：每天的经营日报"), "每周经营巡检");
  await input(field(root, "placeholder", "描述需要检查的数据、分析内容和提醒条件"), "检查门店库存并整理建议");
  await select(field(root, "id", "schedule-frequency"), "weekly");
  await input(field(root, "aria-label", "任务执行时间"), "09:35");
  await select(field(root, "id", "schedule-weekday"), "6");
  await click(root, "保存任务");
  assert.equal(calls.create[0].input.cron, "35 9 * * 6");
  assert.equal(calls.create[0].input.name, "每周经营巡检");
  assert.equal(calls.create[0].base, "http://fixture.test");
  assert.equal(calls.create[0].token, "fixture-token");
  assert.equal(calls.notices.at(-1), "定时任务已创建");
});

test("invalid custom cron preserves the editor and does not send a request", async () => {
  const { root, calls } = await mount({ schedules: [schedule({ cron: "15 7,19 * * 1-5" })] });
  await click(root, "编辑");
  await input(field(root, "placeholder", "分 时 日 月 周，例如：0 8 * * *"), "0 8 * *");
  await click(root, "保存任务");
  assert.match(textContent(root), /执行规则需要填写 5 段 cron/);
  assert.equal(findAll(root, (node) => node.tag === "dialog").length, 1);
  assert.equal(calls.update.length, 0);
});

test("changing gateway identity aborts a pending run and ignores its late session id", async () => {
  const { root, workspace, api, calls } = await mount();
  let finish;
  let signal;
  api.run = (_base, _token, _id, currentSignal) => {
    signal = currentSignal;
    return new Promise((resolve) => { finish = resolve; });
  };
  const pending = button(root, "立即运行").props.onClick();
  await nextTick();
  workspace.token.value = "new-fixture-token";
  assert.equal(signal.aborted, true);
  finish({ sessionId: "stale-session" });
  await pending;
  await nextTick();
  assert.equal(button(root, "查看执行对话"), undefined);
  assert.equal(calls.notices.length, 0);
  assert.equal(calls.refresh, 0);
  assert.equal(button(root, "立即运行").props.disabled, false);
});

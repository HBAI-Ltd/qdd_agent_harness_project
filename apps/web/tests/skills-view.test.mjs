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
const apiUrl = moduleUrl(`
  let handlers;
  export function setApi(value) { handlers = value; }
  export const listSkills = () => Promise.resolve([]);
  export const gatewayJson = () => Promise.resolve([]);
  export const createSkill = (...args) => handlers.create(...args);
  export const updateSkill = (...args) => handlers.update(...args);
  export const deleteSkill = (...args) => handlers.remove(...args);
`);
const controlsUrl = moduleUrl(`
  import { h } from "vue";
  const container = (tag) => ({ setup: (_, { attrs, slots }) => () => h(tag, attrs, slots.default?.()) });
  export const ElButton = {
    inheritAttrs: false, props: ["disabled", "loading", "nativeType"],
    setup: (props, { attrs, slots }) => () => h("button", { ...attrs, type: props.nativeType || "button", disabled: props.disabled || props.loading }, slots.default?.()),
  };
  export const ElInput = {
    inheritAttrs: false, props: ["modelValue", "type", "disabled"], emits: ["update:modelValue"],
    setup(props, { attrs, emit, expose }) {
      expose({ focus() {} });
      return () => h(props.type === "textarea" ? "textarea" : "input", {
        ...attrs, value: props.modelValue, disabled: props.disabled,
        onInput: (event) => emit("update:modelValue", event.target.value),
      });
    },
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
  export const ElCheckboxGroup = container("div");
  export const ElCheckbox = container("label");
  export const confirmations = [];
  export const ElMessageBox = { async confirm(...args) { confirmations.push(args); } };
`);
const iconUrl = moduleUrl('import { h } from "vue"; export default { setup: () => () => h("svg") };');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith("data:text/javascript,")) {
      if (specifier === "vue") return { url: vueUrl, shortCircuit: true };
      if (specifier === "element-plus") return { url: controlsUrl, shortCircuit: true };
      if (specifier === "@/components/AgentIcon.vue") return { url: iconUrl, shortCircuit: true };
      if (specifier.startsWith("@/composables/")) return { url: contextUrl, shortCircuit: true };
      if (specifier.startsWith("@/api/")) return { url: apiUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

// Exercise the actual view template, including rendered states and button handlers.
const source = await readFile(new URL("../src/views/skills/index.vue", import.meta.url), "utf8");
const { descriptor } = parse(source);
const script = compileScript(descriptor, { id: "skills-view-test", inlineTemplate: true });
const { default: SkillsView } = await import(moduleUrl(stripTypeScriptTypes(script.content, { mode: "strip" })));
const { setContext } = await import(contextUrl);
const { setApi } = await import(apiUrl);
const { confirmations } = await import(controlsUrl);
const mounted = [];
const at = "2026-10-17T03:00:00Z";
const skill = (id, name, extra = {}) => ({
  id, name, description: "", steps: ["检查门店经营数据"], tools: [], source: "user", createdAt: at, updatedAt: at, ...extra,
});
const fixtures = [
  skill("inventory", "库存检查", { description: "检查每日库存", steps: ["查找低于安全库存的商品", "整理补货建议"], tools: ["inventory_read", "custom_tool"] }),
  skill("daily", "经营日报", { source: "agent", description: "每天整理经营表现", steps: ["汇总昨日销售额"], sessionId: "source-session" }),
];

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

async function mount({ skills = fixtures, connected = true, loading = false, error = "" } = {}) {
  const root = { children: [] };
  const calls = { create: [], update: [], remove: [], run: [], views: [], sessions: [], notices: [], refresh: 0 };
  const resources = {
    skills: { data: ref(skills), loading: ref(loading), error: ref(error), async refresh() { calls.refresh++; } },
    connectors: { data: ref([{ name: "inventory_read", description: "读取库存：商品当前库存" }]), loading: ref(false), error: ref(""), async refresh() {} },
  };
  const workspace = { connected: ref(connected), gatewayUrl: ref("http://fixture.test"), token: ref("fixture-token") };
  const navigation = {
    async runSkill(value) { calls.run.push(value); },
    async openView(value) { calls.views.push(value); },
    async openSession(value) { calls.sessions.push(value); },
  };
  const api = {
    async create(base, token, input, signal) { calls.create.push({ base, token, input, signal }); return skill("created", input.name, input); },
    async update(base, token, id, input, signal) { calls.update.push({ base, token, id, input, signal }); return skill(id, input.name, input); },
    async remove(base, token, id, signal) { calls.remove.push({ base, token, id, signal }); },
  };
  setApi(api);
  setContext({ workspace, navigation, resources, notify(value) { calls.notices.push(value); } });
  const app = renderer.createApp(SkillsView);
  app.mount(root);
  mounted.push(app);
  await nextTick();
  return { root, workspace, navigation, resources, calls, api };
}

function findAll(root, predicate) {
  return [...(predicate(root) ? [root] : []), ...root.children.flatMap((child) => findAll(child, predicate))];
}
const textContent = (node) => (node.text ?? "") + node.children.map(textContent).join("");
const hasClass = (value) => (node) => (node.props?.class ?? "").split(" ").includes(value);
const button = (root, label) => findAll(root, (node) => node.tag === "button" && (node.props["aria-label"] === label || textContent(node).trim() === label))[0];
const byId = (root, id) => findAll(root, (node) => node.props?.id === id)[0];
const search = (root) => findAll(root, (node) => node.tag === "input" && node.props["aria-label"] === "搜索已保存技能")[0];
const selectedNames = (root) => findAll(root, hasClass("skill-select")).map((node) => textContent(findAll(node, (entry) => entry.tag === "strong")[0]));
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
  confirmations.length = 0;
});

test("source filters combine with step search and clear unmatched selections", async () => {
  const { root } = await mount();
  assert.deepEqual(selectedNames(root), ["库存检查", "经营日报"]);
  await click(root, "对话提炼1");
  assert.deepEqual(selectedNames(root), ["经营日报"]);
  assert.equal(textContent(byId(root, "skill-detail-title")), "经营日报");
  await click(root, "全部2");
  await input(search(root), "安全库存");
  assert.deepEqual(selectedNames(root), ["库存检查"]);
  await input(search(root), "不存在的技能");
  assert.match(textContent(root), /没有找到匹配的技能/);
  assert.equal(byId(root, "skill-detail"), undefined);
  await click(root, "清除搜索和筛选");
  assert.deepEqual(selectedNames(root), ["库存检查", "经营日报"]);
});

test("loading, initial failure and disconnect each have actionable states instead of an empty library", async () => {
  const { root, resources, workspace, calls } = await mount({ skills: undefined, loading: true });
  // An explicit missing response represents the first request still in flight.
  resources.skills.data.value = undefined;
  await nextTick();
  assert.equal(findAll(root, (node) => node.props?.["aria-label"] === "正在加载技能库").length, 1);
  resources.skills.loading.value = false;
  resources.skills.error.value = "访问权限不足";
  await nextTick();
  assert.match(textContent(root), /技能库暂时没有加载成功/);
  assert.doesNotMatch(textContent(root), /从一个常做的任务开始/);
  await click(root, "重新加载");
  assert.equal(calls.refresh, 1);
  workspace.connected.value = false;
  await nextTick();
  assert.match(textContent(root), /连接工作空间，打开你的技能库/);
  await click(root, "连接工作空间");
  assert.deepEqual(calls.views, ["settings"]);
  await click(root, "浏览模板");
  assert.equal(findAll(root, hasClass("template-card")).length, 5);
  assert.equal(button(root, "使用模板").props.disabled, true);
});

test("template customization sends reordered steps and selects the saved skill", async () => {
  const { root, calls } = await mount({ skills: [] });
  await click(root, "挑选技能模板");
  assert.equal(findAll(root, hasClass("template-card")).length, 5);
  await click(root, "使用模板");
  const originalSteps = findAll(root, (node) => node.tag === "textarea").slice(0, 3).map((node) => node.props.value);
  await click(root, "下移第 1 个步骤");
  assert.equal(byId(root, "skill-editor-step-0").props.value, originalSteps[1]);
  await click(root, "移除第 3 个步骤");
  await click(root, "添加步骤");
  await input(byId(root, "skill-editor-step-2"), "整理处理建议，提交店长确认");
  await input(byId(root, "skill-editor-name"), "每日临期巡检");
  await click(root, "创建技能");
  assert.deepEqual(calls.create[0].input.steps, [originalSteps[1], originalSteps[0], "整理处理建议，提交店长确认"]);
  assert.equal(calls.create[0].base, "http://fixture.test");
  assert.equal(calls.create[0].token, "fixture-token");
  assert.equal(calls.notices[0], "技能已创建");
  assert.equal(findAll(root, (node) => node.tag === "dialog").length, 0);
  assert.equal(textContent(byId(root, "skill-detail-title")), "每日临期巡检");
  assert.deepEqual(selectedNames(root), ["每日临期巡检"]);
});

test("failed editing preserves the draft and retry preserves known and custom tools", async () => {
  const { root, api, calls } = await mount();
  const update = api.update;
  api.update = async () => { throw new Error("技能暂时无法保存"); };
  await click(root, "编辑");
  await input(byId(root, "skill-editor-name"), "每日库存检查");
  await click(root, "保存修改");
  assert.match(textContent(root), /技能暂时无法保存/);
  assert.equal(byId(root, "skill-editor-name").props.value, "每日库存检查");
  assert.equal(byId(root, "skill-editor-extra-tools").props.value, "custom_tool");
  api.update = update;
  await click(root, "保存修改");
  assert.equal(calls.create.length, 0);
  assert.equal(calls.update[0].id, "inventory");
  assert.deepEqual(calls.update[0].input.tools, ["inventory_read", "custom_tool"]);
  assert.equal(textContent(byId(root, "skill-detail-title")), "每日库存检查");
});

test("disconnect keeps the skill draft visible and offline saving explains why it cannot save", async () => {
  const { root, workspace, calls } = await mount();
  await click(root, "编辑");
  await input(byId(root, "skill-editor-name"), "断连时保留的库存检查");
  workspace.connected.value = false;
  await nextTick();
  assert.equal(byId(root, "skill-editor-name")?.props.value, "断连时保留的库存检查");
  assert.match(textContent(root), /未连接.*编辑内容已保留/);
  await click(root, "保存修改");
  assert.equal(calls.update.length, 0);
  assert.equal(calls.notices.length, 0);
  workspace.connected.value = true;
  await nextTick();
  await click(root, "保存修改");
  assert.equal(calls.update[0].input.name, "断连时保留的库存检查");
  assert.deepEqual(calls.notices, ["技能已更新"]);
});

test("disconnect during skill creation aborts the request and ignores a late success", async () => {
  const { root, workspace, calls, api } = await mount({ skills: [] });
  const create = api.create;
  let complete;
  let signal;
  api.create = (...args) => {
    signal = args[3];
    return new Promise((resolve) => { complete = resolve; });
  };
  await click(root, "新建技能");
  await input(byId(root, "skill-editor-name"), "保存中断的技能");
  await input(byId(root, "skill-editor-step-0"), "检查库存");
  const pending = click(root, "创建技能");
  workspace.connected.value = false;
  await nextTick();
  assert.equal(signal.aborted, true);
  assert.match(textContent(root), /保存结果.*未确认/);
  assert.equal(byId(root, "skill-editor-name")?.props.value, "保存中断的技能");
  complete(skill("late", "不应当显示为成功"));
  await pending;
  assert.deepEqual(calls.notices, []);
  assert.deepEqual(selectedNames(root), []);
  workspace.connected.value = true;
  await nextTick();
  assert.match(textContent(root), /保存结果.*未确认/);
  api.create = create;
  await click(root, "创建技能");
  assert.equal(calls.create[0].input.name, "保存中断的技能");
  assert.deepEqual(calls.notices, ["技能已创建"]);
});

for (const field of ["gatewayUrl", "token"]) {
  test(`skill drafts cannot be silently written after ${field} changes`, async () => {
    const { root, workspace, calls } = await mount();
    await click(root, "编辑");
    await input(byId(root, "skill-editor-name"), "原工作空间的草稿");
    const original = workspace[field].value;
    workspace[field].value = "changed-connection";
    await nextTick();
    assert.equal(byId(root, "skill-editor-name")?.props.value, "原工作空间的草稿");
    await click(root, "保存修改");
    assert.match(textContent(root), /连接配置已更改/);
    assert.deepEqual(calls.update, []);
    assert.deepEqual(calls.notices, []);
    workspace[field].value = original;
    await nextTick();
    await click(root, "保存修改");
    assert.equal(calls.update[0].input.name, "原工作空间的草稿");
  });
}

test("empty steps are rejected and the last step cannot be removed", async () => {
  const { root, calls } = await mount();
  await click(root, "新建技能");
  await input(byId(root, "skill-editor-name"), "库存检查");
  await click(root, "创建技能");
  assert.match(textContent(root), /请填写 1–12 个完整步骤/);
  assert.equal(calls.create.length, 0);
  assert.equal(button(root, "移除第 1 个步骤").props.disabled, true);
  assert.equal(button(root, "上移第 1 个步骤").props.disabled, true);
  assert.equal(button(root, "下移第 1 个步骤").props.disabled, true);
});

test("run and source navigation use the selected skill, and deletion updates the library immediately", async () => {
  const { root, calls } = await mount();
  await click(root, "查看技能：经营日报");
  await click(root, "运行技能");
  assert.equal(calls.run[0].id, "daily");
  await click(root, "查看来源对话");
  assert.deepEqual(calls.sessions, ["source-session"]);
  await click(root, "删除技能");
  assert.match(confirmations[0][0], /经营日报/);
  assert.equal(calls.remove[0].id, "daily");
  assert.deepEqual(selectedNames(root), ["库存检查"]);
  assert.equal(textContent(byId(root, "skill-detail-title")), "库存检查");
});

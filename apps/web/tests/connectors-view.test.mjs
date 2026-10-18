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
  export const listConnectors = () => Promise.resolve({ connectors: [], catalog: [] });
  export const installConnector = (...args) => handlers.install(...args);
  export const updateConnector = (...args) => handlers.update(...args);
  export const verifyConnector = (...args) => handlers.verify(...args);
  export const testConnector = (...args) => handlers.test(...args);
  export const deleteConnector = (...args) => handlers.remove(...args);
`);
const cameraUrl = moduleUrl(`
  export const listCameraAccounts = () => Promise.resolve([]);
  export const providerOf = (id) => id === "mcp:haik" ? "haik" : id === "mcp:tysl" ? "tysl" : undefined;
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
    setup: (props, { attrs, emit }) => () => h("input", {
      ...attrs, value: props.modelValue, disabled: props.disabled,
      onInput: (event) => emit("update:modelValue", event.target.value),
    }),
  };
  export const ElSelect = {
    inheritAttrs: false, props: ["modelValue", "disabled"], emits: ["update:modelValue"],
    setup: (props, { attrs, emit, slots }) => () => h("select", {
      ...attrs, value: props.modelValue, disabled: props.disabled,
      onChange: (event) => emit("update:modelValue", event.target.value),
    }, slots.default?.()),
  };
  export const ElDialog = {
    props: ["modelValue", "title"],
    setup: (props, { slots }) => () => props.modelValue ? h("dialog", { open: true }, [h("h2", props.title), slots.default?.(), slots.footer?.()]) : null,
  };
  export const ElAlert = { props: ["title"], setup: (props) => () => h("p", { role: "alert" }, props.title) };
  export const ElEmpty = container("div");
  export const ElForm = container("form");
  export const ElFormItem = container("label");
  export const ElCard = container("article");
  export const ElTag = container("span");
  export const ElSkeleton = container("div");
  export const ElRadioGroup = container("div");
  export const ElRadioButton = container("span");
`);
const emptyUrl = moduleUrl('export default { setup: () => () => null };');
const optionUrl = moduleUrl('import { h } from "vue"; export default { props: ["value", "label", "disabled"], setup: (props) => () => h("option", { value: props.value, disabled: props.disabled }, props.label) };');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith("data:text/javascript,")) {
      if (specifier === "vue") return { url: vueUrl, shortCircuit: true };
      if (specifier.startsWith("element-plus/es/components/")) return { url: controlsUrl, shortCircuit: true };
      if (specifier === "@/components/StringSelectOption") return { url: optionUrl, shortCircuit: true };
      if (specifier.startsWith("@/components/")) return { url: emptyUrl, shortCircuit: true };
      if (specifier.startsWith("@/composables/")) return { url: contextUrl, shortCircuit: true };
      if (specifier === "@/api/cameras") return { url: cameraUrl, shortCircuit: true };
      if (specifier === "@/api/connectors") return { url: apiUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

// Render the real connector view and exercise the user-controlled installation flow.
const source = await readFile(new URL("../src/views/connectors/index.vue", import.meta.url), "utf8");
const { descriptor } = parse(source);
const script = compileScript(descriptor, { id: "connectors-view-test", inlineTemplate: true });
const { default: ConnectorsView } = await import(moduleUrl(stripTypeScriptTypes(script.content, { mode: "strip" })));
const { setContext } = await import(contextUrl);
const { setApi } = await import(apiUrl);
const mounted = [];
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
const cameraCatalog = { type: "camera", name: "门店摄像头", category: "设备", available: true, modes: ["mcp"], tags: [], providers: [{ id: "haik", name: "海康互联" }, { id: "tysl", name: "天翼视联" }, { id: "ezviz", name: "萤石" }] };
const posCatalog = { type: "pos", name: "收银系统", category: "经营", available: true, modes: ["mcp"], tags: [], providers: [{ id: "shouqianba", name: "收钱吧" }] };
const mcpConnector = { id: "mcp:ezviz", type: "camera", name: "萤石摄像头", origin: "installed", permission: "confirm", status: "connected", detail: "本地服务已连接", config: { mode: "mcp", provider: "ezviz", consoleUrl: "http://127.0.0.1:8791/" }, lastVerifiedAt: null, createdAt: null };
async function mount({ catalog = [cameraCatalog], connectors = [] } = {}) {
  const root = { children: [] };
  const calls = { install: [], update: [], verify: [], test: [], remove: [], notices: [] };
  const resources = { connectors: { data: ref({ catalog, connectors }), loading: ref(false), error: ref(""), async refresh() {} } };
  const workspace = { connected: ref(true), gatewayUrl: ref("http://fixture.test"), token: ref("fixture-token") };
  setApi({
    async install(...args) { calls.install.push(args); return mcpConnector; },
    async update(...args) { calls.update.push(args); return mcpConnector; },
    async verify(...args) { calls.verify.push(args); return mcpConnector; },
    async test(...args) { calls.test.push(args); return { ok: true }; },
    async remove(...args) { calls.remove.push(args); return { ok: true }; },
  });
  setContext({ workspace, navigation: {}, resources, notify(value) { calls.notices.push(value); } });
  const app = renderer.createApp(ConnectorsView);
  app.mount(root);
  mounted.push(app);
  await nextTick();
  return { root, calls };
}
function findAll(root, predicate) {
  return [...(predicate(root) ? [root] : []), ...root.children.flatMap((child) => findAll(child, predicate))];
}
const textContent = (node) => (node.text ?? "") + node.children.map(textContent).join("");
const button = (root, label) => findAll(root, (node) => node.tag === "button" && textContent(node).trim() === label)[0];
const providerSelect = (root) => findAll(root, (node) => node.props?.["aria-label"] === "接入平台")[0];
async function click(root, label) {
  const target = button(root, label);
  assert.ok(target, `button exists: ${label}`);
  assert.notEqual(target.props.disabled, true);
  await target.props.onClick();
  await nextTick();
}
async function choose(root, provider) {
  providerSelect(root).props.onChange({ target: { value: provider } });
  await nextTick();
}
afterEach(() => { for (const app of mounted.splice(0)) app.unmount(); });

test("camera platforms start unselected and install only the explicitly confirmed selection", async () => {
  const { root, calls } = await mount();
  assert.equal(calls.install.length, 0);
  await click(root, "安装连接器");
  assert.equal(providerSelect(root).props.value, "");
  assert.deepEqual(findAll(providerSelect(root), (node) => node.tag === "option").map((node) => node.props.value), ["haik", "tysl", "ezviz"]);
  assert.equal(calls.install.length, 0);
  await click(root, "验证并安装");
  assert.match(textContent(root), /请选择要接入的平台/);
  assert.equal(calls.install.length, 0);
  await choose(root, "ezviz");
  assert.equal(calls.install.length, 0);
  await click(root, "验证并安装");
  assert.deepEqual(calls.install[0].slice(0, 3), ["http://fixture.test", "fixture-token", { type: "camera", mode: "mcp", provider: "ezviz" }]);
  assert.equal(calls.install.length, 1);
  assert.equal(providerSelect(root), undefined);
});

test("POS requires a selection even with a single provider and cancellation installs nothing", async () => {
  const { root, calls } = await mount({ catalog: [posCatalog] });
  await click(root, "安装连接器");
  assert.equal(providerSelect(root).props.value, "");
  await choose(root, "shouqianba");
  await click(root, "取消");
  assert.equal(calls.install.length, 0);
  await click(root, "安装连接器");
  assert.equal(providerSelect(root).props.value, "");
  await choose(root, "shouqianba");
  await click(root, "验证并安装");
  assert.deepEqual(calls.install[0][2], { type: "pos", mode: "mcp", provider: "shouqianba" });
});

test("already installed providers are disabled and duplicate requests are rejected locally", async () => {
  const { root, calls } = await mount({ connectors: [mcpConnector] });
  await click(root, "安装连接器");
  const option = findAll(root, (node) => node.tag === "option" && node.props.value === "ezviz")[0];
  assert.equal(option.props.disabled, true);
  await choose(root, "ezviz");
  await click(root, "验证并安装");
  assert.match(textContent(root), /这个平台已安装/);
  assert.equal(calls.install.length, 0);
});

test("installed MCP has its own console and name-only settings without Feishu controls", async () => {
  const { root, calls } = await mount({ connectors: [mcpConnector] });
  assert.equal(button(root, "测试消息"), undefined);
  assert.doesNotMatch(textContent(root), /App ID|App Secret|接收方/);
  const login = findAll(root, (node) => node.tag === "a" && textContent(node) === "打开登录控制台")[0];
  assert.equal(login.props.href, "http://127.0.0.1:8791/");
  await click(root, "设置");
  assert.doesNotMatch(textContent(root), /推送权限|助手自动推送/);
  await click(root, "保存设置");
  assert.deepEqual(calls.update[0].slice(2, 4), ["mcp:ezviz", { name: "萤石摄像头" }]);
  await click(root, "重新验证");
  assert.match(textContent(root), /检查本地服务与 MCP 工具/);
  await click(root, "开始验证");
  assert.equal(calls.verify[0][2], "mcp:ezviz");
});

test("Feishu retains its existing webhook form and install request", async () => {
  const { root, calls } = await mount({ catalog: [{ type: "feishu", name: "飞书", category: "通知", available: true, modes: ["webhook", "app"], tags: [] }] });
  await click(root, "安装连接器");
  assert.equal(providerSelect(root), undefined);
  const webhook = findAll(root, (node) => node.props?.placeholder?.startsWith("https://open.feishu.cn"))[0];
  webhook.props.onInput({ target: { value: "https://open.feishu.cn/open-apis/bot/v2/hook/fixture" } });
  await nextTick();
  await click(root, "验证并安装");
  assert.deepEqual(calls.install[0][2], { type: "feishu", mode: "webhook", permission: "confirm", webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/fixture" });
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { after, afterEach, test } from "node:test";
import { compileScript, parse } from "@vue/compiler-sfc";
import { createRenderer, h, nextTick, reactive } from "vue";

const vueUrl = import.meta.resolve("vue");
const apiUrl = "data:text/javascript," + encodeURIComponent(`
  export const calls = [];
  const request = (kind, base, token, signal, datasets) => new Promise((resolve, reject) => {
    calls.push({ kind, base, token, signal, datasets, resolve, reject });
  });
  export const listDatasets = (base, token, signal) => request("datasets", base, token, signal);
  export const getMetrics = (base, token, signal) => request("metrics", base, token, signal);
  export const refreshDatasets = (base, token, datasets, signal) => request("refresh", base, token, signal, datasets);
`);
const controlsUrl = "data:text/javascript," + encodeURIComponent(`
  import { h } from "vue";
  export const ElButton = { props: ["disabled", "loading"], setup: (props, { attrs, slots }) => () => h("button", { ...attrs, disabled: props.disabled || props.loading }, slots.default?.()) };
  export const ElAlert = { props: ["title", "type"], setup: (props) => () => h("div", { role: "alert", "data-type": props.type }, props.title) };
  export const ElCard = { setup: (_, { slots }) => () => h("section", [slots.header?.(), slots.default?.()]) };
  export const ElEmpty = { props: ["description"], setup: (props) => () => h("div", props.description) };
  export const ElSkeleton = { setup: () => () => h("div", "正在读取数据") };
  export const ElTag = { setup: (_, { slots }) => () => h("span", slots.default?.()) };
`);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith("data:text/javascript,")) {
      const url = specifier === "vue" ? vueUrl : specifier === "element-plus" ? controlsUrl : specifier === "@/api/datasets" ? apiUrl : undefined;
      if (url) return { url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { descriptor } = parse(await readFile(new URL("../src/components/WorkspaceData.vue", import.meta.url), "utf8"));
const compiled = compileScript(descriptor, { id: "workspace-data-test", inlineTemplate: true });
const { default: WorkspaceData } = await import("data:text/javascript," + encodeURIComponent(stripTypeScriptTypes(compiled.content, { mode: "strip" })));
const { calls } = await import(apiUrl);
const mounted = [];
afterEach(() => { for (const app of mounted.splice(0)) app.unmount(); calls.splice(0); });
after(() => { hooks.deregister(); });

function remove(node) {
  if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
  node.parent = null;
}
const renderer = createRenderer({
  createElement: (tag) => ({ tag, props: {}, children: [], parent: null }),
  createText: (text) => ({ text, children: [], parent: null }),
  createComment: (text) => ({ comment: text, children: [], parent: null }),
  setText: (node, text) => { node.text = text; },
  setElementText: (node, text) => { node.text = text; node.children = []; },
  patchProp: (node, key, _previous, value) => { node.props[key] = value; },
  insert(node, parent, anchor = null) {
    remove(node);
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
    node.parent = parent;
  },
  remove,
  parentNode: (node) => node.parent,
  nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
});
const at = "2026-10-17T03:00:00Z";
const manifest = (name, source) => ({ name, description: `${name}数据`, kind: "fact", fields: { id: "string" }, key: ["id"], version: `${name}-v1`, watermark: at, rowCount: 12, updatedAt: at, ...(source ? { source: { tool: `mcp__erp__${name}`, sinceArg: "since" } } : {}) });
const manifests = [manifest("sales", true), manifest("inventory", true), manifest("local", false)];
const metrics = {
  revenue: { label: "销售额", type: "flow", field: "revenue", unit: "¥" },
  profit: { label: "毛利", type: "flow", field: "profit", unit: "¥" },
  margin: { label: "毛利率", type: "ratio", numerator: "profit", denominator: "revenue", unit: "%", description: "毛利除以销售额", digits: 2 },
  stock: { label: "库存", type: "stock", field: "quantity", entity: "sku", digits: 0 },
  state: { label: "状态", type: "state", field: "state" },
};
function mount(extra = {}) {
  const props = reactive({ connected: true, gatewayUrl: "http://fixture-a.test", token: "token-a", ...extra });
  const root = { children: [] };
  const app = renderer.createApp({ setup: () => () => h(WorkspaceData, props) });
  app.mount(root);
  mounted.push(app);
  return { props, root, unmount: () => { mounted.splice(mounted.indexOf(app), 1); app.unmount(); } };
}
const textContent = (node) => (node.text ?? "") + node.children.map(textContent).join("");
const findAll = (node, predicate) => [...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => findAll(child, predicate))];
const button = (root, label) => findAll(root, (node) => node.tag === "button" && (textContent(node) === label || node.props["aria-label"] === label))[0];
const alerts = (root) => findAll(root, (node) => node.props?.role === "alert");
async function settle() { await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick(); }
async function resolveLoad(offset = 0, datasets = manifests, catalog = metrics) {
  assert.equal(calls[offset].kind, "datasets");
  assert.equal(calls[offset + 1].kind, "metrics");
  calls[offset].resolve(datasets);
  calls[offset + 1].resolve(catalog);
  await settle();
}

test("settings data panel loads real manifest and metric fields only after connection", async () => {
  const { props, root } = mount({ connected: false });
  assert.equal(calls.length, 0);
  assert.match(textContent(root), /连接网关后/);
  props.connected = true;
  await nextTick();
  await resolveLoad();
  assert.match(textContent(root), /sales-v1/);
  assert.match(textContent(root), /mcp__erp__sales.*增量参数 since/);
  assert.match(textContent(root), /本地数据（未配置增量来源）/);
  assert.match(textContent(root), /毛利 ÷ 销售额（先汇总，再计算）/);
  assert.match(textContent(root), /quantity · 期末值 · 按 sku 分别取值后汇总/);
  assert.match(textContent(root), /按状态区间统计 · 字段 state/);
  assert.match(textContent(root), /2 位小数/);
  assert.equal(button(root, "刷新数据集 local").props.disabled, true);
  assert.equal(button(root, "刷新数据集 sales").props.disabled, false);
});

test("all-source refresh reports HTTP 200 per-dataset failures and reloads current versions", async () => {
  const { root } = mount();
  await resolveLoad();
  const request = button(root, "刷新全部来源").props.onClick();
  assert.equal(calls[2].kind, "refresh");
  assert.equal(calls[2].datasets, undefined);
  await nextTick();
  assert.equal(button(root, "刷新全部来源").props.disabled, true);
  calls[2].resolve([
    { dataset: "sales", added: 4, version: "sales-v2", watermark: at },
    { dataset: "inventory", added: 0, version: "inventory-v1", watermark: at, error: "库存系统暂时不可用" },
  ]);
  await settle();
  await resolveLoad(3, [{ ...manifests[0], version: "sales-v2", rowCount: 16 }, ...manifests.slice(1)]);
  await request;
  await nextTick();
  assert.match(textContent(root), /1 个数据集刷新完成，1 个失败/);
  assert.match(textContent(root), /处理 4 行 · 版本 sales-v2/);
  assert.match(textContent(root), /刷新失败：库存系统暂时不可用/);
  assert.equal(alerts(root).some((alert) => alert.props["data-type"] === "warning"), true);
  assert.equal(button(root, "刷新全部来源").props.disabled, false);
});

test("single refresh uses the exact dataset, blocks duplicates, and explains empty backend results", async () => {
  const { root } = mount();
  await resolveLoad();
  const request = button(root, "刷新数据集 sales").props.onClick();
  await button(root, "刷新数据集 sales").props.onClick();
  assert.deepEqual(calls[2].datasets, ["sales"]);
  assert.equal(calls.length, 3);
  calls[2].resolve([]);
  await settle();
  await resolveLoad(3);
  await request;
  await nextTick();
  assert.match(textContent(root), /没有可刷新的来源，无需增量刷新/);
  assert.equal(alerts(root).some((alert) => alert.props["data-type"] === "success"), false);
});

test("one catalog failure preserves the other resource and retries without clearing useful data", async () => {
  const { root } = mount();
  calls[0].resolve(manifests);
  calls[1].reject(new Error("指标读取失败"));
  await settle();
  assert.match(textContent(root), /sales-v1/);
  assert.match(textContent(root), /指标读取失败/);
  const request = button(root, "重新读取").props.onClick();
  calls[2].reject(new TypeError("network"));
  calls[3].resolve(metrics);
  await request;
  await nextTick();
  assert.match(textContent(root), /sales-v1/);
  assert.match(textContent(root), /毛利率/);
  assert.match(textContent(root), /无法连接网关/);
});

test("switching gateway and token aborts old requests and rejects late reads and refresh results", async () => {
  const { props, root } = mount();
  const oldLoad = calls.slice();
  props.gatewayUrl = "http://fixture-b.test";
  props.token = "token-b";
  await nextTick();
  assert.ok(oldLoad.every((call) => call.signal.aborted));
  oldLoad[0].resolve([manifest("old-account", true)]);
  oldLoad[1].reject(new Error("old failure"));
  await settle();
  assert.doesNotMatch(textContent(root), /old-account|old failure/);
  const latestLoad = calls.length - 2;
  assert.ok(calls.slice(0, latestLoad).every((call) => call.signal.aborted));
  await resolveLoad(latestLoad);
  assert.equal(calls[latestLoad].base, "http://fixture-b.test");
  assert.equal(calls[latestLoad].token, "token-b");
  const refreshIndex = calls.length;
  const request = button(root, "刷新数据集 sales").props.onClick();
  props.token = "token-c";
  await nextTick();
  assert.equal(calls[refreshIndex].signal.aborted, true);
  calls[refreshIndex].resolve([{ dataset: "old-account", added: 9, version: "obsolete", watermark: at }]);
  await request;
  await nextTick();
  assert.doesNotMatch(textContent(root), /obsolete|old-account/);
  assert.equal(calls.length, refreshIndex + 3);
  await resolveLoad(refreshIndex + 1, [manifest("new-account", false)], {});
  assert.match(textContent(root), /new-account/);
  assert.equal(button(root, "刷新全部来源").props.disabled, true);
});

test("disconnect and unmount cancel data requests without displaying old failures", async () => {
  const { props, root, unmount } = mount();
  await resolveLoad();
  const request = button(root, "刷新数据集 sales").props.onClick();
  props.connected = false;
  await nextTick();
  assert.equal(calls[2].signal.aborted, true);
  calls[2].reject(new Error("old-account refresh failure"));
  await request;
  assert.doesNotMatch(textContent(root), /sales-v1|old-account/);
  props.connected = true;
  await nextTick();
  unmount();
  assert.ok(calls.slice(3).every((call) => call.signal.aborted));
  calls[3].resolve(manifests);
  calls[4].reject(new Error("unmounted failure"));
  await settle();
});

test("failed refresh surfaces backend errors and enables a new attempt", async () => {
  const { root } = mount();
  await resolveLoad();
  const request = button(root, "刷新数据集 sales").props.onClick();
  calls[2].reject(new Error("访问已过期，请重新连接"));
  await request;
  await nextTick();
  assert.match(textContent(root), /访问已过期，请重新连接/);
  assert.equal(button(root, "刷新数据集 sales").props.disabled, false);
  assert.equal(calls.length, 3);
});

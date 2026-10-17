import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { afterEach, test } from "node:test";
import { compileScript, parse } from "@vue/compiler-sfc";
import { createRenderer, h, nextTick, reactive } from "vue";

const moduleUrl = (source) => "data:text/javascript," + encodeURIComponent(source);
const vueUrl = import.meta.resolve("vue");
const controlsUrl = moduleUrl(`
  import { h } from "vue";
  const container = (tag) => ({ setup: (_, { attrs, slots }) => () => h(tag, attrs, slots.default?.()) });
  export const ElButton = {
    inheritAttrs: false, props: ["disabled", "loading"],
    setup: (props, { attrs, slots }) => () => h("button", { ...attrs, disabled: !!(props.disabled || props.loading) }, slots.default?.()),
  };
  export const ElCard = container("article"), ElCheckboxButton = container("label"), ElCheckboxGroup = container("div"),
    ElCollapse = container("section"), ElCollapseItem = container("details"), ElInput = container("input"),
    ElRadioButton = container("label"), ElRadioGroup = container("div");
`);
const iconUrl = moduleUrl('import { h } from "vue"; export default { setup: () => () => h("svg") };');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith("data:text/javascript,")) {
      if (specifier === "vue") return { url: vueUrl, shortCircuit: true };
      if (specifier.startsWith("element-plus/es/components/")) return { url: controlsUrl, shortCircuit: true };
      if (specifier === "@/components/AgentIcon.vue") return { url: iconUrl, shortCircuit: true };
      if (specifier === "@/utils/approvalPreview") return { url: new URL("../src/utils/approvalPreview.ts", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { descriptor } = parse(await readFile(new URL("../src/components/SessionActions.vue", import.meta.url), "utf8"));
const script = compileScript(descriptor, { id: "approval-preview-view-test", inlineTemplate: true });
const { default: SessionActions } = await import(moduleUrl(stripTypeScriptTypes(script.content, { mode: "strip" })));
const mounted = [];
const at = "2026-10-17T12:00:00Z";
const approval = (tool, args) => ({ type: "approval_required", at, requestId: "approval-1", source: "harness", tool, args });

function remove(node) {
  if (!node.parent) return;
  const index = node.parent.children.indexOf(node);
  if (index >= 0) node.parent.children.splice(index, 1);
  node.parent = null;
}
const renderer = createRenderer({
  patchProp: (node, key, _previous, value) => { node.props[key] = value; },
  insert(node, parent, anchor = null) {
    remove(node); node.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
  },
  remove,
  createElement: (tag) => ({ tag, props: {}, children: [], parent: null }),
  createText: (text) => ({ text, children: [], parent: null }),
  createComment: () => ({ children: [], parent: null }),
  setText: (node, text) => { node.text = text; },
  setElementText: (node, text) => { node.text = text; node.children = []; },
  parentNode: (node) => node.parent,
  nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
});
function mount(event, extra = {}) {
  const root = { children: [] };
  const props = reactive({ events: [event], status: "waiting", sessionId: "session-1", busy: false, ...extra });
  const approvals = [];
  const app = renderer.createApp({ setup: () => () => h(SessionActions, { ...props, onApprove: (...args) => approvals.push(args) }) });
  app.mount(root); mounted.push(app);
  return { root, props, approvals };
}
const textContent = (node) => (node.text ?? "") + node.children.map(textContent).join("");
function findAll(root, predicate) { return [...(predicate(root) ? [root] : []), ...root.children.flatMap((child) => findAll(child, predicate))]; }
const buttons = (root) => findAll(root, (node) => node.tag === "button");
const button = (root, label) => buttons(root).find((node) => textContent(node) === label);
afterEach(() => { for (const app of mounted.splice(0)) app.unmount(); });

test("record approval renders actual field summaries and sends only the selected explicit decision", async () => {
  const args = { name: "records/loss_log", label: "试吃报损登记", fields: ["数量（qty，number，必填）", "原因（reason，string：试吃/破损）"] };
  const { root, props, approvals } = mount(approval("define_record", args));
  const preview = findAll(root, (node) => node.props?.class === "operation-preview record-preview")[0];
  assert.ok(preview);
  assert.match(textContent(preview), /试吃报损登记.*records\/loss_log.*数量（qty，number，必填）.*试吃\/破损/);
  assert.match(textContent(preview), /已有字段会保留/);
  assert.equal(approvals.length, 0);
  button(root, "确认登记表结构").props.onClick();
  assert.deepEqual(approvals, [["approval-1", true]]);
  assert.deepEqual(args.fields, ["数量（qty，number，必填）", "原因（reason，string：试吃/破损）"]);
  props.events.push({ type: "approval_resolved", requestId: "approval-1", approved: true, at });
  await nextTick();
  assert.equal(buttons(root).length, 0);
});

test("schedule approval displays gateway time, pending page publication and recurring notification authorization", () => {
  const args = { name: "每日提醒", cron: "0 9 * * *", nextRun: "2026/10/18 09:00:00", prompt: "检查临期库存", skill: "临期预警", page: "expiry", notify: "门店群" };
  const { root, approvals } = mount(approval("create_schedule", args));
  const preview = findAll(root, (node) => node.props?.class === "operation-preview schedule-preview")[0];
  assert.match(textContent(preview), /0 9 \* \* \*.*按网关所在时区执行.*2026\/10\/18 09:00:00.*启用定时执行/);
  assert.match(textContent(preview), /页面发布后才会创建任务/);
  assert.match(textContent(preview), /临期预警.*expiry.*门店群.*检查临期库存/);
  assert.match(textContent(preview), /每次执行完成后.*推送结论/);
  assert.equal(approvals.length, 0);
  button(root, "暂不创建").props.onClick();
  assert.deepEqual(approvals, [["approval-1", false]]);
});

test("malformed approvals retain all raw parameters and busy state blocks decisions", () => {
  const args = { name: "不能解析的任务", cron: null, notify: { connectorId: "unknown" } };
  const { root, approvals } = mount(approval("create_schedule", args), { busy: true });
  assert.equal(findAll(root, (node) => node.props?.class === "operation-preview schedule-preview").length, 0);
  assert.match(textContent(root), /"cron": null/);
  assert.match(textContent(root), /"connectorId": "unknown"/);
  const approve = button(root, "确认创建定时任务");
  assert.equal(approve.props.disabled, true);
  approve.props.onClick();
  assert.deepEqual(approvals, []);
});

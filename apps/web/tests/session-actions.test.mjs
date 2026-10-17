import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { afterEach, test } from "node:test";
import { compileScript, parse } from "@vue/compiler-sfc";
import { createRenderer, h, nextTick, reactive } from "vue";

const dependencies = new Map([["vue", import.meta.resolve("vue")]]);
const controls = "data:text/javascript,export const ElButton={},ElCard={},ElCheckboxButton={},ElCheckboxGroup={},ElCollapse={},ElCollapseItem={},ElInput={},ElRadioButton={},ElRadioGroup={}";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith("data:text/javascript,")) {
      if (dependencies.has(specifier)) return { url: dependencies.get(specifier), shortCircuit: true };
      if (specifier === "element-plus") return { url: controls, shortCircuit: true };
      if (specifier === "@/components/AgentIcon.vue") return { url: "data:text/javascript,export default {}", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

// Exercise the component's actual setup logic without needing a browser renderer.
const source = await readFile(new URL("../src/components/SessionActions.vue", import.meta.url), "utf8");
const { descriptor } = parse(source);
const script = compileScript(descriptor, { id: "session-actions-test" });
const compiled = stripTypeScriptTypes(script.content, { mode: "strip" });
const { default: SessionActions } = await import("data:text/javascript," + encodeURIComponent(compiled));
SessionActions.render = () => h("div");
const mounted = [];
const at = "2026-10-17T03:00:00Z";
const range = {
  id: "range", header: "时间范围", question: "要查看哪个时间范围？",
  options: [{ label: "最近 7 天（推荐）" }, { label: "最近 30 天" }],
  multiSelect: false, allowOther: true,
};
const categories = {
  id: "categories", header: "品类", question: "关注哪些品类？",
  options: [{ label: "生鲜（推荐）" }, { label: "饮料" }, { label: "other" }],
  multiSelect: true, allowOther: true,
};
const question = (requestId = "questions-1", questions = [range, categories]) => ({ type: "question_required", requestId, round: 1, questions, at });
const approval = (requestId = "approval-1") => ({ type: "approval_required", requestId, tool: "调整价格", source: "ERP", args: { productId: "sku-1" }, at });

function mount(events = [question()], extra = {}) {
  const props = reactive({ events, status: "waiting", sessionId: "session-1", busy: false, ...extra });
  const answers = [];
  const approvals = [];
  const renderer = createRenderer({
    patchProp() {}, insert() {}, remove() {}, setText() {}, setElementText() {},
    createElement: (tag) => ({ tag }), createText: (text) => ({ text }), createComment: (text) => ({ text }),
    parentNode: () => null, nextSibling: () => null,
  });
  const app = renderer.createApp({
    setup() {
      return () => h(SessionActions, {
        ...props,
        onAnswer: (...args) => answers.push(args),
        onApprove: (...args) => approvals.push(args),
      });
    },
  });
  app.mount({});
  mounted.push(app);
  return { state: app._instance.subTree.component.setupState, props, answers, approvals };
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
});

test("all questions receive their recommended default and submit backend option labels", () => {
  const { state, answers } = mount();
  assert.deepEqual(state.selections, { range: ["最近 7 天（推荐）"], categories: ["生鲜（推荐）"] });
  state.selectSingle(range, "1");
  state.selectMultiple(categories, ["0", "1"]);
  assert.match(state.answerSummary, /时间范围：最近 30 天/);
  assert.match(state.answerSummary, /品类：生鲜（推荐）、饮料/);
  state.submitAnswers();
  assert.deepEqual(answers, [["questions-1", { range: ["最近 30 天"], categories: ["生鲜（推荐）", "饮料"] }]]);
});

test("custom answers are required when selected and preserve single and multiple choice semantics", () => {
  const { state, answers } = mount();
  state.selectSingle(range, "other");
  assert.deepEqual(state.selections.range, []);
  state.submitAnswers();
  assert.equal(answers.length, 0);
  assert.match(state.validationError, /时间范围.*其他内容/);
  state.otherText.range = "  最近 14 天  ";
  state.selectMultiple(categories, ["0", "other"]);
  state.otherText.categories = "烘焙";
  state.submitAnswers();
  assert.deepEqual(answers, [["questions-1", { range: ["最近 14 天"], categories: ["生鲜（推荐）", "烘焙"] }]]);
  state.selectMultiple(categories, ["2"]);
  assert.equal(state.otherSelected.categories, false);
  assert.deepEqual(state.selections.categories, ["other"]);
});

test("switching request or session resets defaults, custom text, and validation", async () => {
  const { state, props } = mount();
  state.selectSingle(range, "other");
  state.submitAnswers();
  state.otherText.range = "上个月";
  props.events = [question("questions-2")];
  await nextTick();
  assert.deepEqual(state.selections.range, ["最近 7 天（推荐）"]);
  assert.equal(state.otherText.range, "");
  assert.equal(state.validationError, "");
  state.selectSingle(range, "1");
  props.sessionId = "session-2";
  props.events = [question("questions-2")];
  await nextTick();
  assert.deepEqual(state.selections.range, ["最近 7 天（推荐）"]);
});

test("answered questions, resolved approvals, and terminal runs are never presented as pending", async () => {
  const { state, props } = mount([question(), approval()]);
  assert.equal(state.pendingQuestion.requestId, "questions-1");
  assert.equal(state.pendingApprovals.length, 1);
  props.events.push({ type: "question_answered", requestId: "questions-1", answers: null, at });
  props.events.push({ type: "approval_resolved", requestId: "approval-1", approved: false, at });
  await nextTick();
  assert.equal(state.pendingQuestion, undefined);
  assert.equal(state.pendingApprovals.length, 0);
  props.events.push(question("interrupted"), approval("interrupted-approval"));
  props.status = "error";
  await nextTick();
  assert.equal(state.pendingQuestion, undefined);
  assert.equal(state.pendingApprovals.length, 0);
  props.events.push({ type: "status", status: "error", at }, { type: "status", status: "running", at }, question("new-run"));
  props.status = "waiting";
  await nextTick();
  assert.equal(state.pendingQuestion.requestId, "new-run");
  assert.equal(state.pendingApprovals.length, 0);
});

test("busy state prevents choice changes and repeated question or approval submission", () => {
  const { state, answers, approvals } = mount([question(), approval()], { busy: true });
  state.selectSingle(range, "1");
  state.selectMultiple(categories, ["1"]);
  state.submitAnswers();
  state.approve("approval-1", true);
  assert.deepEqual(state.selections, { range: ["最近 7 天（推荐）"], categories: ["生鲜（推荐）"] });
  assert.equal(answers.length, 0);
  assert.equal(approvals.length, 0);
});

test("empty multiple choices require an answer and authorization emits an explicit decision", () => {
  const { state, answers, approvals } = mount([question(), approval()]);
  state.selectMultiple(categories, []);
  state.submitAnswers();
  assert.equal(answers.length, 0);
  assert.match(state.validationError, /至少选择一项.*品类/);
  state.approve("approval-1", false);
  assert.deepEqual(approvals, [["approval-1", false]]);
});

test("save_skill approvals preview the exact name, steps and tools without modifying authorization", () => {
  const args = { name: "临期预警", description: "每天检查临期库存", steps: ["查库存", "发送提醒"], tools: ["store__get_inventory", "send_notification"] };
  const request = { ...approval(), tool: "save_skill", source: "harness", args };
  const { state, approvals } = mount([request]);
  assert.deepEqual(state.skillPreview(request), args);
  state.approve(request.requestId, true);
  assert.deepEqual(approvals, [["approval-1", true]]);
  assert.deepEqual(request.args, args);
  assert.equal(state.skillPreview({ ...request, args: { name: "不完整技能", steps: [123] } }), undefined);
});

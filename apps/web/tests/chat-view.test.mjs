import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { afterEach, test } from "node:test";
import { compileScript, parse } from "@vue/compiler-sfc";
import { createRenderer, nextTick, ref } from "vue";

const vueUrl = import.meta.resolve("vue");
const contextUrl = "data:text/javascript," + encodeURIComponent(`
  let current;
  export function setContext(context) { current = context; }
  export function useWorkspaceContext() { return current; }
`);
const controlsUrl = "data:text/javascript," + encodeURIComponent(`
  import { h } from "vue";
  export const ElButton = {
    inheritAttrs: false,
    props: ["nativeType", "disabled"],
    setup: (props, { attrs, slots }) => () => h("button", { ...attrs, type: props.nativeType || "button", disabled: props.disabled }, slots.default?.()),
  };
  export const ElCard = { setup: (_, { slots }) => () => h("div", slots.default?.()) };
  export const ElInput = {
    inheritAttrs: false,
    props: ["modelValue"],
    emits: ["update:modelValue"],
    setup(props, { attrs, emit, expose }) {
      expose({ focus() {} });
      return () => h("textarea", { ...attrs, value: props.modelValue, onInput: (event) => emit("update:modelValue", event.target.value) });
    },
  };
`);
const childUrl = "data:text/javascript," + encodeURIComponent('import { h } from "vue"; export default { setup: () => () => h("span") };');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith("data:text/javascript,")) {
      if (specifier === "vue") return { url: vueUrl, shortCircuit: true };
      if (specifier === "element-plus") return { url: controlsUrl, shortCircuit: true };
      if (specifier === "@/composables/workspaceContext") return { url: contextUrl, shortCircuit: true };
      if (specifier.startsWith("@/components/")) return { url: childUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

// Compile the actual template so visibility, status text, and button/keyboard
// behavior are exercised together without a browser dependency.
const source = await readFile(new URL("../src/views/chat/index.vue", import.meta.url), "utf8");
const { descriptor } = parse(source);
const script = compileScript(descriptor, { id: "chat-view-test", inlineTemplate: true });
const { default: ChatView } = await import("data:text/javascript," + encodeURIComponent(stripTypeScriptTypes(script.content, { mode: "strip" })));
const { setContext } = await import(contextUrl);
const mounted = [];
const at = "2026-10-17T03:00:00Z";
const user = (text) => ({ type: "user", text, at });
const say = (text) => ({ type: "say", text, at });
const session = (status = "idle", events = []) => ({ id: "session-1", title: "库存", events, status, slug: null });

function remove(node) {
  if (!node.parent) return;
  const index = node.parent.children.indexOf(node);
  if (index !== -1) node.parent.children.splice(index, 1);
  node.parent = null;
}

async function mount(initialSession) {
  const root = { children: [] };
  const calls = { submit: [], cancel: 0 };
  const workspace = {
    activeSession: ref(initialSession),
    activeSessionId: ref(initialSession?.id ?? null),
    revisionPageSlug: ref(null),
    preferences: ref({ enterToSend: true }),
    connected: ref(true),
    loadingSession: ref(false),
    sending: ref(false),
    pendingMessage: ref(),
    responding: ref(false),
    canCancel: ref(false),
    cancelling: ref(false),
    eventActionBusy: ref(false),
    answerQuestions() {},
    resolveApproval() {},
    async cancel() { calls.cancel++; workspace.cancelling.value = true; },
  };
  const draft = ref("");
  setContext({
    workspace,
    draft,
    async submitMessage() {
      calls.submit.push(draft.value);
      workspace.pendingMessage.value = user(draft.value);
      workspace.responding.value = true;
      workspace.canCancel.value = true;
      workspace.sending.value = true;
      return true;
    },
    notify() {},
    navigation: { openPage() {}, openView() {} },
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
    createElement: (tag) => ({ tag, props: {}, children: [], parent: null, scrollTop: 0, scrollHeight: 300, clientHeight: 300 }),
    createText: (text) => ({ text, children: [], parent: null }),
    createComment: (text) => ({ comment: text, children: [], parent: null }),
    setText: (node, text) => { node.text = text; },
    setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: (node) => node.parent,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  });
  const app = renderer.createApp(ChatView);
  app.mount(root);
  mounted.push(app);
  await nextTick();
  return { root, workspace, draft, calls };
}

function findAll(root, predicate) {
  return [...(predicate(root) ? [root] : []), ...root.children.flatMap((child) => findAll(child, predicate))];
}
const hasClass = (value) => (node) => (node.props?.class ?? "").split(" ").includes(value);
const textContent = (node) => (node.text ?? "") + node.children.map(textContent).join("");
const button = (root, label) => findAll(root, (node) => node.tag === "button" && node.props["aria-label"] === label)[0];
const messages = (root) => findAll(root, hasClass("chat-message-text")).map(textContent);
const input = (root) => findAll(root, (node) => node.tag === "textarea")[0];
const form = (root) => findAll(root, (node) => node.tag === "form")[0];
const submit = (root) => form(root).props.onSubmit({ preventDefault() {} });

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
});

test("first send immediately replaces welcome with the optimistic message, loading and a native stop button", async () => {
  const { root, workspace, draft, calls } = await mount();
  assert.equal(findAll(root, hasClass("chat-welcome")).length, 1);
  draft.value = "帮我查看库存";
  await nextTick();
  await submit(root);
  await nextTick();
  assert.deepEqual(calls.submit, ["帮我查看库存"]);
  assert.deepEqual(messages(root), ["帮我查看库存"]);
  assert.equal(findAll(root, hasClass("chat-welcome")).length, 0);
  assert.match(textContent(root), /正在发送…/);
  assert.equal(findAll(root, (node) => node.props?.role === "status").length, 1);
  assert.equal(button(root, "停止回复").props.type, "button");
  assert.equal(button(root, "发送消息"), undefined);
  await button(root, "停止回复").props.onClick();
  await nextTick();
  assert.equal(calls.cancel, 1);
  assert.equal(workspace.cancelling.value, true);
  assert.equal(button(root, "停止回复").props.disabled, true);
  assert.match(textContent(root), /正在停止…/);
});

test("existing messages stay mounted while submitting and the server echo replaces the optimistic bubble", async () => {
  const { root, workspace, draft } = await mount(session("done", [user("已有问题"), say("已有回复")]));
  const originalList = findAll(root, hasClass("chat-messages-scroll"))[0];
  draft.value = "继续分析库存";
  await nextTick();
  await submit(root);
  workspace.loadingSession.value = true;
  await nextTick();
  assert.deepEqual(messages(root), ["已有问题", "已有回复", "继续分析库存"]);
  assert.equal(findAll(root, hasClass("chat-messages-scroll"))[0], originalList);
  assert.equal(findAll(root, hasClass("chat-loading")).length, 0);
  workspace.activeSession.value.events.push(user("继续分析库存"));
  workspace.pendingMessage.value = undefined;
  workspace.activeSession.value.status = "running";
  workspace.loadingSession.value = false;
  await nextTick();
  assert.deepEqual(messages(root), ["已有问题", "已有回复", "继续分析库存"]);
  assert.equal(findAll(root, hasClass("chat-messages-scroll"))[0], originalList);
  assert.match(textContent(root), /助手正在回复…/);
});

test("busy Enter never submits again, drafts remain editable and stopping restores sending", async () => {
  const { root, workspace, draft, calls } = await mount(session("running", [user("分析库存")]));
  workspace.responding.value = true;
  workspace.sending.value = true;
  workspace.canCancel.value = true;
  await nextTick();
  let prevented = 0;
  const event = (extra = {}) => ({ key: "Enter", shiftKey: false, isComposing: false, preventDefault() { prevented++; }, ...extra });
  input(root).props.onInput({ target: { value: "下一条草稿" } });
  await nextTick();
  input(root).props.onKeydown(event());
  await submit(root);
  assert.equal(prevented, 1);
  assert.deepEqual(calls.submit, []);
  assert.equal(draft.value, "下一条草稿");
  assert.equal(input(root).props.disabled, undefined);
  input(root).props.onKeydown(event({ shiftKey: true }));
  input(root).props.onKeydown(event({ isComposing: true }));
  assert.equal(prevented, 1);
  await button(root, "停止回复").props.onClick();
  await nextTick();
  assert.match(textContent(root), /正在停止…/);
  workspace.activeSession.value.status = "cancelled";
  workspace.responding.value = false;
  workspace.sending.value = false;
  workspace.canCancel.value = false;
  workspace.cancelling.value = false;
  await nextTick();
  assert.equal(draft.value, "下一条草稿");
  assert.equal(button(root, "停止回复"), undefined);
  assert.equal(button(root, "发送消息").props.disabled, false);
  input(root).props.onKeydown(event());
  assert.deepEqual(calls.submit, ["下一条草稿"]);
});

test("waiting for questions or approval has an explicit prompt and can be stopped", async () => {
  const { root, workspace, draft, calls } = await mount(session("waiting", [user("帮我创建技能")]));
  workspace.sending.value = true;
  workspace.canCancel.value = true;
  draft.value = "保留的草稿";
  await nextTick();
  assert.match(textContent(root), /等待你的确认/);
  assert.equal(findAll(root, hasClass("chat-loading-dots")).length, 0);
  assert.equal(button(root, "停止回复").props.disabled, false);
  await submit(root);
  assert.deepEqual(calls.submit, []);
  await button(root, "停止回复").props.onClick();
  await nextTick();
  assert.equal(calls.cancel, 1);
  assert.match(textContent(root), /正在停止…/);
  assert.equal(draft.value, "保留的草稿");
});

test("empty, disconnected and loading states do not send and Enter-to-send preference is honored", async () => {
  const { root, workspace, draft, calls } = await mount();
  await submit(root);
  draft.value = "有效内容";
  workspace.connected.value = false;
  await nextTick();
  await submit(root);
  workspace.connected.value = true;
  workspace.loadingSession.value = true;
  await nextTick();
  await submit(root);
  workspace.loadingSession.value = false;
  workspace.preferences.value.enterToSend = false;
  await nextTick();
  let prevented = false;
  input(root).props.onKeydown({ key: "Enter", shiftKey: false, isComposing: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.deepEqual(calls.submit, []);
  await submit(root);
  assert.deepEqual(calls.submit, ["有效内容"]);
});

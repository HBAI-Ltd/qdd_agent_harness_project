import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { afterEach, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { compileScript, parse } from "@vue/compiler-sfc";
import { createRenderer, effectScope, nextTick, ref } from "vue";
import { useConversationDrafts } from "../src/composables/useConversationDrafts.ts";

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
  export const ElSelect = { setup: (_, { slots }) => () => h("select", slots.default?.()) };
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
const markdownUrl = new URL("../src/utils/markdown.ts", import.meta.url).href;
const timelineUrl = new URL("../src/utils/chatTimeline.ts", import.meta.url).href;
let markdownComponentUrl;
const browserUrl = "data:text/javascript," + encodeURIComponent(`
  import { h } from "vue";
  export default {
    props: ["browser", "sessionId"],
    emits: ["close"],
    setup: (props, { emit }) => () => h("section", {
      class: "session-browser",
      "data-session-id": props.sessionId,
      "data-browser-id": props.browser.browserSessionId,
    }, [h("button", { "aria-label": "关闭实时浏览器画面", onClick: () => emit("close") }, "关闭")]),
  };
`);
const workspaceApiUrl = "data:text/javascript," + encodeURIComponent(`
  export async function downloadAttachment() { return new Blob(); }
`);
const composerUrl = "data:text/javascript," + encodeURIComponent(`
  export async function filesFromDrop() { return []; }
  export function filesFromInput() { return []; }
`);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith("data:text/javascript,")) {
      if (specifier === "vue") return { url: vueUrl, shortCircuit: true };
      if (specifier === "element-plus") return { url: controlsUrl, shortCircuit: true };
      if (specifier === "@/composables/workspaceContext") return { url: contextUrl, shortCircuit: true };
      if (specifier === "@/api/workspace") return { url: workspaceApiUrl, shortCircuit: true };
      if (specifier === "@/composables/useComposer") return { url: composerUrl, shortCircuit: true };
      if (specifier === "@/utils/markdown") return { url: markdownUrl, shortCircuit: true };
      if (specifier === "@/utils/chatTimeline") return { url: timelineUrl, shortCircuit: true };
      if (specifier === "@/components/SessionBrowser.vue") return { url: browserUrl, shortCircuit: true };
      if (specifier === "@/components/MarkdownContent.vue") return { url: markdownComponentUrl, shortCircuit: true };
      if (specifier.startsWith("@/components/")) return { url: childUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

// Compile the actual templates, including the Markdown renderer, so visibility,
// status text, and button/keyboard behavior run together without a browser.
async function compileComponent(path, id) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id, inlineTemplate: true });
  return "data:text/javascript," + encodeURIComponent(stripTypeScriptTypes(script.content, { mode: "strip" }));
}
markdownComponentUrl = await compileComponent("../src/components/MarkdownContent.vue", "markdown-content-test");
const { default: ChatView } = await import(await compileComponent("../src/views/chat/index.vue", "chat-view-test"));
const { setContext } = await import(contextUrl);
const mounted = [];
const at = "2026-10-17T03:00:00Z";
const user = (text) => ({ type: "user", text, at });
const say = (text) => ({ type: "say", text, at });
const thinking = (text) => ({ type: "thinking", text, at });
const tool = (callId, status, extra = {}) => ({ type: "tool", callId, name: "查询库存", status, text: "查询库存", at, ...extra });
const session = (status = "idle", events = []) => ({ id: "session-1", title: "库存", events, status, slug: null });

function remove(node) {
  if (!node.parent) return;
  const index = node.parent.children.indexOf(node);
  if (index !== -1) node.parent.children.splice(index, 1);
  node.parent = null;
}

async function mount(initialSession, sendResult = async () => true) {
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
    liveBlocks: ref({ sessionId: null, blocks: {} }),
    answerQuestions() {},
    resolveApproval() {},
    async cancel() { calls.cancel++; workspace.cancelling.value = true; },
  };
  const scope = effectScope();
  const { draft, submitMessage } = scope.run(() => useConversationDrafts(
    ref("http://127.0.0.1:3000"), workspace.activeSessionId,
    async (text) => {
      calls.submit.push(text);
      workspace.pendingMessage.value = user(text);
      workspace.responding.value = true;
      workspace.canCancel.value = true;
      workspace.sending.value = true;
      const sent = await sendResult(text);
      if (!sent) {
        workspace.pendingMessage.value = undefined;
        workspace.responding.value = false;
        workspace.canCancel.value = false;
        workspace.sending.value = false;
      }
      return sent;
    },
  ));
  setContext({
    workspace,
    draft,
    submitMessage,
    composer: {
      attachments: ref([]), uploading: ref(false), ready: ref([]), catalog: ref(null), currentModel: ref(undefined),
      selectModel() {}, addFiles() {}, removeAttachment() {}, removeFolder() {},
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
  mounted.push({ app, scope });
  await nextTick();
  return { root, workspace, draft, calls };
}

function findAll(root, predicate) {
  return [...(predicate(root) ? [root] : []), ...root.children.flatMap((child) => findAll(child, predicate))];
}
const hasClass = (value) => (node) => (node.props?.class ?? "").split(" ").includes(value);
const htmlText = (html) => html.replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[entity]).trim();
const textContent = (node) => (node.text ?? "") + (node.props?.innerHTML ? htmlText(node.props.innerHTML) : "") + node.children.map(textContent).join("");
const button = (root, label) => findAll(root, (node) => node.tag === "button" && node.props["aria-label"] === label)[0];
const messages = (root) => findAll(root, hasClass("chat-message-text")).map(textContent);
const input = (root) => findAll(root, (node) => node.tag === "textarea")[0];
const form = (root) => findAll(root, (node) => node.tag === "form")[0];
const submit = (root) => form(root).props.onSubmit({ preventDefault() {} });
const processes = (root) => findAll(root, (node) => node.tag === "details" && hasClass("chat-process")(node));
const summary = (node) => node.children.find((child) => child.tag === "summary");

afterEach(() => {
  for (const { app, scope } of mounted.splice(0)) {
    app.unmount();
    scope.stop();
  }
});

const browserEvent = (id = "browser-1", status = "running") => ({
  type: "browser", at,
  browser: { browserSessionId: id, tabId: "tab-1", url: "https://example.com/", title: "网页", canGoBack: false, canGoForward: false, status },
});
async function browserPanel(root) {
  // Allow the real async component loader to mount the viewer stub.
  await setImmediate();
  await nextTick();
  return findAll(root, hasClass("session-browser"))[0];
}

test("a browser event automatically shows its live viewer and respects manual collapse until a new browser opens", async () => {
  const { root, workspace } = await mount(session("running", [user("打开网页")]));
  assert.equal(await browserPanel(root), undefined);
  workspace.activeSession.value.events.push(browserEvent());
  const panel = await browserPanel(root);
  assert.ok(panel);
  assert.equal(panel.props["data-session-id"], "session-1");
  assert.equal(panel.props["data-browser-id"], "browser-1");
  button(root, "关闭实时浏览器画面").props.onClick();
  await nextTick();
  workspace.activeSession.value.events.push(browserEvent());
  assert.equal(await browserPanel(root), undefined);
  const reopen = findAll(root, (node) => node.tag === "button" && textContent(node) === "查看浏览器")[0];
  reopen.props.onClick();
  assert.ok(await browserPanel(root));
  button(root, "关闭实时浏览器画面").props.onClick();
  await nextTick();
  workspace.activeSession.value.events.push(browserEvent("browser-2"));
  assert.equal((await browserPanel(root)).props["data-browser-id"], "browser-2");
});

test("conversation switching hides the old viewer and automatically restores the selected conversation's running browser", async () => {
  const { root, workspace } = await mount(session("idle", [browserEvent()]));
  assert.ok(await browserPanel(root));
  workspace.activeSessionId.value = "session-2";
  assert.equal(await browserPanel(root), undefined);
  workspace.activeSession.value = { ...session("idle", [browserEvent("browser-2")]), id: "session-2" };
  const panel = await browserPanel(root);
  assert.equal(panel.props["data-session-id"], "session-2");
  assert.equal(panel.props["data-browser-id"], "browser-2");
  workspace.activeSession.value = undefined;
  workspace.activeSessionId.value = null;
  assert.equal(await browserPanel(root), undefined);
});

test("closed browser events hide the live viewer and do not offer an obsolete connection", async () => {
  const { root, workspace } = await mount(session("idle", [browserEvent()]));
  assert.ok(await browserPanel(root));
  workspace.activeSession.value.events.push(browserEvent("browser-1", "closed"));
  assert.equal(await browserPanel(root), undefined);
  assert.equal(findAll(root, (node) => node.tag === "button" && /查看(实时画面|浏览器)/.test(textContent(node))).length, 0);
  workspace.activeSession.value = session("idle", [browserEvent("browser-2", "closed")]);
  assert.equal(await browserPanel(root), undefined);
});

test("the submitted text leaves the input before a delayed response and subsequent typing survives success", async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const { root, draft, calls } = await mount(undefined, () => pending);
  input(root).props.onInput({ target: { value: "帮我查看库存" } });
  await nextTick();
  const request = submit(root);
  assert.equal(draft.value, "");
  await nextTick();
  assert.equal(input(root).props.value, "");
  assert.deepEqual(calls.submit, ["帮我查看库存"]);
  assert.deepEqual(messages(root), ["帮我查看库存"]);
  input(root).props.onInput({ target: { value: "下一条问题" } });
  resolve(true);
  await request;
  await nextTick();
  assert.equal(input(root).props.value, "下一条问题");
});

test("a failed delayed send restores the message so the user can retry", async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const { root, draft } = await mount(undefined, () => pending);
  draft.value = "需要重试的问题";
  await nextTick();
  const request = submit(root);
  assert.equal(draft.value, "");
  resolve(false);
  await request;
  await nextTick();
  assert.equal(input(root).props.value, "需要重试的问题");
  assert.equal(button(root, "发送消息").props.disabled, false);
  assert.equal(findAll(root, hasClass("chat-welcome")).length, 1);
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

test("each assistant turn places independently collapsed process rows above its Markdown answer", async () => {
  const { root } = await mount(session("done", [
    user("查看库存"),
    thinking("**先核对**数据来源"),
    tool("inventory", "completed", { input: { store: "A" }, output: "120 件" }),
    say("## 库存结果\n\n库存 **120** 件。"),
    user("继续分析"),
    thinking("检查变化"),
    say("库存稳定。"),
  ]));
  const assistants = findAll(root, hasClass("chat-message-assistant"));
  assert.equal(assistants.length, 2);
  assert.equal(findAll(root, hasClass("chat-avatar-assistant")).length, 2);
  assert.equal(findAll(root, hasClass("chat-message-meta")).length, 2);
  const rows = processes(root);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.props.open, undefined);
    assert.ok(summary(row));
    assert.equal(summary(row).props.onClick, undefined);
  }
  const main = findAll(assistants[0], hasClass("chat-message-main"))[0];
  const activity = findAll(main, hasClass("chat-activities"))[0];
  const answer = findAll(main, hasClass("chat-answer"))[0];
  assert.ok(main.children.indexOf(activity) < main.children.indexOf(answer));
  assert.match(textContent(summary(rows[0])), /思考/);
  assert.match(textContent(summary(rows[1])), /查询库存已完成/);
  assert.match(findAll(rows[0], hasClass("markdown-content"))[0].props.innerHTML, /<strong>先核对<\/strong>/);
  assert.match(findAll(answer, hasClass("markdown-content"))[0].props.innerHTML, /<h2>库存结果<\/h2>/);
  // Native <details> owns open state; toggling one row does not change another.
  rows[0].open = true;
  assert.equal(rows[1].open, undefined);
});

test("tool lifecycle updates one keyed row, preserves native expansion and distinguishes failure from running", async () => {
  const { root, workspace } = await mount(session("running", [
    user("查询门店"),
    thinking("先查询库存"),
    tool("inventory", "running", { input: { store: "A" } }),
    tool("sales", "running", { name: "查询销售" }),
  ]));
  const [thought, inventory, sales] = processes(root);
  inventory.open = true;
  thought.open = false;
  workspace.activeSession.value.events.push(
    tool("inventory", undefined, { text: "已读取 100 条" }),
    tool("inventory", "failed", { output: "连接超时" }),
    say("稍后重试。"),
  );
  await nextTick();
  assert.deepEqual(processes(root), [thought, inventory, sales]);
  assert.equal(inventory.open, true);
  assert.equal(thought.open, false);
  assert.equal(sales.open, undefined);
  assert.equal(inventory.props["data-status"], "failed");
  assert.equal(sales.props["data-status"], "running");
  assert.match(textContent(summary(inventory)), /调用失败/);
  assert.match(textContent(summary(sales)), /调用中…/);
  assert.match(textContent(inventory), /已读取 100 条/);
  assert.match(textContent(inventory), /错误详情连接超时/);
  assert.match(textContent(inventory), /"store": "A"/);
  assert.deepEqual(messages(root), ["查询门店", "稍后重试。"]);
});

test("legacy tool records stay inspectable without inventing successful completion", async () => {
  const { root } = await mount(session("done", [
    user("查库存"),
    { type: "tool", text: "查询 store__get_inventory", at },
    { type: "tool", text: "工具连接异常", at },
    say("暂时无法读取。"),
  ]));
  const rows = processes(root);
  assert.equal(rows.length, 2);
  assert.match(textContent(summary(rows[0])), /store__get_inventory执行记录/);
  assert.match(textContent(summary(rows[1])), /执行记录/);
  assert.doesNotMatch(rows.map((row) => textContent(summary(row))).join(""), /已完成/);
  assert.match(textContent(rows[1]), /工具连接异常/);
});

test("switching conversations remounts process rows so expansion cannot leak across sessions", async () => {
  const events = [user("查库存"), thinking("检查数据"), tool("inventory", "completed")];
  const { root, workspace } = await mount(session("done", events));
  const original = processes(root)[0];
  original.open = true;
  workspace.activeSessionId.value = "session-2";
  workspace.activeSession.value = { ...session("done", events), id: "session-2" };
  await nextTick();
  const selected = processes(root)[0];
  assert.notEqual(selected, original);
  assert.equal(selected.open, undefined);
  workspace.activeSessionId.value = "session-1";
  workspace.activeSession.value = session("done", events);
  await nextTick();
  assert.notEqual(processes(root)[0], selected);
  assert.equal(processes(root)[0].open, undefined);
});

test("actual Markdown component renders answer tables and code and escapes unsafe HTML in answers and thinking", async () => {
  const { root } = await mount(session("done", [
    user("生成报告"),
    thinking('**核对来源**\n\n<img src=x onerror="alert(1)">'),
    say('| 门店 | 库存 |\n| --- | ---: |\n| A | **120** |\n\n```js\nconst label = "<script>";\n```\n\n<script>alert(1)</script>\n\n[打开](javascript:alert(1))'),
  ]));
  const row = processes(root)[0];
  const thoughtHtml = findAll(row, hasClass("markdown-content"))[0].props.innerHTML;
  const answerHtml = findAll(root, hasClass("chat-message-markdown"))[0].props.innerHTML;
  assert.match(thoughtHtml, /<strong>核对来源<\/strong>/);
  assert.match(thoughtHtml, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(thoughtHtml, /<img\b/);
  assert.match(answerHtml, /<div class="markdown-table-scroll"><table>/);
  assert.match(answerHtml, /<td style="text-align:right"><strong>120<\/strong><\/td>/);
  assert.match(answerHtml, /<pre><code class="language-js">const label = &quot;&lt;script&gt;&quot;;/);
  assert.match(answerHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(answerHtml, /<script\b|href="javascript:/i);
});

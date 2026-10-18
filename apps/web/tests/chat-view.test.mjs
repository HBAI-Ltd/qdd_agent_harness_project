import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { afterEach, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { compileScript, parse } from "@vue/compiler-sfc";
import { computed, createRenderer, effectScope, nextTick, ref } from "vue";
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
  export const ElSelect = {
    props: ["modelValue", "disabled"], emits: ["update:modelValue"],
    setup: (props, { attrs, slots, emit }) => () => h("select", { ...attrs, value: props.modelValue, disabled: props.disabled, onChange: (event) => emit("update:modelValue", event.target.value) }, slots.default?.()),
  };
  export const ElOptionGroup = { props: ["label"], setup: (props, { slots }) => () => h("optgroup", { label: props.label }, slots.default?.()) };
`);
const optionUrl = "data:text/javascript," + encodeURIComponent('import { h } from "vue"; export default { props: ["value", "label", "disabled"], setup: (props) => () => h("option", { value: props.value, disabled: props.disabled }, props.label) };');
const childUrl = "data:text/javascript," + encodeURIComponent('import { h } from "vue"; export default { setup: () => () => h("span") };');
const markdownUrl = new URL("../src/utils/markdown.ts", import.meta.url).href;
const timelineUrl = new URL("../src/utils/chatTimeline.ts", import.meta.url).href;
let markdownComponentUrl;
let attachmentComponentUrl;
let mediaComponentUrl;
const mediaUrl = new URL("../src/utils/media.ts", import.meta.url).href;
const browserUrl = "data:text/javascript," + encodeURIComponent(`
  import { h } from "vue";
  export default {
    props: ["browser", "sessionId"],
    emits: ["close"],
    setup: (props, { emit }) => () => h("section", {
      class: "session-browser",
      "data-session-id": props.sessionId,
      "data-browser-id": props.browser.browserSessionId,
    }, [h("button", { "aria-label": "关闭浏览器", onClick: () => emit("close", { ...props.browser, status: "closed" }) }, "关闭")]),
  };
`);
const workspaceApiUrl = "data:text/javascript," + encodeURIComponent(`
  export async function downloadAttachment() { return new Blob(); }
`);
const composerUrl = "data:text/javascript," + encodeURIComponent(`
  export async function filesFromDrop(data) { return filesFromInput(data.files); }
  export function filesFromInput(list) { return [...(list ?? [])].map((file) => ({ file, path: file.webkitRelativePath || file.name })); }
  export function formatSize(size) { return size + " B"; }
`);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith("data:text/javascript,")) {
      if (specifier === "vue") return { url: vueUrl, shortCircuit: true };
      if (specifier.startsWith("element-plus/es/components/")) return { url: controlsUrl, shortCircuit: true };
      if (specifier === "@/composables/workspaceContext") return { url: contextUrl, shortCircuit: true };
      if (specifier === "@/api/workspace") return { url: workspaceApiUrl, shortCircuit: true };
      if (specifier === "@/composables/useComposer") return { url: composerUrl, shortCircuit: true };
      if (specifier === "@/utils/markdown") return { url: markdownUrl, shortCircuit: true };
      if (specifier === "@/utils/media") return { url: mediaUrl, shortCircuit: true };
      if (specifier === "@/utils/chatTimeline") return { url: timelineUrl, shortCircuit: true };
      if (specifier === "@/components/StringSelectOption") return { url: optionUrl, shortCircuit: true };
      if (specifier === "@/components/SessionBrowser.vue") return { url: browserUrl, shortCircuit: true };
      if (specifier === "@/components/MarkdownContent.vue") return { url: markdownComponentUrl, shortCircuit: true };
      if (specifier === "@/components/AttachmentList.vue") return { url: attachmentComponentUrl, shortCircuit: true };
      if (specifier === "@/components/ChatMedia.vue") return { url: mediaComponentUrl, shortCircuit: true };
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
mediaComponentUrl = await compileComponent("../src/components/ChatMedia.vue", "chat-media-test");
markdownComponentUrl = await compileComponent("../src/components/MarkdownContent.vue", "markdown-content-test");
attachmentComponentUrl = await compileComponent("../src/components/AttachmentList.vue", "attachment-list-test");
const { default: ChatView } = await import(await compileComponent("../src/views/chat/index.vue", "chat-view-test"));
const { setContext } = await import(contextUrl);
const mounted = [];
const at = "2026-10-17T03:00:00Z";
let blockIndex = 0;
const user = (text) => ({ type: "user", text, at });
const textBlock = (blockId, content) => ({ type: "text", blockId, content, done: true, at });
const say = (text) => textBlock(`fixture:${blockIndex++}`, text);
const thinking = (content, blockId = `fixture:${blockIndex++}`) => ({ type: "thinking", blockId, content, done: true, at });
const tool = (id, status, extra = {}, blockId = `fixture:${blockIndex++}`) => ({ type: "tool", blockId, tool: { id, name: "查询库存", status, ...extra }, at });
const session = (status = "idle", events = []) => ({ id: "session-1", title: "库存", events, status, slug: null });

function remove(node) {
  if (!node.parent) return;
  const index = node.parent.children.indexOf(node);
  if (index !== -1) node.parent.children.splice(index, 1);
  node.parent = null;
}

async function mount(initialSession, sendResult = async () => true) {
  const root = { children: [] };
  const calls = { submit: [], selections: [], attachments: [], notifications: [], cancel: 0 };
  const workspace = {
    gatewayUrl: ref("http://127.0.0.1:3000"),
    token: ref("test-token"),
    activeSession: ref(initialSession),
    activeSessionId: ref(initialSession?.id ?? null),
    liveBlocks: ref({ sessionId: initialSession?.id ?? null, blocks: {} }),
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
    chatOptions: ref({ models: [
      { id: "model-a", label: "模型 A", reasoningEfforts: ["default", "none", "low", "high"], defaultReasoningEffort: "default" },
      { id: "model-b", label: "模型 B", reasoningEfforts: ["default", "medium", "high"], defaultReasoningEffort: "medium" },
    ], defaults: { model: "model-a", reasoningEffort: "default" } }),
    chatOptionsLoading: ref(false), chatOptionsError: ref(""),
    chatSelection: ref({ model: "model-a", reasoningEffort: "default" }),
    selectChatModel(id) {
      const model = workspace.chatOptions.value.models.find((entry) => entry.id === id);
      workspace.chatSelection.value = { model: id, reasoningEffort: model.defaultReasoningEffort };
    },
    selectReasoningEffort(reasoningEffort) { workspace.chatSelection.value = { ...workspace.chatSelection.value, reasoningEffort }; },
    loadChatOptions() {},
    answerQuestions() {},
    resolveApproval() {},
    async cancel() { calls.cancel++; workspace.cancelling.value = true; },
  };
  const scope = effectScope();
  const attachments = ref([]);
  const catalog = ref({ models: workspace.chatOptions.value.models.map((model) => ({ ...model, provider: "openai", available: true })), default: "model-a" });
  const currentModel = ref(catalog.value.models[0]);
  const composer = {
    attachments, catalog, currentModel,
    modelLoading: ref(false), modelError: ref(""), modelChanging: ref(false), refreshModels() {},
    uploading: computed(() => attachments.value.some((item) => item.status === "uploading")),
    ready: computed(() => attachments.value.filter((item) => item.status === "done").map((item) => item.ref)),
    selectModel(id) {
      currentModel.value = catalog.value.models.find((model) => model.id === id);
      workspace.selectChatModel(id);
    },
    addFiles(files) {
      for (const { file, path } of files) attachments.value.push({
        key: path, path, size: file.size, status: "done", ref: { id: path, path, size: file.size, mime: file.type || "application/octet-stream" },
      });
    },
    async addFilesFrom(load) { this.addFiles(await load()); },
    removeAttachment(key) { attachments.value = attachments.value.filter((item) => item.key !== key); },
    removeFolder(folder) { attachments.value = attachments.value.filter((item) => !item.path.startsWith(folder + "/")); },
  };
  const { draft, submitMessage } = scope.run(() => useConversationDrafts(
    ref("http://127.0.0.1:3000"), workspace.activeSessionId,
    async (text) => {
      calls.submit.push(text);
      calls.selections.push({ ...workspace.chatSelection.value });
      const sentAttachments = [...composer.ready.value];
      calls.attachments.push(sentAttachments.map((item) => item.id));
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
      } else {
        const ids = new Set(sentAttachments.map((item) => item.id));
        attachments.value = attachments.value.filter((item) => !ids.has(item.ref?.id));
      }
      return sent;
    },
  ));
  setContext({
    workspace,
    draft,
    submitMessage,
    composer,
    notify(message) { calls.notifications.push(message); },
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
    createElement: (tag) => ({ tag, props: {}, children: [], parent: null, scrollTop: 0, scrollHeight: 300, clientHeight: 300,
      getBoundingClientRect() { return { top: this.props.class === "chat-browser-preview" ? 40 : 0 }; },
    }),
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
  return { root, workspace, draft, attachments, composer, calls };
}

function findAll(root, predicate) {
  return [...(predicate(root) ? [root] : []), ...root.children.flatMap((child) => findAll(child, predicate))];
}
const hasClass = (value) => (node) => (node.props?.class ?? "").split(" ").includes(value);
const htmlText = (html) => html.replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[entity]).trim();
const textContent = (node) => (node.text ?? "") + (node.props?.innerHTML ? htmlText(node.props.innerHTML) : "") + node.children.map(textContent).join("");
const markdownHtml = (node) => findAll(node, (child) => typeof child.props?.innerHTML === "string")[0]?.props.innerHTML;
const button = (root, label) => findAll(root, (node) => node.tag === "button" && node.props["aria-label"] === label)[0];
const messages = (root) => findAll(root, hasClass("chat-message-text")).map(textContent);
const input = (root) => findAll(root, (node) => node.tag === "textarea")[0];
const form = (root) => findAll(root, (node) => node.tag === "form")[0];
const submit = (root) => form(root).props.onSubmit({ preventDefault() {} });

test("assistant media and uploaded media appear in history and composer without autoplay", async () => {
  const image = { id: "photo", path: "folder/photo.png", size: 100, mime: "image/png" };
  const { root, composer } = await mount(session("idle", [
    { ...user("看看图片"), attachments: [image] },
    say("![截图](https://example.com/a.png)\n\n[录像](https://example.com/a.mp4)\n\n[直播](https://example.com/a.m3u8)\n\n[监控](https://example.com/a.flv)"),
  ]));
  assert.equal(findAll(root, hasClass("chat-media")).length, 5);
  assert.equal(findAll(root, (node) => node.tag === "img").length, 1);
  assert.equal(findAll(root, (node) => node.tag === "video").length, 0);
  assert.equal(findAll(root, (node) => node.tag === "button" && textContent(node) === "播放视频").length, 3);
  composer.addFiles([{ path: "video.mp4", file: new File(["fixture"], "video.mp4", { type: "video/mp4" }) }]);
  await nextTick();
  assert.equal(findAll(root, hasClass("chat-media")).length, 6);
  const preview = findAll(root, (node) => node.tag === "button" && textContent(node) === "预览图片")[0];
  await preview.props.onClick();
  await nextTick();
  assert.equal(findAll(root, (node) => node.tag === "img" && node.props.src.startsWith("blob:")).length, 1);
});

test("failed inline images expose a retry and preserve their original link", async () => {
  const { root } = await mount(session("idle", [say("![截图](https://example.com/broken.png)")]));
  const image = findAll(root, (node) => node.tag === "img")[0];
  image.props.onError();
  await nextTick();
  assert.match(textContent(root), /图片加载失败/);
  assert.equal(findAll(root, (node) => node.tag === "button" && textContent(node) === "重试").length, 1);
  assert.equal(findAll(root, (node) => node.tag === "a" && node.props.href === "https://example.com/broken.png").length, 1);
});

test("attachment picker accepts arbitrary file types, allows attachment-only sends, and clears sent refs", async () => {
  const { root, attachments, calls } = await mount(undefined);
  const picker = findAll(root, (node) => node.tag === "input" && node.props.type === "file")[0];
  assert.equal(picker.props.multiple, "");
  assert.equal(picker.props.accept, undefined);
  const target = { files: [new File(["binary"], "photo.png"), new File(["sku,qty\nA,120"], "库存.csv")], value: "selection" };
  picker.props.onChange({ target });
  assert.equal(target.value, "");
  await setImmediate();
  await nextTick();
  assert.equal(attachments.value.length, 2);
  assert.equal(findAll(root, hasClass("attachment-chip")).length, 2);
  assert.equal(button(root, "发送消息").props.disabled, false);
  await submit(root);
  assert.equal(calls.submit.length, 1);
  assert.equal(calls.submit[0], "请查看我上传的附件。");
  assert.deepEqual(calls.attachments, [["photo.png", "库存.csv"]]);
  assert.equal(attachments.value.length, 0);
});

test("removing an attachment excludes its ref and failed sends preserve the remaining files", async () => {
  const { root, draft, attachments, composer, calls } = await mount(undefined, async () => false);
  composer.addFiles([
    { file: new File(["Keep this"], "a.md"), path: "a.md" },
    { file: new File(["Remove this"], "b.md"), path: "b.md" },
  ]);
  draft.value = "总结附件";
  await nextTick();
  findAll(root, (node) => node.tag === "button" && node.props["aria-label"] === "移除附件")[1].props.onClick();
  await nextTick();
  await submit(root);
  await nextTick();
  assert.equal(calls.submit[0], "总结附件");
  assert.deepEqual(calls.attachments, [["a.md"]]);
  assert.equal(draft.value, "总结附件");
  assert.deepEqual(attachments.value.map((entry) => entry.path), ["a.md"]);
});

test("uploads block Enter and submit, upload errors stay visible, and dropped files use uploaded refs", async () => {
  const { root, draft, attachments, composer, calls } = await mount(undefined);
  attachments.value = [{ key: "pending", path: "pending.png", size: 8, status: "uploading" }];
  draft.value = "等待附件";
  await nextTick();
  assert.equal(composer.uploading.value, true);
  assert.equal(button(root, "发送消息").props.disabled, true);
  input(root).props.onKeydown({ key: "Enter", shiftKey: false, isComposing: false, preventDefault() {} });
  await submit(root);
  assert.equal(calls.submit.length, 0);
  attachments.value[0].status = "error";
  attachments.value[0].error = "上传失败";
  await nextTick();
  assert.match(textContent(root), /上传失败/);
  const view = findAll(root, hasClass("chat-view"))[0];
  await view.props.onDrop({ preventDefault() {}, dataTransfer: { types: ["Files"], files: [new File(["binary"], "photo.png"), new File(["ok"], "ok.txt")] } });
  await setImmediate();
  await nextTick();
  await submit(root);
  assert.deepEqual(calls.attachments, [["photo.png", "ok.txt"]]);
  assert.deepEqual(attachments.value.map((entry) => entry.path), ["pending.png"]);
});

test("model selection resets effort, only supported levels render, and the submission snapshots the choice", async () => {
  const { root, workspace, draft, calls } = await mount(undefined);
  const selects = findAll(root, (node) => node.tag === "select");
  assert.equal(selects.length, 1);
  const select = selects[0];
  assert.equal(select.props["aria-label"], "切换模型");
  select.props.onChange({ target: { value: "model-b" } });
  await nextTick();
  assert.equal(workspace.chatSelection.value.model, "model-b");
  const levels = findAll(root, (node) => node.tag === "button" && node.props["aria-pressed"] !== undefined);
  assert.deepEqual(levels.map(textContent), ["默认", "中", "高"]);
  assert.equal(levels[1].props["aria-pressed"], true);
  levels[2].props.onClick();
  draft.value = "分析";
  await nextTick();
  await submit(root);
  assert.deepEqual(calls.selections, [{ model: "model-b", reasoningEffort: "high" }]);
  assert.equal(workspace.chatSelection.value.reasoningEffort, "high");
});

test("models are searchable inside the combined picker, grouped by provider, and unavailable models are disabled", async () => {
  const { root, composer } = await mount(undefined);
  composer.catalog.value.models[0].provider = "DeepSeek";
  composer.catalog.value.models[1].provider = "阿里云百炼";
  composer.catalog.value.models[1].available = false;
  await nextTick();
  const picker = findAll(root, hasClass("chat-model-picker"))[0];
  assert.match(textContent(picker), /模型 A.*默认/s);
  assert.equal(findAll(picker, (node) => node.tag === "summary")[0].props["aria-label"], "选择模型和思考强度");
  const select = findAll(picker, (node) => node.tag === "select")[0];
  assert.equal(select.props.filterable, "");
  assert.deepEqual(findAll(select, (node) => node.tag === "optgroup").map((node) => node.props.label), ["DeepSeek", "阿里云百炼"]);
  const unavailable = findAll(select, (node) => node.tag === "option" && node.props.value === "model-b")[0];
  assert.equal(unavailable.props.disabled, true);
  assert.match(textContent(unavailable), /未配置 Key/);
  assert.equal(findAll(root, hasClass("chat-composer-footer"))[0].children.some((node) => node.tag === "select"), false);
});

test("switching a model locks sends and effort changes until confirmation and model failures remain retryable", async () => {
  const { root, composer, draft, calls } = await mount(undefined);
  composer.modelChanging.value = true;
  draft.value = "分析经营数据";
  await nextTick();
  assert.equal(button(root, "发送消息").props.disabled, true);
  assert.ok(findAll(root, (node) => node.tag === "button" && node.props["aria-pressed"] !== undefined).every((node) => node.props.disabled));
  await submit(root);
  assert.equal(calls.submit.length, 0);
  composer.modelChanging.value = false;
  composer.modelError.value = "暂时无法切换模型";
  await nextTick();
  const error = findAll(root, hasClass("chat-model-error"))[0];
  assert.equal(error.props.role, "alert");
  assert.match(textContent(error), /暂时无法切换模型.*重试/s);
  assert.equal(button(root, "发送消息").props.disabled, false);
});
const processes = (root) => findAll(root, (node) => node.tag === "details" && hasClass("chat-process")(node));
const summary = (node) => node.children.find((child) => child.tag === "summary");
const assistantMain = (assistant) => findAll(assistant, hasClass("chat-message-main"))[0];
const replyParts = (assistant) => findAll(assistant, (node) => hasClass("chat-process")(node) || hasClass("chat-answer")(node));
function inlineActivity(root, assistant = findAll(root, hasClass("chat-message-assistant")).at(-1)) {
  const indicators = findAll(root, hasClass("chat-activity"));
  assert.equal(indicators.length, 1);
  assert.ok(assistant);
  const main = assistantMain(assistant);
  assert.equal(indicators[0].parent, main);
  assert.equal(main.children.filter((node) => node.tag).at(-1), indicators[0]);
  assert.equal(indicators[0].props.role, "status");
  assert.equal(findAll(assistant, hasClass("chat-avatar-assistant")).length, 1);
  return indicators[0];
}

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
  findAll(root, (node) => node.tag === "button" && textContent(node) === "收起浏览器")[0].props.onClick();
  await nextTick();
  workspace.activeSession.value.events.push(browserEvent());
  assert.equal(await browserPanel(root), undefined);
  const reopen = findAll(root, (node) => node.tag === "button" && textContent(node) === "查看浏览器")[0];
  reopen.props.onClick();
  assert.ok(await browserPanel(root));
  findAll(root, (node) => node.tag === "button" && textContent(node) === "收起浏览器")[0].props.onClick();
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

test("the browser preview stays at the conversation bottom while messages and browser state update", async () => {
  const { root, workspace } = await mount(session("running", [user("打开网页"), say("正在打开。"), browserEvent(), say("网页已打开。界面会实时更新。") ]));
  const panel = await browserPanel(root);
  const assistant = findAll(root, hasClass("chat-message-assistant"))[0];
  assert.ok(panel);
  assert.equal(findAll(assistant, hasClass("session-browser")).length, 0);
  assert.ok(findAll(findAll(root, hasClass("chat-messages-scroll"))[0], hasClass("session-browser")).includes(panel));
  const firstRow = processes(root)[0];
  const update = browserEvent();
  update.browser.url = "https://example.com/details";
  workspace.activeSession.value.events.push(update, browserEvent());
  await nextTick();
  assert.equal(await browserPanel(root), panel);
  assert.equal(processes(root)[0], firstRow);
  assert.equal(processes(root).filter((node) => node.props["data-kind"] === "browser").length, 1);
  assert.equal(findAll(root, hasClass("session-browser")).length, 1);
  const list = findAll(root, hasClass("chat-messages"))[0];
  assert.equal(list.children.filter((node) => node.tag).at(-1), panel.parent);
  workspace.activeSession.value.events.push(user("总结一下"), say("最新一轮回复。"));
  await nextTick();
  assert.equal(await browserPanel(root), panel);
  assert.equal(list.children.filter((node) => node.tag).at(-1), panel.parent);
});

test("one bottom preview serves the whole conversation and closed snapshots cannot reopen it", async () => {
  const { root, workspace } = await mount(session("idle", [user("打开网页"), browserEvent(), say("已打开。"), user("继续浏览"), browserEvent(), say("完成。") ]));
  const panel = await browserPanel(root);
  const replies = findAll(root, hasClass("chat-message-assistant"));
  assert.equal(findAll(replies[0], hasClass("session-browser")).length, 0);
  assert.equal(findAll(replies[1], hasClass("session-browser")).length, 0);
  assert.equal(findAll(root, hasClass("chat-messages"))[0].children.filter((node) => node.tag).at(-1), panel.parent);
  assert.equal(findAll(root, hasClass("session-browser")).length, 1);
  workspace.activeSession.value.events.push(browserEvent("browser-1", "closed"), browserEvent("browser-1"));
  assert.equal(await browserPanel(root), undefined);
  assert.equal(findAll(root, (node) => node.tag === "button" && /查看(实时画面|浏览器)/.test(textContent(node))).length, 0);
});

test("an automatically mounted browser keeps the latest reply visible and does not move a history reader", async () => {
  const history = await mount(session("idle", [user("打开网页"), browserEvent(), say("已打开。"), user("总结一下"), say("这是最新回复。") ]));
  await browserPanel(history.root);
  const historyList = findAll(history.root, hasClass("chat-messages-scroll"))[0];
  assert.equal(historyList.scrollTop, historyList.scrollHeight);

  const live = await mount(session("running", [user("打开网页"), say("正在准备。") ]));
  const list = findAll(live.root, hasClass("chat-messages-scroll"))[0];
  list.scrollHeight = 1200;
  list.clientHeight = 300;
  list.scrollTop = 120;
  live.workspace.activeSession.value.events.push(browserEvent());
  await browserPanel(live.root);
  assert.equal(list.scrollTop, 120);
  findAll(live.root, (node) => node.tag === "button" && textContent(node) === "收起浏览器")[0].props.onClick();
  await nextTick();
  findAll(live.root, (node) => node.tag === "button" && textContent(node) === "查看浏览器")[0].props.onClick();
  await browserPanel(live.root);
  assert.ok(list.scrollTop > 120, "An explicit reopen should reveal the browser card");
});

test("the real close callback hides the browser without offering to reopen a closed session", async () => {
  const { root, workspace } = await mount(session("idle", [browserEvent()]));
  assert.ok(await browserPanel(root));
  button(root, "关闭浏览器").props.onClick();
  assert.equal(await browserPanel(root), undefined);
  workspace.activeSession.value.events.push(browserEvent());
  assert.equal(await browserPanel(root), undefined);
  assert.equal(findAll(root, (node) => node.tag === "button" && /查看(实时画面|浏览器)/.test(textContent(node))).length, 0);
  workspace.activeSession.value.events.push(browserEvent("browser-2"));
  assert.equal((await browserPanel(root)).props["data-browser-id"], "browser-2");
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
  assert.equal(findAll(root, hasClass("chat-message-assistant")).length, 1);
  assert.equal(findAll(root, hasClass("chat-avatar-assistant")).length, 1);
  const activity = inlineActivity(root);
  assert.equal(button(root, "停止回复").props.type, "button");
  assert.equal(button(root, "发送消息"), undefined);
  await button(root, "停止回复").props.onClick();
  await nextTick();
  assert.equal(calls.cancel, 1);
  assert.equal(workspace.cancelling.value, true);
  assert.equal(button(root, "停止回复").props.disabled, true);
  assert.match(textContent(root), /正在停止…/);
  assert.equal(inlineActivity(root), activity);
});

test("existing messages stay mounted while submitting and the server echo replaces the optimistic bubble", async () => {
  const { root, workspace, draft } = await mount(session("idle", [user("已有问题"), say("已有回复")]));
  const originalList = findAll(root, hasClass("chat-messages-scroll"))[0];
  const historicalAssistant = findAll(root, hasClass("chat-message-assistant"))[0];
  draft.value = "继续分析库存";
  await nextTick();
  await submit(root);
  workspace.loadingSession.value = true;
  await nextTick();
  assert.deepEqual(messages(root), ["已有问题", "已有回复", "继续分析库存"]);
  assert.equal(findAll(root, hasClass("chat-messages-scroll"))[0], originalList);
  assert.equal(findAll(root, hasClass("chat-loading")).length, 0);
  assert.equal(findAll(root, hasClass("chat-message-assistant")).length, 2);
  assert.equal(findAll(historicalAssistant, hasClass("chat-activity")).length, 0);
  inlineActivity(root);
  workspace.activeSession.value.events.push(user("继续分析库存"));
  workspace.pendingMessage.value = undefined;
  workspace.activeSession.value.status = "running";
  workspace.loadingSession.value = false;
  await nextTick();
  assert.deepEqual(messages(root), ["已有问题", "已有回复", "继续分析库存"]);
  assert.equal(findAll(root, hasClass("chat-messages-scroll"))[0], originalList);
  assert.match(textContent(root), /助手正在回复…/);
  assert.equal(findAll(root, hasClass("chat-message-assistant")).length, 2);
  assert.equal(findAll(root, hasClass("chat-message-assistant"))[0], historicalAssistant);
  assert.equal(findAll(historicalAssistant, hasClass("chat-activity")).length, 0);
  inlineActivity(root);
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
  workspace.activeSession.value.status = "idle";
  workspace.activeSession.value.events.push({ type: "error", message: "已取消", at });
  workspace.responding.value = false;
  workspace.sending.value = false;
  workspace.canCancel.value = false;
  workspace.cancelling.value = false;
  await nextTick();
  assert.equal(draft.value, "下一条草稿");
  assert.equal(button(root, "停止回复"), undefined);
  assert.equal(button(root, "发送消息").props.disabled, false);
  assert.equal(findAll(root, hasClass("chat-activity")).length, 0);
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
  assert.equal(findAll(root, hasClass("chat-message-assistant")).length, 1);
  const activity = inlineActivity(root);
  assert.equal(button(root, "停止回复").props.disabled, false);
  await submit(root);
  assert.deepEqual(calls.submit, []);
  await button(root, "停止回复").props.onClick();
  await nextTick();
  assert.equal(calls.cancel, 1);
  assert.match(textContent(root), /正在停止…/);
  assert.equal(inlineActivity(root), activity);
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

test("each assistant turn renders independently collapsed process rows in the order of its Markdown answers", async () => {
  const { root } = await mount(session("idle", [
    user("查看库存"),
    thinking("**先核对**数据来源"),
    tool("inventory", "success", { args: { store: "A" }, result: "120 件" }),
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
  const answer = findAll(assistants[0], hasClass("chat-answer"))[0];
  assert.deepEqual(replyParts(assistants[0]), [rows[0], rows[1], answer]);
  assert.equal(findAll(root, hasClass("chat-activities")).length, 0);
  assert.match(textContent(summary(rows[0])), /思考/);
  assert.match(textContent(summary(rows[1])), /查询库存已完成/);
  assert.match(markdownHtml(rows[0]), /<strong>先核对<\/strong>/);
  assert.match(markdownHtml(answer), /<h2>库存结果<\/h2>/);
  // Native <details> owns open state; toggling one row does not change another.
  rows[0].open = true;
  assert.equal(rows[1].open, undefined);
});

test("tool lifecycle updates one keyed row, preserves native expansion and distinguishes failure from running", async () => {
  const { root, workspace } = await mount(session("running", [
    user("查询门店"),
    thinking("先查询库存", "reply:0"),
    tool("inventory", "running", { args: { store: "A" } }, "reply:1"),
    tool("sales", "running", { name: "查询销售" }, "reply:2"),
  ]));
  const [thought, inventory, sales] = processes(root);
  inventory.open = true;
  thought.open = false;
  workspace.activeSession.value.events.push(
    tool("inventory", "running", { progress: "已读取 100 条" }, "reply:1"),
    tool("inventory", "error", { result: "连接超时" }, "reply:1"),
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

test("text, tool, text and later tools append in sequence with inline loading after the last part", async () => {
  const { root, workspace } = await mount(session("running", [user("分析门店"), textBlock("reply:0", "先读取库存。")]));
  workspace.responding.value = true;
  await nextTick();
  const assistant = findAll(root, hasClass("chat-message-assistant"))[0];
  const firstAnswer = replyParts(assistant)[0];
  const loading = inlineActivity(root, assistant);
  workspace.activeSession.value.events.push(tool("inventory", "running", {}, "reply:1"));
  await nextTick();
  const inventory = processes(root)[0];
  inventory.open = true;
  assert.deepEqual(replyParts(assistant), [firstAnswer, inventory]);
  assert.equal(inlineActivity(root), loading);
  workspace.activeSession.value.events.push(textBlock("reply:2", "库存已读取，继续查询销售。"), tool("sales", "running", { name: "查询销售" }, "reply:3"));
  await nextTick();
  const secondAnswer = findAll(assistant, hasClass("chat-answer"))[1];
  const sales = processes(root)[1];
  sales.open = true;
  assert.deepEqual(replyParts(assistant), [firstAnswer, inventory, secondAnswer, sales]);
  assert.equal(inlineActivity(root), loading);
  workspace.activeSession.value.events.push(tool("inventory", "success", { result: "120 件" }, "reply:1"));
  await nextTick();
  assert.deepEqual(replyParts(assistant), [firstAnswer, inventory, secondAnswer, sales]);
  assert.equal(inventory.open, true);
  assert.equal(sales.open, true);
  assert.equal(inventory.props["data-status"], "completed");
  assert.equal(inlineActivity(root), loading);
  workspace.activeSession.value.events.push(tool("sales", "success", { result: "100 元" }, "reply:3"), textBlock("reply:4", "**汇总完成**。"));
  workspace.activeSession.value.status = "idle";
  workspace.responding.value = false;
  await nextTick();
  const finalAnswer = findAll(assistant, hasClass("chat-answer"))[2];
  assert.deepEqual(replyParts(assistant), [firstAnswer, inventory, secondAnswer, sales, finalAnswer]);
  assert.equal(findAll(root, hasClass("chat-message-assistant"))[0], assistant);
  assert.equal(findAll(root, hasClass("chat-message-assistant")).length, 1);
  assert.equal(findAll(root, hasClass("chat-avatar-assistant")).length, 1);
  assert.equal(findAll(root, hasClass("chat-activity")).length, 0);
  assert.equal(inventory.open, true);
  assert.equal(sales.open, true);
  assert.deepEqual(messages(root), ["分析门店", "先读取库存。", "库存已读取，继续查询销售。", "汇总完成。"]);
});

test("skill and browser rows stay between their surrounding Markdown answers", async () => {
  const { root } = await mount(session("idle", [
    user("分析网页"),
    textBlock("reply:0", "先加载分析技能。"),
    { type: "skill", skill: { id: "analysis", name: "网页分析" }, action: "loaded", at },
    textBlock("reply:1", "继续打开网页。"),
    browserEvent(),
    textBlock("reply:2", "开始读取页面。"),
    tool("read", "success", { name: "读取页面", result: "读取完成" }, "reply:3"),
    textBlock("reply:4", "**分析完成**。"),
  ]));
  const assistant = findAll(root, hasClass("chat-message-assistant"))[0];
  const [skill, browser, read] = processes(root);
  const [beforeSkill, beforeBrowser, beforeTool, final] = findAll(assistant, hasClass("chat-answer"));
  assert.deepEqual(replyParts(assistant), [beforeSkill, skill, beforeBrowser, browser, beforeTool, read, final]);
  assert.match(textContent(summary(skill)), /网页分析已加载/);
  assert.match(textContent(summary(browser)), /浏览器已打开/);
  assert.match(textContent(summary(read)), /读取页面已完成/);
  assert.equal(findAll(root, hasClass("chat-avatar-assistant")).length, 1);
  assert.equal(findAll(root, hasClass("chat-activity")).length, 0);
});

test("streamed thinking and answer Markdown update in place and done snapshots preserve expanded rows", async () => {
  const { root, workspace } = await mount(session("running", [user("分析库存")]));
  workspace.responding.value = true;
  await nextTick();
  const assistant = findAll(root, hasClass("chat-message-assistant"))[0];
  const loading = inlineActivity(root, assistant);
  assert.deepEqual(replyParts(assistant), []);
  workspace.liveBlocks.value.blocks["reply:0"] = { type: "thinking", content: "**先核对**" };
  await nextTick();
  const thought = processes(root)[0];
  assert.ok(thought);
  assert.equal(findAll(root, hasClass("chat-message-assistant"))[0], assistant);
  assert.equal(inlineActivity(root), loading);
  thought.open = true;
  assert.match(markdownHtml(thought), /<strong>先核对<\/strong>/);
  workspace.liveBlocks.value.blocks["reply:0"].content += "数据来源";
  workspace.liveBlocks.value.blocks["reply:1"] = { type: "text", content: "## 库存结果\n\n库存 **120** 件。" };
  await nextTick();
  const answer = findAll(assistant, hasClass("chat-answer"))[0];
  assert.deepEqual(replyParts(assistant), [thought, answer]);
  assert.equal(inlineActivity(root), loading);
  assert.match(textContent(thought), /先核对数据来源/);
  assert.match(markdownHtml(answer), /<h2>库存结果<\/h2>/);
  assert.match(markdownHtml(answer), /<strong>120<\/strong>/);
  workspace.activeSession.value.events.push(thinking("**已核对**最终来源", "reply:0"), textBlock("reply:1", "最终库存 **121** 件。"));
  // A done snapshot wins even if a stale live block survives the same render tick.
  await nextTick();
  assert.equal(findAll(root, hasClass("chat-message-assistant"))[0], assistant);
  assert.deepEqual(processes(root), [thought]);
  assert.equal(findAll(assistant, hasClass("chat-answer"))[0], answer);
  assert.equal(inlineActivity(root), loading);
  assert.equal(thought.open, true);
  assert.match(textContent(thought), /已核对最终来源/);
  assert.doesNotMatch(textContent(thought), /先核对/);
  assert.deepEqual(messages(root), ["分析库存", "最终库存 121 件。"]);
  delete workspace.liveBlocks.value.blocks["reply:0"];
  delete workspace.liveBlocks.value.blocks["reply:1"];
  await nextTick();
  assert.equal(processes(root)[0], thought);
  assert.equal(thought.open, true);
  assert.equal(findAll(assistant, hasClass("chat-answer"))[0], answer);
  assert.equal(inlineActivity(root), loading);
  workspace.activeSession.value.status = "idle";
  workspace.responding.value = false;
  await nextTick();
  assert.equal(findAll(root, hasClass("chat-message-assistant"))[0], assistant);
  assert.deepEqual(replyParts(assistant), [thought, answer]);
  assert.equal(thought.open, true);
  assert.equal(findAll(root, hasClass("chat-avatar-assistant")).length, 1);
  assert.equal(findAll(root, hasClass("chat-activity")).length, 0);
});

test("stream content follows the scroll position and never pulls a reader away from older messages", async () => {
  const { root, workspace } = await mount(session("running", [user("分析库存")]));
  workspace.liveBlocks.value.blocks["reply:0"] = { type: "text", content: "第一段" };
  await nextTick();
  await nextTick();
  const list = findAll(root, hasClass("chat-messages-scroll"))[0];
  list.scrollHeight = 1000;
  list.clientHeight = 300;
  list.scrollTop = 660;
  workspace.liveBlocks.value.blocks["reply:0"].content += "继续回复";
  await nextTick();
  await nextTick();
  assert.equal(list.scrollTop, 1000);
  list.scrollTop = 120;
  workspace.liveBlocks.value.blocks["reply:0"].content += "更多回复";
  await nextTick();
  await nextTick();
  assert.equal(list.scrollTop, 120);
  assert.deepEqual(messages(root), ["分析库存", "第一段继续回复更多回复"]);
});

test("tool success merges several progress updates and a late running event cannot reopen the call", async () => {
  const { root, workspace } = await mount(session("running", [
    user("查询门店"), tool("inventory", "running", { args: { store: "A" }, progress: "准备读取" }, "reply:0"),
  ]));
  const row = processes(root)[0];
  row.open = true;
  workspace.activeSession.value.events.push(
    tool("inventory", "running", { progress: "已读取 100 条" }, "reply:0"),
    tool("inventory", "running", { progress: "已读取 120 条" }, "reply:0"),
    tool("inventory", "success", { result: "120 件" }, "reply:0"),
    tool("inventory", "running", { progress: "迟到的进度" }, "reply:0"),
  );
  await nextTick();
  assert.deepEqual(processes(root), [row]);
  assert.equal(row.open, true);
  assert.equal(row.props["data-status"], "completed");
  assert.match(textContent(summary(row)), /查询库存已完成/);
  assert.match(textContent(row), /准备读取/);
  assert.match(textContent(row), /已读取 100 条/);
  assert.match(textContent(row), /已读取 120 条/);
  assert.match(textContent(row), /迟到的进度/);
  assert.match(textContent(row), /结果120 件/);
  assert.match(textContent(row), /"store": "A"/);
});

test("out of order completed blocks use their backend sequence while warnings remain after older answers", async () => {
  const { root } = await mount(session("idle", [
    user("生成报告"),
    tool("inventory", "success", {}, "reply:1"),
    thinking("最后汇总", "reply:3"),
    textBlock("reply:4", "第二段"),
    thinking("先核对来源", "reply:0"),
    textBlock("reply:2", "第一段"),
    { type: "warn", text: "部分数据缺失", at },
    { type: "error", message: "连接中断", at },
  ]));
  const rows = processes(root);
  assert.equal(rows.length, 3);
  assert.match(textContent(rows[0]), /先核对来源/);
  assert.match(textContent(rows[1]), /查询库存已完成/);
  assert.match(textContent(rows[2]), /最后汇总/);
  const assistant = findAll(root, hasClass("chat-message-assistant"))[0];
  const answers = findAll(assistant, hasClass("chat-answer"));
  assert.deepEqual(replyParts(assistant), [rows[0], rows[1], answers[0], rows[2], answers[1], answers[2], answers[3]]);
  assert.deepEqual(messages(root), ["生成报告", "第一段", "第二段", "部分数据缺失", "连接中断"]);
});

test("terminal sessions distinguish an explicitly cancelled tool from an incomplete failed request", async () => {
  const { root, workspace } = await mount(session("running", [user("查询"), tool("inventory", "running")]));
  const row = processes(root)[0];
  workspace.activeSession.value.events.push({ type: "error", message: "已取消", at });
  workspace.activeSession.value.status = "idle";
  await nextTick();
  assert.equal(processes(root)[0], row);
  assert.equal(row.props["data-status"], "cancelled");
  assert.match(textContent(summary(row)), /已中断/);
  workspace.activeSession.value = session("idle", [user("查询"), tool("inventory", "running"), { type: "error", message: "网络中断", at }]);
  await nextTick();
  assert.equal(processes(root)[0].props["data-status"], "ended");
  assert.match(textContent(summary(processes(root)[0])), /未完成/);
  assert.doesNotMatch(textContent(summary(processes(root)[0])), /已完成|已中断|调用中/);
});

test("reused tool IDs stay isolated in separate assistant turns and old session live blocks remain hidden", async () => {
  const { root, workspace } = await mount(session("running", [
    user("第一轮"), tool("reused", "success", { result: "第一轮结果" }, "first:0"),
    user("第二轮"), tool("reused", "error", { result: "第二轮错误" }, "second:0"),
  ]));
  const rows = processes(root);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].props["data-status"], "completed");
  assert.equal(rows[1].props["data-status"], "failed");
  assert.match(textContent(rows[0]), /第一轮结果/);
  assert.doesNotMatch(textContent(rows[0]), /第二轮错误/);
  assert.equal(findAll(root, hasClass("chat-avatar-assistant")).length, 2);
  workspace.liveBlocks.value.blocks["second:1"] = { type: "text", content: "旧会话流式回复" };
  await nextTick();
  assert.match(textContent(root), /旧会话流式回复/);
  workspace.activeSessionId.value = "session-2";
  workspace.activeSession.value = { ...session("idle", [user("新会话")]), id: "session-2" };
  await nextTick();
  assert.deepEqual(messages(root), ["新会话"]);
  assert.doesNotMatch(textContent(root), /旧会话流式回复/);
});

test("legacy tool records stay inspectable without inventing successful completion", async () => {
  const { root } = await mount(session("idle", [
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
  const events = [user("查库存"), thinking("检查数据"), tool("inventory", "success")];
  const { root, workspace } = await mount(session("idle", events));
  const original = processes(root)[0];
  original.open = true;
  workspace.activeSessionId.value = "session-2";
  workspace.activeSession.value = { ...session("idle", events), id: "session-2" };
  await nextTick();
  const selected = processes(root)[0];
  assert.notEqual(selected, original);
  assert.equal(selected.open, undefined);
  workspace.activeSessionId.value = "session-1";
  workspace.activeSession.value = session("idle", events);
  await nextTick();
  assert.notEqual(processes(root)[0], selected);
  assert.equal(processes(root)[0].open, undefined);
});

test("actual Markdown component renders answer tables and code and escapes unsafe HTML in answers and thinking", async () => {
  const { root } = await mount(session("idle", [
    user("生成报告"),
    thinking('**核对来源**\n\n<img src=x onerror="alert(1)">'),
    say('| 门店 | 库存 |\n| --- | ---: |\n| A | **120** |\n\n```js\nconst label = "<script>";\n```\n\n<script>alert(1)</script>\n\n[打开](javascript:alert(1))'),
  ]));
  const row = processes(root)[0];
  const thoughtHtml = markdownHtml(row);
  const answerHtml = markdownHtml(findAll(root, hasClass("chat-message-markdown"))[0]);
  assert.match(thoughtHtml, /<strong>核对来源<\/strong>/);
  assert.match(thoughtHtml, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(thoughtHtml, /<img\b/);
  assert.match(answerHtml, /<div class="markdown-table-scroll"><table>/);
  assert.match(answerHtml, /<td style="text-align:right"><strong>120<\/strong><\/td>/);
  assert.match(answerHtml, /<pre><code class="language-js">const label = &quot;&lt;script&gt;&quot;;/);
  assert.match(answerHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(answerHtml, /<script\b|href="javascript:/i);
});

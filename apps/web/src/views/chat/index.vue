<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, ref, watch } from "vue";
import { ElButton } from "element-plus/es/components/button/index";
import { ElCard } from "element-plus/es/components/card/index";
import { ElInput } from "element-plus/es/components/input/index";
import { ElOptionGroup, ElSelect } from "element-plus/es/components/select/index";
import type { InputInstance } from "element-plus";
import type { BrowserSessionState, ReasoningEffort, SessionEvent } from "@qdd/shared";
import AgentIcon from "@/components/AgentIcon.vue";
import AttachmentList, { type AttachmentItem } from "@/components/AttachmentList.vue";
import StringSelectOption from "@/components/StringSelectOption";
import { downloadAttachment } from "@/api/workspace";
import { filesFromDrop, filesFromInput } from "@/composables/useComposer";
import MarkdownContent from "@/components/MarkdownContent.vue";
import SessionActions from "@/components/SessionActions.vue";
import { useWorkspaceContext } from "@/composables/workspaceContext";
import { buildChatTimeline, toolStatus, toolTitle } from "@/utils/chatTimeline";

const SessionBrowser = defineAsyncComponent(() => import("@/components/SessionBrowser.vue"));

const { workspace, draft, submitMessage, notify, navigation, composer: attach } = useWorkspaceContext();
const {
  activeSession,
  activeSessionId,
  liveBlocks,
  revisionPageSlug,
  preferences,
  connected,
  loadingSession,
  sending,
  pendingMessage,
  responding,
  canCancel,
  cancelling,
  eventActionBusy,
  answerQuestions,
  resolveApproval,
  cancel,
  chatOptions,
  chatOptionsLoading,
  chatOptionsError,
  chatSelection,
  selectReasoningEffort,
  loadChatOptions,
} = workspace;
const { openPage, openView } = navigation;
const composer = ref<InputInstance>();
const fileInput = ref<HTMLInputElement>();
const folderInput = ref<HTMLInputElement>();
const dragDepth = ref(0);
const { attachments, uploading, catalog, currentModel, modelLoading, modelError, modelChanging } = attach;
const composerItems = computed<AttachmentItem[]>(() =>
  attachments.value.map((a) => ({
    key: a.key,
    path: a.path,
    size: a.size,
    status: a.status,
    ...(a.error ? { error: a.error } : {}),
    ...(a.ref ? { id: a.ref.id, mime: a.ref.mime } : {}),
  })),
);
const canSend = computed(
  () =>
    connected.value &&
    !sending.value &&
    !loadingSession.value &&
    !uploading.value &&
    !modelChanging.value &&
    (Boolean(draft.value.trim()) || attach.ready.value.length > 0),
);
const modelValue = computed({
  get: () => currentModel.value?.id ?? "",
  set: (id: string) => {
    if (!id) return;
    void attach.selectModel(id);
  },
});
const modelGroups = computed(() => {
  const groups = new Map<string, NonNullable<typeof catalog.value>["models"]>();
  for (const model of catalog.value?.models ?? []) {
    const provider = model.provider || "其他模型";
    const group = groups.get(provider) ?? [];
    group.push(model);
    groups.set(provider, group);
  }
  return Array.from(groups, ([provider, models]) => ({ provider, models }));
});
function refreshChatModels() {
  void attach.refreshModels();
  void loadChatOptions();
}
function historyItems(event: SessionEvent): AttachmentItem[] {
  return event.type === "user" ? (event.attachments ?? []).map((a) => ({ key: a.id, id: a.id, path: a.path, size: a.size, mime: a.mime })) : [];
}
function pickFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  attach.addFiles(filesFromInput(input.files));
  input.value = "";
  focusComposer();
}
function handlePaste(event: ClipboardEvent) {
  if (!connected.value || !event.clipboardData?.files.length) return;
  event.preventDefault();
  attach.addFiles(filesFromInput(event.clipboardData.files));
}
function hasFiles(event: DragEvent) {
  return [...(event.dataTransfer?.types ?? [])].includes("Files");
}
function dragEnter(event: DragEvent) {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth.value++;
}
function dragLeave(event: DragEvent) {
  if (!hasFiles(event)) return;
  dragDepth.value = Math.max(0, dragDepth.value - 1);
}
async function drop(event: DragEvent) {
  if (!hasFiles(event) || !event.dataTransfer) return;
  event.preventDefault();
  dragDepth.value = 0;
  if (!connected.value) return;
  attach.addFiles(await filesFromDrop(event.dataTransfer));
  focusComposer();
}
async function openAttachment(item: AttachmentItem) {
  if (!item.id) return;
  try {
    const blob = await downloadAttachment(workspace.gatewayUrl.value, workspace.token.value, item.id);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = item.path.split("/").pop() ?? "attachment";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch {
    notify("下载附件失败");
  }
}
const messageList = ref<HTMLElement>();
const browserPreview = ref<HTMLElement>();
const browserOpen = ref(false);
const closedBrowserId = ref("");
let revealBrowserRequested = false;
let followBrowserOnMount = false;
const reasoningLabels: Record<ReasoningEffort, string> = {
  default: "默认",
  none: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
  ultra: "超高",
};
const selectedModel = computed(() => chatOptions.value?.models.find((model) => model.id === chatSelection.value?.model));
const gapLabels = { missing_data: "缺少数据", estimate: "估测说明", unsupported: "暂不支持", permission: "需要授权" };
const showConversation = computed(() => Boolean(activeSession.value || pendingMessage.value || responding.value || cancelling.value));
const waitingForConfirmation = computed(() => activeSession.value?.status === "waiting" && !responding.value && !cancelling.value);
const activityLabel = computed(() => {
  if (cancelling.value) return "正在停止…";
  if (pendingMessage.value && responding.value) return "正在发送…";
  if (responding.value) return "助手正在回复…";
  if (waitingForConfirmation.value) return "等待你的确认，完成下方的问题或授权后继续。";
  return "";
});
const composerHint = computed(() => {
  if (cancelling.value) return "正在停止 · 草稿会保留";
  if (waitingForConfirmation.value) return "完成确认以继续 · 可点击停止结束本次执行";
  if (responding.value) return "可先编写下一条消息 · 点击停止可结束回复";
  return preferences.value.enterToSend ? "Enter 发送 · Shift + Enter 换行" : "点击发送 · Enter 换行";
});
const timeline = computed(() => {
  const session = activeSession.value;
  const live = session && liveBlocks.value.sessionId === session.id ? liveBlocks.value.blocks : {};
  const entries = buildChatTimeline(session?.events ?? [], pendingMessage.value, live, session?.status);
  if (activityLabel.value && entries.at(-1)?.kind !== "assistant") {
    const lastUser = entries.findLast((entry) => entry.kind === "user");
    entries.push({
      kind: "assistant",
      key: `assistant:${lastUser?.key ?? -1}`,
      at: lastUser?.kind === "user" ? lastUser.event.at : (session?.updatedAt ?? ""),
      parts: [],
    });
  }
  return entries;
});
// History keeps browser activity records; one live viewer stays at the conversation bottom.
const browserActivity = computed(() => {
  for (const entry of timeline.value.toReversed()) {
    if (entry.kind !== "assistant") continue;
    const part = entry.parts.findLast((part) => part.event.type === "browser");
    if (part?.event.type === "browser") return { entryKey: entry.key, browser: part.event.browser };
  }
  return undefined;
});
const latestBrowser = computed(() => {
  const browser = browserActivity.value?.browser;
  return browser?.browserSessionId === closedBrowserId.value ? { ...browser, status: "closed" as const } : browser;
});
const browserEntryKey = computed(() => browserActivity.value?.entryKey);
const suggestions = [
  { title: "经营看板", description: "查看销售与毛利，发现经营机会", prompt: "展示最近 30 天各品类销售额和毛利" },
  { title: "库存分析", description: "梳理库存变化，掌握门店状态", prompt: "帮我查看当前库存，并分析最近一周的变化" },
  { title: "趋势洞察", description: "从真实数据中找到变化与原因", prompt: "分析最近一个月的销售趋势，标出需要关注的变化" },
  { title: "生成页面", description: "说出你的想法，生成专属工具", prompt: "帮我做一个门店经营数据页面，先和我确认需要哪些指标" },
];

function focusComposer() {
  void nextTick(() => composer.value?.focus());
}
async function scrollToLatest() {
  await nextTick();
  if (messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight;
}
function focusBrowserPreview(element: Element | null) {
  if (!element?.getBoundingClientRect || !messageList.value?.getBoundingClientRect) return;
  const list = messageList.value;
  list.scrollTop += element.getBoundingClientRect().top - list.getBoundingClientRect().top - 16;
}
function toggleBrowser() {
  browserOpen.value = !browserOpen.value;
  revealBrowserRequested = browserOpen.value;
  if (browserOpen.value) void nextTick(() => focusBrowserPreview(browserPreview.value ?? null));
}
function browserMounted() {
  if (!browserOpen.value || latestBrowser.value?.status !== "running") return;
  if (revealBrowserRequested) focusBrowserPreview(browserPreview.value ?? null);
  else if (followBrowserOnMount) void scrollToLatest();
  revealBrowserRequested = false;
  followBrowserOnMount = false;
}
function browserClosed(browser: BrowserSessionState) {
  if (browser.browserSessionId !== latestBrowser.value?.browserSessionId) return;
  closedBrowserId.value = browser.browserSessionId;
  browserOpen.value = false;
  revealBrowserRequested = false;
  followBrowserOnMount = false;
}
function handleEnter(event: Event | KeyboardEvent) {
  if (!("key" in event)) return;
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && preferences.value.enterToSend) {
    event.preventDefault();
    void sendMessage();
  }
}
async function sendMessage() {
  if (!canSend.value) return;
  if (!draft.value.trim()) draft.value = "请查看我上传的附件。";
  try {
    await submitMessage();
  } catch (cause) {
    notify(cause instanceof Error ? cause.message : "发送失败，请重试。");
  }
}
function useSuggestion(prompt: string) {
  draft.value = prompt;
  focusComposer();
}
function eventText(event: SessionEvent): string {
  if ("text" in event) return event.text;
  if (event.type === "error") return event.message;
  if (event.type === "published") return `页面已发布：${event.page.title}`;
  return "";
}
function formatToolInput(input: Record<string, unknown>): string {
  return JSON.stringify(input, null, 2);
}
async function copyMessage(content: string) {
  try {
    await navigator.clipboard.writeText(content);
    notify("已复制回复");
  } catch {
    notify("复制失败，请选择文字后手动复制");
  }
}
watch([activeSessionId, () => activeSession.value?.id], () => {
  closedBrowserId.value = "";
  void scrollToLatest();
  focusComposer();
});
watch(
  [activeSessionId, () => activeSession.value?.id, () => latestBrowser.value?.browserSessionId, () => latestBrowser.value?.status],
  () => {
    revealBrowserRequested = false;
    const element = messageList.value;
    followBrowserOnMount = !element || element.scrollHeight - element.scrollTop - element.clientHeight < 100;
    browserOpen.value = activeSession.value?.id === activeSessionId.value && latestBrowser.value?.status === "running";
  },
  { immediate: true },
);
watch(
  [
    () => activeSession.value?.events.length,
    pendingMessage,
    activityLabel,
    () => Object.values(liveBlocks.value.blocks).reduce((length, block) => length + block.content.length, 0),
  ],
  async () => {
    const element = messageList.value;
    const nearBottom = !element || element.scrollHeight - element.scrollTop - element.clientHeight < 100;
    if (nearBottom) await scrollToLatest();
  },
);
onMounted(() => {
  void scrollToLatest();
  focusComposer();
});
</script>

<template>
  <section
    class="chat-view"
    aria-label="门店助手对话"
    @dragenter="dragEnter"
    @dragover="(e) => hasFiles(e) && e.preventDefault()"
    @dragleave="dragLeave"
    @drop="drop">
    <div v-if="dragDepth > 0" class="chat-drop-overlay" aria-hidden="true">
      <AgentIcon name="clip" :size="28" />
      <strong>松开即可添加附件</strong>
      <span>支持任意类型文件与整个文件夹，单个文件不超过 50 MB</span>
    </div>
    <div v-if="loadingSession && !showConversation" class="chat-loading" role="status">正在加载对话…</div>
    <div v-else-if="!showConversation" class="chat-welcome-scroll">
      <div class="chat-welcome">
        <p class="chat-eyebrow">门店经营，从一个问题开始</p>
        <h1>
          把经营问题说清楚，
          <br />
          <span>让数据帮你做决定。</span>
        </h1>
        <div class="chat-suggestions">
          <ElCard
            v-for="suggestion in suggestions"
            :key="suggestion.title"
            class="chat-suggestion"
            shadow="never"
            role="button"
            tabindex="0"
            @click="useSuggestion(suggestion.prompt)"
            @keydown.enter.prevent="useSuggestion(suggestion.prompt)"
            @keydown.space.prevent="useSuggestion(suggestion.prompt)">
            <strong>{{ suggestion.title }}</strong>
            <span>{{ suggestion.description }}</span>
          </ElCard>
        </div>
      </div>
    </div>

    <div v-else ref="messageList" class="chat-messages-scroll" role="log" aria-label="会话消息">
      <div class="chat-messages">
        <article
          v-for="entry in timeline"
          :key="`${activeSessionId ?? 'draft'}:${entry.key}`"
          class="chat-message"
          :class="entry.kind === 'user' ? 'chat-message-user' : 'chat-message-assistant'">
          <span class="chat-avatar" :class="{ 'chat-avatar-assistant': entry.kind !== 'user' }">
            <span v-if="entry.kind === 'user'">Q</span>
            <AgentIcon v-else name="spark" :size="18" />
          </span>
          <div class="chat-message-main">
            <div v-if="entry.kind === 'user'" class="chat-bubble">
              <p class="chat-message-text">{{ entry.event.text }}</p>
              <AttachmentList
                v-if="historyItems(entry.event).length"
                class="chat-bubble-attachments"
                :items="historyItems(entry.event)"
                :gateway-url="workspace.gatewayUrl.value"
                :token="workspace.token.value"
                @open="openAttachment" />
            </div>
            <template v-else>
              <div class="chat-message-meta">
                <strong>门店助手</strong>
                <time v-if="entry.at" :datetime="entry.at">
                  {{ new Date(entry.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) }}
                </time>
              </div>
              <template v-for="part in entry.parts" :key="part.key">
                <details
                  v-if="part.kind === 'activity'"
                  class="chat-process"
                  :data-kind="part.event.type"
                  :data-status="part.event.type === 'tool' ? part.event.status : undefined">
                  <summary class="chat-process-summary">
                    <AgentIcon class="chat-process-chevron" name="chevron" :size="13" />
                    <AgentIcon
                      :name="
                        part.event.type === 'thinking'
                          ? 'thinking'
                          : part.event.type === 'browser'
                            ? 'code'
                            : part.event.type === 'skill'
                              ? 'plan'
                              : 'tool'
                      "
                      :size="15" />
                    <template v-if="part.event.type === 'tool'">
                      <span class="chat-process-name" :title="toolTitle(part.event)">{{ toolTitle(part.event) }}</span>
                      <span class="chat-process-status">{{ toolStatus(part.event) }}</span>
                    </template>
                    <template v-else-if="part.event.type === 'thinking'">
                      <span class="chat-process-name">思考</span>
                      <span class="chat-process-status">{{ part.event.done ? "已完成" : "生成中…" }}</span>
                    </template>
                    <template v-else-if="part.event.type === 'skill'">
                      <span class="chat-process-name">{{ part.event.skill.name }}</span>
                      <span class="chat-process-status">{{ part.event.action === "loaded" ? "已加载" : "已保存" }}</span>
                    </template>
                    <template v-else-if="part.event.type === 'browser'">
                      <span class="chat-process-name">浏览器</span>
                      <span class="chat-process-status">{{ part.event.browser.status === "closed" ? "已关闭" : "已打开" }}</span>
                    </template>
                  </summary>
                  <div class="chat-process-details">
                    <MarkdownContent v-if="part.event.type === 'thinking'" :content="part.event.text" />
                    <template v-else-if="part.event.type === 'tool'">
                      <template v-if="part.event.input">
                        <p class="chat-process-label">参数</p>
                        <pre class="chat-process-data" tabindex="0" aria-label="工具参数">{{ formatToolInput(part.event.input) }}</pre>
                      </template>
                      <template v-if="part.progress.length">
                        <p class="chat-process-label">执行详情</p>
                        <p v-for="(text, index) in part.progress" :key="index" class="chat-process-text">{{ text }}</p>
                      </template>
                      <template v-if="part.event.output !== undefined">
                        <p class="chat-process-label">{{ part.event.status === "failed" ? "错误详情" : "结果" }}</p>
                        <pre class="chat-process-data" tabindex="0" aria-label="工具结果">{{ part.event.output }}</pre>
                      </template>
                      <p v-if="!part.event.input && !part.progress.length && part.event.output === undefined" class="chat-process-text">
                        {{ part.event.text }}
                      </p>
                    </template>
                    <template v-else-if="part.event.type === 'skill'">
                      <p class="chat-process-text">
                        {{ part.event.action === "loaded" ? "已加载，按技能步骤继续执行。" : "已保存，可在技能页面复用。" }}
                      </p>
                      <ElButton link type="primary" @click="openView('skills')">
                        查看技能
                        <AgentIcon name="chevron" :size="13" />
                      </ElButton>
                    </template>
                    <template v-else-if="part.event.type === 'browser'">
                      <p class="chat-process-text">{{ part.event.browser.title || part.event.browser.url }}</p>
                      <p v-if="part.event.browser.title" class="chat-process-text">{{ part.event.browser.url }}</p>
                      <ElButton
                        v-if="
                          entry.key === browserEntryKey &&
                          part.event.browser.status === 'running' &&
                          latestBrowser?.status === 'running' &&
                          part.event.browser.browserSessionId === latestBrowser.browserSessionId
                        "
                        link
                        type="primary"
                        @click="toggleBrowser">
                        {{ browserOpen ? "收起画面" : "查看实时画面" }}
                      </ElButton>
                    </template>
                  </div>
                </details>
                <div
                  v-else
                  class="chat-answer"
                  :class="{
                    'chat-bubble-warning': part.event.type === 'warn' || part.event.type === 'gaps',
                    'chat-bubble-error': part.event.type === 'error',
                  }">
                  <div v-if="part.event.type === 'gaps'" class="chat-gaps">
                    <div v-for="(gap, index) in part.event.gaps" :key="index">
                      <strong>{{ gapLabels[gap.kind] }} · {{ gap.item }}</strong>
                      <p>{{ gap.reason }}</p>
                      <p v-if="gap.suggestion">{{ gap.suggestion }}</p>
                    </div>
                  </div>
                  <MarkdownContent v-else class="chat-message-text chat-message-markdown" :content="eventText(part.event)" />
                  <div v-if="part.event.type === 'say' || part.event.type === 'published'" class="chat-message-actions">
                    <ElButton v-if="part.event.type === 'say'" link @click="copyMessage(part.event.text)">
                      <AgentIcon name="copy" :size="14" />
                      复制
                    </ElButton>
                    <ElButton v-if="part.event.type === 'published'" link type="primary" @click="openPage(part.event.page.slug)">
                      查看页面
                      <AgentIcon name="chevron" :size="13" />
                    </ElButton>
                  </div>
                </div>
              </template>
              <div
                v-if="activityLabel && entry.key === timeline.at(-1)?.key"
                class="chat-activity"
                role="status"
                aria-live="polite"
                aria-atomic="true">
                <div class="chat-activity-content">
                  <span v-if="responding || cancelling" class="chat-loading-dots" aria-hidden="true">
                    <i></i>
                    <i></i>
                    <i></i>
                  </span>
                  <span>{{ activityLabel }}</span>
                </div>
              </div>
            </template>
          </div>
        </article>
        <SessionActions
          v-if="activeSession"
          :key="activeSessionId ?? 'draft'"
          :session-id="activeSession.id"
          :events="activeSession.events"
          :status="activeSession.status"
          :busy="eventActionBusy"
          @answer="answerQuestions"
          @approve="resolveApproval" />
        <div
          v-if="browserOpen && latestBrowser?.status === 'running' && activeSession && activeSession.id === activeSessionId"
          ref="browserPreview"
          class="chat-browser-preview">
          <SessionBrowser
            :key="`${activeSession.id}:${latestBrowser.browserSessionId}`"
            :browser="latestBrowser"
            :session-id="activeSession.id"
            @vue:mounted="browserMounted"
            @close="browserClosed" />
        </div>
      </div>
    </div>

    <div class="chat-composer-area">
      <p v-if="!connected" class="chat-composer-note">
        先在
        <ElButton link type="primary" @click="openView('settings')">设置</ElButton>
        中填写网关地址和 token。
      </p>
      <p v-else-if="revisionPageSlug" class="chat-composer-note">
        正在修改页面：
        <ElButton link type="primary" @click="openPage(revisionPageSlug)">{{ revisionPageSlug }}</ElButton>
      </p>
      <AttachmentList
        v-if="composerItems.length"
        class="chat-composer-attachments"
        :items="composerItems"
        :gateway-url="workspace.gatewayUrl.value"
        :token="workspace.token.value"
        removable
        @remove="attach.removeAttachment"
        @remove-folder="attach.removeFolder"
        @open="openAttachment" />
      <input ref="fileInput" type="file" multiple hidden aria-label="选择文件" @change="pickFiles" />
      <input ref="folderInput" type="file" webkitdirectory multiple hidden aria-label="选择文件夹" @change="pickFiles" />
      <form class="chat-composer" @submit.prevent="sendMessage">
        <ElInput
          id="message-input"
          ref="composer"
          v-model="draft"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 5 }"
          :maxlength="8000"
          resize="none"
          aria-label="向门店助手发送消息"
          :placeholder="
            waitingForConfirmation
              ? '请先完成问题或授权确认，也可以停止后继续发送'
              : responding
                ? '助手正在处理，你可以先编写下一条消息…'
                : '描述你的经营需求，或继续聊聊…'
          "
          @keydown="handleEnter"
          @paste="handlePaste" />
        <div class="chat-composer-toolbar">
          <details v-if="catalog?.models.length || selectedModel" class="chat-model-picker">
            <summary aria-label="选择模型和思考强度">
              <AgentIcon name="spark" :size="15" />
              <span class="chat-model-name">{{ currentModel?.label ?? selectedModel?.label ?? "选择模型" }}</span>
              <span v-if="chatSelection && selectedModel" class="chat-model-effort">· {{ reasoningLabels[chatSelection.reasoningEffort] }}</span>
              <AgentIcon name="down" :size="13" />
            </summary>
            <div class="chat-model-panel">
              <label for="chat-model-select">模型</label>
              <ElSelect id="chat-model-select" v-model="modelValue" aria-label="切换模型" filterable :loading="modelLoading" :disabled="!connected">
                <ElOptionGroup v-for="group in modelGroups" :key="group.provider" :label="group.provider">
                  <StringSelectOption
                    v-for="model in group.models"
                    :key="model.id"
                    :value="model.id"
                    :label="`${model.label}${model.available ? '' : '（未配置 Key）'}`"
                    :disabled="!model.available" />
                </ElOptionGroup>
              </ElSelect>
              <p class="chat-model-note">切换模型后，下一轮回复起生效。</p>
              <p v-if="modelChanging" class="chat-model-note" role="status">正在切换模型…</p>
              <div v-if="modelError || chatOptionsError" class="chat-model-error" role="alert">
                <span>{{ modelError || chatOptionsError }}</span>
                <button type="button" :disabled="modelLoading || chatOptionsLoading" @click="refreshChatModels">重试</button>
              </div>
              <fieldset v-if="chatSelection && selectedModel" class="chat-reasoning-options">
                <legend>思考强度</legend>
                <button
                  v-for="effort in selectedModel.reasoningEfforts"
                  :key="effort"
                  type="button"
                  :aria-pressed="chatSelection.reasoningEffort === effort"
                  :disabled="!connected || modelChanging"
                  @click="selectReasoningEffort(effort)">
                  {{ reasoningLabels[effort] }}
                </button>
              </fieldset>
            </div>
          </details>
          <button
            v-else-if="(modelError || chatOptionsError) && connected"
            type="button"
            class="chat-model-retry"
            :title="modelError || chatOptionsError"
            @click="refreshChatModels">
            重新加载模型
          </button>
          <span v-else class="chat-model-placeholder">{{ modelLoading || chatOptionsLoading ? "正在加载模型…" : "默认模型" }}</span>
          <div class="chat-composer-tools">
            <div class="chat-attach-buttons">
              <button
                type="button"
                class="chat-attach"
                title="添加文件（任意类型）"
                aria-label="添加文件"
                :disabled="!connected"
                @click="fileInput?.click()">
                <AgentIcon name="clip" :size="18" />
              </button>
              <button
                type="button"
                class="chat-attach"
                title="添加文件夹"
                aria-label="添加文件夹"
                :disabled="!connected"
                @click="folderInput?.click()">
                <AgentIcon name="folder" :size="18" />
              </button>
            </div>
            <button
              v-if="canCancel || cancelling"
              class="chat-send chat-stop"
              type="button"
              aria-label="停止回复"
              :title="cancelling ? '正在停止…' : '停止回复'"
              :disabled="cancelling"
              @click="cancel">
              <span class="chat-stop-symbol" aria-hidden="true"></span>
            </button>
            <ElButton v-else class="chat-send" type="primary" native-type="submit" aria-label="发送消息" title="发送消息" :disabled="!canSend">
              <AgentIcon name="arrow" :size="20" />
            </ElButton>
          </div>
        </div>
      </form>
      <div class="chat-composer-footer">
        <div class="chat-conversation-actions">
          <ElButton v-if="activeSession?.slug" link type="primary" @click="openPage(activeSession.slug)">查看生成页面</ElButton>
          <ElButton v-if="latestBrowser?.status === 'running' && activeSession?.id === activeSessionId" link @click="toggleBrowser">
            {{ browserOpen ? "收起浏览器" : "查看浏览器" }}
          </ElButton>
        </div>
        <p class="chat-keyboard-hint">{{ composerHint }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.chat-drop-overlay {
  position: absolute;
  inset: 12px;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 2px dashed var(--qdd-primary);
  border-radius: 16px;
  background: color-mix(in srgb, var(--qdd-surface) 88%, transparent);
  color: var(--qdd-text);
  pointer-events: none;
}
.chat-drop-overlay span {
  color: var(--qdd-muted);
  font-size: 12px;
}
.chat-composer-attachments {
  margin-bottom: 10px;
}
.chat-bubble-attachments {
  margin-top: 8px;
}
.chat-attach-buttons {
  display: flex;
  flex: 0 0 auto;
  align-self: center;
  gap: 2px;
}
.chat-attach {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: none;
  color: var(--qdd-muted);
  cursor: pointer;
}
.chat-attach:hover:not(:disabled) {
  background: var(--qdd-border);
  color: var(--qdd-text);
}
.chat-attach:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.chat-view {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.chat-loading {
  display: grid;
  flex: 1;
  place-items: center;
  color: var(--qdd-muted);
  font-size: 14px;
}
.chat-welcome-scroll {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  padding: 32px;
}
.chat-welcome {
  width: min(100%, 760px);
  margin: auto;
  text-align: center;
}
.chat-eyebrow {
  margin: 0 0 16px;
  color: var(--qdd-muted);
  font-size: 14px;
}
.chat-welcome h1 {
  margin: 0;
  font-size: clamp(28px, 3.1vw, 42px);
  font-weight: 650;
  line-height: 1.45;
  letter-spacing: -0.8px;
}
.chat-welcome h1 span {
  color: var(--qdd-primary);
}
.chat-suggestions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-top: 30px;
  text-align: left;
}
.chat-suggestion {
  cursor: pointer;
  border-radius: 10px;
  transition:
    border-color 0.15s,
    background 0.15s;
}
.chat-suggestion:hover {
  border-color: var(--qdd-primary);
  background: var(--qdd-primary-soft);
}
.chat-suggestion :deep(.el-card__body) {
  padding: 18px 22px;
}
.chat-suggestion strong {
  display: block;
  margin-bottom: 4px;
  color: var(--qdd-text);
  font-size: 16px;
  font-weight: 600;
}
.chat-suggestion span {
  display: block;
  color: var(--qdd-muted);
  font-size: 13px;
  line-height: 1.6;
}
.chat-messages-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.chat-messages {
  display: flex;
  flex-direction: column;
  gap: 22px;
  width: min(100%, 960px);
  margin: 0 auto;
  padding: 30px 34px 20px;
}
.chat-message {
  display: flex;
  align-items: flex-start;
  gap: 13px;
  min-width: 0;
}
.chat-message-user {
  flex-direction: row-reverse;
}
.chat-avatar {
  display: grid;
  flex: 0 0 36px;
  place-items: center;
  width: 36px;
  height: 36px;
  border: 1px solid var(--qdd-border);
  border-radius: 50%;
  color: var(--qdd-muted);
  background: var(--qdd-surface);
  font-size: 13px;
}
.chat-avatar-assistant {
  color: var(--qdd-primary);
  background: var(--qdd-primary-soft);
  border-color: var(--qdd-primary-soft);
}
.chat-message-main {
  min-width: 0;
  max-width: calc(100% - 49px);
}
.chat-message-assistant .chat-message-main {
  flex: 1;
}
.chat-message-user .chat-message-main {
  max-width: min(82%, 700px);
}
.chat-bubble {
  padding: 14px 18px;
  border: 1px solid var(--qdd-border);
  border-radius: 12px;
  background: var(--qdd-surface);
}
.chat-message-user .chat-bubble {
  padding: 12px 18px;
}
.chat-message-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 9px;
  color: var(--qdd-muted);
  font-size: 11px;
}
.chat-message-meta strong {
  color: var(--qdd-text);
  font-size: 13px;
  font-weight: 600;
}
.chat-message-meta time {
  margin-left: auto;
}
.chat-message-text {
  margin: 0;
  font-size: 14px;
  line-height: 1.8;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.chat-message-markdown {
  white-space: normal;
}
.chat-answer {
  min-width: 0;
}
.chat-answer + .chat-answer {
  margin-top: 16px;
}
.chat-answer + .chat-process,
.chat-process + .chat-answer {
  margin-top: 12px;
}
.chat-process + .chat-process {
  margin-top: 2px;
}
.chat-browser-preview {
  min-width: 0;
  margin-left: 49px;
}
.chat-message-actions {
  display: flex;
  margin-top: 10px;
}
.chat-message-actions :deep(.el-button) {
  color: var(--qdd-muted);
  font-size: 12px;
}
.chat-message-actions :deep(.el-button--primary) {
  color: var(--qdd-primary);
}
.chat-message-actions :deep(.el-button > span) {
  gap: 5px;
}
.chat-activity {
  margin-top: 8px;
  color: var(--qdd-muted);
  font-size: 13px;
}
.chat-activity-content {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 24px;
  line-height: 1.7;
}
.chat-loading-dots {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
}
.chat-loading-dots i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--qdd-primary);
  animation: chat-loading-pulse 1.2s ease-in-out infinite;
}
.chat-loading-dots i:nth-child(2) {
  animation-delay: 0.16s;
}
.chat-loading-dots i:nth-child(3) {
  animation-delay: 0.32s;
}
@keyframes chat-loading-pulse {
  0%,
  80%,
  100% {
    opacity: 0.35;
    transform: translateY(0);
  }
  40% {
    opacity: 1;
    transform: translateY(-3px);
  }
}
.chat-process {
  min-width: 0;
  color: var(--qdd-muted);
  font-size: 13px;
}
.chat-process-summary {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 30px;
  width: fit-content;
  max-width: 100%;
  padding: 3px 6px 3px 0;
  border-radius: 5px;
  cursor: pointer;
  list-style: none;
  line-height: 1.6;
}
.chat-process-summary::-webkit-details-marker {
  display: none;
}
.chat-process-summary:hover {
  color: var(--qdd-text);
  background: var(--qdd-hover);
}
.chat-process-summary:focus-visible {
  outline: 2px solid var(--qdd-primary);
  outline-offset: 2px;
}
.chat-process-summary > svg {
  flex: 0 0 auto;
}
.chat-process-chevron {
  transition: transform 0.15s;
}
.chat-process[open] > .chat-process-summary .chat-process-chevron {
  transform: rotate(90deg);
}
.chat-process-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat-process-status {
  flex: 0 0 auto;
  font-size: 12px;
}
.chat-process[data-status="failed"] .chat-process-status {
  color: var(--qdd-bad);
}
.chat-process-details {
  display: grid;
  gap: 8px;
  min-width: 0;
  margin: 5px 0 10px 6px;
  padding: 6px 0 6px 18px;
  border-left: 2px solid var(--qdd-border);
  color: var(--qdd-text);
}
.chat-process-label {
  margin: 0;
  color: var(--qdd-muted);
  font-size: 12px;
}
.chat-process-data {
  max-width: 100%;
  max-height: 280px;
  margin: 0;
  padding: 12px;
  overflow: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--qdd-border);
  border-radius: 8px;
  background: var(--qdd-surface);
  font:
    12px/1.65 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  white-space: pre;
}
.chat-process-text {
  margin: 0;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.chat-process-details :deep(.el-button) {
  justify-self: start;
  margin: 0;
  font-size: 12px;
}
.chat-bubble-warning {
  padding: 12px 14px;
  border-left: 2px solid var(--qdd-warn);
  border-radius: 6px;
  background: color-mix(in srgb, var(--qdd-warn) 5%, var(--qdd-surface));
}
.chat-bubble-error {
  padding: 12px 14px;
  border-left: 2px solid var(--qdd-bad);
  border-radius: 6px;
  color: var(--qdd-bad);
  background: color-mix(in srgb, var(--qdd-bad) 5%, var(--qdd-surface));
}
.chat-gaps {
  display: grid;
  gap: 12px;
  font-size: 13px;
  line-height: 1.8;
}
.chat-gaps strong {
  color: var(--qdd-warn);
  font-weight: 500;
}
.chat-gaps p {
  margin: 3px 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.chat-composer-area {
  flex: 0 0 auto;
  width: min(100%, 960px);
  margin: 0 auto;
  padding: 16px 34px 20px;
}
.chat-composer {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 110px;
  padding: 17px 18px 12px 22px;
  border: 1px solid var(--qdd-border);
  border-radius: 14px;
  background: var(--qdd-surface);
}
.chat-composer:focus-within {
  border-color: var(--qdd-primary);
}
.chat-composer :deep(.el-textarea) {
  width: 100%;
  min-width: 0;
}
.chat-composer :deep(.el-textarea__inner) {
  padding: 0;
  box-shadow: none;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--qdd-text);
  font: 14px/1.8 var(--qdd-font);
  outline: none;
}
.chat-composer :deep(.el-textarea__inner:focus-visible) {
  outline: none;
}
.chat-composer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-width: 0;
}
.chat-composer-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.chat-file-input {
  display: none;
}
.chat-attach-button,
.chat-attachment-remove {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  padding: 7px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--qdd-muted);
  cursor: pointer;
}
.chat-attach-button:hover,
.chat-attachment-remove:hover {
  background: var(--qdd-hover);
  color: var(--qdd-text);
}
.chat-attach-button:disabled {
  opacity: 0.45;
  cursor: default;
}
.chat-attachments {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-height: 150px;
  overflow-y: auto;
}
.chat-attachment {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(100%, 270px);
  padding: 8px 7px 8px 10px;
  border: 1px solid var(--qdd-border);
  border-radius: 9px;
  color: var(--qdd-muted);
  background: var(--qdd-bg);
}
.chat-attachment > svg {
  flex-shrink: 0;
}
.chat-attachment-info {
  display: grid;
  gap: 3px;
  min-width: 0;
}
.chat-attachment-info strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--qdd-text);
  font-size: 12px;
  font-weight: 500;
}
.chat-attachment-info span,
.chat-attachment-progress {
  color: var(--qdd-muted);
  font-size: 11px;
}
.chat-model-picker {
  min-width: 0;
  max-width: calc(100% - 100px);
}
.chat-model-picker > summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 6px;
  border-radius: 6px;
  color: var(--qdd-muted);
  font-size: 12px;
  list-style: none;
  cursor: pointer;
}
.chat-model-picker > summary::-webkit-details-marker {
  display: none;
}
.chat-model-picker > summary:hover {
  background: var(--qdd-hover);
  color: var(--qdd-text);
}
.chat-model-picker > summary > svg,
.chat-model-effort {
  flex-shrink: 0;
}
.chat-model-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat-model-panel {
  position: absolute;
  z-index: 5;
  bottom: 62px;
  left: 16px;
  display: grid;
  gap: 10px;
  width: min(340px, calc(100% - 32px));
  padding: 16px;
  border: 1px solid var(--qdd-border);
  border-radius: 12px;
  background: var(--qdd-surface);
  box-shadow: 0 8px 30px #0002;
}
.chat-model-panel > label,
.chat-reasoning-options > legend {
  padding: 0;
  color: var(--qdd-text);
  font-size: 12px;
}
.chat-model-note {
  margin: 0;
  color: var(--qdd-muted);
  font-size: 11px;
  line-height: 1.6;
}
.chat-model-error {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--qdd-bad);
  font-size: 12px;
  line-height: 1.6;
}
.chat-model-error > span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.chat-model-error > button {
  flex-shrink: 0;
  border: 0;
  padding: 4px;
  background: transparent;
  color: var(--qdd-primary);
  font: inherit;
  cursor: pointer;
}
.chat-reasoning-options {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 2px 0 0;
  padding: 10px 0 0;
  border: 0;
}
.chat-reasoning-options > button {
  flex: 1;
  min-width: 40px;
  padding: 7px 5px;
  border: 1px solid var(--qdd-border);
  border-radius: 6px;
  background: transparent;
  color: var(--qdd-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.chat-reasoning-options > button[aria-pressed="true"] {
  border-color: var(--qdd-primary);
  color: var(--qdd-primary);
  background: var(--qdd-primary-soft);
}
.chat-model-placeholder,
.chat-model-retry {
  padding: 0 6px;
  color: var(--qdd-muted);
  font: inherit;
  font-size: 12px;
}
.chat-model-retry {
  border: 0;
  background: transparent;
  cursor: pointer;
}
.chat-send {
  flex: 0 0 44px;
  width: 44px;
  height: 44px;
  padding: 0;
  border-radius: 10px;
}
.chat-stop {
  display: grid;
  place-items: center;
  border: 1px solid var(--qdd-primary);
  background: var(--qdd-primary);
  color: var(--qdd-surface);
  cursor: pointer;
}
.chat-stop:hover {
  opacity: 0.88;
}
.chat-stop:focus-visible {
  outline: 2px solid var(--qdd-primary);
  outline-offset: 3px;
}
.chat-stop:disabled {
  opacity: 0.55;
  cursor: wait;
}
.chat-stop-symbol {
  width: 14px;
  height: 14px;
  border-radius: 2px;
  background: currentColor;
}
.chat-composer-note {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 3px;
  margin: 0 0 10px;
  color: var(--qdd-muted);
  font-size: 12px;
}
.chat-composer-note :deep(.el-button) {
  font-size: 12px;
}
.chat-composer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 17px;
  margin-top: 9px;
}
.chat-conversation-actions {
  display: flex;
  align-items: center;
  gap: 14px;
}
.chat-conversation-actions :deep(.el-button) {
  margin: 0;
  color: var(--qdd-muted);
  font-size: 11px;
}
.chat-conversation-actions :deep(.el-button > span) {
  gap: 5px;
}
.chat-keyboard-hint {
  margin: 0 0 0 auto;
  text-align: right;
  color: var(--qdd-muted);
  font-size: 11px;
}
@media (prefers-reduced-motion: reduce) {
  .chat-messages-scroll {
    scroll-behavior: auto;
  }
  .chat-loading-dots i {
    animation: none;
    opacity: 0.65;
  }
  .chat-process-chevron {
    transition: none;
  }
}
@media (max-width: 760px) {
  .chat-welcome-scroll {
    padding: 26px 20px;
  }
  .chat-welcome h1 {
    font-size: 30px;
  }
  .chat-suggestions {
    gap: 10px;
    margin-top: 24px;
  }
  .chat-suggestion :deep(.el-card__body) {
    padding: 15px;
  }
  .chat-suggestion strong {
    font-size: 14px;
  }
  .chat-suggestion span {
    font-size: 12px;
  }
  .chat-messages {
    padding: 24px 20px 14px;
    gap: 20px;
  }
  .chat-composer-area {
    padding: 12px 20px 16px;
  }
  .chat-composer {
    min-height: 74px;
    padding: 14px 15px;
    gap: 10px;
  }
}
@media (max-width: 460px) {
  .chat-welcome h1 {
    font-size: 26px;
  }
  .chat-suggestions {
    grid-template-columns: 1fr;
  }
  .chat-messages,
  .chat-composer-area {
    padding-inline: 14px;
  }
  .chat-message {
    gap: 9px;
  }
  .chat-browser-preview {
    margin-left: 39px;
  }
  .chat-avatar {
    flex-basis: 30px;
    width: 30px;
    height: 30px;
  }
  .chat-message-main {
    max-width: calc(100% - 39px);
  }
  .chat-bubble {
    padding: 12px;
  }
  .chat-composer-footer {
    gap: 8px;
  }
  .chat-conversation-actions {
    gap: 8px;
  }
}
</style>

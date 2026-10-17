<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { ElButton, ElCard, ElInput, type InputInstance } from "element-plus";
import type { SessionEvent } from "@qdd/shared";
import AgentIcon from "@/components/AgentIcon.vue";
import SessionActions from "@/components/SessionActions.vue";
import { useWorkspaceContext } from "@/composables/workspaceContext";

const { workspace, draft, submitMessage, notify, navigation } = useWorkspaceContext();
const {
  activeSession, activeSessionId, revisionPageSlug, preferences, connected,
  loadingSession, sending, cancelling, eventActionBusy, answerQuestions, resolveApproval, cancel,
} = workspace;
const { openPage, openView } = navigation;
const composer = ref<InputInstance>();
const messageList = ref<HTMLElement>();
const gapLabels = { missing_data: "缺少数据", estimate: "估测说明", unsupported: "暂不支持", permission: "需要授权" };
const timeline = computed(() =>
  (activeSession.value?.events ?? [])
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => ["user", "say", "tool", "warn", "error", "published", "gaps"].includes(event.type)),
);
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
function handleEnter(event: Event | KeyboardEvent) {
  if (!("key" in event)) return;
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && preferences.value.enterToSend) {
    event.preventDefault();
    void submitMessage();
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
async function copyMessage(content: string) {
  try {
    await navigator.clipboard.writeText(content);
    notify("已复制回复");
  } catch {
    notify("复制失败，请选择文字后手动复制");
  }
}
watch([activeSessionId, () => activeSession.value?.id], () => {
  void scrollToLatest();
  focusComposer();
});
watch(() => activeSession.value?.events.length, async () => {
  const element = messageList.value;
  const nearBottom = !element || element.scrollHeight - element.scrollTop - element.clientHeight < 100;
  if (nearBottom) await scrollToLatest();
});
onMounted(() => {
  void scrollToLatest();
  focusComposer();
});
</script>

<template>
  <section class="chat-view" aria-label="门店助手对话">
    <div v-if="loadingSession" class="chat-loading" role="status">正在加载对话…</div>
    <div v-else-if="!activeSession" class="chat-welcome-scroll">
      <div class="chat-welcome">
        <p class="chat-eyebrow">门店经营，从一个问题开始</p>
        <h1>把经营问题说清楚，<br /><span>让数据帮你做决定。</span></h1>
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
          :key="entry.index"
          class="chat-message"
          :class="entry.event.type === 'user' ? 'chat-message-user' : 'chat-message-assistant'">
          <span class="chat-avatar" :class="{ 'chat-avatar-assistant': entry.event.type !== 'user' }">
            <span v-if="entry.event.type === 'user'">Q</span>
            <AgentIcon v-else name="spark" :size="18" />
          </span>
          <div class="chat-message-main">
            <template v-if="entry.event.type === 'tool'">
              <div class="chat-message-meta"><strong>执行进度</strong><time :datetime="entry.event.at">{{ new Date(entry.event.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) }}</time></div>
              <div class="chat-tool"><span>工具</span><div>{{ entry.event.text }}</div></div>
            </template>
            <div v-else class="chat-bubble" :class="{ 'chat-bubble-warning': entry.event.type === 'warn' || entry.event.type === 'gaps', 'chat-bubble-error': entry.event.type === 'error' }">
              <div v-if="entry.event.type !== 'user'" class="chat-message-meta">
                <strong>门店助手</strong>
                <time :datetime="entry.event.at">{{ new Date(entry.event.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) }}</time>
              </div>
              <div v-if="entry.event.type === 'gaps'" class="chat-gaps">
                <div v-for="(gap, index) in entry.event.gaps" :key="index">
                  <strong>{{ gapLabels[gap.kind] }} · {{ gap.item }}</strong>
                  <p>{{ gap.reason }}</p>
                  <p v-if="gap.suggestion">{{ gap.suggestion }}</p>
                </div>
              </div>
              <p v-else class="chat-message-text">{{ eventText(entry.event) }}</p>
              <div v-if="entry.event.type === 'say' || entry.event.type === 'published'" class="chat-message-actions">
                <ElButton v-if="entry.event.type === 'say'" link @click="copyMessage(entry.event.text)"><AgentIcon name="copy" :size="14" />复制</ElButton>
                <ElButton v-if="entry.event.type === 'published'" link type="primary" @click="openPage(entry.event.page.slug)">查看页面<AgentIcon name="chevron" :size="13" /></ElButton>
              </div>
            </div>
          </div>
        </article>
        <SessionActions
          :key="activeSessionId ?? 'draft'"
          :session-id="activeSession.id"
          :events="activeSession.events"
          :status="activeSession.status"
          :busy="eventActionBusy"
          @answer="answerQuestions"
          @approve="resolveApproval" />
      </div>
    </div>

    <div class="chat-composer-area">
      <p v-if="!connected" class="chat-composer-note">先在 <ElButton link type="primary" @click="openView('settings')">设置</ElButton> 中填写网关地址和 token。</p>
      <p v-else-if="revisionPageSlug" class="chat-composer-note">正在修改页面：<ElButton link type="primary" @click="openPage(revisionPageSlug)">{{ revisionPageSlug }}</ElButton></p>
      <form class="chat-composer" @submit.prevent="submitMessage">
        <ElInput
          id="message-input"
          ref="composer"
          v-model="draft"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 5 }"
          :maxlength="8000"
          resize="none"
          aria-label="向门店助手发送消息"
          :placeholder="activeSession?.status === 'waiting' ? '请先完成上方的问题或授权确认' : '描述你的经营需求，或继续聊聊…'"
          @keydown="handleEnter" />
        <ElButton
          class="chat-send"
          type="primary"
          native-type="submit"
          aria-label="发送消息"
          title="发送消息"
          :disabled="!connected || !draft.trim() || sending || loadingSession">
          <AgentIcon name="arrow" :size="20" />
        </ElButton>
      </form>
      <div class="chat-composer-footer">
        <div class="chat-conversation-actions">
          <ElButton v-if="activeSession?.status === 'running'" link :loading="cancelling" @click="cancel"><AgentIcon v-if="!cancelling" name="stop" :size="13" />停止执行</ElButton>
          <ElButton v-if="activeSession?.slug" link type="primary" @click="openPage(activeSession.slug)">查看生成页面</ElButton>
        </div>
        <p class="chat-keyboard-hint">{{ preferences.enterToSend ? "Enter 发送 · Shift + Enter 换行" : "点击发送 · Enter 换行" }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.chat-view { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.chat-loading { display: grid; flex: 1; place-items: center; color: var(--qdd-muted); font-size: 14px; }
.chat-welcome-scroll { display: flex; flex: 1; flex-direction: column; min-height: 0; overflow-y: auto; padding: 32px; }
.chat-welcome { width: min(100%, 760px); margin: auto; text-align: center; }
.chat-eyebrow { margin: 0 0 16px; color: var(--qdd-muted); font-size: 14px; }
.chat-welcome h1 { margin: 0; font-size: clamp(28px, 3.1vw, 42px); font-weight: 650; line-height: 1.45; letter-spacing: -.8px; }
.chat-welcome h1 span { color: var(--qdd-primary); }
.chat-suggestions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 30px; text-align: left; }
.chat-suggestion { cursor: pointer; border-radius: 10px; transition: border-color .15s, background .15s; }
.chat-suggestion:hover { border-color: var(--qdd-primary); background: var(--qdd-primary-soft); }
.chat-suggestion :deep(.el-card__body) { padding: 18px 22px; }
.chat-suggestion strong { display: block; margin-bottom: 4px; color: var(--qdd-text); font-size: 16px; font-weight: 600; }
.chat-suggestion span { display: block; color: var(--qdd-muted); font-size: 13px; line-height: 1.6; }
.chat-messages-scroll { flex: 1; min-height: 0; overflow-y: auto; scroll-behavior: smooth; }
.chat-messages { display: flex; flex-direction: column; gap: 22px; width: min(100%, 960px); margin: 0 auto; padding: 30px 34px 20px; }
.chat-message { display: flex; align-items: flex-start; gap: 13px; min-width: 0; }
.chat-message-user { flex-direction: row-reverse; }
.chat-avatar { display: grid; flex: 0 0 36px; place-items: center; width: 36px; height: 36px; border: 1px solid var(--qdd-border); border-radius: 50%; color: var(--qdd-muted); background: var(--qdd-surface); font-size: 13px; }
.chat-avatar-assistant { color: var(--qdd-primary); background: var(--qdd-primary-soft); border-color: var(--qdd-primary-soft); }
.chat-message-main { min-width: 0; max-width: calc(100% - 49px); }
.chat-message-assistant .chat-message-main { flex: 1; }
.chat-message-user .chat-message-main { max-width: min(82%, 700px); }
.chat-bubble { padding: 14px 18px; border: 1px solid var(--qdd-border); border-radius: 12px; background: var(--qdd-surface); }
.chat-message-user .chat-bubble { padding: 12px 18px; }
.chat-message-meta { display: flex; align-items: center; gap: 10px; margin-bottom: 9px; color: var(--qdd-muted); font-size: 11px; }
.chat-message-meta strong { color: var(--qdd-text); font-size: 13px; font-weight: 600; }
.chat-message-meta time { margin-left: auto; }
.chat-message-text { margin: 0; font-size: 14px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; }
.chat-message-actions { display: flex; margin-top: 10px; }
.chat-message-actions :deep(.el-button) { color: var(--qdd-muted); font-size: 12px; }
.chat-message-actions :deep(.el-button--primary) { color: var(--qdd-primary); }
.chat-message-actions :deep(.el-button > span) { gap: 5px; }
.chat-tool { display: flex; align-items: flex-start; gap: 10px; padding: 10px 13px; border: 1px solid var(--qdd-border); border-radius: 8px; background: var(--qdd-surface); color: var(--qdd-text); font-size: 13px; line-height: 1.7; }
.chat-tool > span { flex: 0 0 auto; margin-top: 1px; padding: 0 6px; border-radius: 4px; background: var(--qdd-bg); color: var(--qdd-muted); font-size: 11px; }
.chat-tool > div { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.chat-bubble-warning { background: color-mix(in srgb, var(--qdd-warn) 5%, var(--qdd-surface)); border-color: color-mix(in srgb, var(--qdd-warn) 30%, var(--qdd-border)); }
.chat-bubble-error { color: var(--qdd-bad); border-color: color-mix(in srgb, var(--qdd-bad) 30%, var(--qdd-border)); }
.chat-gaps { display: grid; gap: 12px; font-size: 13px; line-height: 1.8; }
.chat-gaps strong { color: var(--qdd-warn); font-weight: 500; }
.chat-gaps p { margin: 3px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.chat-composer-area { flex: 0 0 auto; width: min(100%, 960px); margin: 0 auto; padding: 16px 34px 20px; }
.chat-composer { display: flex; align-items: flex-end; gap: 16px; min-height: 82px; padding: 17px 18px 17px 22px; border: 1px solid var(--qdd-border); border-radius: 14px; background: var(--qdd-surface); }
.chat-composer:focus-within { border-color: var(--qdd-primary); }
.chat-composer :deep(.el-textarea) { flex: 1; align-self: center; min-width: 0; }
.chat-composer :deep(.el-textarea__inner) { padding: 0; box-shadow: none; border: 0; border-radius: 0; background: transparent; color: var(--qdd-text); font: 14px/1.8 var(--qdd-font); outline: none; }
.chat-composer :deep(.el-textarea__inner:focus-visible) { outline: none; }
.chat-send.el-button { flex: 0 0 44px; width: 44px; height: 44px; padding: 0; border-radius: 10px; }
.chat-composer-note { display: flex; align-items: center; flex-wrap: wrap; gap: 3px; margin: 0 0 10px; color: var(--qdd-muted); font-size: 12px; }
.chat-composer-note :deep(.el-button) { font-size: 12px; }
.chat-composer-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 17px; margin-top: 9px; }
.chat-conversation-actions { display: flex; align-items: center; gap: 14px; }
.chat-conversation-actions :deep(.el-button) { margin: 0; color: var(--qdd-muted); font-size: 11px; }
.chat-conversation-actions :deep(.el-button > span) { gap: 5px; }
.chat-keyboard-hint { margin: 0 0 0 auto; text-align: right; color: var(--qdd-muted); font-size: 11px; }
@media (max-width: 760px) {
  .chat-welcome-scroll { padding: 26px 20px; }
  .chat-welcome h1 { font-size: 30px; }
  .chat-suggestions { gap: 10px; margin-top: 24px; }
  .chat-suggestion :deep(.el-card__body) { padding: 15px; }
  .chat-suggestion strong { font-size: 14px; }
  .chat-suggestion span { font-size: 12px; }
  .chat-messages { padding: 24px 20px 14px; gap: 20px; }
  .chat-composer-area { padding: 12px 20px 16px; }
  .chat-composer { min-height: 74px; padding: 14px 15px; gap: 10px; }
}
@media (max-width: 460px) {
  .chat-welcome h1 { font-size: 26px; }
  .chat-suggestions { grid-template-columns: 1fr; }
  .chat-messages, .chat-composer-area { padding-inline: 14px; }
  .chat-message { gap: 9px; }
  .chat-avatar { flex-basis: 30px; width: 30px; height: 30px; }
  .chat-message-main { max-width: calc(100% - 39px); }
  .chat-bubble { padding: 12px; }
  .chat-composer-footer { gap: 8px; }
  .chat-conversation-actions { gap: 8px; }
}
</style>

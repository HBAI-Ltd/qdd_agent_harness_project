<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, ref, watch } from "vue";
import { ElButton } from "element-plus/es/components/button/index";
import { ElCard } from "element-plus/es/components/card/index";
import { ElInput } from "element-plus/es/components/input/index";
import type { InputInstance } from "element-plus";
import type { SessionEvent } from "@qdd/shared";
import AgentIcon from "@/components/AgentIcon.vue";
import MarkdownContent from "@/components/MarkdownContent.vue";
import SessionActions from "@/components/SessionActions.vue";
import { useWorkspaceContext } from "@/composables/workspaceContext";
import { buildChatTimeline, toolStatus, toolTitle } from "@/utils/chatTimeline";

const SessionBrowser = defineAsyncComponent(() => import("@/components/SessionBrowser.vue"));

const { workspace, draft, submitMessage, notify, navigation } = useWorkspaceContext();
const {
  activeSession, activeSessionId, revisionPageSlug, preferences, connected,
  loadingSession, sending, pendingMessage, responding, canCancel, cancelling,
  eventActionBusy, answerQuestions, resolveApproval, cancel,
} = workspace;
const { openPage, openView } = navigation;
const composer = ref<InputInstance>();
const messageList = ref<HTMLElement>();
const browserOpen = ref(false);
const latestBrowser = computed(() => activeSession.value?.events.findLast((event) => event.type === "browser")?.browser);
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
const timeline = computed(() => buildChatTimeline(activeSession.value?.events ?? [], pendingMessage.value));
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
    void sendMessage();
  }
}
async function sendMessage() {
  if (sending.value || loadingSession.value || !connected.value || !draft.value.trim()) return;
  await submitMessage();
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
  void scrollToLatest();
  focusComposer();
});
watch([
  activeSessionId,
  () => activeSession.value?.id,
  () => latestBrowser.value?.browserSessionId,
  () => latestBrowser.value?.status,
], () => {
  browserOpen.value = activeSession.value?.id === activeSessionId.value && latestBrowser.value?.status === "running";
}, { immediate: true });
watch([() => activeSession.value?.events.length, pendingMessage, activityLabel], async () => {
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
    <div v-if="loadingSession && !showConversation" class="chat-loading" role="status">正在加载对话…</div>
    <div v-else-if="!showConversation" class="chat-welcome-scroll">
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
            </div>
            <template v-else>
              <div class="chat-message-meta">
                <strong>门店助手</strong>
                <time :datetime="entry.at">{{ new Date(entry.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) }}</time>
              </div>
              <div v-if="entry.activities.length" class="chat-activities" aria-label="思考与执行过程">
                <details v-for="activity in entry.activities" :key="activity.key" class="chat-process" :data-kind="activity.event.type" :data-status="activity.event.type === 'tool' ? activity.event.status : undefined">
                  <summary class="chat-process-summary">
                    <AgentIcon class="chat-process-chevron" name="chevron" :size="13" />
                    <AgentIcon :name="activity.event.type === 'thinking' ? 'thinking' : activity.event.type === 'browser' ? 'code' : activity.event.type === 'skill' ? 'plan' : 'tool'" :size="15" />
                    <template v-if="activity.event.type === 'tool'">
                      <span class="chat-process-name" :title="toolTitle(activity.event)">{{ toolTitle(activity.event) }}</span>
                      <span class="chat-process-status">{{ toolStatus(activity.event) }}</span>
                    </template>
                    <template v-else-if="activity.event.type === 'thinking'">
                      <span class="chat-process-name">思考</span>
                    </template>
                    <template v-else-if="activity.event.type === 'skill'">
                      <span class="chat-process-name">{{ activity.event.skill.name }}</span>
                      <span class="chat-process-status">{{ activity.event.action === 'loaded' ? '已加载' : '已保存' }}</span>
                    </template>
                    <template v-else-if="activity.event.type === 'browser'">
                      <span class="chat-process-name">浏览器</span>
                      <span class="chat-process-status">{{ activity.event.browser.status === 'closed' ? '已关闭' : '已打开' }}</span>
                    </template>
                  </summary>
                  <div class="chat-process-details">
                    <MarkdownContent v-if="activity.event.type === 'thinking'" :content="activity.event.text" />
                    <template v-else-if="activity.event.type === 'tool'">
                      <template v-if="activity.event.input">
                        <p class="chat-process-label">参数</p>
                        <pre class="chat-process-data" tabindex="0" aria-label="工具参数">{{ formatToolInput(activity.event.input) }}</pre>
                      </template>
                      <template v-if="activity.progress.length">
                        <p class="chat-process-label">执行详情</p>
                        <p v-for="(text, index) in activity.progress" :key="index" class="chat-process-text">{{ text }}</p>
                      </template>
                      <template v-if="activity.event.output !== undefined">
                        <p class="chat-process-label">{{ activity.event.status === 'failed' ? '错误详情' : '结果' }}</p>
                        <pre class="chat-process-data" tabindex="0" aria-label="工具结果">{{ activity.event.output }}</pre>
                      </template>
                      <p v-if="!activity.event.input && !activity.progress.length && activity.event.output === undefined" class="chat-process-text">{{ activity.event.text }}</p>
                    </template>
                    <template v-else-if="activity.event.type === 'skill'">
                      <p class="chat-process-text">{{ activity.event.action === 'loaded' ? '已加载，按技能步骤继续执行。' : '已保存，可在技能页面复用。' }}</p>
                      <ElButton link type="primary" @click="openView('skills')">查看技能<AgentIcon name="chevron" :size="13" /></ElButton>
                    </template>
                    <template v-else-if="activity.event.type === 'browser'">
                      <p class="chat-process-text">{{ activity.event.browser.title || activity.event.browser.url }}</p>
                      <p v-if="activity.event.browser.title" class="chat-process-text">{{ activity.event.browser.url }}</p>
                      <ElButton v-if="activity.event.browser.status === 'running' && latestBrowser?.status === 'running' && activity.event.browser.browserSessionId === latestBrowser.browserSessionId" link type="primary" @click="browserOpen = !browserOpen">{{ browserOpen ? '收起画面' : '查看实时画面' }}</ElButton>
                    </template>
                  </div>
                </details>
              </div>
              <div v-for="message in entry.messages" :key="message.key" class="chat-answer" :class="{ 'chat-bubble-warning': message.event.type === 'warn' || message.event.type === 'gaps', 'chat-bubble-error': message.event.type === 'error' }">
                <div v-if="message.event.type === 'gaps'" class="chat-gaps">
                  <div v-for="(gap, index) in message.event.gaps" :key="index">
                    <strong>{{ gapLabels[gap.kind] }} · {{ gap.item }}</strong>
                    <p>{{ gap.reason }}</p>
                    <p v-if="gap.suggestion">{{ gap.suggestion }}</p>
                  </div>
                </div>
                <MarkdownContent v-else class="chat-message-text chat-message-markdown" :content="eventText(message.event)" />
                <div v-if="message.event.type === 'say' || message.event.type === 'published'" class="chat-message-actions">
                  <ElButton v-if="message.event.type === 'say'" link @click="copyMessage(message.event.text)"><AgentIcon name="copy" :size="14" />复制</ElButton>
                  <ElButton v-if="message.event.type === 'published'" link type="primary" @click="openPage(message.event.page.slug)">查看页面<AgentIcon name="chevron" :size="13" /></ElButton>
                </div>
              </div>
            </template>
          </div>
        </article>
        <article v-if="activityLabel" class="chat-message chat-message-assistant chat-activity" role="status" aria-live="polite" aria-atomic="true">
          <span class="chat-avatar chat-avatar-assistant"><AgentIcon :name="waitingForConfirmation ? 'clock' : 'spark'" :size="18" /></span>
          <div class="chat-activity-content">
            <span v-if="responding || cancelling" class="chat-loading-dots" aria-hidden="true"><i></i><i></i><i></i></span>
            <span>{{ activityLabel }}</span>
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
      </div>
    </div>

    <SessionBrowser v-if="browserOpen && latestBrowser && activeSession" :key="`${activeSession.id}:${latestBrowser.browserSessionId}`" :browser="latestBrowser" :session-id="activeSession.id" @close="browserOpen = false" />

    <div class="chat-composer-area">
      <p v-if="!connected" class="chat-composer-note">先在 <ElButton link type="primary" @click="openView('settings')">设置</ElButton> 中填写网关地址和 token。</p>
      <p v-else-if="revisionPageSlug" class="chat-composer-note">正在修改页面：<ElButton link type="primary" @click="openPage(revisionPageSlug)">{{ revisionPageSlug }}</ElButton></p>
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
          :placeholder="waitingForConfirmation ? '请先完成问题或授权确认，也可以停止后继续发送' : responding ? '助手正在处理，你可以先编写下一条消息…' : '描述你的经营需求，或继续聊聊…'"
          @keydown="handleEnter" />
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
        <ElButton
          v-else
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
          <ElButton v-if="activeSession?.slug" link type="primary" @click="openPage(activeSession.slug)">查看生成页面</ElButton>
          <ElButton v-if="latestBrowser?.status === 'running'" link @click="browserOpen = !browserOpen">{{ browserOpen ? "收起浏览器" : "查看浏览器" }}</ElButton>
        </div>
        <p class="chat-keyboard-hint">{{ composerHint }}</p>
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
.chat-message-markdown { white-space: normal; }
.chat-answer { min-width: 0; }
.chat-answer + .chat-answer { margin-top: 16px; }
.chat-message-actions { display: flex; margin-top: 10px; }
.chat-message-actions :deep(.el-button) { color: var(--qdd-muted); font-size: 12px; }
.chat-message-actions :deep(.el-button--primary) { color: var(--qdd-primary); }
.chat-message-actions :deep(.el-button > span) { gap: 5px; }
.chat-activity { color: var(--qdd-muted); font-size: 13px; }
.chat-activity-content { display: flex; align-items: center; gap: 10px; min-height: 36px; line-height: 1.7; }
.chat-loading-dots { display: flex; flex: 0 0 auto; align-items: center; gap: 4px; }
.chat-loading-dots i { width: 5px; height: 5px; border-radius: 50%; background: var(--qdd-primary); animation: chat-loading-pulse 1.2s ease-in-out infinite; }
.chat-loading-dots i:nth-child(2) { animation-delay: .16s; }
.chat-loading-dots i:nth-child(3) { animation-delay: .32s; }
@keyframes chat-loading-pulse { 0%, 80%, 100% { opacity: .35; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-3px); } }
.chat-activities { display: grid; gap: 2px; min-width: 0; margin: 0 0 14px; }
.chat-process { min-width: 0; color: var(--qdd-muted); font-size: 13px; }
.chat-process-summary { display: flex; align-items: center; gap: 7px; min-height: 30px; width: fit-content; max-width: 100%; padding: 3px 6px 3px 0; border-radius: 5px; cursor: pointer; list-style: none; line-height: 1.6; }
.chat-process-summary::-webkit-details-marker { display: none; }
.chat-process-summary:hover { color: var(--qdd-text); background: var(--qdd-hover); }
.chat-process-summary:focus-visible { outline: 2px solid var(--qdd-primary); outline-offset: 2px; }
.chat-process-summary > svg { flex: 0 0 auto; }
.chat-process-chevron { transition: transform .15s; }
.chat-process[open] > .chat-process-summary .chat-process-chevron { transform: rotate(90deg); }
.chat-process-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-process-status { flex: 0 0 auto; font-size: 12px; }
.chat-process[data-status="failed"] .chat-process-status { color: var(--qdd-bad); }
.chat-process[data-status="running"] .chat-process-status { color: var(--qdd-primary); }
.chat-process-details { display: grid; gap: 8px; min-width: 0; margin: 5px 0 10px 6px; padding: 6px 0 6px 18px; border-left: 2px solid var(--qdd-border); color: var(--qdd-text); }
.chat-process-label { margin: 0; color: var(--qdd-muted); font-size: 12px; }
.chat-process-data { max-width: 100%; max-height: 280px; margin: 0; padding: 12px; overflow: auto; overscroll-behavior: contain; border: 1px solid var(--qdd-border); border-radius: 8px; background: var(--qdd-surface); font: 12px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre; }
.chat-process-text { margin: 0; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.chat-process-details :deep(.el-button) { justify-self: start; margin: 0; font-size: 12px; }
.chat-bubble-warning { padding: 12px 14px; border-left: 2px solid var(--qdd-warn); border-radius: 6px; background: color-mix(in srgb, var(--qdd-warn) 5%, var(--qdd-surface)); }
.chat-bubble-error { padding: 12px 14px; border-left: 2px solid var(--qdd-bad); border-radius: 6px; color: var(--qdd-bad); background: color-mix(in srgb, var(--qdd-bad) 5%, var(--qdd-surface)); }
.chat-gaps { display: grid; gap: 12px; font-size: 13px; line-height: 1.8; }
.chat-gaps strong { color: var(--qdd-warn); font-weight: 500; }
.chat-gaps p { margin: 3px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.chat-composer-area { flex: 0 0 auto; width: min(100%, 960px); margin: 0 auto; padding: 16px 34px 20px; }
.chat-composer { display: flex; align-items: flex-end; gap: 16px; min-height: 82px; padding: 17px 18px 17px 22px; border: 1px solid var(--qdd-border); border-radius: 14px; background: var(--qdd-surface); }
.chat-composer:focus-within { border-color: var(--qdd-primary); }
.chat-composer :deep(.el-textarea) { flex: 1; align-self: center; min-width: 0; }
.chat-composer :deep(.el-textarea__inner) { padding: 0; box-shadow: none; border: 0; border-radius: 0; background: transparent; color: var(--qdd-text); font: 14px/1.8 var(--qdd-font); outline: none; }
.chat-composer :deep(.el-textarea__inner:focus-visible) { outline: none; }
.chat-send { flex: 0 0 44px; width: 44px; height: 44px; padding: 0; border-radius: 10px; }
.chat-stop { display: grid; place-items: center; border: 1px solid var(--qdd-primary); background: var(--qdd-primary); color: var(--qdd-surface); cursor: pointer; }
.chat-stop:hover { opacity: .88; }
.chat-stop:focus-visible { outline: 2px solid var(--qdd-primary); outline-offset: 3px; }
.chat-stop:disabled { opacity: .55; cursor: wait; }
.chat-stop-symbol { width: 14px; height: 14px; border-radius: 2px; background: currentColor; }
.chat-composer-note { display: flex; align-items: center; flex-wrap: wrap; gap: 3px; margin: 0 0 10px; color: var(--qdd-muted); font-size: 12px; }
.chat-composer-note :deep(.el-button) { font-size: 12px; }
.chat-composer-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 17px; margin-top: 9px; }
.chat-conversation-actions { display: flex; align-items: center; gap: 14px; }
.chat-conversation-actions :deep(.el-button) { margin: 0; color: var(--qdd-muted); font-size: 11px; }
.chat-conversation-actions :deep(.el-button > span) { gap: 5px; }
.chat-keyboard-hint { margin: 0 0 0 auto; text-align: right; color: var(--qdd-muted); font-size: 11px; }
@media (prefers-reduced-motion: reduce) {
  .chat-messages-scroll { scroll-behavior: auto; }
  .chat-loading-dots i { animation: none; opacity: .65; }
  .chat-process-chevron { transition: none; }
}
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

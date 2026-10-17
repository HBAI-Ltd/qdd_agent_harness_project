<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { SessionEvent, SessionStatus } from "@qdd/shared";
import AgentIcon from "@/components/AgentIcon.vue";
import TaskPreview from "@/components/TaskPreview.vue";
import SessionActions from "@/components/SessionActions.vue";
import StoreOverview from "@/components/StoreOverview.vue";
import "../../assets/theme.css";
import * as gatewayApi from "@/api/workspace";
import { TASK_PAGE_MESSAGE_EVENT, type TaskPageEvent } from "@/utils/taskPageBridge";
import { useWorkspace } from "./useWorkspace";

const {
  sessions, activeSessionId, activeSession, pages, activePageSlug, activePage, revisionPageSlug,
  preferences, token, gatewayUrl, loadingSessions, loadingPages, loadingSession, error,
  connected, sending, cancelling, eventActionBusy, loadWorkspace, selectSession,
  startConversation, sendMessage, answerQuestions, resolveApproval, cancel, revisePage,
} = useWorkspace();

type View = "overview" | "chat" | "tasks" | "settings";
const view = ref<View>("overview");
const taskPageContext = computed(() => ({ theme: preferences.value.theme, locale: "zh-CN" }));
const sidebarOpen = ref(false);
const mediaQuery = window.matchMedia("(max-width: 760px)");
const isMobile = ref(mediaQuery.matches);
const query = ref("");
const pageQuery = ref("");
const drafts = ref<Record<string, string>>({});
const draft = computed({
  get: () => drafts.value[activeSessionId.value ?? `new:${revisionPageSlug.value ?? ""}`] ?? "",
  set: (value: string) => { drafts.value[activeSessionId.value ?? `new:${revisionPageSlug.value ?? ""}`] = value; },
});
const composer = ref<HTMLTextAreaElement>();
const searchInput = ref<HTMLInputElement>();
const messageList = ref<HTMLElement>();
const styleText = ref("");
const styleLoading = ref(false);
const styleSaving = ref(false);
const styleNotice = ref("");
let styleController: AbortController | undefined;
let styleSaveController: AbortController | undefined;
const toast = ref("");
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const statusLabels: Record<SessionStatus, string> = {
  running: "正在执行", waiting: "等待你的确认", idle: "已就绪", error: "执行失败",
};
const gapLabels = { missing_data: "缺少数据", estimate: "估测说明", unsupported: "暂不支持", permission: "需要授权" };
const filteredSessions = computed(() => sessions.value.filter((session) => session.title.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
const sidebarPages = computed(() => pages.value.filter((page) => page.title.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
const filteredPages = computed(() => pages.value.filter((page) => `${page.title} ${page.summary}`.toLocaleLowerCase().includes(pageQuery.value.trim().toLocaleLowerCase())));
const timeline = computed(() => (activeSession.value?.events ?? []).map((event, index) => ({ event, index }))
  .filter(({ event }) => ["user", "say", "tool", "warn", "error", "published", "gaps"].includes(event.type)));
const heading = computed(() => view.value === "overview" ? "工作空间概览" : view.value === "settings" ? "设置"
  : view.value === "tasks" ? activePage.value?.title || "任务页面" : activeSession.value?.title || "新对话");
const suggestions = [
  { icon: "shop", title: "经营看板", description: "查看销售与毛利，发现经营机会", prompt: "展示最近 30 天各品类销售额和毛利" },
  { icon: "plan", title: "库存分析", description: "梳理库存变化，掌握门店状态", prompt: "帮我查看当前库存，并分析最近一周的变化" },
  { icon: "pen", title: "趋势洞察", description: "从真实数据中找到变化与原因", prompt: "分析最近一个月的销售趋势，标出需要关注的变化" },
  { icon: "code", title: "生成页面", description: "说出你的想法，生成专属工具", prompt: "帮我做一个门店经营数据页面，先和我确认需要哪些指标" },
];

function focusComposer() { void nextTick(() => composer.value?.focus()); }
function showToast(message: string) {
  toast.value = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value = ""; }, 2200);
}
function newConversation() {
  startConversation();
  view.value = "chat";
  sidebarOpen.value = false;
  focusComposer();
}
async function openSession(id: string) {
  view.value = "chat";
  sidebarOpen.value = false;
  await selectSession(id);
}
function openPage(slug: string) {
  activePageSlug.value = slug;
  view.value = "tasks";
  sidebarOpen.value = false;
}
function openView(nextView: View) {
  if (nextView === "tasks") activePageSlug.value = null;
  view.value = nextView;
  sidebarOpen.value = false;
  if (nextView === "settings" && connected.value) void loadStyle();
}
function editPage(slug: string) {
  revisePage(slug);
  view.value = "chat";
  focusComposer();
}

// All template events enter the shell here after iframe/origin/nonce validation.
function handleTaskMessage(message: TaskPageEvent) {
  window.dispatchEvent(new CustomEvent<TaskPageEvent>(TASK_PAGE_MESSAGE_EVENT, { detail: message }));
  if (message.type === "conversation:prefill" && message.payload && typeof message.payload === "object"
    && !Array.isArray(message.payload) && typeof message.payload.text === "string"
    && message.payload.text.trim() && message.payload.text.length <= 8000) {
    editPage(message.slug);
    draft.value = message.payload.text;
    focusComposer();
    showToast("已带入对话，请确认后发送");
  }
  message.reply("host:received", { type: message.type });
}
async function submit() {
  const key = activeSessionId.value ?? `new:${revisionPageSlug.value ?? ""}`;
  const text = draft.value;
  if (await sendMessage(text)) {
    if (drafts.value[key] === text) delete drafts.value[key];
    focusComposer();
  }
}
function handleEnter(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && preferences.value.enterToSend) {
    event.preventDefault();
    void submit();
  }
}
function useSuggestion(prompt: string) { draft.value = prompt; focusComposer(); }
function eventText(event: SessionEvent): string {
  if ("text" in event) return event.text;
  if (event.type === "error") return event.message;
  if (event.type === "published") return `页面已发布：${event.page.title}`;
  return "";
}
async function copyMessage(content: string) {
  try { await navigator.clipboard.writeText(content); toast.value = "已复制回复"; }
  catch { toast.value = "复制失败，请选择文字后手动复制"; }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value = ""; }, 2200);
}
function styleError(cause: unknown) {
  return cause instanceof TypeError ? "无法连接网关，请检查地址与跨域配置。" : cause instanceof Error ? cause.message : "风格设置请求失败。";
}
async function loadStyle() {
  styleController?.abort();
  const controller = new AbortController();
  styleController = controller;
  styleLoading.value = true;
  styleNotice.value = "";
  try {
    const text = await gatewayApi.getStyle(gatewayUrl.value, token.value, controller.signal);
    if (!controller.signal.aborted) styleText.value = text;
  } catch (cause) {
    if (!controller.signal.aborted) styleNotice.value = styleError(cause);
  } finally {
    if (styleController === controller) styleLoading.value = false;
  }
}
async function saveStyle(reset = false) {
  if (styleSaving.value || !connected.value) return;
  styleSaving.value = true;
  styleNotice.value = "";
  const controller = new AbortController();
  styleSaveController = controller;
  try {
    const text = reset
      ? await gatewayApi.resetStyle(gatewayUrl.value, token.value, controller.signal)
      : await gatewayApi.saveStyle(gatewayUrl.value, token.value, styleText.value, controller.signal);
    if (controller.signal.aborted) return;
    styleText.value = text;
    styleNotice.value = reset ? "已恢复默认页面风格" : "页面风格已保存";
  } catch (cause) { if (!controller.signal.aborted) styleNotice.value = styleError(cause); }
  finally { if (styleSaveController === controller) styleSaving.value = false; }
}
function updateViewport(event: MediaQueryListEvent) { isMobile.value = event.matches; }
function shortcut(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    sidebarOpen.value = true;
    void nextTick(() => searchInput.value?.focus());
  }
  if (event.key === "Escape") sidebarOpen.value = false;
}
watch(connected, (value) => {
  if (value && view.value === "settings") void loadStyle();
  if (!value) { styleController?.abort(); styleText.value = ""; }
});
watch(() => preferences.value.theme, (theme) => {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
}, { immediate: true });
watch([gatewayUrl, token], () => {
  styleController?.abort();
  styleSaveController?.abort();
  styleLoading.value = false;
  styleSaving.value = false;
  styleNotice.value = "";
});
watch(() => activeSession.value?.events.length, async () => {
  const element = messageList.value;
  const nearBottom = !element || element.scrollHeight - element.scrollTop - element.clientHeight < 100;
  await nextTick();
  if (nearBottom && messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight;
});
watch(draft, async () => {
  await nextTick();
  if (composer.value) {
    composer.value.style.height = "auto";
    composer.value.style.height = `${Math.min(composer.value.scrollHeight, 180)}px`;
  }
});
onMounted(() => { document.addEventListener("keydown", shortcut); mediaQuery.addEventListener("change", updateViewport); });
onBeforeUnmount(() => {
  document.removeEventListener("keydown", shortcut);
  mediaQuery.removeEventListener("change", updateViewport);
  styleController?.abort();
  styleSaveController?.abort();
  clearTimeout(toastTimer);
});
</script>

<template>
  <div class="harness-app" :data-theme="preferences.theme">
    <button v-if="sidebarOpen" class="sidebar-scrim" aria-label="关闭侧边栏" @click="sidebarOpen = false" />
    <aside id="workspace-sidebar" class="sidebar" :class="{ 'is-open': sidebarOpen }" aria-label="工作空间导航" :inert="isMobile && !sidebarOpen ? true : undefined">
      <div class="brand-row">
        <a class="brand" href="/" aria-label="钱多多首页" @click.prevent="openView('overview')"><span class="brand-mark"><AgentIcon name="shop" :size="23" /></span><span>钱多多<span class="brand-caption">门店经营工作台</span></span></a>
        <button class="icon-button mobile-close" aria-label="收起侧边栏" @click="sidebarOpen = false"><AgentIcon name="close" :size="18" /></button>
      </div>
      <button class="new-task-button" @click="newConversation"><AgentIcon name="plus" :size="18" /><span>新建对话</span><span class="new-task-hint">开启新想法</span></button>
      <nav class="primary-nav" aria-label="主导航">
        <button :class="{ selected: view === 'overview' }" :aria-current="view === 'overview' ? 'page' : undefined" @click="openView('overview')"><AgentIcon name="shop" :size="19" />概览</button>
        <button :class="{ selected: view === 'chat' }" :aria-current="view === 'chat' ? 'page' : undefined" @click="openView('chat')"><AgentIcon name="chat" :size="19" />对话<span class="nav-count">{{ sessions.length }}</span></button>
        <button :class="{ selected: view === 'tasks' }" :aria-current="view === 'tasks' ? 'page' : undefined" @click="openView('tasks')"><AgentIcon name="plan" :size="19" />任务<span class="nav-count">{{ pages.length }}</span></button>
        <button :class="{ selected: view === 'settings' }" :aria-current="view === 'settings' ? 'page' : undefined" @click="openView('settings')"><AgentIcon name="sliders" :size="19" />设置</button>
      </nav>
      <div class="task-section-heading"><span>对话记录</span><button class="icon-button" aria-label="刷新工作空间" title="刷新工作空间" :disabled="!token.trim() || loadingSessions || loadingPages" @click="loadWorkspace"><AgentIcon name="refresh" :size="14" /></button></div>
      <label class="task-search"><AgentIcon name="search" :size="16" /><input ref="searchInput" v-model="query" placeholder="搜索对话或页面" aria-label="搜索对话或页面" /><kbd>Ctrl K</kbd></label>
      <div class="task-list">
        <p v-if="loadingSessions" class="backend-status" role="status">正在加载对话…</p>
        <div v-for="session in filteredSessions" :key="session.id" class="task-row" :class="{ active: view === 'chat' && activeSessionId === session.id }">
          <button class="task-select" :title="session.title" :aria-current="view === 'chat' && activeSessionId === session.id ? 'true' : undefined" @click="openSession(session.id)"><span v-if="session.status === 'running'" class="task-pulse" /><AgentIcon v-else name="chat" :size="15" /><span>{{ session.title }}</span><span v-if="session.status === 'waiting'" class="waiting-label">待确认</span></button>
        </div>
        <p v-if="!filteredSessions.length && !loadingSessions" class="backend-status">{{ connected ? '暂无对话记录' : '连接网关后加载对话' }}</p>
        <div class="task-section-heading backend-task-heading"><span>任务页面 <span class="backend-task-count">{{ pages.length }}</span></span></div>
        <p v-if="loadingPages" class="backend-status" role="status">正在加载页面…</p>
        <div v-for="page in sidebarPages" :key="page.slug" class="task-row" :class="{ active: view === 'tasks' && activePageSlug === page.slug }"><button class="task-select" :title="page.title" :aria-current="view === 'tasks' && activePageSlug === page.slug ? 'true' : undefined" @click="openPage(page.slug)"><AgentIcon name="code" :size="15" /><span>{{ page.title }}</span></button></div>
        <p v-if="!sidebarPages.length && !loadingPages" class="backend-status">{{ connected ? '已发布页面将在这里显示' : '连接网关后加载页面' }}</p>
      </div>
      <div class="sidebar-bottom"><div class="workspace-note"><span class="note-symbol"><AgentIcon name="spark" :size="17" /></span><div><strong>一个想法，一张专属页面</strong><span>基于真实数据，与你一起完成</span></div></div><div class="profile"><span class="avatar">Q</span><div><strong>我的工作空间</strong><span>钱多多门店助手</span></div><span class="local-dot" /></div></div>
    </aside>

    <main class="main-panel" :inert="isMobile && sidebarOpen ? true : undefined">
      <header class="topbar"><div class="breadcrumb"><button class="icon-button sidebar-toggle" aria-label="展开侧边栏" aria-controls="workspace-sidebar" :aria-expanded="sidebarOpen" @click="sidebarOpen = !sidebarOpen"><AgentIcon name="panel" :size="19" /></button><span class="workspace-crumb">门店工作台</span><AgentIcon class="crumb-chevron" name="chevron" :size="13" /><strong>{{ heading }}</strong></div><button class="demo-badge connection-badge" :class="{ connected }" @click="openView('settings')"><span />{{ connected ? '网关已连接' : '连接网关' }}</button></header>
      <p v-if="error" class="workspace-storage-warning" role="alert">{{ error }}</p>

      <div v-if="view === 'overview'" class="overview-scroll"><StoreOverview :sessions="sessions" :pages="pages" :connected="connected" :loading="loadingSessions || loadingPages" @start-conversation="newConversation" @open-settings="openView('settings')" @open-page="openPage" @revise-page="editPage" /></div>

      <template v-else-if="view === 'chat'">
        <div v-if="activeSession" class="conversation-toolbar"><span>{{ statusLabels[activeSession.status] }}</span><div><button v-if="activeSession.slug" class="text-action" @click="openPage(activeSession.slug)">查看生成页面</button><button v-if="activeSession.status === 'running'" class="secondary-button" :disabled="cancelling" @click="cancel">{{ cancelling ? '正在取消…' : '停止执行' }}</button></div></div>
        <div v-if="loadingSession" class="task-content-status" role="status">正在加载对话…</div>
        <div v-else-if="!activeSession" class="welcome-scroll"><section class="welcome"><div class="eyebrow"><span />门店经营，从一个问题开始</div><div class="welcome-emblem"><AgentIcon name="spark" :size="34" /></div><h1>把经营问题说清楚，<br /><span>让数据帮你做决定。</span></h1><p class="welcome-description">{{ revisionPageSlug ? `继续改进页面：${revisionPageSlug}` : '说说你的门店经营需求。' }}<br />一起确认目标，生成你的专属页面。</p><div class="suggestions-label"><span>不妨从这里开始</span><span class="label-line" /></div><div class="suggestion-grid"><button v-for="suggestion in suggestions" :key="suggestion.title" class="suggestion-card" @click="useSuggestion(suggestion.prompt)"><span class="suggestion-icon"><AgentIcon :name="suggestion.icon" :size="21" /></span><span class="suggestion-text"><strong>{{ suggestion.title }}</strong><span>{{ suggestion.description }}</span></span><AgentIcon class="suggestion-chevron" name="chevron" :size="15" /></button></div><div class="welcome-footnote"><AgentIcon name="clock" :size="14" />会话与已发布页面由网关保存</div></section></div>
        <div v-else ref="messageList" class="messages-scroll" role="log" aria-label="会话消息"><div class="messages-inner"><div class="conversation-start"><span />{{ activeSession.title }}<span /></div>
          <article v-for="entry in timeline" :key="entry.index" class="message" :class="entry.event.type === 'user' ? 'user' : 'assistant'">
            <div class="message-avatar" :class="entry.event.type === 'user' ? 'user' : 'assistant'"><span v-if="entry.event.type === 'user'">Q</span><AgentIcon v-else :name="entry.event.type === 'tool' ? 'code' : 'spark'" :size="18" /></div>
            <div class="message-body"><div class="message-meta"><strong>{{ entry.event.type === 'user' ? '你' : entry.event.type === 'tool' ? '执行进度' : '门店助手' }}</strong><time :datetime="entry.event.at">{{ new Date(entry.event.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</time></div>
              <div v-if="entry.event.type === 'gaps'" class="capability-gaps"><div v-for="(gap, index) in entry.event.gaps" :key="index"><strong>{{ gapLabels[gap.kind] }} · {{ gap.item }}</strong><p>{{ gap.reason }}</p><p v-if="gap.suggestion">{{ gap.suggestion }}</p></div></div>
              <div v-else class="message-content" :class="{ 'progress-text': entry.event.type === 'tool' || entry.event.type === 'warn' }">{{ eventText(entry.event) }}</div>
              <button v-if="entry.event.type === 'say'" class="copy-button" @click="copyMessage(entry.event.text)"><AgentIcon name="copy" :size="14" />复制</button>
              <button v-if="entry.event.type === 'published'" class="text-action" @click="openPage(entry.event.page.slug)">查看页面</button>
            </div>
          </article>
          <SessionActions :events="activeSession.events" :status="activeSession.status" :busy="eventActionBusy" @answer="answerQuestions" @approve="resolveApproval" />
        </div></div>
        <div class="composer-area" :class="{ 'welcome-composer': !activeSession }"><p v-if="!connected" class="generation-note">先在<button @click="openView('settings')">设置</button>中填写网关地址和 token。</p><form class="composer" @submit.prevent="submit"><label class="sr-only" for="message-input">向门店助手发送消息</label><textarea id="message-input" ref="composer" v-model="draft" rows="2" maxlength="8000" :placeholder="activeSession?.status === 'waiting' ? '请先完成上方的问题或授权确认' : '描述你的经营需求，或继续聊聊…'" @keydown="handleEnter" /><div class="composer-toolbar"><div class="composer-options"><AgentIcon name="spark" :size="16" /><span>门店助手</span></div><div class="send-controls"><span class="keyboard-hint">{{ preferences.enterToSend ? 'Enter 发送' : '点击发送' }}</span><button class="send-button" type="submit" aria-label="发送消息" title="发送消息" :disabled="!connected || !draft.trim() || sending || loadingSession"><AgentIcon name="arrow" :size="20" /></button></div></div></form><p class="composer-caption">基于门店真实数据<span>·</span>需求确认后生成页面</p></div>
      </template>

      <template v-else-if="view === 'tasks' && activePageSlug"><div class="conversation-toolbar"><button class="text-action" @click="openView('tasks')">返回任务列表</button><button v-if="activePage" class="secondary-button" @click="editPage(activePage.slug)">通过对话修改</button></div><TaskPreview v-if="activePage" :page="activePage" :gateway-url="gatewayUrl" :context="taskPageContext" @message="handleTaskMessage" /><div v-else class="task-content-status"><p>{{ loadingPages ? '正在加载页面…' : '该页面尚未发布或已不可用' }}</p><button class="secondary-button" @click="loadWorkspace">刷新页面列表</button></div></template>
      <div v-else-if="view === 'tasks'" class="settings-scroll"><section class="settings-content task-board"><span class="section-eyebrow">已发布页面</span><h1>任务页面</h1><p class="settings-intro">经营看板与分析工具，集中管理、随时使用。</p><div class="task-board-controls"><label class="board-search"><AgentIcon name="search" :size="16" /><input v-model="pageQuery" placeholder="搜索页面" aria-label="搜索页面" /></label><button class="secondary-button" :disabled="!connected || loadingPages" @click="loadWorkspace">刷新页面</button></div><div v-if="!filteredPages.length" class="task-board-empty"><AgentIcon name="code" :size="32" /><h2>{{ loadingPages ? '正在加载页面…' : pages.length ? '没有找到相关页面' : '暂无已发布页面' }}</h2><p>从一段对话开始，告诉门店助手你想查看什么。</p><button class="confirm-button" @click="newConversation">开始对话</button></div><div v-else class="task-cards"><article v-for="page in filteredPages" :key="page.slug" class="work-task-card"><div class="work-task-heading"><span class="work-task-status">已发布 · v{{ page.version }}</span><span v-if="page.stale" class="review-label">待复核</span></div><h2><button class="task-title-button" @click="openPage(page.slug)">{{ page.title }}<AgentIcon name="chevron" :size="17" /></button></h2><p class="work-task-description">{{ page.summary || page.wish }}</p><div class="work-task-footer"><time :datetime="page.updatedAt">{{ new Date(page.updatedAt).toLocaleDateString('zh-CN') }} 更新</time><button class="text-action" @click="openPage(page.slug)">打开页面</button></div></article></div></section></div>

      <div v-else class="settings-scroll"><section class="settings-content"><span class="section-eyebrow">连接与偏好</span><h1>工作空间设置</h1><p class="settings-intro">连接你的门店助手，调整工作习惯。</p>
        <form class="settings-card gateway-settings" @submit.prevent="loadWorkspace">
          <h2><AgentIcon name="sliders" :size="19" />网关连接</h2>
          <label for="gateway-url">网关地址</label>
          <el-input id="gateway-url" v-model="gatewayUrl" type="url" :placeholder="gatewayApi.DEFAULT_GATEWAY_URL" required />
          <div class="gateway-address-help"><span>配置地址：{{ gatewayApi.DEFAULT_GATEWAY_URL }}</span><el-button link type="primary" :disabled="loadingSessions || loadingPages" @click="gatewayUrl = gatewayApi.DEFAULT_GATEWAY_URL">使用配置地址</el-button></div>
          <label for="gateway-token">网关 token</label>
          <el-input id="gateway-token" v-model="token" type="password" autocomplete="off" placeholder="填写网关访问 token" required />
          <p class="settings-info">网关 token 可通过终端命令 <code>npm run qdd -- token</code> 获取，仅保留在当前浏览器会话中。网关需允许当前前端来源访问。</p>
          <el-button type="primary" native-type="submit" :loading="loadingSessions || loadingPages" :disabled="!token.trim() || loadingSessions || loadingPages">{{ loadingSessions || loadingPages ? '正在连接…' : '连接网关' }}</el-button>
          <span v-if="connected" class="connection-result">已连接</span>
        </form>
        <div class="settings-card">
          <h2><AgentIcon name="sun" :size="19" />外观与输入</h2>
          <div class="setting-row"><div><strong>界面主题</strong><p>选择工作空间的浅色或深色外观</p></div><div class="theme-options"><button :class="{ chosen: preferences.theme === 'light' }" :aria-pressed="preferences.theme === 'light'" @click="preferences.theme = 'light'"><AgentIcon name="sun" :size="17" />浅色</button><button :class="{ chosen: preferences.theme === 'dark' }" :aria-pressed="preferences.theme === 'dark'" @click="preferences.theme = 'dark'"><AgentIcon name="moon" :size="17" />深色</button></div></div>
          <div class="setting-row"><div><strong>Enter 发送消息</strong><p>开启后按 Enter 发送，Shift + Enter 换行</p></div><el-switch v-model="preferences.enterToSend" aria-label="Enter 发送消息" /></div>
        </div>
        <div class="settings-card gateway-settings">
          <h2><AgentIcon name="pen" :size="19" />页面统一风格</h2>
          <p class="style-help">后续生成的页面统一遵守这份风格提示词。</p>
          <label class="sr-only" for="page-style">页面风格提示词</label>
          <el-input id="page-style" v-model="styleText" type="textarea" :rows="6" :disabled="!connected || styleLoading || styleSaving" :placeholder="connected ? '正在读取页面风格…' : '连接网关后可编辑页面风格'" />
          <div class="style-actions"><el-button type="primary" :loading="styleSaving" :disabled="!connected || styleLoading || styleSaving" @click="saveStyle()">保存风格</el-button><el-button :disabled="!connected || styleLoading || styleSaving" @click="saveStyle(true)">恢复默认</el-button></div>
          <p v-if="styleNotice" class="style-notice" role="status">{{ styleNotice }}</p>
        </div>
      </section></div>
    </main>
    <div v-if="toast" class="toast" role="status"><AgentIcon name="check" :size="16" />{{ toast }}</div>
  </div>
</template>

<style src="./workspace.css"></style>

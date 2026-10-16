<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import AgentIcon from "@/components/AgentIcon.vue";
import TaskPreview from "@/components/TaskPreview.vue";
import { useWorkspace } from "./useWorkspace";
import type { ChatMessage, Conversation, WorkspaceTask } from "./useWorkspace";

const {
  conversations, activeConversationId, activeConversation, sortedConversations,
  pendingConversationId, tasks, sortedTasks, preferences, storageError,
  newConversation, deleteConversation, renameConversation, createTaskFromConversation,
  setTaskStatus, renameTask, deleteTask, sendMessage, stopReply,
  activeTaskId, activeTask, loadingTasks, loadingConversations, loadingTask, loadingConversation,
  listError, conversationListError, detailError, conversationError, actionError,
  creatingConversation, mutatingTask, stoppingReply, loadTasks, loadConversations,
  selectTask: loadTask, selectConversation: loadConversation,
} = useWorkspace();
type View = "chat" | "tasks" | "settings";
type WorkspaceDialog =
  | { kind: "create-task"; conversation: Conversation; sourceMessageId: string }
  | { kind: "rename" | "delete"; entity: "conversation"; item: Conversation }
  | { kind: "rename" | "delete"; entity: "task"; item: WorkspaceTask };
const view = ref<View>("chat");
const sidebarOpen = ref(false);
const mobileQuery = window.matchMedia("(max-width: 760px)");
const isMobile = ref(mobileQuery.matches);
const query = ref("");
const taskQuery = ref("");
const taskFilter = ref<"all" | WorkspaceTask["status"]>("all");
const drafts = ref<Record<string, string>>({});
const draft = computed({
  get: () => drafts.value[activeConversationId.value ?? "welcome"] ?? "",
  set: (value: string) => { drafts.value[activeConversationId.value ?? "welcome"] = value; },
});
const composer = ref<HTMLTextAreaElement>();
const searchInput = ref<HTMLInputElement>();
const messageList = ref<HTMLElement>();
const dialogInput = ref<HTMLInputElement>();
const dialogCloseButton = ref<HTMLButtonElement>();
const dialog = ref<WorkspaceDialog | null>(null);
const newTitle = ref("");
const taskDescription = ref("");
const dialogError = ref("");
const dialogSubmitting = ref(false);
const toast = ref("");
const focusedMessageId = ref<string | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let returnFocus: HTMLElement | null = null;
const hasMessages = computed(() => Boolean(activeConversation.value?.messages.length));
const canCreateTask = computed(() => Boolean(activeConversation.value?.messages.some((message) => message.role === "user")));
const conversationTasks = computed(() => sortedTasks.value.filter((task) => task.conversationId === activeConversationId.value));
const filteredConversations = computed(() => sortedConversations.value.filter((conversation) => conversation.title.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
const conversationGroups = computed(() => {
  const today = new Date().setHours(0, 0, 0, 0);
  return [
    { label: "今天", conversations: filteredConversations.value.filter((conversation) => conversation.updatedAt >= today) },
    { label: "更早", conversations: filteredConversations.value.filter((conversation) => conversation.updatedAt < today) },
  ].filter((group) => group.conversations.length);
});
const filteredTasks = computed(() => {
  const text = taskQuery.value.trim().toLocaleLowerCase();
  return sortedTasks.value.filter((task) => (taskFilter.value === "all" || task.status === taskFilter.value)
    && `${task.title} ${task.description} ${task.sourceConversationTitle}`.toLocaleLowerCase().includes(text));
});
const statusLabels: Record<WorkspaceTask["status"], string> = { todo: "待处理", in_progress: "进行中", done: "已完成" };
const taskFilters = computed(() => [
  { value: "all" as const, label: "全部", count: tasks.value.length },
  ...(["todo", "in_progress", "done"] as const).map((status) => ({ value: status, label: statusLabels[status], count: tasks.value.filter((task) => task.status === status).length })),
]);
const dialogHeading = computed(() => {
  if (!dialog.value) return "";
  if (dialog.value.kind === "create-task") return "从对话创建任务";
  return `${dialog.value.kind === "rename" ? "重命名" : "删除"}${dialog.value.entity === "conversation" ? "对话" : "任务"}`;
});
const assistantLabels = { general: "通用助手", store: "门店助手", code: "代码助手" };
const suggestions = [
  { icon: "shop", color: "green", title: "门店经营", description: "梳理经营思路，找到增长机会", prompt: "帮我制定一份门店本周的经营计划" },
  { icon: "code", color: "blue", title: "编写代码", description: "从一个想法，到可运行的代码", prompt: "帮我拆解一个前端项目的开发任务" },
  { icon: "pen", color: "orange", title: "内容创作", description: "写一份文案，让表达更有力量", prompt: "帮我写一份新品上线的推广文案" },
  { icon: "plan", color: "purple", title: "规划任务", description: "拆解复杂目标，让行动更清晰", prompt: "帮我把一个项目目标拆解成可执行的任务" },
];

function updateViewport(event: MediaQueryListEvent) { isMobile.value = event.matches; }
function focusComposer() { void nextTick(() => composer.value?.focus()); }
function showToast(message: string) {
  toast.value = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value = ""; }, 2800);
}
async function createConversation() {
  view.value = "chat";
  if (!await newConversation()) return;
  query.value = "";
  sidebarOpen.value = false;
  focusedMessageId.value = null;
  focusComposer();
}
async function selectConversation(id: string, messageId: string | null = null) {
  view.value = "chat";
  sidebarOpen.value = false;
  focusedMessageId.value = messageId;
  await loadConversation(id);
  if (messageId) void nextTick(() => document.getElementById(`message-${messageId}`)?.scrollIntoView({ block: "center" }));
}
function openView(nextView: View) {
  if (nextView === "tasks") activeTaskId.value = null;
  view.value = nextView;
  sidebarOpen.value = false;
}
function openTask(id: string) {
  view.value = "tasks";
  sidebarOpen.value = false;
  void loadTask(id);
}
async function submit() {
  const key = activeConversationId.value ?? "welcome";
  const text = draft.value;
  if (await sendMessage(text)) {
    if (drafts.value[key] === text) delete drafts.value[key];
    focusedMessageId.value = null;
    focusComposer();
    void nextTick(() => messageList.value?.scrollTo({ top: messageList.value.scrollHeight }));
  }
}
function handleEnter(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && preferences.value.enterToSend) {
    event.preventDefault();
    submit();
  }
}
function useSuggestion(prompt: string) { draft.value = prompt; focusComposer(); }
function prepareDialog() {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dialogError.value = "";
  void nextTick(() => (dialogInput.value ?? dialogCloseButton.value)?.focus());
}
function openConversationDialog(kind: "rename" | "delete", conversation: Conversation) {
  dialog.value = { kind, entity: "conversation", item: conversation };
  newTitle.value = conversation.title;
  prepareDialog();
}
function openTaskDialog(kind: "rename" | "delete", task: WorkspaceTask) {
  dialog.value = { kind, entity: "task", item: task };
  newTitle.value = task.title;
  prepareDialog();
}
function openCreateTask(message?: ChatMessage) {
  const conversation = activeConversation.value;
  const source = message ?? conversation?.messages.findLast((entry) => entry.role === "user");
  if (!conversation || !source?.content.trim() || !canCreateTask.value) return;
  dialog.value = { kind: "create-task", conversation, sourceMessageId: source.id };
  newTitle.value = source.content.split("\n")[0]?.trim().slice(0, 80) || conversation.title;
  taskDescription.value = source.content.slice(0, 8000);
  prepareDialog();
}
function closeDialog() {
  if (dialogSubmitting.value) return;
  dialog.value = null;
  void nextTick(() => { if (returnFocus?.isConnected) returnFocus.focus(); });
}
async function confirmDialog() {
  const current = dialog.value;
  if (!current || dialogSubmitting.value) return;
  dialogSubmitting.value = true;
  dialogError.value = "";
  try {
  if (current.kind === "create-task") {
    if (!newTitle.value.trim()) return;
    const task = await createTaskFromConversation(current.conversation.id, newTitle.value, taskDescription.value, current.sourceMessageId);
    if (!task) { dialogError.value = actionError.value || "无法创建任务，请检查名称及来源对话。"; return; }
    dialogSubmitting.value = false;
    closeDialog();
    taskFilter.value = "all";
    taskQuery.value = "";
    openTask(task.id);
    showToast("任务已创建，聊天记录保留在来源对话中");
    return;
  }
  let success: boolean;
  if (current.kind === "rename") {
    if (!newTitle.value.trim()) return;
    if (current.entity === "conversation") success = await renameConversation(current.item.id, newTitle.value);
    else success = await renameTask(current.item.id, newTitle.value);
  } else if (current.entity === "conversation") {
    success = await deleteConversation(current.item.id);
    if (success) delete drafts.value[current.item.id];
  } else {
    success = await deleteTask(current.item.id);
  }
  if (!success) { dialogError.value = actionError.value || "操作失败，请重试。"; return; }
  dialogSubmitting.value = false;
  closeDialog();
  } finally { dialogSubmitting.value = false; }
}
async function changeTaskStatus(id: string, event: Event) {
  const select = event.target as HTMLSelectElement;
  const status = select.value;
  const previous = tasks.value.find((task) => task.id === id)?.status ?? "todo";
  if (status === "todo" || status === "in_progress" || status === "done") {
    if (!await setTaskStatus(id, status)) select.value = previous;
  }
}
async function copyMessage(content: string) {
  try { await navigator.clipboard.writeText(content); showToast("已复制回复"); }
  catch { showToast("复制失败，请选择文字后手动复制"); }
}
function shortcut(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    sidebarOpen.value = true;
    void nextTick(() => searchInput.value?.focus());
  }
  if (event.key === "Escape") { if (dialog.value) closeDialog(); sidebarOpen.value = false; }
}
function trapDialogFocus(event: KeyboardEvent) {
  if (event.key !== "Tab") return;
  const elements = (event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("button:not(:disabled), input, textarea");
  const first = elements[0];
  const last = elements[elements.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}
watch(() => activeConversation.value?.messages.map((message) => message.content).join(""), async () => {
  const element = messageList.value;
  const nearBottom = !element || element.scrollHeight - element.scrollTop - element.clientHeight < 100;
  await nextTick();
  if (nearBottom && messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight;
});
watch(activeConversationId, () => {
  void nextTick(() => { if (!focusedMessageId.value) messageList.value?.scrollTo({ top: messageList.value.scrollHeight }); });
});
watch(draft, async () => {
  await nextTick();
  if (composer.value) { composer.value.style.height = "auto"; composer.value.style.height = `${Math.min(composer.value.scrollHeight, 180)}px`; }
});
onMounted(() => { document.addEventListener("keydown", shortcut); mobileQuery.addEventListener("change", updateViewport); });
onBeforeUnmount(() => { document.removeEventListener("keydown", shortcut); mobileQuery.removeEventListener("change", updateViewport); clearTimeout(toastTimer); });
</script>

<template>
  <div class="harness-app" :data-theme="preferences.theme">
    <button v-if="sidebarOpen" class="sidebar-scrim" aria-label="关闭侧边栏" @click="sidebarOpen = false" />
    <aside id="workspace-sidebar" class="sidebar" :class="{ 'is-open': sidebarOpen }" aria-label="工作空间导航" :inert="dialog || (isMobile && !sidebarOpen) ? true : undefined">
      <div class="brand-row">
        <a class="brand" href="/" aria-label="Harness 首页" @click.prevent="openView('chat')"><span class="brand-mark">h<span>·</span></span><span>harness<span class="brand-caption">AGENT WORKSPACE</span></span></a>
        <button class="icon-button mobile-close" aria-label="收起侧边栏" @click="sidebarOpen = false"><AgentIcon name="close" :size="18" /></button>
      </div>
      <button class="new-task-button" :disabled="creatingConversation" @click="createConversation"><AgentIcon name="plus" :size="18" /><span>{{ creatingConversation ? '正在创建…' : '新建对话' }}</span><span class="new-task-hint">开启新想法</span></button>
      <nav class="primary-nav" aria-label="主导航">
        <button :class="{ selected: view === 'chat' }" :aria-current="view === 'chat' ? 'page' : undefined" @click="openView('chat')"><AgentIcon name="chat" :size="19" />对话<span class="nav-count">{{ conversations.length }}</span></button>
        <button :class="{ selected: view === 'tasks' }" :aria-current="view === 'tasks' ? 'page' : undefined" @click="openView('tasks')"><AgentIcon name="plan" :size="19" />任务<span class="nav-count">{{ tasks.length }}</span></button>
        <button :class="{ selected: view === 'settings' }" :aria-current="view === 'settings' ? 'page' : undefined" @click="openView('settings')"><AgentIcon name="sliders" :size="19" />设置</button>
      </nav>
      <div class="task-section-heading"><span>对话记录</span><button class="icon-button" :disabled="loadingConversations || creatingConversation || Boolean(pendingConversationId)" aria-label="刷新对话列表" title="刷新对话列表" @click="loadConversations"><AgentIcon name="refresh" :size="14" /></button></div>
      <label class="task-search"><AgentIcon name="search" :size="16" /><input ref="searchInput" v-model="query" placeholder="搜索对话" aria-label="搜索对话" /><kbd>⌘ / Ctrl K</kbd></label>
      <div class="task-list">
        <div v-if="loadingConversations" class="backend-status" role="status">正在加载对话…</div>
        <div v-else-if="conversationListError" class="backend-status" role="status"><p>{{ conversationListError }}</p><button class="secondary-button" @click="loadConversations">重新加载对话</button></div>
        <div v-for="group in conversationGroups" :key="group.label" class="task-group">
          <p class="group-label">{{ group.label }}</p>
          <div v-for="conversation in group.conversations" :key="conversation.id" class="task-row" :class="{ active: conversation.id === activeConversationId && view === 'chat' }">
            <button class="task-select" :title="conversation.title" :aria-current="conversation.id === activeConversationId && view === 'chat' ? 'true' : undefined" @click="selectConversation(conversation.id)"><span v-if="pendingConversationId === conversation.id" class="task-pulse" aria-label="正在回复" /><AgentIcon v-else name="chat" :size="15" /><span>{{ conversation.title }}</span></button>
            <div class="task-actions"><button class="icon-button" :aria-label="`重命名对话：${conversation.title}`" title="重命名对话" @click="openConversationDialog('rename', conversation)"><AgentIcon name="edit" :size="14" /></button><button class="icon-button" :aria-label="`删除对话：${conversation.title}`" title="删除对话" @click="openConversationDialog('delete', conversation)"><AgentIcon name="trash" :size="14" /></button></div>
          </div>
        </div>
        <div v-if="!filteredConversations.length && !loadingConversations && !conversationListError" class="empty-tasks"><AgentIcon :name="query ? 'search' : 'chat'" :size="24" /><p>{{ query ? '没有找到相关对话' : '从一个问题，开始对话' }}</p><span>{{ query ? '换个关键词试试' : '对话记录由后端提供' }}</span></div>
        <div class="task-section-heading backend-task-heading"><span>任务列表 <span class="backend-task-count">{{ tasks.length }}</span></span><button class="icon-button" :disabled="loadingTasks || mutatingTask" aria-label="刷新任务列表" title="刷新任务列表" @click="loadTasks"><AgentIcon name="refresh" :size="14" /></button></div>
        <div v-if="loadingTasks" class="backend-status" role="status">正在加载后端任务…</div>
        <div v-else-if="listError" class="backend-status" role="status"><p>{{ listError }}</p><button class="secondary-button" @click="loadTasks">重新加载任务</button></div>
        <div v-for="task in sortedTasks" :key="task.id" class="task-row" :class="{ active: view === 'tasks' && activeTaskId === task.id }"><button class="task-select" :title="task.title" :aria-current="view === 'tasks' && activeTaskId === task.id ? 'true' : undefined" @click="openTask(task.id)"><AgentIcon name="code" :size="15" /><span>{{ task.title }}</span></button></div>
        <p v-if="!tasks.length && !loadingTasks && !listError" class="backend-status">后端返回的任务将在这里显示</p>
      </div>
      <div class="sidebar-bottom">
        <div class="workspace-note"><span class="note-symbol"><AgentIcon name="spark" :size="17" /></span><div><strong>聊清想法，再创建任务</strong><span>对话记录与任务进度独立管理</span></div></div>
        <div class="profile"><span class="avatar">Q</span><div><strong>我的工作空间</strong><span>后端任务空间</span></div><span class="local-dot" title="任务与对话由后端提供" /></div>
      </div>
    </aside>

    <main class="main-panel" :inert="dialog || (isMobile && sidebarOpen) ? true : undefined">
      <header class="topbar">
        <div class="breadcrumb"><button class="icon-button sidebar-toggle" aria-label="展开侧边栏" aria-controls="workspace-sidebar" :aria-expanded="sidebarOpen" @click="sidebarOpen = !sidebarOpen"><AgentIcon name="panel" :size="19" /></button><span class="workspace-crumb">工作空间</span><AgentIcon class="crumb-chevron" name="chevron" :size="13" /><strong>{{ view === 'settings' ? '设置' : view === 'tasks' ? activeTask?.title || '任务' : activeConversation?.title || '新对话' }}</strong></div>
        <span class="demo-badge"><span />后端任务</span>
      </header>
      <p v-if="storageError" class="workspace-storage-warning" role="status">{{ storageError }}</p>
      <p v-if="actionError && !dialog" class="workspace-storage-warning" role="status">{{ actionError }}</p>

      <template v-if="view === 'chat'">
        <div v-if="hasMessages" class="conversation-toolbar"><span>将对话里的行动项保存为任务</span><div><button v-if="conversationTasks.length" class="text-action" @click="openView('tasks')">已创建 {{ conversationTasks.length }} 个任务</button><button class="secondary-button" :disabled="!canCreateTask" @click="openCreateTask()"><AgentIcon name="plus" :size="15" />创建任务</button></div></div>
        <div v-if="loadingConversation" class="task-content-status" role="status"><AgentIcon name="clock" :size="28" /><p>正在加载对话…</p></div>
        <div v-else-if="conversationError" class="task-content-status" role="status"><p>{{ conversationError }}</p><button class="secondary-button" @click="activeConversationId && loadConversation(activeConversationId)">重新加载对话</button></div>
        <div v-else-if="!hasMessages" class="welcome-scroll">
          <section class="welcome">
            <div class="eyebrow"><span />YOUR IDEAS, IN MOTION</div><div class="welcome-emblem"><AgentIcon name="spark" :size="34" /></div>
            <h1>把想法交给 Agent，<br /><span>一起完成下一件事。</span></h1>
            <p class="welcome-description">先通过对话梳理想法与目标。<br />明确行动后，从对话创建任务并跟进。</p>
            <div class="suggestions-label"><span>不妨从这里开始</span><span class="label-line" /></div>
            <div class="suggestion-grid"><button v-for="suggestion in suggestions" :key="suggestion.title" class="suggestion-card" @click="useSuggestion(suggestion.prompt)"><span class="suggestion-icon" :class="suggestion.color"><AgentIcon :name="suggestion.icon" :size="21" /></span><span class="suggestion-text"><strong>{{ suggestion.title }}</strong><span>{{ suggestion.description }}</span></span><AgentIcon class="suggestion-chevron" name="chevron" :size="15" /></button></div>
            <div class="welcome-footnote"><AgentIcon name="clock" :size="14" />每段对话独立记录，任务由对话创建</div>
          </section>
        </div>
        <div v-else ref="messageList" class="messages-scroll" role="log" aria-label="聊天消息" :aria-busy="pendingConversationId === activeConversationId">
          <div class="messages-inner"><div class="conversation-start"><span />{{ activeConversation?.title }}<span /></div>
            <article v-for="message in activeConversation?.messages" :id="`message-${message.id}`" :key="message.id" class="message" :class="[message.role, { 'source-highlight': focusedMessageId === message.id }]">
              <div class="message-avatar" :class="message.role"><AgentIcon v-if="message.role === 'assistant'" name="spark" :size="19" /><span v-else>Q</span></div>
              <div class="message-body">
                <div class="message-meta"><strong>{{ message.role === 'user' ? '你' : 'Harness' }}</strong><span v-if="message.role === 'assistant'" class="assistant-tag">{{ assistantLabels[message.assistant ?? "general"] }}</span><time :datetime="new Date(message.createdAt).toISOString()">{{ new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</time></div>
                <div class="message-content">{{ message.content }}<span v-if="!message.content" class="typing-dots" aria-label="正在生成回复">•••</span></div>
                <div v-if="message.content && (message.role === 'user' || pendingConversationId !== activeConversationId)" class="message-actions"><button v-if="message.role === 'assistant'" class="copy-button" @click="copyMessage(message.content)"><AgentIcon name="copy" :size="14" />复制</button><button class="copy-button" aria-label="从这条消息创建任务" @click="openCreateTask(message)"><AgentIcon name="plus" :size="14" />创建任务</button></div>
              </div>
            </article>
          </div>
        </div>
        <div class="composer-area" :class="{ 'welcome-composer': !hasMessages }">
          <p v-if="pendingConversationId === activeConversationId && pendingConversationId" class="generation-note" role="status">{{ stoppingReply ? '正在请求后端停止…' : '正在等待后端回复…' }}</p>
          <p v-if="pendingConversationId && pendingConversationId !== activeConversationId" class="generation-note">另一个对话正在回复，请等待完成或<button @click="stopReply">停止回复</button>。</p>
          <form class="composer" @submit.prevent="submit">
            <label class="sr-only" for="message-input">向 Harness 发送消息</label><textarea id="message-input" ref="composer" v-model="draft" rows="2" maxlength="8000" placeholder="说说你的想法，或问我一个问题…" @keydown="handleEnter" />
            <div class="composer-toolbar"><div class="composer-options"><AgentIcon name="spark" :size="16" /><label><span class="sr-only">选择助手</span><select v-model="preferences.assistant"><option value="general">通用助手</option><option value="store">门店助手</option><option value="code">代码助手</option></select></label><span class="toolbar-divider" /><span class="demo-label">Harness Agent</span></div><div class="send-controls"><span v-if="draft.length > 7500" class="character-count">{{ draft.length }}/8000</span><span class="keyboard-hint">{{ preferences.enterToSend ? 'Enter 发送' : '点击发送' }}</span><button v-if="pendingConversationId === activeConversationId && pendingConversationId" class="send-button stop-button" :disabled="stoppingReply" type="button" aria-label="停止回复" title="停止回复" @click="stopReply"><AgentIcon name="stop" :size="16" /></button><button v-else class="send-button" type="submit" aria-label="发送消息" title="发送消息" :disabled="!draft.trim() || Boolean(pendingConversationId) || creatingConversation || loadingConversation || Boolean(activeConversationId && !activeConversation)"><AgentIcon name="arrow" :size="20" /></button></div></div>
          </form>
          <p class="composer-caption">Harness 与你一起，把想法变成行动<span>·</span>任务内容与对话由后端提供</p>
        </div>
      </template>

      <template v-else-if="view === 'tasks' && activeTaskId">
        <div class="conversation-toolbar"><button class="text-action" @click="openView('tasks')">返回任务列表</button><span>任务内容</span></div>
        <div v-if="loadingTask" class="task-content-status" role="status"><AgentIcon name="clock" :size="28" /><p>正在加载任务内容…</p></div>
        <div v-else-if="detailError" class="task-content-status" role="status"><p>{{ detailError }}</p><button class="secondary-button" @click="activeTaskId && loadTask(activeTaskId)">重新加载任务</button></div>
        <TaskPreview v-else-if="activeTask?.content" :key="activeTask.id" :task-id="activeTask.id" :title="activeTask.title" :content="activeTask.content" />
        <div v-else class="task-content-status"><AgentIcon name="code" :size="28" /><p>后端尚未返回任务页面</p><button class="secondary-button" @click="activeTaskId && loadTask(activeTaskId)">刷新任务内容</button></div>
      </template>
      <div v-else-if="view === 'tasks'" class="settings-scroll">
        <section class="settings-content task-board">
          <span class="section-eyebrow">FROM CONVERSATION TO ACTION</span><h1>任务</h1><p class="settings-intro">查看后端任务，打开页面内容并跟进进度。</p>
          <div class="task-board-controls"><div class="task-filters" aria-label="筛选任务状态"><button v-for="filter in taskFilters" :key="filter.value" :class="{ selected: taskFilter === filter.value }" :aria-pressed="taskFilter === filter.value" @click="taskFilter = filter.value">{{ filter.label }} <span>{{ filter.count }}</span></button></div><label class="board-search"><AgentIcon name="search" :size="16" /><input v-model="taskQuery" placeholder="搜索任务" aria-label="搜索任务" /></label></div>
          <div v-if="loadingTasks" class="task-board-empty" role="status">正在加载任务列表…</div>
          <div v-else-if="listError" class="task-board-empty" role="status"><p>{{ listError }}</p><button class="secondary-button" @click="loadTasks">重新加载任务</button></div>
          <div v-else-if="!filteredTasks.length" class="task-board-empty"><AgentIcon name="plan" :size="32" /><h2>{{ tasks.length ? '没有符合条件的任务' : '后端暂无任务' }}</h2><p>{{ tasks.length ? '尝试其他关键词或状态筛选。' : '任务由后端提供，也可以从对话中创建。' }}</p><button v-if="!tasks.length" class="confirm-button" @click="conversations.length ? openView('chat') : createConversation()">{{ conversations.length ? '返回对话' : '开始对话' }}</button></div>
          <div v-else class="task-cards">
            <article v-for="task in filteredTasks" :key="task.id" class="work-task-card" :class="{ completed: task.status === 'done' }">
              <div class="work-task-heading"><span class="work-task-status" :class="task.status">{{ statusLabels[task.status] }}</span><div><button class="icon-button" :aria-label="`重命名任务：${task.title}`" @click="openTaskDialog('rename', task)"><AgentIcon name="edit" :size="15" /></button><button class="icon-button" :aria-label="`删除任务：${task.title}`" @click="openTaskDialog('delete', task)"><AgentIcon name="trash" :size="15" /></button></div></div>
              <h2><button class="task-title-button" @click="openTask(task.id)">{{ task.title }}<AgentIcon name="chevron" :size="17" /></button></h2><p class="work-task-description">{{ task.description || '暂无补充说明' }}</p>
              <div class="task-source"><AgentIcon name="chat" :size="14" /><span>来源：{{ task.sourceConversationTitle || '后端任务' }}</span><button v-if="task.conversationId" class="text-action" @click="selectConversation(task.conversationId, task.sourceMessageId)">返回来源对话</button><span v-else class="source-removed">无来源对话</span></div>
              <div class="work-task-footer"><time :datetime="new Date(task.createdAt).toISOString()">{{ new Date(task.createdAt).toLocaleDateString('zh-CN') }} 创建</time><label><span>任务状态</span><select :value="task.status" :aria-label="`任务状态：${task.title}`" @change="changeTaskStatus(task.id, $event)"><option value="todo">待处理</option><option value="in_progress">进行中</option><option value="done">已完成</option></select></label></div>
            </article>
          </div>
        </section>
      </div>

      <div v-else class="settings-scroll"><section class="settings-content"><span class="section-eyebrow">MAKE IT YOURS</span><h1>工作空间设置</h1><p class="settings-intro">调整你的习惯，让协作更顺手。</p>
        <div class="settings-card"><h2><AgentIcon name="sun" :size="19" />外观</h2><div class="setting-row"><div><strong>界面主题</strong><p>选择你喜欢的工作空间外观</p></div><div class="theme-options"><button :class="{ chosen: preferences.theme === 'light' }" :aria-pressed="preferences.theme === 'light'" @click="preferences.theme = 'light'"><AgentIcon name="sun" :size="17" />浅色</button><button :class="{ chosen: preferences.theme === 'dark' }" :aria-pressed="preferences.theme === 'dark'" @click="preferences.theme = 'dark'"><AgentIcon name="moon" :size="17" />深色</button></div></div></div>
        <div class="settings-card"><h2><AgentIcon name="chat" :size="19" />对话偏好</h2><div class="setting-row"><div><strong>Enter 发送消息</strong><p>开启后按 Enter 发送，Shift + Enter 换行</p></div><button class="switch" :class="{ enabled: preferences.enterToSend }" role="switch" :aria-checked="preferences.enterToSend" aria-label="Enter 发送消息" @click="preferences.enterToSend = !preferences.enterToSend"><span /></button></div><div class="setting-row"><div><strong>默认助手</strong><p>为新对话选择合适的助手场景</p></div><select v-model="preferences.assistant" class="setting-select" aria-label="默认助手"><option value="general">通用助手</option><option value="store">门店助手</option><option value="code">代码助手</option></select></div></div>
        <div class="settings-card"><h2><AgentIcon name="folder" :size="19" />后端工作空间</h2><div class="setting-row"><div><strong>对话与任务</strong><p>已加载 {{ conversations.length }} 个对话、{{ tasks.length }} 个任务</p></div><span class="local-tag">后端数据</span></div><div class="settings-info">对话、任务列表和任务内容通过后端接口加载。界面偏好保存在当前浏览器；任务页面在独立预览中运行。</div></div>
        <p v-if="!storageError" class="settings-saved"><AgentIcon name="check" :size="16" />设置已自动保存到当前浏览器</p>
      </section></div>
    </main>

    <div v-if="dialog" class="dialog-backdrop" @click.self="closeDialog"><section class="task-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" @keydown="trapDialogFocus">
      <div class="dialog-heading"><h2 id="dialog-title">{{ dialogHeading }}</h2><button ref="dialogCloseButton" class="icon-button" :disabled="dialogSubmitting" aria-label="关闭弹窗" @click="closeDialog"><AgentIcon name="close" :size="18" /></button></div>
      <form @submit.prevent="confirmDialog">
        <template v-if="dialog.kind !== 'delete'"><label for="item-title">{{ dialog.kind === 'create-task' || dialog.entity === 'task' ? '任务名称' : '对话名称' }}</label><input id="item-title" ref="dialogInput" v-model="newTitle" maxlength="80" autocomplete="off" required /></template>
        <template v-if="dialog.kind === 'create-task'"><label class="description-label" for="task-description">任务说明</label><textarea id="task-description" v-model="taskDescription" rows="5" maxlength="8000" /><p class="dialog-source">来源对话：{{ dialog.conversation.title }}</p></template>
        <p v-else-if="dialog.kind === 'delete'">确定删除「{{ dialog.item.title }}」吗？{{ dialog.entity === 'conversation' ? '聊天记录将被移除，已创建的任务会保留。' : '此任务将被移除，来源对话和聊天记录会保留。' }}</p>
        <p v-if="dialogError" class="dialog-error" role="alert">{{ dialogError }}</p>
        <div class="dialog-actions"><button type="button" class="secondary-button" :disabled="dialogSubmitting" @click="closeDialog">取消</button><button class="confirm-button" :disabled="dialogSubmitting || (dialog.kind !== 'delete' && !newTitle.trim())">{{ dialogSubmitting ? '正在提交…' : dialog.kind === 'create-task' ? '创建任务' : dialog.kind === 'rename' ? '保存名称' : dialog.entity === 'conversation' ? '删除对话' : '删除任务' }}</button></div>
      </form>
    </section></div>
    <div v-if="toast" class="toast" role="status"><AgentIcon name="check" :size="16" />{{ toast }}</div>
  </div>
</template>

<style src="./workspace.css"></style>

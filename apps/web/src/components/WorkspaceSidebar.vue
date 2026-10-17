<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { ElButton } from "element-plus/es/components/button/index";
import { ElInput } from "element-plus/es/components/input/index";
import { ElMenu, ElMenuItem } from "element-plus/es/components/menu/index";
import { ElScrollbar } from "element-plus/es/components/scrollbar/index";
import { ElTag } from "element-plus/es/components/tag/index";
import type { InputInstance } from "element-plus";
import type { SessionMeta, SessionStatus } from "@qdd/shared";
import AgentIcon from "@/components/AgentIcon.vue";
import { useWorkspaceContext, type WorkspaceView } from "@/composables/workspaceContext";

const props = defineProps<{
  collapsed: boolean;
  mobileOpen: boolean;
  isMobile: boolean;
  view: WorkspaceView;
}>();
const emit = defineEmits<{
  toggle: [];
  close: [];
  newConversation: [];
  selectConversation: [id: string];
}>();
const { workspace, overview, navigation } = useWorkspaceContext();
const {
  sessions, activeSessionId, pages, activePageSlug, token,
  loadingSessions, loadingPages, connected, loadWorkspace,
} = workspace;
const query = ref("");
const searchInput = ref<InputInstance>();
const compact = computed(() => props.collapsed && !props.isMobile);
const searchTerm = computed(() => query.value.trim().toLocaleLowerCase());
const statusLabels: Record<SessionStatus, string> = {
  running: "正在执行",
  waiting: "等待确认",
  idle: "已就绪",
  error: "执行失败",
};
interface NavigationItem {
  view: WorkspaceView;
  label: string;
  icon: string;
  count?: number;
}
const navItems = computed<NavigationItem[]>(() => [
  { view: "chat", label: "对话", icon: "chat", count: sessions.value.length },
  { view: "tasks", label: "任务", icon: "plan", count: pages.value.length },
  { view: "schedules", label: "定时任务", icon: "clock", ...(overview.data.value ? { count: overview.data.value.schedules.total } : {}) },
  { view: "skills", label: "技能", icon: "spark", ...(overview.data.value ? { count: overview.data.value.skills.total } : {}) },
  { view: "connectors", label: "连接器", icon: "folder", ...(overview.data.value ? { count: overview.data.value.connectors.connected } : {}) },
  { view: "overview", label: "工作台总览", icon: "shop" },
]);
const filteredSessions = computed(() => [...sessions.value]
  .filter((session) => `${session.title} ${session.summary}`.toLocaleLowerCase().includes(searchTerm.value))
  .sort((first, second) => modifiedTime(second) - modifiedTime(first)));
const filteredPages = computed(() => pages.value.filter((page) =>
  `${page.title} ${page.summary} ${page.slug}`.toLocaleLowerCase().includes(searchTerm.value)));

function modifiedTime(session: SessionMeta): number {
  return Date.parse(session.updatedAt) || Date.parse(session.createdAt) || 0;
}

function sessionTitle(session: SessionMeta): string {
  return session.title.trim() || session.summary.trim() || "未命名对话";
}

function sessionTooltip(session: SessionMeta): string {
  const date = new Date(session.updatedAt);
  const updated = Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", {
    year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  return [sessionTitle(session), session.summary.trim(), statusLabels[session.status], updated].filter(Boolean).join("\n");
}

function selectNavigation(value: string) {
  const item = navItems.value.find((entry) => entry.view === value);
  if (item) void navigation.openView(item.view);
}

function focusSearch() {
  searchInput.value?.focus();
}

async function revealSearch() {
  if (compact.value) emit("toggle");
  await nextTick();
  focusSearch();
}

defineExpose({ focusSearch });
</script>

<template>
  <aside
    id="workspace-sidebar"
    class="sidebar"
    :class="{ 'is-open': mobileOpen, 'is-collapsed': compact }"
    aria-label="工作空间导航"
    :inert="isMobile && !mobileOpen ? true : undefined">
    <div class="brand-row">
      <a class="brand" href="/chat" aria-label="钱多多对话首页" title="钱多多对话首页" @click.prevent="navigation.openView('chat')">
        <span class="brand-mark" aria-hidden="true">钱</span>
        <span class="sidebar-label brand-name">
          钱多多
          <span class="brand-caption">门店人工智能助手</span>
        </span>
      </a>
      <ElButton
        v-if="!isMobile"
        class="sidebar-control"
        text
        :aria-label="compact ? '展开侧边栏' : '收起侧边栏'"
        :title="compact ? '展开侧边栏' : '收起侧边栏'"
        aria-controls="workspace-sidebar"
        :aria-expanded="!compact"
        @click="emit('toggle')">
        <AgentIcon name="panel" :size="18" />
      </ElButton>
      <ElButton v-else class="sidebar-control" text aria-label="关闭侧边栏" title="关闭侧边栏" @click="emit('close')">
        <AgentIcon name="close" :size="18" />
      </ElButton>
    </div>

    <ElButton class="new-conversation" plain aria-label="新建对话" title="新建对话" @click="emit('newConversation')">
      <AgentIcon name="plus" :size="19" />
      <span class="sidebar-label">新建对话</span>
    </ElButton>

    <div v-if="compact" class="sidebar-rail-tools">
      <ElButton class="sidebar-control" text aria-label="搜索对话和页面" title="搜索对话和页面 (Ctrl K)" @click="revealSearch">
        <AgentIcon name="search" :size="18" />
      </ElButton>
    </div>
    <ElInput
      v-else
      ref="searchInput"
      v-model="query"
      class="sidebar-search"
      clearable
      placeholder="搜索对话和页面"
      aria-label="搜索对话和页面">
      <template #prefix><AgentIcon name="search" :size="15" /></template>
      <template #suffix><kbd v-if="!query">Ctrl K</kbd></template>
    </ElInput>

    <nav class="sidebar-navigation" aria-label="主导航">
      <ElMenu class="workspace-menu" :default-active="view" :collapse="compact" :collapse-transition="false" @select="selectNavigation">
        <ElMenuItem
          v-for="item in navItems"
          :key="item.view"
          :index="item.view"
          :aria-label="item.label"
          :title="item.label"
          :aria-current="view === item.view ? 'page' : undefined">
          <AgentIcon class="menu-icon" :name="item.icon" :size="19" />
          <template #title>
            <span class="menu-label">{{ item.label }}</span>
            <ElTag v-if="item.count !== undefined && !compact" class="menu-count" type="info" effect="plain" size="small" round>
              {{ item.count }}
            </ElTag>
          </template>
        </ElMenuItem>
      </ElMenu>
    </nav>

    <div v-show="!compact" class="sidebar-lists">
      <section class="sidebar-section conversation-section" aria-labelledby="conversation-history-heading" :aria-busy="loadingSessions">
        <div class="sidebar-section-heading">
          <h2 id="conversation-history-heading">对话记录</h2>
          <ElButton
            class="sidebar-control refresh-control"
            text
            aria-label="刷新工作空间"
            title="刷新工作空间"
            :disabled="!token.trim() || loadingSessions || loadingPages"
            @click="loadWorkspace">
            <AgentIcon name="refresh" :size="14" />
          </ElButton>
        </div>
        <ElScrollbar class="conversation-list" tabindex="0" aria-label="对话记录列表">
          <p v-if="loadingSessions" class="sidebar-status" role="status">正在加载对话…</p>
          <ElButton
            v-for="session in filteredSessions"
            :key="session.id"
            class="conversation-select"
            :class="{ active: view === 'chat' && activeSessionId === session.id }"
            text
            native-type="button"
            :aria-label="`${sessionTitle(session)}，${statusLabels[session.status]}`"
            :title="sessionTooltip(session)"
            :aria-current="view === 'chat' && activeSessionId === session.id ? 'true' : undefined"
            @click="emit('selectConversation', session.id)">
            <span v-if="session.status === 'running'" class="session-status-dot" aria-hidden="true" />
            <span class="conversation-title">{{ sessionTitle(session) }}</span>
            <ElTag v-if="session.status === 'waiting'" class="session-tag" type="warning" effect="light" size="small" round>待确认</ElTag>
            <ElTag v-else-if="session.status === 'error'" class="session-tag" type="danger" effect="light" size="small" round>失败</ElTag>
          </ElButton>
          <p v-if="!filteredSessions.length && !loadingSessions" class="sidebar-status">
            {{ searchTerm ? "没有找到相关对话" : connected ? "暂无对话，点击上方新建对话" : "连接网关后加载对话记录" }}
          </p>
        </ElScrollbar>
      </section>

      <section class="sidebar-section pages-section" aria-labelledby="task-pages-heading" :aria-busy="loadingPages">
        <div class="sidebar-section-heading">
          <h2 id="task-pages-heading">任务页面</h2>
        </div>
        <ElScrollbar class="page-list" tabindex="0" aria-label="任务页面列表">
          <p v-if="loadingPages" class="sidebar-status" role="status">正在加载页面…</p>
          <ElButton
            v-for="page in filteredPages"
            :key="page.slug"
            class="task-select"
            :class="{ active: view === 'tasks' && activePageSlug === page.slug }"
            text
            native-type="button"
            :aria-label="`打开${page.pinnedAt ? '已置顶' : ''}${page.kind === 'scheduled' ? '定时任务' : '一次性任务'}页面：${page.title}`"
            :title="`${page.title}${page.pinnedAt ? ' · 已置顶' : ''} · ${page.kind === 'scheduled' ? '定时任务' : '一次性任务'}`"
            :aria-current="view === 'tasks' && activePageSlug === page.slug ? 'true' : undefined"
            @click="navigation.openPage(page.slug)">
            <AgentIcon :name="page.kind === 'scheduled' ? 'clock' : 'code'" :size="15" />
            <span class="task-title">{{ page.title }}</span>
            <ElTag v-if="page.pinnedAt" class="session-tag" type="warning" effect="plain" size="small">置顶</ElTag>
          </ElButton>
          <p v-if="!filteredPages.length && !loadingPages" class="sidebar-status">
            {{ searchTerm ? "没有找到相关页面" : connected ? "已发布页面将在这里显示" : "连接网关后加载页面" }}
          </p>
        </ElScrollbar>
      </section>
    </div>

    <div class="sidebar-bottom">
      <ElButton
        class="profile"
        :class="{ selected: view === 'settings' }"
        text
        native-type="button"
        aria-label="工作空间设置"
        title="工作空间设置"
        :aria-current="view === 'settings' ? 'page' : undefined"
        @click="navigation.openView('settings')">
        <span class="avatar" aria-hidden="true">Q</span>
        <span class="sidebar-label profile-description">
          <strong>我的工作空间</strong>
          <span><i class="connection-dot" :class="{ connected }" aria-hidden="true" />{{ connected ? "网关已连接" : "网关未连接" }}</span>
        </span>
        <AgentIcon class="sidebar-label profile-settings-icon" name="sliders" :size="18" />
      </ElButton>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 292px;
  flex: 0 0 292px;
  min-height: 0;
  overflow: hidden;
  padding: 22px 16px 0;
  background: var(--qdd-surface);
  transition: width .2s ease, flex-basis .2s ease, transform .2s ease;
}
.brand-row { flex-shrink: 0; gap: 8px; padding: 0 6px; margin-bottom: 18px; }
.brand { gap: 12px; letter-spacing: 0; }
.brand-mark { width: 40px; height: 40px; border-radius: 10px; font-size: 23px; font-weight: 650; }
.brand-name { font-size: 21px; font-weight: 650; }
.brand-caption { margin-top: 5px; font-size: 12px; font-weight: 400; letter-spacing: 0; }
.sidebar-control { width: 30px; height: 30px; padding: 0; flex-shrink: 0; margin: 0; color: var(--qdd-muted); background: transparent; }
.sidebar-control:hover { color: var(--qdd-text); background: var(--qdd-hover); }
.new-conversation {
  width: calc(100% - 8px);
  height: 40px;
  min-height: 40px;
  flex-shrink: 0;
  justify-content: flex-start;
  margin: 0 4px 10px;
  padding: 0 15px;
  border: 1px solid var(--qdd-border) !important;
  border-radius: 10px;
  background: var(--qdd-surface);
  color: var(--qdd-text);
  font-size: 14px !important;
  font-weight: 500;
}
.new-conversation :deep(> span) { display: flex; align-items: center; gap: 10px; }
.new-conversation:hover, .new-conversation:focus-visible { color: var(--qdd-primary); border-color: var(--qdd-primary) !important; background: var(--qdd-primary-soft); }
.sidebar-search { width: calc(100% - 8px); margin: 0 4px 10px; flex-shrink: 0; }
.sidebar-search :deep(.el-input__wrapper) { padding: 0 10px; min-height: 34px; border-radius: 8px; background: var(--qdd-bg); }
.sidebar-search :deep(.el-input__inner) { font-size: 12px; height: 34px; }
.sidebar-search kbd { color: var(--qdd-muted); font: 10px/1.5 var(--qdd-font); white-space: nowrap; }
.sidebar-navigation { flex-shrink: 0; }
.workspace-menu { width: 100%; padding: 0; border-right: 0; background: transparent; --el-menu-bg-color: transparent; --el-menu-item-height: 38px; }
.workspace-menu :deep(.el-menu-item) { display: flex; height: var(--el-menu-item-height); gap: 10px; padding: 0 14px !important; margin-bottom: 2px; border-radius: 8px; color: var(--qdd-muted); font-size: 14px; line-height: var(--el-menu-item-height); }
.workspace-menu :deep(.el-menu-item:hover) { background: var(--qdd-hover); }
.workspace-menu :deep(.el-menu-item.is-active) { color: var(--qdd-primary); background: var(--qdd-primary-soft); font-weight: 600; }
.menu-label { flex: 1; }
.menu-count { height: 20px; min-width: 24px; padding: 0 6px; border-color: transparent; background: transparent; color: inherit; font-size: 12px; font-weight: 400; }
.sidebar-lists { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; padding-top: 6px; }
.sidebar-section { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.conversation-section { flex: 1.25; }
.pages-section { flex: 1; }
.sidebar-section-heading { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; min-height: 36px; padding: 6px 12px 3px; color: var(--qdd-muted); }
.sidebar-section-heading h2 { margin: 0; font-size: 12px; font-weight: 400; }
.refresh-control { width: 23px; height: 23px; }
.conversation-list, .page-list { flex: 1; min-height: 0; }
.conversation-list :deep(.el-scrollbar__wrap), .page-list :deep(.el-scrollbar__wrap) { overscroll-behavior: contain; }
.conversation-list :deep(.el-scrollbar__view), .page-list :deep(.el-scrollbar__view) { padding: 0 4px 3px; }
.conversation-select, .task-select {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: auto;
  min-height: 38px;
  padding: 8px 12px;
  margin: 0 0 3px;
  border-radius: 8px;
  text-align: left;
  background: transparent;
  color: var(--qdd-text);
  font-size: 13px !important;
  font-weight: 400;
  line-height: 22px;
}
.conversation-select :deep(> span), .task-select :deep(> span) { display: flex; width: 100%; min-width: 0; gap: 8px; }
.conversation-select.el-button:hover, .task-select.el-button:hover { background: var(--qdd-hover); }
.conversation-select.el-button.active, .task-select.el-button.active { background: var(--qdd-bg); }
.conversation-title, .task-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-status-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--qdd-primary); }
.session-tag { height: 20px; padding: 0 7px; font-size: 11px; border-color: transparent; flex-shrink: 0; }
.sidebar-status { padding: 8px 12px; margin: 0; color: var(--qdd-muted); font-size: 12px; line-height: 1.7; }
.sidebar-bottom { flex-shrink: 0; margin-top: auto; padding-top: 6px; }
.profile { width: 100%; height: auto; min-height: 64px; margin: 0; border-radius: 0; background: transparent; color: var(--qdd-text); text-align: left; gap: 10px; padding: 12px 7px 14px; font-weight: 400; line-height: 1.6; }
.profile :deep(> span) { display: flex; width: 100%; min-width: 0; gap: 10px; }
.profile.el-button:hover, .profile.el-button.selected { background: var(--qdd-hover); }
.profile-description { flex: 1; min-width: 0; }
.profile strong { font-size: 12px; font-weight: 500; }
.profile-description > span { display: flex; align-items: center; gap: 5px; font-size: 11px; }
.connection-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--qdd-muted); }
.connection-dot.connected { background: var(--qdd-good); }
.profile-settings-icon { color: var(--qdd-muted); }
.sidebar-rail-tools { display: grid; justify-items: center; margin-bottom: 10px; }
.is-collapsed { width: 76px; flex-basis: 76px; padding: 20px 10px 0; }
.is-collapsed .sidebar-label { display: none; }
.is-collapsed .brand-row { flex-direction: column; gap: 10px; padding: 0; margin-bottom: 16px; }
.is-collapsed .brand { gap: 0; }
.is-collapsed .new-conversation { width: 100%; justify-content: center; margin: 0 0 10px; padding: 0; }
.is-collapsed .workspace-menu { width: 100%; }
.is-collapsed .workspace-menu :deep(.el-menu-item) { justify-content: center; padding: 0 !important; }
.is-collapsed .workspace-menu :deep(.el-menu-tooltip__trigger) { justify-content: center; padding: 0 !important; }
.is-collapsed .profile { justify-content: center; padding-left: 0; padding-right: 0; }
.is-collapsed .profile :deep(> span) { justify-content: center; }
@media (min-height: 561px) and (max-height: 650px) {
  .sidebar { padding-top: 16px; }
  .brand-row { margin-bottom: 12px; }
  .new-conversation { margin-bottom: 8px; }
  .sidebar-search { margin-bottom: 8px; }
  .workspace-menu { --el-menu-item-height: 34px; }
  .sidebar-lists { padding-top: 4px; }
  .sidebar-section-heading { min-height: 32px; padding-top: 3px; }
  .profile { min-height: 58px; padding-top: 10px; padding-bottom: 12px; }
}
@media (max-height: 560px) {
  .sidebar { overflow-y: auto; scrollbar-width: thin; }
  .sidebar-lists { flex: 0 0 auto; overflow: visible; }
  .sidebar-section { flex: none; }
  .conversation-list { height: 160px; flex: none; }
  .page-list { height: 130px; flex: none; }
}
@media (max-width: 760px) {
  .sidebar { padding-top: 20px; width: min(300px, 88vw); }
}
@media (prefers-reduced-motion: reduce) {
  .sidebar { transition: none; }
}
</style>

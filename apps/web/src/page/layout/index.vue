<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElAlert } from "element-plus/es/components/alert/index";
import { ElBreadcrumb, ElBreadcrumbItem } from "element-plus/es/components/breadcrumb/index";
import { ElButton } from "element-plus/es/components/button/index";
import { ElMessage } from "element-plus/es/components/message/index";
import { ElTag } from "element-plus/es/components/tag/index";
import AgentIcon from "@/components/AgentIcon.vue";
import WorkspaceSidebar from "@/components/WorkspaceSidebar.vue";
import { useWorkspace } from "@/composables/useWorkspace";
import { useConversationDrafts } from "@/composables/useConversationDrafts";
import { useComposer } from "@/composables/useComposer";
import { useGatewayResource } from "@/composables/useGatewayResource";
import { getOverview, listPending } from "@/api/dashboard";
import type { Skill } from "@qdd/shared";
import { WORKSPACE_CONTEXT, type WorkspaceView } from "@/composables/workspaceContext";

const workspace = useWorkspace();
const {
  activeSessionId, activeSession, activePageSlug, activePage,
  preferences, gatewayUrl, token, error, connected,
} = workspace;
const router = useRouter();
const route = useRoute();
const view = computed<WorkspaceView>(() => {
  const name = route.name;
  return name === "overview" || name === "tasks" || name === "settings"
    || name === "schedules" || name === "skills" || name === "connectors" ? name : "chat";
});
const viewLabels: Record<WorkspaceView, string> = {
  chat: "对话", tasks: "任务", schedules: "定时任务", skills: "技能", connectors: "连接器", overview: "工作台总览", settings: "设置",
};
const heading = computed(() => view.value === "chat" ? activeSession.value?.title || "新对话"
  : view.value === "tasks" && activePageSlug.value ? activePage.value?.title || "任务详情" : viewLabels[view.value]);
const conversationStatus = computed(() => activeSession.value?.status);
const statusLabels = { running: "正在执行", waiting: "等待你的确认", idle: "已就绪", error: "执行失败" };
const sidebar = ref<InstanceType<typeof WorkspaceSidebar>>();
const sidebarOpen = ref(false);
const sidebarCollapsed = ref(false);
const mediaQuery = window.matchMedia("(max-width: 760px)");
const isMobile = ref(mediaQuery.matches);
const pendingSkillId = ref<string | null>(null);
const composer = useComposer(workspace);
const { draft, attachments, convertingAttachments, addAttachments, submitMessage, beginSelection, startNewDraft, clear: clearDrafts } = useConversationDrafts(
  gatewayUrl, activeSessionId, async (text) => composer.sendWithAttachments(async (attachments) => {
    const model = composer.currentModel.value?.id;
    const sent = await workspace.sendMessage(text, {
      ...(pendingSkillId.value ? { skillId: pendingSkillId.value } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(model ? { model } : {}),
    });
    return sent;
  }),
);
const overview = useGatewayResource("overview", getOverview, workspace);
const pending = useGatewayResource("pending", listPending, workspace);
let navigationVersion = 0;

try { sidebarCollapsed.value = localStorage.getItem("harness-sidebar-collapsed") === "true"; }
catch { /* The sidebar remains usable without browser storage. */ }

watch(sidebarCollapsed, (collapsed) => {
  try { localStorage.setItem("harness-sidebar-collapsed", String(collapsed)); }
  catch { /* Retain the preference for this visit. */ }
});
watch(token, clearDrafts, { flush: "sync" });
watch([activeSessionId, gatewayUrl, token], () => { pendingSkillId.value = null; }, { flush: "sync" });
watch(() => route.fullPath, () => {
  navigationVersion++;
  sidebarOpen.value = false;
}, { flush: "sync" });
watch([() => route.params.slug, activePageSlug], ([slug]) => {
  const next = typeof slug === "string" ? slug : null;
  if (activePageSlug.value !== next) activePageSlug.value = next;
}, { immediate: true, flush: "sync" });
watch(() => preferences.value.theme, (theme) => {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
}, { immediate: true });

function notify(message: string) {
  ElMessage({ message, grouping: true });
}
function toggleSidebar() {
  if (isMobile.value) sidebarOpen.value = !sidebarOpen.value;
  else sidebarCollapsed.value = !sidebarCollapsed.value;
}
async function openView(next: WorkspaceView): Promise<void> {
  navigationVersion++;
  sidebarOpen.value = false;
  await router.push({ name: next });
}
async function openConversation(): Promise<void> {
  const opening = workspace.openConversation();
  await openView("chat");
  await opening;
}
async function openPage(slug: string): Promise<void> {
  navigationVersion++;
  sidebarOpen.value = false;
  await router.push({ name: "tasks", params: { slug } });
}
async function openRecords(name: string): Promise<void> {
  navigationVersion++;
  sidebarOpen.value = false;
  await router.push({ name: "settings", query: { record: name }, hash: "#settings-records" });
}
async function editPage(slug: string): Promise<boolean> {
  const version = ++navigationVersion;
  if (activeSessionId.value !== null || !workspace.sending.value) {
    beginSelection();
    composer.beginSelection();
  }
  if (!await workspace.revisePage(slug)) return false;
  if (version !== navigationVersion) return false;
  sidebarOpen.value = false;
  const previousPath = route.fullPath;
  await router.push({ name: "chat" });
  return route.name === "chat"
    && navigationVersion === version + (route.fullPath === previousPath ? 0 : 1);
}
async function newConversation() {
  pendingSkillId.value = null;
  startNewDraft();
  composer.startNewDraft();
  workspace.startNewConversation();
  await openView("chat");
}
async function runSkill(skill: Skill) {
  const opening = newConversation();
  pendingSkillId.value = skill.id;
  draft.value = `请执行「${skill.name}」技能。${skill.description}`;
  const running = submitMessage();
  await opening;
  await running;
}
async function selectConversation(id: string) {
  beginSelection();
  composer.beginSelection();
  const selecting = workspace.selectSession(id);
  await openView("chat");
  await selecting;
}
function updateViewport(event: MediaQueryListEvent) {
  isMobile.value = event.matches;
  sidebarOpen.value = false;
}
function shortcut(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (isMobile.value) sidebarOpen.value = true;
    else sidebarCollapsed.value = false;
    void nextTick(() => sidebar.value?.focusSearch());
  }
  if (event.key === "Escape" && sidebarOpen.value) {
    sidebarOpen.value = false;
    void nextTick(() => document.querySelector<HTMLButtonElement>(".sidebar-toggle")?.focus());
  }
}

provide(WORKSPACE_CONTEXT, {
  workspace, overview, pending, draft, attachments, convertingAttachments, addAttachments, submitMessage, notify, composer,
  navigation: { openConversation, openSession: selectConversation, newConversation, runSkill, openPage, openRecords, openView, editPage },
});
onMounted(() => {
  document.addEventListener("keydown", shortcut);
  mediaQuery.addEventListener("change", updateViewport);
});
onBeforeUnmount(() => {
  document.removeEventListener("keydown", shortcut);
  mediaQuery.removeEventListener("change", updateViewport);
});
</script>

<template>
  <div class="harness-app" :data-theme="preferences.theme">
    <button v-if="isMobile && sidebarOpen" class="sidebar-scrim" aria-label="关闭侧边栏" @click="sidebarOpen = false" />
    <WorkspaceSidebar
      ref="sidebar"
      :collapsed="sidebarCollapsed"
      :mobile-open="sidebarOpen"
      :is-mobile="isMobile"
      :view="view"
      @toggle="toggleSidebar"
      @close="sidebarOpen = false"
      @new-conversation="newConversation"
      @select-conversation="selectConversation" />
    <main class="main-panel" :inert="isMobile && sidebarOpen ? true : undefined">
      <header class="topbar">
        <div class="breadcrumb">
          <ElButton
            class="sidebar-toggle"
            text
            circle
            :aria-label="isMobile ? '展开侧边栏' : sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
            aria-controls="workspace-sidebar"
            :aria-expanded="isMobile ? sidebarOpen : !sidebarCollapsed"
            @click="toggleSidebar">
            <AgentIcon name="panel" :size="19" />
          </ElButton>
          <ElBreadcrumb separator="›">
            <ElBreadcrumbItem class="workspace-crumb">工作台</ElBreadcrumbItem>
            <ElBreadcrumbItem v-if="view === 'tasks' && activePageSlug">
              <a href="/tasks" @click.prevent="openView('tasks')">任务</a>
            </ElBreadcrumbItem>
            <ElBreadcrumbItem><span class="current-heading">{{ heading }}</span></ElBreadcrumbItem>
          </ElBreadcrumb>
        </div>
        <div class="topbar-actions">
          <ElButton v-if="view === 'tasks' && activePage" @click="editPage(activePage.slug)">
            <AgentIcon name="edit" :size="16" />通过对话修改
          </ElButton>
          <ElTag v-if="view === 'chat' && conversationStatus" class="conversation-state" :type="conversationStatus === 'waiting' ? 'warning' : conversationStatus === 'error' ? 'danger' : 'success'" effect="plain" round>
            <span class="status-dot" />{{ statusLabels[conversationStatus] }}
          </ElTag>
          <ElButton v-else class="connection-badge" text @click="openView('settings')">
            <ElTag :type="connected ? 'success' : 'info'" effect="plain" round><span class="status-dot" />{{ connected ? "已连接" : "连接网关" }}</ElTag>
          </ElButton>
        </div>
      </header>
      <ElAlert v-if="error && view !== 'settings'" class="workspace-error" :title="error" type="error" show-icon :closable="false" />
      <router-view />
    </main>
  </div>
</template>

<style src="../../assets/workspace.css"></style>

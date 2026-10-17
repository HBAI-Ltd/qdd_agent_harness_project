<script setup lang="ts">
import { computed, ref } from "vue";
import { ElButton, ElCard, ElEmpty, ElInput, ElSkeleton, ElTag } from "element-plus";
import AgentIcon from "@/components/AgentIcon.vue";
import TaskPreview from "@/components/TaskPreview.vue";
import { useWorkspaceContext } from "@/composables/workspaceContext";
import { TASK_PAGE_MESSAGE_EVENT, type TaskPageEvent } from "@/utils/taskPageBridge";

const { workspace, draft, notify, navigation } = useWorkspaceContext();
const { pages, activePageSlug, activePage, preferences, gatewayUrl, connected, loadingPages, loadWorkspace, pendingPagePins, setPagePinned } = workspace;
const { newConversation, openPage, editPage } = navigation;
const pageQuery = ref("");
const pageKind = ref<"all" | "scheduled" | "once">("all");
const pageKinds = computed(() => [
  { value: "all" as const, label: "全部", count: pages.value.length },
  { value: "scheduled" as const, label: "定时任务", count: pages.value.filter((page) => page.kind === "scheduled").length },
  { value: "once" as const, label: "一次性任务", count: pages.value.filter((page) => page.kind === "once").length },
]);
const taskPageContext = computed(() => ({ theme: preferences.value.theme, locale: "zh-CN" }));
const filteredPages = computed(() =>
  pages.value.filter((page) => (pageKind.value === "all" || page.kind === pageKind.value)
    && `${page.title} ${page.summary} ${page.schedules.map((schedule) => schedule.name).join(" ")}`
      .toLocaleLowerCase().includes(pageQuery.value.trim().toLocaleLowerCase())),
);

// TaskPreview validates the frame, origin and bridge nonce before emitting.
async function handleTaskMessage(message: TaskPageEvent) {
  if (message.slug !== activePageSlug.value) return;
  window.dispatchEvent(new CustomEvent<TaskPageEvent>(TASK_PAGE_MESSAGE_EVENT, { detail: message }));
  message.reply("host:received", { type: message.type });
  if (
    message.type === "conversation:prefill" &&
    message.payload &&
    typeof message.payload === "object" &&
    !Array.isArray(message.payload) &&
    typeof message.payload.text === "string" &&
    message.payload.text.trim() &&
    message.payload.text.length <= 8000
  ) {
    if (await editPage(message.slug)) {
      draft.value = message.payload.text;
      notify("已带入对话，请确认后发送");
    }
  }
}
</script>

<template>
  <template v-if="activePageSlug">
    <TaskPreview
      v-if="activePage"
      :page="activePage"
      :gateway-url="gatewayUrl"
      :context="taskPageContext"
      :pin-disabled="!connected || pendingPagePins.has(activePage.slug)"
      :pin-pending="pendingPagePins.has(activePage.slug)"
      @pin="setPagePinned(activePage.slug, $event)"
      @schedules="navigation.openView('schedules')"
      @message="handleTaskMessage" />
    <div v-else class="task-content-status">
      <p>{{ loadingPages ? "正在加载页面…" : "该页面尚未发布或已不可用" }}</p>
      <ElButton :loading="loadingPages" :disabled="!connected" @click="loadWorkspace">刷新页面列表</ElButton>
    </div>
  </template>
  <div v-else class="feature-page task-board">
    <header class="feature-header">
      <div><span class="feature-eyebrow">任务</span><h1>做好的页面，一直都在</h1><p>经营看板与分析工具，随时打开，继续使用。</p></div>
      <ElButton type="primary" @click="newConversation"><AgentIcon name="plus" :size="16" />通过对话创建</ElButton>
    </header>
    <div class="task-board-controls">
      <ElInput v-model="pageQuery" clearable placeholder="搜索任务页面" aria-label="搜索任务页面"><template #prefix><AgentIcon name="search" :size="17" /></template></ElInput>
      <span class="task-total">{{ pages.length }} 个任务页面</span>
      <ElButton :loading="loadingPages" :disabled="!connected" @click="loadWorkspace"><AgentIcon name="refresh" :size="16" />刷新</ElButton>
    </div>
    <div class="task-kind-filters" role="group" aria-label="按任务类型筛选">
      <ElButton v-for="kind in pageKinds" :key="kind.value" :type="pageKind === kind.value ? 'primary' : 'default'" :plain="pageKind !== kind.value" :aria-pressed="pageKind === kind.value" @click="pageKind = kind.value">
        {{ kind.label }}<span class="task-kind-count">{{ kind.count }}</span>
      </ElButton>
    </div>
    <ElSkeleton v-if="loadingPages" :rows="6" animated />
    <ElCard v-else-if="!filteredPages.length" class="task-board-empty" shadow="never">
      <ElEmpty :image-size="84" :description="!connected ? '连接网关后查看任务页面' : pages.length ? '没有找到相关页面' : '还没有已发布的页面'">
        <p>从一个经营问题开始，和门店助手一起生成专属页面。</p>
        <ElButton type="primary" @click="newConversation">新建对话</ElButton>
      </ElEmpty>
    </ElCard>
    <div v-else class="task-cards">
      <ElCard v-for="page in filteredPages" :key="page.slug" class="work-task-card" shadow="never">
        <div class="work-task-heading"><ElTag :type="page.kind === 'scheduled' ? 'primary' : 'info'" effect="plain" size="small">{{ page.kind === "scheduled" ? "定时任务" : "一次性任务" }}</ElTag><ElTag v-if="page.pinnedAt" type="warning" effect="plain" size="small">已置顶</ElTag><ElTag v-if="page.stale" type="warning" effect="light" size="small" round>待复核</ElTag><AgentIcon :name="page.kind === 'scheduled' ? 'clock' : 'code'" :size="20" /></div>
        <h2><ElButton link class="task-title-button" @click="openPage(page.slug)">{{ page.title }}</ElButton></h2>
        <p class="work-task-description">{{ page.summary || page.wish }}</p>
        <div v-if="page.schedules.length" class="work-task-schedules" aria-label="关联定时任务">
          <ElButton v-for="schedule in page.schedules" :key="schedule.id" class="work-task-schedule" text :aria-label="`管理定时任务：${schedule.name}，${schedule.enabled ? '已启用' : '已暂停'}`" @click="navigation.openView('schedules')">
            <span class="work-task-schedule-name">{{ schedule.name }}</span><ElTag :type="schedule.enabled ? 'success' : 'info'" effect="plain" size="small">{{ schedule.enabled ? "已启用" : "已暂停" }}</ElTag><AgentIcon name="chevron" :size="12" />
          </ElButton>
        </div>
        <div class="work-task-footer"><span class="work-task-updated"><time :datetime="page.updatedAt">{{ new Date(page.updatedAt).toLocaleDateString("zh-CN") }} 更新</time><span>v{{ page.version }}</span></span><div class="work-task-actions"><ElButton link :type="page.pinnedAt ? 'warning' : 'default'" :aria-label="`${page.pinnedAt ? '取消置顶' : '置顶'}：${page.title}`" :aria-pressed="!!page.pinnedAt" :loading="pendingPagePins.has(page.slug)" :disabled="!connected || pendingPagePins.has(page.slug)" @click="setPagePinned(page.slug, !page.pinnedAt)">{{ page.pinnedAt ? "取消置顶" : "置顶" }}</ElButton><ElButton link type="primary" @click="openPage(page.slug)">打开页面<AgentIcon name="chevron" :size="14" /></ElButton></div></div>
      </ElCard>
    </div>
  </div>
</template>

<style scoped>
.task-board-controls { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; }
.task-board-controls > :deep(.el-input) { width: min(360px, 100%); }
.task-total { color: var(--qdd-muted); font-size: 12px; white-space: nowrap; }
.task-board-controls > :deep(.el-button) { margin-left: auto; }
.task-kind-filters { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
.task-kind-filters :deep(.el-button + .el-button) { margin-left: 0; }
.task-kind-count { margin-left: 7px; font-size: 12px; opacity: .8; }
.task-board-empty { margin-top: 12px; }
.task-board-empty p { margin: 0 0 20px; color: var(--qdd-muted); font-size: 13px; }
.task-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; }
.work-task-card :deep(.el-card__body) { display: flex; flex-direction: column; height: 100%; padding: 23px; }
.work-task-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.work-task-heading > svg { margin-left: auto; color: var(--qdd-muted); }
.work-task-card h2 { margin: 17px 0 8px; font-size: 20px; line-height: 1.5; }
.task-title-button.el-button { max-width: 100%; padding: 0; background: transparent; text-align: left; color: var(--qdd-text); font: inherit; font-weight: 600; white-space: normal; overflow-wrap: anywhere; }
.task-title-button :deep(> span) { display: block; min-width: 0; }
.task-title-button:hover { color: var(--qdd-primary); }
.work-task-description { flex: 1; margin: 0 0 24px; color: var(--qdd-muted); font-size: 13px; line-height: 1.8; overflow-wrap: anywhere; }
.work-task-schedules { display: grid; gap: 6px; margin: -8px 0 18px; }
.work-task-schedule.el-button { height: auto; padding: 7px 9px; margin: 0; background: var(--qdd-bg); text-align: left; }
.work-task-schedule :deep(> span) { display: flex; align-items: center; gap: 7px; width: 100%; min-width: 0; }
.work-task-schedule-name { flex: 1; min-width: 0; white-space: normal; overflow-wrap: anywhere; font-size: 12px; line-height: 1.6; }
.work-task-schedule :deep(.el-tag), .work-task-schedule svg { flex-shrink: 0; }
.work-task-footer { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; padding-top: 16px; border-top: 1px solid var(--qdd-border); }
.work-task-footer time { color: var(--qdd-muted); font-size: 11px; }
.work-task-updated { display: flex; flex-wrap: wrap; gap: 6px; color: var(--qdd-muted); font-size: 11px; }
.work-task-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.work-task-actions :deep(.el-button + .el-button) { margin-left: 0; }
@media (max-width: 1240px) { .task-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 760px) { .task-board-controls { flex-wrap: wrap; gap: 12px; } .task-board-controls > :deep(.el-input) { width: 100%; } .task-cards { grid-template-columns: 1fr; } }
</style>

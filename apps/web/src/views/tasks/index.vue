<script setup lang="ts">
import { computed, ref } from "vue";
import { ElButton, ElCard, ElEmpty, ElInput, ElSkeleton, ElTag } from "element-plus";
import AgentIcon from "@/components/AgentIcon.vue";
import TaskPreview from "@/components/TaskPreview.vue";
import { useWorkspaceContext } from "@/composables/workspaceContext";
import { TASK_PAGE_MESSAGE_EVENT, type TaskPageEvent } from "@/utils/taskPageBridge";

const { workspace, draft, notify, navigation } = useWorkspaceContext();
const { pages, activePageSlug, activePage, preferences, gatewayUrl, connected, loadingPages, loadWorkspace } = workspace;
const { newConversation, openPage, editPage } = navigation;
const pageQuery = ref("");
const taskPageContext = computed(() => ({ theme: preferences.value.theme, locale: "zh-CN" }));
const filteredPages = computed(() =>
  pages.value.filter((page) => `${page.title} ${page.summary}`.toLocaleLowerCase().includes(pageQuery.value.trim().toLocaleLowerCase())),
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
    <TaskPreview v-if="activePage" :page="activePage" :gateway-url="gatewayUrl" :context="taskPageContext" @message="handleTaskMessage" />
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
    <ElSkeleton v-if="loadingPages" :rows="6" animated />
    <ElCard v-else-if="!filteredPages.length" class="task-board-empty" shadow="never">
      <ElEmpty :image-size="84" :description="!connected ? '连接网关后查看任务页面' : pages.length ? '没有找到相关页面' : '还没有已发布的页面'">
        <p>从一个经营问题开始，和门店助手一起生成专属页面。</p>
        <ElButton type="primary" @click="newConversation">新建对话</ElButton>
      </ElEmpty>
    </ElCard>
    <div v-else class="task-cards">
      <ElCard v-for="page in filteredPages" :key="page.slug" class="work-task-card" shadow="never">
        <div class="work-task-heading"><ElTag type="success" effect="plain" size="small">已发布 · v{{ page.version }}</ElTag><ElTag v-if="page.stale" type="warning" effect="light" size="small" round>待复核</ElTag><AgentIcon name="code" :size="20" /></div>
        <h2><ElButton link class="task-title-button" @click="openPage(page.slug)">{{ page.title }}</ElButton></h2>
        <p class="work-task-description">{{ page.summary || page.wish }}</p>
        <div class="work-task-footer"><time :datetime="page.updatedAt">{{ new Date(page.updatedAt).toLocaleDateString("zh-CN") }} 更新</time><ElButton link type="primary" @click="openPage(page.slug)">打开页面<AgentIcon name="chevron" :size="14" /></ElButton></div>
      </ElCard>
    </div>
  </div>
</template>

<style scoped>
.task-board-controls { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; }
.task-board-controls > :deep(.el-input) { width: min(360px, 100%); }
.task-total { color: var(--qdd-muted); font-size: 12px; white-space: nowrap; }
.task-board-controls > :deep(.el-button) { margin-left: auto; }
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
.work-task-footer { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; padding-top: 16px; border-top: 1px solid var(--qdd-border); }
.work-task-footer time { color: var(--qdd-muted); font-size: 11px; }
@media (max-width: 1240px) { .task-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 760px) { .task-board-controls { flex-wrap: wrap; gap: 12px; } .task-board-controls > :deep(.el-input) { width: 100%; } .task-cards { grid-template-columns: 1fr; } }
</style>

<script setup lang="ts">
import { computed } from "vue";
import type { PageView, SessionDetail, SessionMeta, SessionStatus } from "@qdd/shared";
import { ElAlert, ElButton, ElCard, ElEmpty, ElSkeleton, ElTag } from "element-plus";
import AgentIcon from "@/components/AgentIcon.vue";

const props = defineProps<{
  activeSession?: SessionDetail | undefined;
  sessions: SessionMeta[];
  pages: PageView[];
  connected: boolean;
  loading: boolean;
}>();
const emit = defineEmits<{
  openConversation: [];
  newConversation: [];
  openSession: [id: string];
  openSettings: [];
  openTasks: [];
  openPage: [slug: string];
  revisePage: [slug: string];
}>();
const statusLabels: Record<SessionStatus, string> = {
  running: "正在执行",
  waiting: "待你确认",
  idle: "已就绪",
  error: "执行失败",
};
const statusTypes: Record<SessionStatus, "success" | "warning" | "info" | "danger"> = {
  running: "success",
  waiting: "warning",
  idle: "info",
  error: "danger",
};
const orderedSessions = computed(() => [...props.sessions].sort((a, b) => timeValue(b.updatedAt) - timeValue(a.updatedAt)));
const runningSessions = computed(() => orderedSessions.value.filter((session) => session.status === "running"));
const waitingSessions = computed(() => orderedSessions.value.filter((session) => session.status === "waiting"));
const recentSessions = computed(() => orderedSessions.value.slice(0, 4));
const recentPages = computed(() => [...props.pages].sort((a, b) => timeValue(b.updatedAt) - timeValue(a.updatedAt)).slice(0, 6));
const staleCount = computed(() => props.pages.filter((page) => !!page.stale).length);
const kpis = computed(() => [
  { label: "进行中对话", value: runningSessions.value.length, icon: "chat", tone: "primary", hint: runningSessions.value.length ? runningSessions.value.slice(0, 2).map((session) => session.title || "未命名对话").join("、") : "当前没有正在执行的对话" },
  { label: "待处理确认", value: waitingSessions.value.length, icon: "clock", tone: "warning", hint: waitingSessions.value.length ? "回答问题或确认操作，让助手继续执行" : "当前没有需要你处理的确认" },
  { label: "已发布任务", value: props.pages.length, icon: "plan", tone: "good", hint: staleCount.value ? `${staleCount.value} 个页面待复核` : "分析成果与经营工具，随时打开使用" },
]);

function timeValue(value: string): number {
  return Date.parse(value) || 0;
}
function displayDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间待同步";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
</script>

<template>
  <div class="feature-page store-overview" :aria-busy="loading">
    <header class="feature-header overview-header">
      <div><span class="feature-eyebrow">工作台总览</span><h1>所有助手在做什么，一眼看清</h1><p>{{ connected ? "跟进正在进行的工作，处理确认，随时打开分析成果。" : "连接门店工作空间，查看对话进度和已发布的任务页面。" }}</p></div>
      <ElButton type="primary" @click="connected ? emit('newConversation') : emit('openSettings')"><AgentIcon :name="connected ? 'plus' : 'sliders'" :size="17" />{{ connected ? "新建对话" : "连接工作空间" }}</ElButton>
    </header>

    <section class="overview-kpis" aria-label="工作空间状态">
      <ElCard v-for="kpi in kpis" :key="kpi.label" class="overview-kpi" :class="`tone-${kpi.tone}`" shadow="never">
        <div class="kpi-heading"><span>{{ kpi.label }}</span><AgentIcon :name="kpi.icon" :size="20" /></div>
        <strong class="kpi-value">{{ connected && !loading ? kpi.value : "—" }}<span v-if="connected && !loading">个</span></strong>
        <p>{{ loading ? "正在同步工作空间" : !connected ? "连接后查看真实状态" : kpi.hint }}</p>
      </ElCard>
    </section>

    <ElAlert v-if="!connected" class="overview-connection" title="连接工作空间后，对话进度与任务页面会在这里集中展示。" type="info" show-icon :closable="false" />
    <template v-else>
      <section class="pending-section" aria-labelledby="pending-confirmations-title">
        <div class="overview-section-heading"><div><h2 id="pending-confirmations-title">待处理确认<ElTag v-if="waitingSessions.length" type="warning" effect="plain" round size="small">{{ waitingSessions.length }}</ElTag></h2><p>涉及问题补充或操作授权时，助手会等你确认。</p></div></div>
        <ElSkeleton v-if="loading" :rows="2" animated />
        <div v-else-if="waitingSessions.length" class="pending-list">
          <ElCard v-for="session in waitingSessions" :key="session.id" class="pending-card" shadow="never"><div class="pending-content"><span class="pending-icon"><AgentIcon name="clock" :size="21" /></span><div><h3>{{ session.title || "未命名对话" }}</h3><p>{{ session.summary || "助手正在等待你回答问题或确认操作。" }}</p></div><ElButton type="primary" plain @click="emit('openSession', session.id)">查看并确认<AgentIcon name="chevron" :size="14" /></ElButton></div></ElCard>
        </div>
        <div v-else class="pending-clear"><span><AgentIcon name="check" :size="17" /></span><div><strong>当前没有待处理的确认</strong><p>需要你决定的事项，会在这里提醒。</p></div></div>
      </section>

      <section aria-labelledby="recent-conversations-title">
        <div class="overview-section-heading"><div><h2 id="recent-conversations-title">最近对话</h2><p>查看助手的最新进展，继续未完成的工作。</p></div><ElButton link type="primary" @click="emit('openConversation')">{{ activeSession ? "继续当前对话" : "进入对话" }}<AgentIcon name="chevron" :size="14" /></ElButton></div>
        <ElSkeleton v-if="loading" :rows="3" animated />
        <div v-else-if="recentSessions.length" class="overview-conversation-grid">
          <ElCard v-for="session in recentSessions" :key="session.id" class="overview-session-card" shadow="never"><div class="session-card-top"><ElTag :type="statusTypes[session.status]" size="small" effect="plain"><span v-if="session.status === 'running'" class="running-dot" />{{ statusLabels[session.status] }}</ElTag><time :datetime="session.updatedAt">{{ displayDate(session.updatedAt) }}</time></div><h3><button @click="emit('openSession', session.id)">{{ session.title || "未命名对话" }}</button></h3><p>{{ session.summary || (session.status === "running" ? "助手正在处理你的需求。" : "打开对话，查看历史消息与处理结果。") }}</p><ElButton link type="primary" @click="emit('openSession', session.id)">{{ session.status === "running" ? "查看进度" : session.status === "waiting" ? "前往确认" : "打开对话" }}<AgentIcon name="chevron" :size="14" /></ElButton></ElCard>
        </div>
        <ElCard v-else shadow="never" class="overview-empty"><ElEmpty description="从一个经营问题开始新的对话" :image-size="65"><ElButton type="primary" @click="emit('newConversation')">新建对话</ElButton></ElEmpty></ElCard>
      </section>

      <section aria-labelledby="recent-tasks-title">
        <div class="overview-section-heading"><div><h2 id="recent-tasks-title">最近任务页面<ElTag v-if="pages.length" type="info" effect="plain" size="small" round>{{ pages.length }}</ElTag></h2><p>经营看板、分析结果和专属工具，集中管理。</p></div><ElButton link type="primary" @click="emit('openTasks')">查看全部<AgentIcon name="chevron" :size="14" /></ElButton></div>
        <ElSkeleton v-if="loading" :rows="3" animated />
        <div v-else-if="recentPages.length" class="overview-task-grid">
          <ElCard v-for="page in recentPages" :key="page.slug" class="overview-task-card" shadow="never"><div class="task-card-top"><ElTag type="success" size="small" effect="plain">已发布 · v{{ page.version }}</ElTag><ElTag v-if="page.stale" type="warning" size="small" effect="plain">待复核</ElTag><ElTag v-else-if="page.gaps.length" type="info" size="small" effect="plain">有能力说明</ElTag></div><h3><button @click="emit('openPage', page.slug)">{{ page.title }}</button></h3><p>{{ page.summary || page.wish }}</p><div class="task-card-footer"><time :datetime="page.updatedAt">{{ displayDate(page.updatedAt) }} 更新</time><div><ElButton link type="primary" @click="emit('revisePage', page.slug)">修改</ElButton><ElButton link type="primary" @click="emit('openPage', page.slug)">打开<AgentIcon name="chevron" :size="13" /></ElButton></div></div></ElCard>
        </div>
        <ElCard v-else shadow="never" class="overview-empty"><ElEmpty description="完成一段对话，让经营想法变成可用的页面" :image-size="65"><ElButton @click="emit('openConversation')">前往对话</ElButton></ElEmpty></ElCard>
      </section>
    </template>
    <p class="overview-footnote"><AgentIcon name="check" :size="14" />仅展示当前工作空间的对话状态与已发布页面。</p>
  </div>
</template>

<style scoped>
.store-overview { display: grid; align-content: start; gap: 30px; }
.overview-header { margin-bottom: 0; }
.overview-header > :deep(.el-button > span), .overview-section-heading :deep(.el-button > span), .pending-card :deep(.el-button > span), .overview-session-card :deep(.el-button > span), .overview-task-card :deep(.el-button > span) { display: inline-flex; align-items: center; gap: 6px; }
.overview-kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; }
.overview-kpi :deep(.el-card__body) { padding: 23px 25px; }
.kpi-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; color: var(--qdd-muted); font-size: 13px; }
.kpi-value { display: block; margin: 15px 0 10px; font-size: 37px; line-height: 1.3; font-weight: 600; font-variant-numeric: tabular-nums; }
.kpi-value > span { color: var(--qdd-muted); font-size: 12px; font-weight: 400; margin-left: 8px; }
.overview-kpi p { color: var(--qdd-muted); font-size: 12px; line-height: 1.8; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tone-primary .kpi-value, .tone-primary .kpi-heading > svg { color: var(--qdd-primary); }
.tone-warning .kpi-value, .tone-warning .kpi-heading > svg { color: var(--qdd-warn); }
.tone-good .kpi-value, .tone-good .kpi-heading > svg { color: var(--qdd-good); }
.overview-section-heading { display: flex; justify-content: space-between; align-items: center; gap: 18px; margin-bottom: 17px; }
.overview-section-heading h2 { display: flex; align-items: center; gap: 9px; font-size: 17px; font-weight: 600; margin: 0 0 5px; }
.overview-section-heading p { color: var(--qdd-muted); font-size: 12px; line-height: 1.7; margin: 0; }
.pending-list { display: grid; gap: 12px; }
.pending-card { border-color: color-mix(in srgb, var(--qdd-warn) 35%, var(--qdd-border)); background: color-mix(in srgb, var(--qdd-warn) 4%, var(--qdd-surface)); }
.pending-card :deep(.el-card__body) { padding: 19px 23px; }
.pending-content { display: flex; align-items: center; gap: 16px; }
.pending-icon { display: grid; place-items: center; width: 42px; height: 42px; flex-shrink: 0; color: var(--qdd-warn); border-radius: 10px; background: color-mix(in srgb, var(--qdd-warn) 9%, var(--qdd-surface)); }
.pending-content > div { flex: 1; min-width: 0; }
.pending-content h3 { font-size: 14px; font-weight: 600; margin: 0 0 5px; }
.pending-content p { color: var(--qdd-muted); font-size: 12px; line-height: 1.8; margin: 0; overflow-wrap: anywhere; }
.pending-clear { display: flex; align-items: center; gap: 12px; padding: 20px 23px; border: 1px solid var(--qdd-border); border-radius: var(--qdd-radius); background: var(--qdd-surface); }
.pending-clear > span { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; color: var(--qdd-good); background: color-mix(in srgb, var(--qdd-good) 8%, var(--qdd-surface)); }
.pending-clear strong { font-size: 13px; font-weight: 500; }
.pending-clear p { color: var(--qdd-muted); font-size: 12px; margin: 3px 0 0; }
.overview-conversation-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.overview-session-card :deep(.el-card__body), .overview-task-card :deep(.el-card__body) { display: flex; flex-direction: column; height: 100%; padding: 22px; }
.session-card-top, .task-card-top { display: flex; align-items: center; gap: 7px; }
.session-card-top { justify-content: space-between; }
.session-card-top time, .task-card-footer time { color: var(--qdd-muted); font-size: 11px; white-space: nowrap; }
.running-dot { display: inline-block; width: 5px; height: 5px; margin-right: 5px; border-radius: 50%; background: var(--qdd-good); vertical-align: middle; }
.overview-session-card h3, .overview-task-card h3 { font-size: 15px; font-weight: 600; margin: 17px 0 9px; line-height: 1.7; }
.overview-session-card h3 button, .overview-task-card h3 button { padding: 0; color: var(--qdd-text); background: transparent; text-align: left; overflow-wrap: anywhere; }
.overview-session-card h3 button:hover, .overview-task-card h3 button:hover { color: var(--qdd-primary); }
.overview-session-card p, .overview-task-card p { color: var(--qdd-muted); font-size: 12px; line-height: 1.8; margin: 0 0 18px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.overview-session-card :deep(.el-button.is-link) { align-self: flex-start; margin-top: auto; font-size: 12px; }
.overview-task-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.overview-task-card h3 { margin-top: 15px; }
.task-card-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 15px; margin-top: auto; border-top: 1px solid var(--qdd-border); }
.task-card-footer > div { display: flex; gap: 9px; }
.task-card-footer :deep(.el-button + .el-button) { margin-left: 0; }
.task-card-footer :deep(.el-button) { font-size: 12px; }
.overview-empty :deep(.el-empty) { padding: 22px 0; }
.overview-footnote { display: flex; align-items: center; gap: 6px; color: var(--qdd-muted); font-size: 11px; margin: 0; }
@media (max-width: 1180px) { .overview-task-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .overview-kpi :deep(.el-card__body) { padding: 20px; } }
@media (max-width: 760px) {
  .store-overview { gap: 25px; }
  .overview-kpis, .overview-conversation-grid, .overview-task-grid { grid-template-columns: minmax(0, 1fr); gap: 14px; }
  .overview-kpi :deep(.el-card__body) { padding: 19px 21px; }
  .kpi-value { margin-top: 10px; font-size: 33px; }
  .pending-content { flex-wrap: wrap; gap: 12px; align-items: flex-start; }
  .pending-content > div { flex: 1; min-width: 160px; }
  .pending-content > :deep(.el-button) { margin-left: 54px; }
  .overview-section-heading { align-items: flex-start; gap: 12px; }
  .overview-section-heading > :deep(.el-button) { font-size: 12px; }
  .overview-session-card :deep(.el-card__body), .overview-task-card :deep(.el-card__body) { padding: 20px; }
  .overview-footnote { align-items: flex-start; line-height: 1.8; }
}
</style>

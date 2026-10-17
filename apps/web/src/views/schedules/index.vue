<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { ElAlert, ElButton, ElCard, ElDialog, ElEmpty, ElForm, ElFormItem, ElInput, ElMessageBox, ElSelect, ElSkeleton, ElSwitch, ElTag, ElTimePicker } from "element-plus";
import type { Schedule, ScheduleInput } from "@qdd/shared";
import AgentIcon from "@/components/AgentIcon.vue";
import StringSelectOption from "@/components/StringSelectOption";
import { useWorkspaceContext } from "@/composables/workspaceContext";
import { useGatewayResource } from "@/composables/useGatewayResource";
import { listConnectors } from "@/api/connectors";
import { listSkills } from "@/api/skills";
import { canNotify, createSchedule, deleteSchedule, listSchedules, runSchedule, scheduleCron, scheduleInput, updateSchedule, type ScheduleFrequency } from "@/api/schedules";

const { workspace, navigation, notify } = useWorkspaceContext();
const { connected, gatewayUrl, token, pages, sessions } = workspace;
const { data, loading, error, refresh } = useGatewayResource("schedules", listSchedules);
const skillsResource = useGatewayResource("skills", listSkills);
const connectorsResource = useGatewayResource("connectors", listConnectors);
const schedules = computed(() => data.value ?? []);
const skills = computed(() => skillsResource.data.value ?? []);
const connectors = computed(() => connectorsResource.data.value?.connectors ?? []);
const notificationTargets = computed(() => connectors.value.filter(canNotify));
// TODO: Enable currently unavailable notification types when their catalog entries become available.
const upcomingChannels = computed(() => connectorsResource.data.value?.catalog.filter((entry) => entry.category === "消息通知" && !entry.available) ?? []);
const templates = [
  { name: "经营日报", prompt: "汇总昨日销售与各品类表现，比较近期变化，整理今日经营关注事项。", cron: "0 8 * * *", when: "每天 08:00" },
  { name: "经营周报", prompt: "分析最近一周的销售、库存和经营变化，整理本周总结与下一周的关注事项。", cron: "0 9 * * 1", when: "每周一 09:00" },
  { name: "库存巡检", prompt: "检查当前库存，列出低于安全库存或存在异常变化的商品，并说明需要补充核实的数据。", cron: "0 */2 * * *", when: "每 2 小时" },
  { name: "临期预警", prompt: "查询未来 3 天内到期的商品，结合剩余库存整理优先处理建议，涉及改价先请求确认。", cron: "30 7 * * *", when: "每天 07:30" },
];
const editorOpen = ref(false);
const editingId = ref<string | null>(null);
const form = reactive({
  name: "", prompt: "", frequency: "daily" as ScheduleFrequency, time: "08:00", weekday: "1", rawCron: "0 8 * * *",
  skillId: "", slug: "", connectorId: "", enabled: true,
});
const saving = ref(false);
const formError = ref("");
const actionError = ref("");
const rowBusy = ref<Record<string, string>>({});
const launchedSessions = ref<Record<string, string>>({});
const controllers = new Set<AbortController>();
let saveController: AbortController | undefined;
let version = 0;
let editorVersion = 0;

watch(schedules, (entries) => {
  for (const schedule of entries) {
    if (schedule.lastRun?.sessionId === launchedSessions.value[schedule.id]) delete launchedSessions.value[schedule.id];
  }
});

function errorText(cause: unknown): string {
  return cause instanceof TypeError ? "暂时无法连接工作空间，请检查连接后重试。" : cause instanceof Error ? cause.message : "操作失败，请稍后重试。";
}
function formatTime(value: string | null | undefined): string {
  if (!value) return "尚未安排";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间待同步" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function currentRun(schedule: Schedule) {
  return sessions.value.find((session) => session.origin?.scheduleId === schedule.id
    && (session.status === "running" || session.status === "waiting"));
}
function cronFields(cron: string): { frequency: ScheduleFrequency; time: string; weekday: string; rawCron: string } {
  const fields = cron.trim().split(/\s+/);
  const minute = Number(fields[0]);
  const hour = Number(fields[1]);
  if (cron === "0 */2 * * *") return { frequency: "hourly", time: "08:00", weekday: "1", rawCron: cron };
  if (fields.length === 5 && /^\d+$/.test(fields[0]!) && /^\d+$/.test(fields[1]!) && fields[2] === "*" && fields[3] === "*"
    && minute < 60 && hour < 24 && (fields[4] === "*" || /^[0-6]$/.test(fields[4]!))) {
    return { frequency: fields[4] === "*" ? "daily" : "weekly", time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, weekday: fields[4] === "*" ? "1" : fields[4]!, rawCron: cron };
  }
  return { frequency: "custom", time: "08:00", weekday: "1", rawCron: cron };
}
function cronLabel(cron: string): string {
  const fields = cronFields(cron);
  if (fields.frequency === "hourly") return "每 2 小时";
  if (fields.frequency === "daily") return `每天 ${fields.time}`;
  if (fields.frequency === "weekly") return `每周${["日", "一", "二", "三", "四", "五", "六"][Number(fields.weekday)]} ${fields.time}`;
  return "自定义执行规则";
}
function openEditor(schedule?: Schedule, template?: (typeof templates)[number]) {
  editorVersion++;
  editingId.value = schedule?.id ?? null;
  Object.assign(form, {
    name: schedule?.name ?? template?.name ?? "", prompt: schedule?.prompt ?? template?.prompt ?? "",
    ...cronFields(schedule?.cron ?? template?.cron ?? "0 8 * * *"),
    skillId: schedule?.skillId ?? "", slug: schedule?.slug ?? "", connectorId: schedule?.notify?.connectorId ?? "",
    enabled: schedule?.enabled ?? true,
  });
  formError.value = "";
  editorOpen.value = true;
}
function closeEditor() {
  editorVersion++;
  saveController?.abort();
  saving.value = false;
}
function resetOperations() {
  version++;
  for (const controller of controllers) controller.abort();
  controllers.clear();
  rowBusy.value = {};
  launchedSessions.value = {};
  saving.value = false;
  editorOpen.value = false;
  actionError.value = "";
  formError.value = "";
}
watch([gatewayUrl, token, connected], resetOperations, { flush: "sync" });
onBeforeUnmount(resetOperations);
async function save() {
  if (!connected.value || saving.value) return;
  let input: ScheduleInput;
  try {
    if (!form.name.trim() || !form.prompt.trim()) throw new Error("请填写任务名称与要助手执行的内容。");
    if (form.connectorId && !notificationTargets.value.some((connector) => connector.id === form.connectorId)) throw new Error("请选择已连接并允许推送的消息接收方，或选择不推送。");
    input = scheduleInput({ ...form, cron: scheduleCron(form.frequency, form.time, form.weekday, form.rawCron) }, !!editingId.value);
  } catch (cause) { formError.value = errorText(cause); return; }
  const controller = new AbortController();
  controllers.add(controller);
  saveController = controller;
  const currentVersion = version;
  const currentEditor = editorVersion;
  saving.value = true;
  formError.value = "";
  try {
    if (editingId.value) await updateSchedule(gatewayUrl.value, token.value, editingId.value, input, controller.signal);
    else await createSchedule(gatewayUrl.value, token.value, input, controller.signal);
    if (controller.signal.aborted || currentVersion !== version || currentEditor !== editorVersion) return;
    notify(editingId.value ? "定时任务已更新" : "定时任务已创建");
    editorOpen.value = false;
    await refresh();
  } catch (cause) {
    if (!controller.signal.aborted && currentVersion === version && currentEditor === editorVersion) formError.value = errorText(cause);
  } finally {
    controllers.delete(controller);
    if (saveController === controller) { saving.value = false; saveController = undefined; }
  }
}
async function rowAction(schedule: Schedule, action: string, perform: (signal: AbortSignal) => Promise<void>) {
  if (!connected.value || rowBusy.value[schedule.id]) return;
  const currentVersion = version;
  const controller = new AbortController();
  controllers.add(controller);
  rowBusy.value[schedule.id] = action;
  actionError.value = "";
  try {
    await perform(controller.signal);
    if (!controller.signal.aborted && currentVersion === version) await refresh();
  } catch (cause) {
    if (!controller.signal.aborted && currentVersion === version) actionError.value = errorText(cause);
  } finally {
    controllers.delete(controller);
    if (currentVersion === version) delete rowBusy.value[schedule.id];
  }
}
async function toggle(schedule: Schedule, enabled: boolean) {
  await rowAction(schedule, "toggle", async (signal) => {
    await updateSchedule(gatewayUrl.value, token.value, schedule.id, { enabled }, signal);
    if (!signal.aborted) notify(enabled ? "已启用定时执行" : "已暂停后续定时执行");
  });
}
async function run(schedule: Schedule) {
  await rowAction(schedule, "run", async (signal) => {
    const result = await runSchedule(gatewayUrl.value, token.value, schedule.id, signal);
    if (!signal.aborted) { launchedSessions.value[schedule.id] = result.sessionId; notify("任务已开始执行"); }
  });
}
async function remove(schedule: Schedule) {
  if (!connected.value || rowBusy.value[schedule.id]) return;
  const currentVersion = version;
  const message = currentRun(schedule)
    ? `删除“${schedule.name}”将移除后续计划，当前正在执行的对话仍会继续。确定删除吗？`
    : `确定删除定时任务“${schedule.name}”吗？`;
  try { await ElMessageBox.confirm(message, "删除定时任务", { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" }); }
  catch { return; }
  if (currentVersion !== version) return;
  await rowAction(schedule, "delete", async (signal) => {
    await deleteSchedule(gatewayUrl.value, token.value, schedule.id, signal);
    if (!signal.aborted) notify("定时任务已删除");
  });
}
function runSessionId(schedule: Schedule): string | undefined {
  return currentRun(schedule)?.id ?? launchedSessions.value[schedule.id] ?? schedule.lastRun?.sessionId ?? undefined;
}
</script>

<template>
  <div class="feature-page schedules-page">
    <header class="feature-header"><div><span class="feature-eyebrow">定时任务</span><h1>到点自动做，做完推给你</h1><p>安排经营日报、库存巡检和门店提醒，随时查看执行结果。</p></div><ElButton type="primary" :disabled="!connected" @click="openEditor()"><AgentIcon name="plus" :size="16" />新建定时任务</ElButton></header>
    <ElAlert v-if="error || actionError" :title="actionError || error" type="error" show-icon :closable="false" />
    <ElAlert v-if="!connected" title="连接工作空间后，管理定时任务与执行结果。" type="info" show-icon :closable="false" />
    <div class="schedules-layout">
      <section class="schedule-main" aria-label="已保存定时任务">
        <div class="section-heading"><h2>我的定时任务<ElTag type="info" effect="plain" size="small">{{ schedules.length }}</ElTag></h2><ElButton :loading="loading" :disabled="!connected" @click="refresh">刷新</ElButton></div>
        <p class="timezone-note">执行规则按网关所在时区；下次与最近执行时间按当前浏览器时间显示。</p>
        <ElSkeleton v-if="loading && !data" :rows="5" animated />
        <ElCard v-else-if="!schedules.length" shadow="never"><ElEmpty description="还没有定时任务" :image-size="65"><ElButton :disabled="!connected" @click="openEditor()">创建第一个任务</ElButton></ElEmpty></ElCard>
        <div v-else class="schedule-list">
          <ElCard v-for="schedule in schedules" :key="schedule.id" class="schedule-job" shadow="never">
            <div class="job-heading"><div><h3>{{ schedule.name }}</h3><div class="job-tags"><ElTag :type="schedule.enabled ? 'success' : 'info'" size="small" effect="plain">{{ schedule.enabled ? "已启用" : "已暂停" }}</ElTag><ElTag v-if="currentRun(schedule)" :type="currentRun(schedule)?.status === 'waiting' ? 'warning' : 'success'" size="small" effect="plain">{{ currentRun(schedule)?.status === "waiting" ? "等待确认" : "正在执行" }}</ElTag><ElTag v-if="schedule.skillId" type="info" size="small" effect="plain">{{ skills.find((skill) => skill.id === schedule.skillId)?.name || "关联技能" }}</ElTag></div></div><ElSwitch :model-value="schedule.enabled" :loading="rowBusy[schedule.id] === 'toggle'" :disabled="!connected || !!rowBusy[schedule.id]" :aria-label="`${schedule.enabled ? '暂停' : '启用'}${schedule.name}`" @change="toggle(schedule, !!$event)" /></div>
            <p class="job-prompt">{{ schedule.prompt }}</p><div class="job-timing"><span><AgentIcon name="clock" :size="14" />{{ cronLabel(schedule.cron) }}</span><span>下次：{{ schedule.enabled ? formatTime(schedule.nextRunAt) : "已暂停" }}</span></div>
            <p v-if="schedule.notify" class="job-channel">推送到：{{ connectors.find((connector) => connector.id === schedule.notify?.connectorId)?.name || "原消息接收方" }}</p>
            <div v-if="schedule.lastRun" class="last-run"><div><ElTag :type="schedule.lastRun.status === 'ok' ? 'success' : 'danger'" size="small" effect="plain">{{ schedule.lastRun.status === "ok" ? "最近执行成功" : "最近执行失败" }}</ElTag><time :datetime="schedule.lastRun.at">{{ formatTime(schedule.lastRun.at) }}</time></div><p>{{ schedule.lastRun.message }}</p><p v-if="schedule.lastRun.notified" :class="{ 'notification-error': !schedule.lastRun.notified.ok }">{{ schedule.lastRun.notified.ok ? "结果已推送" : `结果推送失败：${schedule.lastRun.notified.error || '请检查通知渠道'}` }}</p></div>
            <p v-else class="no-run">尚无完成的执行记录</p>
            <div class="job-actions"><ElButton :loading="rowBusy[schedule.id] === 'run'" :disabled="!connected || !!rowBusy[schedule.id] || !!currentRun(schedule)" @click="run(schedule)">立即运行</ElButton><ElButton :disabled="!connected || !!rowBusy[schedule.id]" @click="openEditor(schedule)">编辑</ElButton><ElButton type="danger" link :loading="rowBusy[schedule.id] === 'delete'" :disabled="!connected || !!rowBusy[schedule.id]" @click="remove(schedule)">删除</ElButton><ElButton v-if="runSessionId(schedule)" link type="primary" @click="navigation.openSession(runSessionId(schedule)!)">查看执行对话</ElButton><ElButton v-if="schedule.slug" link type="primary" @click="navigation.openPage(schedule.slug)">打开关联页面</ElButton></div>
          </ElCard>
        </div>
        <section class="schedule-examples"><div class="section-heading"><h2>常用模板</h2><ElTag type="info" size="small" effect="plain">示例</ElTag></div><div class="template-grid"><ElCard v-for="template in templates" :key="template.name" shadow="never"><h3>{{ template.name }}</h3><span>{{ template.when }} · 网关时区</span><p>{{ template.prompt }}</p><ElButton link type="primary" :disabled="!connected" @click="openEditor(undefined, template)">使用模板<AgentIcon name="chevron" :size="14" /></ElButton></ElCard></div></section>
      </section>
      <aside class="notification-side" aria-label="消息通知">
        <ElCard shadow="never"><h2>把结果送到你手边</h2><p>选择已接入的通知渠道，让任务完成后自动推送结论。</p><ElAlert v-if="connectorsResource.error.value" :title="connectorsResource.error.value" type="error" :closable="false" /><div v-if="notificationTargets.length" class="notification-targets"><div v-for="connector in notificationTargets" :key="connector.id"><AgentIcon name="chat" :size="17" /><strong>{{ connector.name }}</strong><ElTag type="success" size="small" effect="plain">可推送</ElTag></div></div><p v-else class="channel-empty">{{ connectorsResource.loading.value ? "正在读取通知渠道…" : "还没有可用的消息接收方。飞书应用需填写接收方，并允许推送。" }}</p><ElButton type="primary" plain @click="navigation.openView('connectors')">管理通知渠道</ElButton><div v-if="upcomingChannels.length" class="upcoming-channels"><ElTag v-for="channel in upcomingChannels" :key="channel.type" type="info" effect="plain">{{ channel.name }} · 即将开放</ElTag></div></ElCard>
        <div class="notification-sample"><span class="sample-label">通知示例</span><div><span class="notification-mark">钱</span><div><strong>经营日报已完成</strong><p>查看本次经营分析与需要关注的事项。</p></div></div><small>示例内容，不代表实际发送结果。</small></div>
      </aside>
    </div>

    <ElDialog v-model="editorOpen" :title="editingId ? '编辑定时任务' : '新建定时任务'" width="min(720px, calc(100vw - 32px))" destroy-on-close :close-on-click-modal="!saving" @close="closeEditor">
      <ElForm :model="form" label-position="top" :disabled="saving" @submit.prevent="save">
        <ElAlert v-if="formError" :title="formError" type="error" show-icon :closable="false" class="form-feedback" />
        <ElFormItem label="任务名称" required><ElInput v-model="form.name" maxlength="30" placeholder="例如：每天的经营日报" /></ElFormItem>
        <ElFormItem label="要助手做什么" required><ElInput v-model="form.prompt" type="textarea" :autosize="{ minRows: 3, maxRows: 7 }" maxlength="2000" placeholder="描述需要检查的数据、分析内容和提醒条件" /></ElFormItem>
        <div class="form-grid">
          <ElFormItem label="执行频率" for="schedule-frequency">
            <ElSelect id="schedule-frequency" v-model="form.frequency" class="schedule-control" :disabled="saving">
              <StringSelectOption value="daily" label="每天" />
              <StringSelectOption value="weekly" label="每周" />
              <StringSelectOption value="hourly" label="每 2 小时" />
              <StringSelectOption value="custom" label="自定义执行规则" />
            </ElSelect>
          </ElFormItem>
          <ElFormItem v-if="form.frequency === 'daily' || form.frequency === 'weekly'" label="执行时间">
            <ElTimePicker v-model="form.time" class="schedule-control" format="HH:mm" value-format="HH:mm" :clearable="false" aria-label="任务执行时间" />
          </ElFormItem>
          <ElFormItem v-if="form.frequency === 'weekly'" label="每周执行日期" for="schedule-weekday">
            <ElSelect id="schedule-weekday" v-model="form.weekday" class="schedule-control" :disabled="saving">
              <StringSelectOption v-for="(day, index) in ['周日','周一','周二','周三','周四','周五','周六']" :key="index" :value="String(index)" :label="day" />
            </ElSelect>
          </ElFormItem>
        </div>
        <ElFormItem v-if="form.frequency === 'custom'" label="执行规则（5 段 cron）"><ElInput v-model="form.rawCron" maxlength="100" placeholder="分 时 日 月 周，例如：0 8 * * *" /></ElFormItem><p class="timezone-note">执行时间使用网关所在时区，请与门店的计划时间核对。</p>
        <div class="form-grid">
          <ElFormItem label="关联技能（可选）" for="schedule-skill">
            <ElSelect id="schedule-skill" v-model="form.skillId" class="schedule-control" :disabled="saving" :empty-values="[null, undefined]">
              <StringSelectOption value="" label="不关联技能" />
              <StringSelectOption v-if="form.skillId && !skills.some((skill) => skill.id === form.skillId)" :value="form.skillId" label="原技能不可用，请重新选择" disabled />
              <StringSelectOption v-for="skill in skills" :key="skill.id" :value="skill.id" :label="skill.name" />
            </ElSelect>
          </ElFormItem>
          <ElFormItem label="刷新已有页面（可选）" for="schedule-page">
            <ElSelect id="schedule-page" v-model="form.slug" class="schedule-control" :disabled="saving" :empty-values="[null, undefined]">
              <StringSelectOption value="" label="生成新结果" />
              <StringSelectOption v-if="form.slug && !pages.some((page) => page.slug === form.slug)" :value="form.slug" label="原页面不可用，请重新选择" disabled />
              <StringSelectOption v-for="page in pages" :key="page.slug" :value="page.slug" :label="page.title" />
            </ElSelect>
          </ElFormItem>
        </div>
        <ElFormItem label="结果推送到" for="schedule-notification">
          <ElSelect id="schedule-notification" v-model="form.connectorId" class="schedule-control" :disabled="saving" :empty-values="[null, undefined]">
            <StringSelectOption value="" label="仅留在工作台，不推送消息" />
            <StringSelectOption v-if="form.connectorId && !notificationTargets.some((connector) => connector.id === form.connectorId)" :value="form.connectorId" label="原接收方不可用，请重新选择" disabled />
            <StringSelectOption v-for="connector in notificationTargets" :key="connector.id" :value="connector.id" :label="connector.name" />
          </ElSelect>
        </ElFormItem>
        <ElAlert v-if="form.connectorId" title="设置推送接收方，即表示允许此任务在每次执行完成后自动发送结论；数据修改默认需确认，并遵守工作空间已有的授权设置。" type="info" show-icon :closable="false" class="form-feedback" />
        <ElAlert v-if="skillsResource.error.value || connectorsResource.error.value" :title="skillsResource.error.value || connectorsResource.error.value" type="warning" show-icon :closable="false" class="form-feedback" />
        <ElFormItem label="定时执行"><ElSwitch v-model="form.enabled" active-text="启用" inactive-text="暂停" /></ElFormItem>
      </ElForm>
      <template #footer><ElButton :disabled="saving" @click="editorOpen = false">取消</ElButton><ElButton type="primary" :loading="saving" :disabled="!connected" @click="save">保存任务</ElButton></template>
    </ElDialog>
  </div>
</template>

<style scoped>
.schedules-layout { display:grid; grid-template-columns:minmax(0,1fr) 280px; align-items:start; gap:24px; }
.schedule-main,.notification-side { min-width:0; }
.section-heading { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:14px; }
.section-heading h2 { display:flex; align-items:center; flex-wrap:wrap; gap:9px; margin:0; font-size:17px; }
.timezone-note { color:var(--qdd-muted); font-size:12px; line-height:1.8; margin:0 0 18px; }
.schedule-list { display:grid; gap:16px; }
.schedule-job :deep(.el-card__body) { padding:22px; }
.job-heading { display:flex; align-items:flex-start; justify-content:space-between; flex-wrap:wrap; gap:14px; }
.job-heading > div { min-width:0; flex:1; }
.job-heading h3 { font-size:17px; margin:0 0 9px; overflow-wrap:anywhere; }
.job-tags { display:flex; flex-wrap:wrap; gap:7px; }
.job-prompt { color:var(--qdd-muted); font-size:13px; line-height:1.8; margin:18px 0 13px; overflow-wrap:anywhere; }
.job-timing { display:flex; align-items:center; flex-wrap:wrap; gap:10px 20px; color:var(--qdd-muted); font-size:12px; }
.job-timing > span:first-child { display:inline-flex; align-items:center; gap:5px; }
.job-channel { color:var(--qdd-muted); font-size:12px; margin:10px 0; }
.last-run { margin-top:16px; padding:14px; border-radius:8px; background:var(--qdd-bg); }
.last-run > div { display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
.last-run time { font-size:11px; color:var(--qdd-muted); }
.last-run p { font-size:12px; line-height:1.8; margin:9px 0 0; overflow-wrap:anywhere; }
.last-run .notification-error { color:var(--qdd-bad); }
.no-run { color:var(--qdd-muted); font-size:12px; margin:16px 0; }
.job-actions { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-top:18px; padding-top:17px; border-top:1px solid var(--qdd-border); }
.job-actions :deep(.el-button + .el-button) { margin-left:0; }
.schedule-examples { margin-top:30px; }
.template-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }
.template-grid h3 { font-size:14px; margin:0 0 7px; }
.template-grid span { color:var(--qdd-muted); font-size:11px; }
.template-grid p { color:var(--qdd-muted); font-size:12px; line-height:1.8; margin:12px 0; }
.notification-side h2 { font-size:16px; margin:0 0 12px; }
.notification-side p { color:var(--qdd-muted); font-size:12px; line-height:1.8; margin:0 0 18px; }
.notification-targets { display:grid; gap:12px; margin:20px 0; }
.notification-targets > div { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.notification-targets strong { font-size:12px; overflow-wrap:anywhere; }
.notification-targets :deep(.el-tag) { margin-left:auto; }
.upcoming-channels { display:flex; flex-wrap:wrap; gap:8px; margin-top:20px; }
.notification-sample { padding:22px; margin-top:18px; border:1px dashed var(--qdd-border); border-radius:var(--qdd-radius); background:var(--qdd-surface); }
.sample-label { font-size:11px; color:var(--qdd-muted); }
.notification-sample > div { display:flex; gap:10px; padding:17px 0; }
.notification-mark { display:grid; place-items:center; width:30px; height:30px; flex-shrink:0; border-radius:7px; color:var(--qdd-on-primary); background:var(--qdd-primary); font-size:15px; }
.notification-sample strong { font-size:12px; }
.notification-sample p { margin:6px 0 0; }
.notification-sample small { color:var(--qdd-muted); font-size:10px; }
.schedule-control, .form-grid :deep(.schedule-control.el-date-editor) { width:100%; }
.form-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
.form-feedback { margin-bottom:20px; }
@media(max-width:1024px) { .schedules-layout { grid-template-columns:minmax(0,1fr); } .notification-side { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; } .notification-sample { margin-top:0; } }
@media(max-width:760px) { .notification-side,.template-grid,.form-grid { grid-template-columns:minmax(0,1fr); } .schedule-job :deep(.el-card__body) { padding:19px; } .form-grid { gap:0; } }
</style>

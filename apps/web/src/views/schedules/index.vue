<script setup lang="ts">
import { reactive, ref } from "vue";
import { ElAlert, ElButton, ElCard, ElDialog, ElEmpty, ElForm, ElFormItem, ElInput, ElSwitch, ElTag } from "element-plus";
import AgentIcon from "@/components/AgentIcon.vue";

// TODO: Load persisted scheduled jobs from the scheduling API; the current job list is empty.
// TODO: Replace the preview templates with schedule-template catalog data when available.
const templates = [
  { name: "经营日报", when: "每天 08:00", prompt: "汇总昨日销售与各品类表现，比较近期变化，整理今日经营关注事项。", frequency: "daily", time: "08:00", channel: "feishu", icon: "shop" },
  { name: "经营周报", when: "每周一 09:00", prompt: "分析最近一周的销售、库存和经营变化，整理本周总结与下一周的关注事项。", frequency: "weekly", time: "09:00", channel: "workspace", icon: "plan" },
  { name: "库存巡检", when: "每 2 小时", prompt: "检查当前库存，列出低于安全库存或存在异常变化的商品，并说明需要补充核实的数据。", frequency: "hourly", time: "08:00", channel: "workspace", icon: "search" },
  { name: "临期预警", when: "每天 07:30", prompt: "查询未来 3 天内到期的商品，结合剩余库存整理优先处理建议，涉及改价先请求确认。", frequency: "daily", time: "07:30", channel: "feishu", icon: "clock" },
];
const channels = [
  { value: "workspace", label: "工作台" },
  { value: "feishu", label: "飞书" },
  { value: "wechat", label: "微信" },
  { value: "wxwork", label: "企业微信" },
];
const frequencies = [
  { label: "每天", value: "daily" },
  { label: "每周一", value: "weekly" },
  { label: "每 2 小时", value: "hourly" },
];
const editorOpen = ref(false);
const scheduleForm = reactive({ name: "", prompt: "", frequency: "daily", time: "08:00", channel: "workspace" });
const previewChannel = ref("feishu");

function createSchedule(template?: (typeof templates)[number]) {
  Object.assign(scheduleForm, template
    ? { name: template.name, prompt: template.prompt, frequency: template.frequency, time: template.time, channel: template.channel }
    : { name: "", prompt: "", frequency: "daily", time: "08:00", channel: "workspace" });
  editorOpen.value = true;
}
function saveSchedule() {
  // TODO: Create and persist scheduled jobs through the scheduling API when available.
}
function bindChannel() {
  // TODO: Bind message channels through notification authorization APIs when available.
}
</script>

<template>
  <div class="feature-page schedules-page">
    <header class="feature-header"><div><span class="feature-eyebrow">定时任务</span><h1>到点自动做，做完推给你</h1><p>为经营日报、库存巡检和门店提醒，准备固定的执行时间。</p></div><ElButton type="primary" @click="createSchedule()"><AgentIcon name="plus" :size="16" />新建定时任务</ElButton></header>
    <div class="schedules-layout">
      <section class="schedule-main" aria-label="定时任务">
        <ElCard class="schedule-empty" shadow="never"><ElEmpty :image-size="68" description="还没有定时任务"><p>定时执行即将开放，先从下面的模板看看可以安排什么。</p><ElButton @click="createSchedule()">预览新建任务</ElButton></ElEmpty></ElCard>
        <div class="template-heading"><h2>常用任务模板</h2><ElTag type="info" effect="plain" size="small">仅供预览</ElTag></div>
        <div class="schedule-templates">
          <ElCard v-for="template in templates" :key="template.name" class="schedule-template" shadow="never">
            <div class="schedule-template-top"><span class="template-icon"><AgentIcon :name="template.icon" :size="19" /></span><div><h3>{{ template.name }}<ElTag type="info" size="small" effect="plain">模板</ElTag></h3><p>{{ template.when }} · {{ channels.find((channel) => channel.value === template.channel)?.label }}</p></div><ElSwitch :model-value="false" disabled :aria-label="`${template.name}模板尚未启用`" /></div>
            <p class="template-description">{{ template.prompt }}</p><ElButton link type="primary" @click="createSchedule(template)">使用模板<AgentIcon name="chevron" :size="14" /></ElButton>
          </ElCard>
        </div>
      </section>

      <aside class="notification-side" aria-label="消息通知设置预览">
        <ElCard class="notification-card" shadow="never">
          <div class="notification-heading">
            <span class="template-icon"><AgentIcon name="chat" :size="19" /></span>
            <div><h2>把结果送到你手边</h2><p>消息通知</p></div>
          </div>
          <ElForm label-position="top" class="channel-form" @submit.prevent>
            <ElFormItem label="预览通知渠道" for="notification-preview-channel">
              <select id="notification-preview-channel" v-model="previewChannel" class="schedule-select">
                <option v-for="channel in channels" :key="channel.value" :value="channel.value">{{ channel.label }}</option>
              </select>
            </ElFormItem>
          </ElForm>
          <div class="channel-status">
            <ElTag type="info" size="small" effect="plain">绑定即将开放</ElTag>
            <ElButton link type="primary" disabled @click="bindChannel">绑定渠道</ElButton>
          </div>
        </ElCard>
        <div class="notification-preview" aria-label="通知样式示例"><div class="phone-camera" /><span class="preview-label">通知示例</span><div class="preview-clock">08:00</div><div class="sample-notification"><span class="notification-app-mark">钱</span><div><small>{{ channels.find((channel) => channel.value === previewChannel)?.label }} · 钱多多助手</small><strong>经营日报已准备好</strong><p>查看本次经营分析与需要关注的事项。</p></div></div><div class="preview-footnote"><AgentIcon name="clock" :size="14" />预览内容，不会实际发送消息</div></div>
      </aside>
    </div>

    <ElDialog v-model="editorOpen" title="新建定时任务 · 预览" width="min(640px, calc(100vw - 32px))" destroy-on-close>
      <div class="schedule-editor-content">
        <ElAlert title="定时执行即将开放，当前内容仅用于配置预览。" type="info" show-icon :closable="false" />
        <ElForm :model="scheduleForm" label-position="top" class="schedule-form" @submit.prevent>
          <ElFormItem label="任务名称">
            <ElInput v-model="scheduleForm.name" maxlength="60" placeholder="例如：每天的经营日报" />
          </ElFormItem>
          <ElFormItem label="要助手做什么">
            <ElInput v-model="scheduleForm.prompt" type="textarea" :autosize="{ minRows: 4, maxRows: 8 }" placeholder="描述需要检查的数据、分析内容和提醒条件" />
          </ElFormItem>
          <div class="schedule-time-fields">
            <ElFormItem label="重复频率" for="schedule-frequency">
              <select id="schedule-frequency" v-model="scheduleForm.frequency" class="schedule-select">
                <option v-for="frequency in frequencies" :key="frequency.value" :value="frequency.value">{{ frequency.label }}</option>
              </select>
            </ElFormItem>
            <ElFormItem :label="scheduleForm.frequency === 'hourly' ? '开始时间' : '执行时间'">
              <ElInput v-model="scheduleForm.time" type="time" aria-label="任务执行时间" />
            </ElFormItem>
          </div>
          <p class="timezone-note">时间按北京时间（Asia/Shanghai）显示。</p>
          <ElFormItem label="结果发送到" for="schedule-channel">
            <select id="schedule-channel" v-model="scheduleForm.channel" class="schedule-select">
              <option v-for="channel in channels" :key="channel.value" :value="channel.value">{{ channel.label }}</option>
            </select>
          </ElFormItem>
        </ElForm>
      </div>
      <template #footer><ElButton @click="editorOpen = false">关闭预览</ElButton><ElButton type="primary" disabled @click="saveSchedule">创建任务 · 即将开放</ElButton></template>
    </ElDialog>
  </div>
</template>

<style scoped>
.feature-header > :deep(.el-button > span) { display: inline-flex; align-items: center; gap: 7px; }
.schedules-layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 26px; align-items: start; }
.schedule-empty { border-radius: var(--qdd-radius); }
.schedule-empty :deep(.el-empty) { padding: 14px 0; }
.schedule-empty :deep(.el-empty__bottom) { margin-top: 12px; }
.schedule-empty p { color: var(--qdd-muted); font-size: 12px; line-height: 1.8; margin: 0 0 17px; }
.template-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 29px 0 15px; }
.template-heading h2 { font-size: 16px; font-weight: 600; margin: 0; }
.schedule-templates { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 15px; }
.schedule-template :deep(.el-card__body) { padding: 20px; }
.schedule-template-top { display: flex; align-items: center; gap: 11px; }
.template-icon { display: grid; place-items: center; width: 38px; height: 38px; flex-shrink: 0; color: var(--qdd-muted); background: var(--qdd-bg); border-radius: 9px; }
.schedule-template-top h3 { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; font-size: 14px; font-weight: 600; margin: 0 0 5px; }
.schedule-template-top p { color: var(--qdd-muted); font-size: 11px; margin: 0; }
.schedule-template-top > :deep(.el-switch) { margin-left: auto; }
.template-description { color: var(--qdd-muted); font-size: 12px; line-height: 1.8; margin: 16px 0 14px; min-height: 65px; }
.schedule-template :deep(.el-button > span) { display: inline-flex; align-items: center; gap: 3px; font-size: 12px; }
.notification-heading { display: flex; align-items: center; gap: 11px; }
.notification-heading h2 { font-size: 14px; margin: 0 0 5px; font-weight: 600; }
.notification-heading p { font-size: 12px; color: var(--qdd-muted); margin: 0; }
.channel-form { margin-top: 23px; }
.schedule-select { width: 100%; height: 34px; border: 1px solid var(--qdd-border); border-radius: var(--el-border-radius-base); background: var(--qdd-surface); color: var(--qdd-text); padding: 0 11px; font: inherit; }
.schedule-select:focus-visible { outline: 2px solid var(--qdd-primary); outline-offset: 2px; }
.channel-status { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.notification-preview { position: relative; overflow: hidden; min-height: 330px; margin: 23px 17px 0; padding: 45px 16px 24px; border: 6px solid var(--qdd-text); border-radius: 30px; background: var(--qdd-bg); text-align: center; }
.phone-camera { position: absolute; top: 10px; left: 50%; width: 44px; height: 8px; border-radius: 9px; background: var(--qdd-text); transform: translateX(-50%); }
.preview-label { color: var(--qdd-muted); font-size: 11px; }
.preview-clock { font-size: 42px; font-weight: 300; line-height: 1.4; margin: 2px 0 22px; font-variant-numeric: tabular-nums; }
.sample-notification { display: flex; align-items: flex-start; gap: 9px; padding: 13px 10px; border: 1px solid var(--qdd-border); border-radius: 12px; background: var(--qdd-surface); text-align: left; }
.notification-app-mark { display: grid; place-items: center; width: 25px; height: 25px; border-radius: 6px; flex-shrink: 0; font-size: 13px; color: var(--qdd-on-primary); background: var(--qdd-primary); }
.sample-notification small { color: var(--qdd-muted); font-size: 10px; }
.sample-notification strong { display: block; font-size: 12px; margin-top: 5px; }
.sample-notification p { font-size: 11px; line-height: 1.7; margin: 6px 0 0; color: var(--qdd-muted); }
.preview-footnote { display: flex; justify-content: center; align-items: center; gap: 5px; font-size: 10px; color: var(--qdd-muted); margin-top: 23px; }
.schedule-form { margin-top: 24px; }
.schedule-time-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.timezone-note { margin: -5px 0 20px; font-size: 12px; color: var(--qdd-muted); }
@media (max-width: 1120px) { .schedules-layout { grid-template-columns: minmax(0, 1fr) 270px; gap: 18px; } .schedule-templates { grid-template-columns: minmax(0, 1fr); } .template-description { min-height: 0; } .notification-preview { margin-left: 6px; margin-right: 6px; } }
@media (max-width: 760px) { .schedules-layout { grid-template-columns: minmax(0, 1fr); } .notification-side { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; } .notification-preview { margin: 0 auto; width: min(100%, 280px); } .schedule-time-fields { grid-template-columns: minmax(0, 1fr); gap: 0; } }
</style>

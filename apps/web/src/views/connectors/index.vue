<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { ElAlert, ElButton, ElCard, ElDialog, ElEmpty, ElForm, ElFormItem, ElInput, ElRadioButton, ElRadioGroup, ElSkeleton, ElSwitch, ElTag } from "element-plus";
import type { ToolInfo } from "@qdd/shared";
import AgentIcon from "@/components/AgentIcon.vue";
import { listTools } from "@/api/catalog";
import { useWorkspaceContext } from "@/composables/workspaceContext";

const { workspace, navigation } = useWorkspaceContext();
const { connected, gatewayUrl, token } = workspace;
// TODO: Replace this planned catalog with connector catalog and installation-status APIs when available.
const connectors = [
  { id: "pos", mark: "收", name: "收银系统", description: "看懂销售和订单，让每天的经营有据可依。", tags: ["销售", "订单"], method: "账号授权", detail: "接入门店收银系统后，助手可以按你的授权范围查看销售与订单数据。" },
  { id: "erp", mark: "进", name: "进销存 ERP", description: "把库存、采购和商品信息放到一起分析。", tags: ["库存", "采购"], method: "账号授权", detail: "接入进销存系统后，可查询商品库存、采购和库存变化。数据修改遵守授权设置。" },
  { id: "message", mark: "通", name: "消息通知", description: "经营结果和待办提醒，送到你常用的消息里。", tags: ["飞书", "微信", "企业微信"], method: "绑定通知渠道", detail: "选择通知渠道，让日报、异常提醒和待确认事项及时送达。" },
  { id: "camera", mark: "摄", name: "门店摄像头", description: "观察门店客流与货架，补充现场信息。", tags: ["客流统计", "货架识别"], method: "扫码绑定", detail: "通过设备绑定连接门店摄像头，在授权范围内辅助观察客流与货架。" },
  { id: "phone", mark: "机", name: "门店手机 · 助手操控", description: "把门店的内容发布和评价回复交给助手协助。", tags: ["小红书", "抖音", "大众点评"], method: "扫码绑定", detail: "绑定门店专用手机后，可规划社交内容发布与门店评价处理。" },
  { id: "delivery", mark: "外", name: "外卖平台", description: "汇总外卖订单与评价，发现需要关注的变化。", tags: ["外卖订单", "评价"], method: "平台授权", detail: "连接外卖平台后，助手可以结合订单和评价分析门店服务表现。" },
];
const selectedConnector = ref<(typeof connectors)[number]>();
const dialogOpen = ref(false);
const connectionPreview = reactive({ account: "", password: "", readOnly: true, deviceName: "", channel: "飞书" });
const tools = ref<ToolInfo[]>([]);
const toolsLoading = ref(false);
const toolsError = ref("");
let toolsController: AbortController | undefined;
const sources = computed(() => {
  const grouped = new Map<string, ToolInfo[]>();
  for (const tool of tools.value) grouped.set(tool.source, [...(grouped.get(tool.source) ?? []), tool]);
  return [...grouped].map(([name, entries]) => ({ name, tools: entries }));
});

function toolTitle(tool: ToolInfo): string {
  return tool.description.split(/[：:。\r\n]/)[0]?.trim() || "数据工具";
}

function previewConnector(connector: (typeof connectors)[number]) {
  selectedConnector.value = connector;
  Object.assign(connectionPreview, { account: "", password: "", readOnly: true, deviceName: "", channel: "飞书" });
  dialogOpen.value = true;
}
function connectConnector() {
  // TODO: Connect installation, account/OAuth authorization and device-binding APIs when available.
}
async function refreshTools() {
  toolsController?.abort();
  if (!connected.value) {
    tools.value = [];
    toolsLoading.value = false;
    toolsError.value = "";
    return;
  }
  const controller = new AbortController();
  toolsController = controller;
  toolsLoading.value = true;
  toolsError.value = "";
  try {
    const result = await listTools(gatewayUrl.value, token.value, controller.signal);
    if (!controller.signal.aborted) tools.value = result;
  } catch (cause) {
    if (!controller.signal.aborted) {
      tools.value = [];
      toolsError.value = cause instanceof TypeError ? "暂时无法读取工具，请检查网关连接。" : cause instanceof Error ? cause.message : "工具列表读取失败，请稍后重试。";
    }
  } finally {
    if (toolsController === controller) toolsLoading.value = false;
  }
}
watch([connected, gatewayUrl, token], () => { void refreshTools(); }, { immediate: true });
onBeforeUnmount(() => { toolsController?.abort(); });
</script>

<template>
  <div class="feature-page connectors-page">
    <header class="feature-header">
      <div><span class="feature-eyebrow">连接器</span><h1>把门店里的系统和设备接给助手</h1><p>销售、库存、现场与消息，在一个工作台里协同。</p></div>
      <ElTag type="info" effect="plain" round>接入功能即将开放</ElTag>
    </header>

    <section class="connector-grid" aria-label="系统与设备连接器">
      <ElCard v-for="connector in connectors" :key="connector.id" class="connector-card" shadow="never">
        <div class="connector-heading"><span class="connector-mark" aria-hidden="true">{{ connector.mark }}</span><ElTag type="info" size="small" effect="plain">即将开放</ElTag></div>
        <h2>{{ connector.name }}</h2><p>{{ connector.description }}</p>
        <div class="connector-tags"><ElTag v-for="tag in connector.tags" :key="tag" type="info" effect="plain" size="small" round>{{ tag }}</ElTag></div>
        <div class="connector-footer"><ElButton disabled>即将开放</ElButton><ElButton link type="primary" @click="previewConnector(connector)">接入说明<AgentIcon name="chevron" :size="14" /></ElButton></div>
      </ElCard>
    </section>

    <section class="loaded-tools" aria-labelledby="loaded-tools-title">
      <div class="section-heading"><div><h2 id="loaded-tools-title">工作空间可用工具</h2><p>查看当前工作空间实际加载的数据来源与工具。</p></div><ElButton :disabled="!connected || toolsLoading" :loading="toolsLoading" @click="refreshTools"><AgentIcon name="refresh" :size="15" />刷新</ElButton></div>
      <ElAlert v-if="toolsError" :title="toolsError" type="error" show-icon :closable="false" />
      <ElCard v-if="!connected" shadow="never" class="tool-empty"><ElEmpty description="连接工作空间后，查看可用的数据工具" :image-size="70"><ElButton type="primary" @click="navigation.openView('settings')">连接工作空间</ElButton></ElEmpty></ElCard>
      <ElSkeleton v-else-if="toolsLoading" :rows="4" animated />
      <ElCard v-else-if="!sources.length && !toolsError" shadow="never" class="tool-empty"><ElEmpty description="当前工作空间还没有可用工具" :image-size="70" /></ElCard>
      <div v-else class="tool-source-grid">
        <ElCard v-for="source in sources" :key="source.name" shadow="never" class="tool-source-card">
          <div class="source-heading"><h3>{{ source.name === 'store' ? '门店数据' : source.name }}</h3><ElTag type="success" size="small" effect="plain">{{ source.tools.length }} 个工具</ElTag></div>
          <ul><li v-for="tool in source.tools" :key="tool.name"><div><strong :title="tool.name">{{ toolTitle(tool) }}</strong><ElTag :type="tool.mutating ? 'warning' : 'info'" size="small" effect="plain">{{ tool.mutating ? '修改数据' : '只读查询' }}</ElTag></div><p>{{ tool.description }}</p></li></ul>
        </ElCard>
      </div>
    </section>

    <ElDialog v-model="dialogOpen" :title="selectedConnector ? `${selectedConnector.name} · 接入说明` : '接入说明'" width="min(560px, calc(100vw - 32px))" destroy-on-close @closed="connectionPreview.password = ''">
      <div v-if="selectedConnector" class="connector-dialog-content">
        <p class="dialog-description">{{ selectedConnector.detail }}</p>
        <ElAlert title="接入功能即将开放，下面是授权信息预览。" type="info" show-icon :closable="false" />
        <ElForm label-position="top" class="connector-preview-form" @submit.prevent>
          <template v-if="['pos', 'erp', 'delivery'].includes(selectedConnector.id)">
            <ElFormItem label="账号"><ElInput v-model="connectionPreview.account" placeholder="门店系统账号" autocomplete="off" /></ElFormItem>
            <ElFormItem label="密码"><ElInput v-model="connectionPreview.password" type="password" show-password placeholder="门店系统密码" autocomplete="off" /></ElFormItem>
            <ElFormItem label="授权范围"><ElSwitch v-model="connectionPreview.readOnly" active-text="只允许查看数据" inactive-text="允许申请修改" /></ElFormItem>
          </template>
          <ElFormItem v-else-if="selectedConnector.id === 'message'" label="通知渠道"><ElRadioGroup v-model="connectionPreview.channel"><ElRadioButton value="飞书">飞书</ElRadioButton><ElRadioButton value="微信">微信</ElRadioButton><ElRadioButton value="企业微信">企业微信</ElRadioButton></ElRadioGroup></ElFormItem>
          <template v-else><ElFormItem label="设备名称"><ElInput v-model="connectionPreview.deviceName" placeholder="例如：一楼门店设备" /></ElFormItem><div class="device-binding-preview"><AgentIcon name="panel" :size="36" /><strong>扫码绑定即将开放</strong><span>开放后，可在这里获取设备绑定二维码。</span></div></template>
        </ElForm>
      </div>
      <template #footer><ElButton @click="dialogOpen = false">关闭</ElButton><ElButton type="primary" disabled @click="connectConnector">{{ selectedConnector?.method }} · 即将开放</ElButton></template>
    </ElDialog>
  </div>
</template>

<style scoped>
.connector-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
.connector-card { border-radius: var(--qdd-radius); }
.connector-card :deep(.el-card__body) { display: flex; flex-direction: column; min-height: 264px; padding: 23px; }
.connector-heading, .connector-footer, .source-heading, .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.connector-mark { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 10px; background: var(--qdd-bg); color: var(--qdd-muted); font-size: 21px; font-weight: 600; }
.connector-card h2 { font-size: 17px; font-weight: 600; margin: 17px 0 7px; line-height: 1.5; }
.connector-card p { margin: 0; color: var(--qdd-muted); font-size: 12px; line-height: 1.8; min-height: 44px; }
.connector-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 14px 0 20px; }
.connector-footer { margin-top: auto; }
.connector-footer :deep(.el-button.is-link) { gap: 3px; font-size: 12px; }
.loaded-tools { margin-top: 34px; }
.section-heading { margin-bottom: 17px; }
.section-heading h2 { font-size: 17px; font-weight: 600; margin: 0 0 6px; }
.section-heading p { margin: 0; color: var(--qdd-muted); font-size: 12px; }
.section-heading > :deep(.el-button > span) { display: flex; gap: 6px; }
.tool-source-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.source-heading h3 { font-size: 14px; margin: 0; overflow-wrap: anywhere; }
.tool-source-card ul { list-style: none; padding: 0; margin: 16px 0 0; }
.tool-source-card li { padding: 12px 0; border-top: 1px solid var(--qdd-border); }
.tool-source-card li > div { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.tool-source-card strong { font-size: 12px; font-weight: 500; overflow-wrap: anywhere; }
.tool-source-card p { color: var(--qdd-muted); font-size: 12px; line-height: 1.8; margin: 6px 0 0; overflow-wrap: anywhere; }
.tool-empty :deep(.el-empty) { padding: 24px 0; }
.dialog-description { margin: 0 0 18px; color: var(--qdd-muted); line-height: 1.8; }
.connector-preview-form { margin-top: 24px; }
.device-binding-preview { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 25px 14px; border: 1px dashed var(--qdd-border); border-radius: var(--qdd-radius); background: var(--qdd-bg); color: var(--qdd-muted); text-align: center; }
.device-binding-preview strong { color: var(--qdd-text); font-size: 14px; }
.device-binding-preview span { font-size: 12px; }
@media (max-width: 1120px) { .connector-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 760px) { .connector-grid, .tool-source-grid { grid-template-columns: minmax(0, 1fr); } .connector-card :deep(.el-card__body) { min-height: 0; padding: 21px; } .loaded-tools { margin-top: 26px; } .section-heading { align-items: flex-start; } }
</style>

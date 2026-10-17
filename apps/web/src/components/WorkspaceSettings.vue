<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import {
  ElAlert, ElButton, ElCard, ElDivider, ElForm, ElFormItem, ElInput,
  ElRadioButton, ElRadioGroup, ElSkeleton, ElSwitch, ElTag,
} from "element-plus";
import type { FormInstance, FormRules } from "element-plus";
import AgentIcon from "@/components/AgentIcon.vue";
import { DEFAULT_GATEWAY_URL, normalizeGatewayUrl } from "@/api/workspace";

const props = defineProps<{
  connected: boolean;
  connecting: boolean;
  connectionError: string;
  connect: () => Promise<void>;
  styleLoading: boolean;
  styleSaving: boolean;
  styleNotice: string;
}>();
const gatewayUrl = defineModel<string>("gatewayUrl", { required: true });
const token = defineModel<string>("token", { required: true });
const theme = defineModel<"light" | "dark">("theme", { required: true });
const enterToSend = defineModel<boolean>("enterToSend", { required: true });
const styleText = defineModel<string>("styleText", { required: true });
const emit = defineEmits<{ saveStyle: []; resetStyle: [] }>();

const connectionForm = ref<FormInstance>();
const connectionDraft = reactive({ gatewayUrl: gatewayUrl.value, token: token.value });
const submitting = ref(false);
const connectionBusy = computed(() => submitting.value || props.connecting);
const connectionChanged = computed(() => connectionDraft.gatewayUrl.trim() !== gatewayUrl.value
  || connectionDraft.token.trim() !== token.value);
const styleDisabled = computed(() => !props.connected || props.styleLoading || props.styleSaving);
const styleNoticeType = computed(() => ["页面风格已保存", "已恢复默认页面风格"].includes(props.styleNotice)
  ? "success" : "error");
const rules: FormRules<typeof connectionDraft> = {
  gatewayUrl: [{
    trigger: "blur",
    validator: (_rule, value: string, callback) => {
      try { normalizeGatewayUrl(value); callback(); }
      catch (cause) { callback(cause instanceof Error ? cause : new Error("请输入有效的网关地址。")); }
    },
  }],
  token: [{ required: true, whitespace: true, message: "请填写网关 token。", trigger: "blur" }],
};

watch([gatewayUrl, token], ([address, accessToken]) => {
  connectionDraft.gatewayUrl = address;
  connectionDraft.token = accessToken;
  connectionForm.value?.clearValidate();
});

async function connectGateway() {
  if (connectionBusy.value || !connectionForm.value) return;
  submitting.value = true;
  try {
    const valid = await connectionForm.value.validate().catch(() => false);
    if (!valid) return;
    gatewayUrl.value = normalizeGatewayUrl(connectionDraft.gatewayUrl);
    token.value = connectionDraft.token.trim();
    await nextTick();
    await props.connect();
  } finally {
    submitting.value = false;
  }
}

function useConfiguredAddress() {
  connectionDraft.gatewayUrl = DEFAULT_GATEWAY_URL;
  connectionForm.value?.clearValidate("gatewayUrl");
}
</script>

<template>
  <div class="settings-panel">
    <section class="settings-layout" aria-labelledby="workspace-settings-title">
      <header class="settings-heading">
        <div>
          <span class="settings-eyebrow">连接与偏好</span>
          <h1 id="workspace-settings-title">工作空间设置</h1>
          <p>连接门店助手，设置适合你的工作方式。</p>
        </div>
        <ElTag :type="connected ? 'success' : 'info'" effect="plain" round>
          {{ connected ? '网关已连接' : '网关未连接' }}
        </ElTag>
      </header>

      <ElCard class="settings-section" shadow="never">
        <template #header>
          <div class="section-heading">
            <span class="section-icon"><AgentIcon name="sliders" :size="20" /></span>
            <div><h2>网关连接</h2><p>连接后恢复当前对话并同步任务页面。</p></div>
          </div>
        </template>
        <ElForm
          ref="connectionForm"
          :model="connectionDraft"
          :rules="rules"
          label-position="top"
          size="large"
          :disabled="connectionBusy"
          @submit.prevent="connectGateway"
        >
          <ElFormItem label="网关地址" prop="gatewayUrl" for="settings-gateway-url">
            <ElInput
              id="settings-gateway-url"
              v-model="connectionDraft.gatewayUrl"
              :placeholder="DEFAULT_GATEWAY_URL"
              autocomplete="url"
              spellcheck="false"
              clearable
            />
          </ElFormItem>
          <div class="configured-address">
            <span>配置地址：<code>{{ DEFAULT_GATEWAY_URL }}</code></span>
            <ElButton link type="primary" :disabled="connectionBusy" @click="useConfiguredAddress">使用配置地址</ElButton>
          </div>
          <ElFormItem label="网关 token" prop="token" for="settings-gateway-token">
            <ElInput
              id="settings-gateway-token"
              v-model="connectionDraft.token"
              type="password"
              show-password
              autocomplete="off"
              placeholder="填写网关访问 token"
            />
          </ElFormItem>
          <div class="token-help">
            <p>在项目终端运行 <code>npm run qdd -- token</code> 获取 token。</p>
            <p>仅在当前浏览器会话中保存。网关需允许当前前端来源访问。</p>
          </div>
          <ElAlert v-if="connectionError" class="settings-feedback" :title="connectionError" type="error" show-icon :closable="false" />
          <div class="connection-footer">
            <ElButton type="primary" native-type="submit" :loading="connectionBusy">
              {{ connectionBusy ? '正在连接…' : connectionChanged ? '保存并连接' : connected ? '重新连接' : '连接网关' }}
            </ElButton>
            <span v-if="connectionChanged" class="draft-hint">连接配置将在点击连接后生效</span>
            <span v-else-if="connected" class="connected-hint"><AgentIcon name="check" :size="15" />已同步工作空间</span>
          </div>
        </ElForm>
      </ElCard>

      <ElCard class="settings-section" shadow="never">
        <template #header>
          <div class="section-heading">
            <span class="section-icon"><AgentIcon name="sun" :size="20" /></span>
            <div><h2>外观与输入</h2><p>偏好自动保存到当前浏览器。</p></div>
          </div>
        </template>
        <div class="preference-row">
          <div class="preference-label"><strong id="settings-theme-label">界面主题</strong><p>选择工作空间的浅色或深色外观</p></div>
          <ElRadioGroup v-model="theme" aria-labelledby="settings-theme-label">
            <ElRadioButton value="light"><AgentIcon name="sun" :size="16" />浅色</ElRadioButton>
            <ElRadioButton value="dark"><AgentIcon name="moon" :size="16" />深色</ElRadioButton>
          </ElRadioGroup>
        </div>
        <ElDivider />
        <div class="preference-row">
          <div class="preference-label"><strong id="settings-enter-label">Enter 发送消息</strong><p id="settings-enter-help">开启后按 Enter 发送，Shift + Enter 换行</p></div>
          <ElSwitch v-model="enterToSend" aria-label="Enter 发送消息" />
        </div>
      </ElCard>

      <ElCard class="settings-section" shadow="never">
        <template #header>
          <div class="section-heading">
            <span class="section-icon"><AgentIcon name="pen" :size="20" /></span>
            <div><h2>页面统一风格</h2><p>后续生成的任务页面将遵守这份风格提示词。</p></div>
          </div>
        </template>
        <ElAlert v-if="!connected" title="连接网关后，即可读取和编辑页面风格。" type="info" show-icon :closable="false" />
        <ElSkeleton v-else-if="styleLoading" :rows="4" animated aria-label="正在读取页面风格" />
        <ElForm v-else label-position="top" :disabled="styleDisabled" @submit.prevent="!styleDisabled && styleText.trim() && emit('saveStyle')">
          <ElFormItem label="风格提示词" for="settings-page-style">
            <ElInput
              id="settings-page-style"
              v-model="styleText"
              type="textarea"
              :autosize="{ minRows: 6, maxRows: 16 }"
              placeholder="例如：使用简洁的卡片布局，突出关键经营指标，统一图表配色。"
            />
          </ElFormItem>
          <div class="style-footer">
            <div class="style-buttons">
              <ElButton type="primary" native-type="submit" :loading="styleSaving" :disabled="styleDisabled || !styleText.trim()">保存风格</ElButton>
              <ElButton :disabled="styleDisabled" @click="emit('resetStyle')">恢复默认</ElButton>
            </div>
            <span class="style-hint">保存后应用于后续生成的页面</span>
          </div>
        </ElForm>
        <ElAlert v-if="connected && styleNotice" class="settings-feedback" :title="styleNotice" :type="styleNoticeType" show-icon :closable="false" />
      </ElCard>
      <slot />
    </section>
  </div>
</template>

<style scoped lang="scss">
.settings-panel {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 40px 32px 64px;

  :deep(.el-button) {
    border: var(--el-border-width) var(--el-border-style) var(--el-button-border-color);
    color: var(--el-button-text-color);
  }

  :deep(.el-button.is-link) { border-color: transparent; }
  :deep(.el-form-item__label) { font-weight: 550; }
  :deep(.el-card__header) { padding: 22px 24px; }
  :deep(.el-card__body) { padding: 24px; }
  :deep(.el-radio-button__inner) { display: flex; align-items: center; gap: 7px; }
  :deep(.el-divider--horizontal) { margin: 22px 0; }
  :deep(.el-alert__title) { overflow-wrap: anywhere; }
}

.settings-layout { width: min(100%, 820px); margin: 0 auto; display: grid; gap: 20px; }
.settings-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 8px; }
.settings-eyebrow { color: var(--qdd-primary); font-size: 12px; font-weight: 600; letter-spacing: 1px; }
.settings-heading h1 { margin: 7px 0 8px; font-size: 28px; line-height: 1.35; font-weight: 650; letter-spacing: -.5px; }
.settings-heading p { margin: 0; color: var(--qdd-muted); }
.settings-heading :deep(.el-tag) { flex-shrink: 0; }
.settings-section { border-radius: var(--qdd-radius); }
.section-heading { display: flex; align-items: center; gap: 12px; }
.section-icon { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 10px; background: var(--qdd-primary-soft); color: var(--qdd-primary); flex-shrink: 0; }
.section-heading h2 { margin: 0 0 3px; font-size: 16px; font-weight: 600; }
.section-heading p { margin: 0; color: var(--qdd-muted); font-size: 13px; }
.configured-address { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 16px; margin: -7px 0 20px; font-size: 12px; color: var(--qdd-muted); }
.configured-address code { overflow-wrap: anywhere; }
.configured-address :deep(.el-button) { font-size: 12px; }
.token-help { margin: -5px 0 22px; color: var(--qdd-muted); font-size: 12px; }
.token-help p { margin: 3px 0; }
.token-help code { background: var(--qdd-bg); padding: 3px 6px; border: 1px solid var(--qdd-border); border-radius: 4px; font-size: 12px; }
.connection-footer, .style-footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
.draft-hint, .style-hint { color: var(--qdd-muted); font-size: 12px; }
.connected-hint { display: inline-flex; align-items: center; gap: 5px; color: var(--qdd-good); font-size: 12px; }
.preference-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.preference-label strong { font-size: 14px; font-weight: 550; }
.preference-label p { color: var(--qdd-muted); font-size: 12px; margin: 5px 0 0; }
.preference-row :deep(.el-radio-group), .preference-row :deep(.el-switch) { flex-shrink: 0; }
.style-buttons { display: flex; flex-wrap: wrap; gap: 10px; }
.style-buttons :deep(.el-button + .el-button) { margin-left: 0; }
.settings-feedback { margin: 16px 0; }
.settings-feedback:last-child { margin-bottom: 0; }

@media (max-width: 760px) {
  .settings-panel { padding: 24px 16px 40px; }
  .settings-heading { align-items: flex-start; gap: 12px; }
  .settings-heading h1 { font-size: 23px; }
  .settings-heading p { font-size: 12px; }
  .settings-heading :deep(.el-tag) { margin-top: 6px; }
  .settings-panel :deep(.el-card__header), .settings-panel :deep(.el-card__body) { padding: 18px; }
  .preference-row { gap: 14px; flex-wrap: wrap; }
}
</style>

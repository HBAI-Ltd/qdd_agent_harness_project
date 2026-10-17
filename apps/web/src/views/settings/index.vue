<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useRoute } from "vue-router";
import WorkspaceSettings from "@/components/WorkspaceSettings.vue";
import WorkspaceData from "@/components/WorkspaceData.vue";
import WorkspaceRecords from "@/components/WorkspaceRecords.vue";
import { useWorkspaceContext } from "@/composables/workspaceContext";
import * as gatewayApi from "@/api/workspace";

const { workspace } = useWorkspaceContext();
const route = useRoute();
const workspaceData = ref<InstanceType<typeof WorkspaceData>>();
const { gatewayUrl, token, preferences, connected, loadingSessions, loadingPages, error, loadWorkspace } = workspace;
const styleText = ref("");
const styleLoading = ref(false);
const styleSaving = ref(false);
const styleNotice = ref("");
let styleController: AbortController | undefined;
let styleSaveController: AbortController | undefined;
let disposed = false;

watch(() => [route.query.record, route.hash], async ([name, hash]) => {
  if (typeof name !== "string" && hash !== "#settings-records") return;
  await nextTick();
  if (disposed) return;
  const section = document.getElementById("settings-records");
  const panel = section?.closest<HTMLElement>(".settings-panel");
  if (!section || !panel) return;
  panel.scrollTo({ top: panel.scrollTop + section.getBoundingClientRect().top - panel.getBoundingClientRect().top - 24 });
}, { immediate: true });

function styleError(cause: unknown) {
  return cause instanceof TypeError ? "无法连接网关，请检查地址与跨域配置。" : cause instanceof Error ? cause.message : "风格设置请求失败。";
}
function stopStyleRequests() {
  styleController?.abort();
  styleSaveController?.abort();
  styleController = undefined;
  styleSaveController = undefined;
  styleLoading.value = false;
  styleSaving.value = false;
}
async function loadStyle() {
  styleController?.abort();
  const controller = new AbortController();
  styleController = controller;
  styleLoading.value = true;
  styleNotice.value = "";
  try {
    const text = await gatewayApi.getStyle(gatewayUrl.value, token.value, controller.signal);
    if (!controller.signal.aborted) styleText.value = text;
  } catch (cause) {
    if (!controller.signal.aborted) styleNotice.value = styleError(cause);
  } finally {
    if (styleController === controller) styleLoading.value = false;
  }
}
async function saveStyle(reset = false) {
  if (styleSaving.value || styleLoading.value || !connected.value) return;
  styleSaving.value = true;
  styleNotice.value = "";
  const controller = new AbortController();
  styleSaveController = controller;
  try {
    const text = reset
      ? await gatewayApi.resetStyle(gatewayUrl.value, token.value, controller.signal)
      : await gatewayApi.saveStyle(gatewayUrl.value, token.value, styleText.value, controller.signal);
    if (controller.signal.aborted) return;
    styleText.value = text;
    styleNotice.value = reset ? "已恢复默认页面风格" : "页面风格已保存";
  } catch (cause) {
    if (!controller.signal.aborted) styleNotice.value = styleError(cause);
  } finally {
    if (styleSaveController === controller) styleSaving.value = false;
  }
}
watch(connected, (value) => {
  if (value) void loadStyle();
  else {
    stopStyleRequests();
    styleText.value = "";
    styleNotice.value = "";
  }
}, { immediate: true });
watch([gatewayUrl, token], () => {
  stopStyleRequests();
  styleText.value = "";
  styleNotice.value = "";
});
onBeforeUnmount(() => { disposed = true; stopStyleRequests(); });
</script>

<template>
  <WorkspaceSettings
    v-model:gateway-url="gatewayUrl"
    v-model:token="token"
    v-model:theme="preferences.theme"
    v-model:enter-to-send="preferences.enterToSend"
    v-model:style-text="styleText"
    :connected="connected"
    :connecting="loadingSessions || loadingPages"
    :connection-error="error"
    :connect="loadWorkspace"
    :style-loading="styleLoading"
    :style-saving="styleSaving"
    :style-notice="styleNotice"
    @save-style="saveStyle()"
    @reset-style="saveStyle(true)">
    <WorkspaceData ref="workspaceData" :connected="connected" :gateway-url="gatewayUrl" :token="token" />
    <WorkspaceRecords :connected="connected" :gateway-url="gatewayUrl" :token="token" :initial-name="typeof route.query.record === 'string' ? route.query.record : undefined" @changed="workspaceData?.refresh()" />
  </WorkspaceSettings>
</template>

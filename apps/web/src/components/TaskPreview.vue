<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElButton, ElTag } from "element-plus";
import type { JsonValue as PageBridgePayload, PageView } from "@qdd/shared";
import AgentIcon from "@/components/AgentIcon.vue";
import { createTaskPageBridge, type TaskPageEvent } from "@/utils/taskPageBridge";

const props = defineProps<{
  page: PageView;
  gatewayUrl: string;
  context?: PageBridgePayload;
}>();

const emit = defineEmits<{ message: [message: TaskPageEvent] }>();
const frame = ref<HTMLIFrameElement>();

const documentUrl = ref("");
const renderVersion = ref(0);
const loading = ref(true);
const renderError = ref("");
let readyTimer: ReturnType<typeof setTimeout> | undefined;
const bridge = createTaskPageBridge({
  getWindow: () => frame.value?.contentWindow ?? null,
  getOrigin: () => documentUrl.value ? new URL(documentUrl.value).origin : "",
  getSlug: () => props.page.slug,
  isOpaque: () => sameOrigin.value,
  getContext: () => props.context ?? { theme: "light", locale: "zh-CN" },
  onMessage(message) {
    if (message.type === "page:ready") {
      clearTimeout(readyTimer);
      loading.value = false;
      renderError.value = "";
    }
    if (message.type === "page:error" && message.payload && typeof message.payload === "object"
      && !Array.isArray(message.payload) && typeof message.payload.message === "string") {
      renderError.value = message.payload.message.slice(0, 500);
    }
    emit("message", message);
  },
});
const sameOrigin = computed(() => {
  if (!documentUrl.value) return false;
  return new URL(documentUrl.value).origin === window.location.origin;
});
// Cross-origin pages keep their gateway origin so the injected SDK and cookie work.
// A same-origin page must stay opaque to prevent its scripts accessing the shell.
const sandbox = computed(() => sameOrigin.value
  ? "allow-scripts"
  : "allow-scripts allow-same-origin");

function reload() {
  clearTimeout(readyTimer);
  bridge.reset();
  renderVersion.value += 1;
  loading.value = true;
  renderError.value = "";
  documentUrl.value = "";
  try {
    const gateway = new URL(props.gatewayUrl, window.location.origin);
    const pageUrl = new URL(props.page.url, `${gateway.origin}/`);
    if (!/^https?:$/.test(gateway.protocol) || gateway.username || gateway.password
      || pageUrl.origin !== gateway.origin || pageUrl.username || pageUrl.password
      || !pageUrl.pathname.startsWith(`/pages/${encodeURIComponent(props.page.slug)}/`)) {
      throw new Error("Invalid page URL");
    }
    // Use the gateway URL unchanged: its page token establishes the page cookie.
    documentUrl.value = pageUrl.href;
  } catch {
    loading.value = false;
    renderError.value = "任务页面地址无效，请检查网关配置后重试。";
  }
}

function loadFailed() {
  clearTimeout(readyTimer);
  loading.value = false;
  renderError.value = "任务页面加载失败，请检查网关连接和嵌入权限。";
}

function frameLoaded() {
  clearTimeout(readyTimer);
  bridge.reset();
  loading.value = true;
  renderError.value = "";
  if (!bridge.initialize()) return loadFailed();
  readyTimer = setTimeout(() => {
    if (bridge.isReady()) return;
    loading.value = false;
    renderError.value = "任务页面未建立通信，请检查页面鉴权、SDK 和嵌入权限。";
  }, 8000);
}

function receiveMessage(event: MessageEvent<unknown>) { bridge.receive(event); }
watch(() => props.context, (context) => { bridge.postMessage("host:context", context ?? null); }, { deep: true });
onMounted(() => window.addEventListener("message", receiveMessage));
onBeforeUnmount(() => {
  window.removeEventListener("message", receiveMessage);
  clearTimeout(readyTimer);
  bridge.reset();
});
defineExpose({ postMessage: bridge.postMessage });

watch(
  () => [props.page.slug, props.page.url, props.page.version, props.gatewayUrl],
  reload,
  { immediate: true },
);
</script>

<template>
  <section class="task-preview" aria-label="任务页面预览">
    <header class="preview-toolbar">
      <div class="preview-heading">
        <AgentIcon name="code" :size="15" />
        <strong>{{ page.title }}</strong>
        <ElTag class="preview-label" type="info" effect="plain" size="small">v{{ page.version }}</ElTag>
      </div>
      <ElButton class="preview-reload" text size="small" @click="reload">
        <AgentIcon name="refresh" :size="14" />
        重新加载
      </ElButton>
    </header>
    <p v-if="page.stale" class="preview-notice" role="status">
      待复核：{{ page.stale }}
    </p>
    <p v-if="sameOrigin" class="preview-notice" role="status">
      当前网关与前端同源，页面已隔离；实时取数可能受限。请将网关配置到独立端口，并允许此前端源嵌入。
    </p>
    <p v-if="renderError" class="preview-error" role="alert">
      {{ renderError }}
    </p>
    <div class="preview-frame-container" :aria-busy="loading">
      <iframe
        v-if="documentUrl"
        ref="frame"
        :key="renderVersion"
        :src="documentUrl"
        :title="`${page.title} — 任务页面`"
        :sandbox="sandbox"
        referrerpolicy="no-referrer"
        @load="frameLoaded"
        @error="loadFailed"
      />
      <div v-if="loading" class="preview-loading" role="status">
        正在渲染任务页面…
      </div>
    </div>
  </section>
</template>

<style scoped>
.task-preview {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--qdd-surface);
}

.preview-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  gap: 16px;
  padding: 14px 24px;
  border-bottom: 1px solid var(--qdd-border);
}

.preview-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  color: var(--qdd-text);
}

.preview-heading strong {
  overflow: hidden;
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-label {
  flex-shrink: 0;
  color: var(--qdd-muted);
  font-size: 11px;
}

.preview-reload {
  flex-shrink: 0;
  padding: 6px 10px;
  border: 1px solid var(--qdd-border) !important;
  border-radius: 6px;
  background: var(--qdd-surface);
  color: var(--qdd-muted) !important;
  font-size: 11px !important;
}

.preview-reload:hover {
  background: var(--qdd-hover);
  color: var(--qdd-text) !important;
}

.preview-error,
.preview-notice {
  flex-shrink: 0;
  margin: 0;
  padding: 11px 24px;
  border-bottom: 1px solid var(--qdd-border);
  background: var(--qdd-bg);
  color: var(--qdd-text);
  font-size: 11px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.preview-frame-container {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  background: var(--qdd-bg);
}

.preview-frame-container iframe {
  display: block;
  flex: 1;
  width: 100%;
  height: 100%;
  min-height: 0;
  border: 0;
  background: var(--qdd-bg);
}

.preview-loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: var(--qdd-surface);
  color: var(--qdd-muted);
  font-size: 12px;
  pointer-events: none;
}

@media (max-width: 760px) {
  .preview-toolbar { padding: 12px 16px; }
  .preview-label { display: none; }
  .preview-error, .preview-notice { padding: 10px 16px; }
}
</style>

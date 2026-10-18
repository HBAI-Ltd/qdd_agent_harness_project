<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElButton } from "element-plus/es/components/button/index";
import { ElTag } from "element-plus/es/components/tag/index";
import type { JsonValue as PageBridgePayload, PageView } from "@qdd/shared";
import AgentIcon from "@/components/AgentIcon.vue";
import { createTaskPageBridge, type TaskPageEvent } from "@/utils/taskPageBridge";

const props = defineProps<{
  page: PageView;
  gatewayUrl: string;
  context?: PageBridgePayload;
  pinDisabled?: boolean;
  pinPending?: boolean;
}>();

const emit = defineEmits<{ message: [message: TaskPageEvent]; pin: [pinned: boolean]; schedules: []; records: [name: string] }>();
const frame = ref<HTMLIFrameElement>();

const documentUrl = ref("");
const renderVersion = ref(0);
const loading = ref(true);
const renderError = ref("");
let readyTimer: ReturnType<typeof setTimeout> | undefined;
const bridge = createTaskPageBridge({
  getWindow: () => frame.value?.contentWindow ?? null,
  getOrigin: () => (documentUrl.value ? new URL(documentUrl.value).origin : ""),
  getSlug: () => props.page.slug,
  isOpaque: () => true,
  getContext: () => props.context ?? { theme: "light", locale: "zh-CN" },
  onMessage(message) {
    if (message.type === "page:ready") {
      clearTimeout(readyTimer);
      loading.value = false;
      renderError.value = "";
    }
    if (
      message.type === "page:error" &&
      message.payload &&
      typeof message.payload === "object" &&
      !Array.isArray(message.payload) &&
      typeof message.payload.message === "string"
    ) {
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
// External pages open normally in a new tab while this frame keeps its isolation.
const sandbox = computed(() =>
  sameOrigin.value
    ? "allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox"
    : "allow-scripts allow-downloads allow-same-origin allow-popups allow-popups-to-escape-sandbox",
);

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
    if (
      !/^https?:$/.test(gateway.protocol) ||
      gateway.username ||
      gateway.password ||
      pageUrl.origin !== gateway.origin ||
      pageUrl.username ||
      pageUrl.password ||
      !pageUrl.pathname.startsWith(`/pages/${encodeURIComponent(props.page.slug)}/`)
    ) {
      throw new Error("Invalid page URL");
    }
    // The gateway redirects this entry URL to its authenticated static-resource path.
    documentUrl.value = pageUrl.href;
    // A pending navigation may never emit load/error, so bound this phase too.
    readyTimer = setTimeout(() => {
      loading.value = false;
      renderError.value = "任务页面加载超时，请检查网关连接后重新加载。";
    }, 15000);
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

function receiveMessage(event: MessageEvent<unknown>) {
  bridge.receive(event);
}
watch(
  () => props.context,
  (context) => {
    bridge.postMessage("host:context", context ?? null);
  },
  { deep: true },
);
onMounted(() => window.addEventListener("message", receiveMessage));
onBeforeUnmount(() => {
  window.removeEventListener("message", receiveMessage);
  clearTimeout(readyTimer);
  bridge.reset();
});
defineExpose({ postMessage: bridge.postMessage });

watch(() => [props.page.slug, props.page.url, props.page.version, props.gatewayUrl], reload, { immediate: true });
</script>

<template>
  <section class="task-preview" aria-label="任务页面预览">
    <header class="preview-toolbar">
      <div class="preview-heading">
        <AgentIcon name="code" :size="15" />
        <strong>{{ page.title }}</strong>
        <ElTag class="preview-label" type="info" effect="plain" size="small">v{{ page.version }}</ElTag>
        <ElTag class="preview-kind" :type="page.kind === 'scheduled' ? 'primary' : 'info'" effect="plain" size="small">
          {{ page.kind === "scheduled" ? "定时任务" : "一次性任务" }}
        </ElTag>
      </div>
      <div class="preview-actions">
        <ElButton
          class="preview-reload"
          text
          size="small"
          :loading="pinPending"
          :disabled="pinDisabled || pinPending"
          :aria-label="`${page.pinnedAt ? '取消置顶' : '置顶'}：${page.title}`"
          :aria-pressed="!!page.pinnedAt"
          @click="emit('pin', !page.pinnedAt)">
          {{ page.pinnedAt ? "取消置顶" : "置顶页面" }}
        </ElButton>
        <ElButton class="preview-reload" text size="small" @click="reload">
          <AgentIcon name="refresh" :size="14" />
          重新加载
        </ElButton>
      </div>
    </header>
    <div v-if="page.schedules.length" class="preview-schedules" aria-label="关联定时任务">
      <span>定时更新：</span>
      <ElButton
        v-for="schedule in page.schedules"
        :key="schedule.id"
        text
        size="small"
        :aria-label="`管理定时任务：${schedule.name}，${schedule.enabled ? '已启用' : '已暂停'}`"
        @click="emit('schedules')">
        {{ schedule.name }}
        <ElTag :type="schedule.enabled ? 'success' : 'info'" effect="plain" size="small">{{ schedule.enabled ? "已启用" : "已暂停" }}</ElTag>
        <AgentIcon name="chevron" :size="12" />
      </ElButton>
    </div>
    <div v-if="page.records?.length" class="preview-schedules" aria-label="页面使用的登记表">
      <span>登记记录：</span>
      <ElButton v-for="name in page.records" :key="name" text size="small" :aria-label="`管理登记记录：${name}`" @click="emit('records', name)">
        {{ name }}
        <AgentIcon name="chevron" :size="12" />
      </ElButton>
    </div>
    <p v-if="page.stale" class="preview-notice" role="status">待复核：{{ page.stale }}</p>
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
        @error="loadFailed" />
      <div v-if="loading" class="preview-loading" role="status">正在渲染任务页面…</div>
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

.preview-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.preview-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}
.preview-kind {
  flex-shrink: 0;
}
.preview-schedules {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  flex-shrink: 0;
  gap: 6px 10px;
  padding: 9px 24px;
  border-bottom: 1px solid var(--qdd-border);
  color: var(--qdd-muted);
  font-size: 11px;
}
.preview-schedules .el-button {
  height: auto;
  padding: 3px 5px;
  margin: 0;
  color: var(--qdd-text);
  white-space: normal;
  text-align: left;
}
.preview-schedules :deep(.el-button > span) {
  gap: 6px;
  flex-wrap: wrap;
  overflow-wrap: anywhere;
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
  .preview-toolbar {
    flex-wrap: wrap;
    gap: 10px;
    padding: 12px 16px;
  }
  .preview-heading {
    flex: 1 1 100%;
  }
  .preview-label {
    display: none;
  }
  .preview-schedules {
    padding: 9px 16px;
  }
  .preview-error,
  .preview-notice {
    padding: 10px 16px;
  }
}
</style>

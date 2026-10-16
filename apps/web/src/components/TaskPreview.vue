<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import AgentIcon from "@/components/AgentIcon.vue";
import { buildTaskDocument, TASK_PREVIEW_CHANNEL } from "@/utils/taskDocument";

const props = defineProps<{
  taskId: string;
  title: string;
  content: { html: string; script: string; css: string };
}>();

const frame = ref<HTMLIFrameElement>();
const documentSource = ref("");
const renderToken = ref("");
const loading = ref(true);
const renderError = ref("");

function reload() {
  renderToken.value = crypto.randomUUID();
  loading.value = true;
  renderError.value = "";
  try {
    documentSource.value = buildTaskDocument(props.content, renderToken.value);
  } catch {
    documentSource.value = "";
    loading.value = false;
    renderError.value = "任务页面生成失败，请重新加载。";
  }
}

function receiveMessage(event: MessageEvent<unknown>) {
  if (event.source !== frame.value?.contentWindow) return;
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (!("channel" in data) || data.channel !== TASK_PREVIEW_CHANNEL) return;
  if (!("token" in data) || data.token !== renderToken.value) return;
  if (!("type" in data) || data.type !== "error") return;
  if (!("message" in data) || typeof data.message !== "string") return;
  renderError.value = data.message.slice(0, 500) || "页面脚本运行失败。";
}

watch(
  () => [props.taskId, props.content.html, props.content.script, props.content.css],
  reload,
  { immediate: true },
);

onMounted(() => window.addEventListener("message", receiveMessage));
onBeforeUnmount(() => window.removeEventListener("message", receiveMessage));
</script>

<template>
  <section class="task-preview" aria-label="任务页面预览">
    <header class="preview-toolbar">
      <div class="preview-heading">
        <AgentIcon name="code" :size="15" />
        <strong>{{ title }}</strong>
        <span class="preview-label">任务页面</span>
      </div>
      <button class="preview-reload" type="button" @click="reload">
        重新加载
      </button>
    </header>
    <p v-if="renderError" class="preview-error" role="alert">
      页面脚本提示：{{ renderError }}
    </p>
    <div class="preview-frame-container" :aria-busy="loading">
      <iframe
        v-if="documentSource"
        :key="renderToken"
        ref="frame"
        :srcdoc="documentSource"
        :title="`${title} — 任务页面`"
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        @load="loading = false"
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
  background: var(--surface);
}

.preview-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  gap: 16px;
  padding: 14px 24px;
  border-bottom: 1px solid var(--line);
}

.preview-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  color: var(--text);
}

.preview-heading strong {
  overflow: hidden;
  font-size: 12px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-label {
  flex-shrink: 0;
  color: var(--faint);
  font-size: 10px;
}

.preview-reload {
  flex-shrink: 0;
  padding: 6px 10px;
  border: 1px solid var(--line) !important;
  border-radius: 6px;
  background: var(--surface);
  color: var(--muted) !important;
  font-size: 11px !important;
}

.preview-reload:hover {
  background: var(--hover);
  color: var(--text) !important;
}

.preview-error {
  flex-shrink: 0;
  margin: 0;
  padding: 11px 24px;
  border-bottom: 1px solid var(--line);
  background: var(--surface-muted);
  color: var(--text);
  font-size: 11px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.preview-frame-container {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  background: #fff;
}

.preview-frame-container iframe {
  display: block;
  flex: 1;
  width: 100%;
  height: 100%;
  min-height: 0;
  border: 0;
  background: #fff;
}

.preview-loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: var(--surface);
  color: var(--muted);
  font-size: 12px;
  pointer-events: none;
}

@media (max-width: 760px) {
  .preview-toolbar { padding: 12px 16px; }
  .preview-label { display: none; }
  .preview-error { padding: 10px 16px; }
}
</style>

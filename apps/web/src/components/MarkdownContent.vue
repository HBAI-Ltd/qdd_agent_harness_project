<script setup lang="ts">
import { computed } from "vue";
import { renderMarkdown } from "@/utils/markdown";

const props = defineProps<{ content: string }>();
const rendered = computed(() => renderMarkdown(props.content));
</script>

<template>
  <div class="markdown-content" v-html="rendered"></div>
</template>

<style scoped>
.markdown-content {
  min-width: 0;
  line-height: 1.8;
  overflow-wrap: anywhere;
  white-space: normal;
}
.markdown-content :deep(> :first-child) { margin-top: 0; }
.markdown-content :deep(> :last-child) { margin-bottom: 0; }
.markdown-content :deep(p) { margin: 0 0 12px; white-space: normal; }
.markdown-content :deep(h1),
.markdown-content :deep(h2),
.markdown-content :deep(h3),
.markdown-content :deep(h4),
.markdown-content :deep(h5),
.markdown-content :deep(h6) {
  margin: 24px 0 10px;
  font-weight: 650;
  line-height: 1.5;
}
.markdown-content :deep(h1) { font-size: 1.5em; }
.markdown-content :deep(h2) { font-size: 1.3em; }
.markdown-content :deep(h3) { font-size: 1.15em; }
.markdown-content :deep(h4),
.markdown-content :deep(h5),
.markdown-content :deep(h6) { font-size: 1em; }
.markdown-content :deep(ul),
.markdown-content :deep(ol) { margin: 10px 0 14px; padding-left: 24px; }
.markdown-content :deep(li) { margin: 4px 0; }
.markdown-content :deep(li > p) { margin-bottom: 6px; }
.markdown-content :deep(li > ul),
.markdown-content :deep(li > ol) { margin: 4px 0; }
.markdown-content :deep(.task-list-item) { list-style: none; }
.markdown-content :deep(input[type="checkbox"]) {
  width: 13px;
  height: 13px;
  margin: 0 6px 0 -20px;
  accent-color: var(--qdd-primary);
  vertical-align: -1px;
}
.markdown-content :deep(blockquote) {
  margin: 14px 0;
  padding: 2px 0 2px 14px;
  border-left: 3px solid var(--qdd-border);
  color: var(--qdd-muted);
}
.markdown-content :deep(blockquote > :last-child) { margin-bottom: 0; }
.markdown-content :deep(a) {
  color: var(--qdd-primary);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.markdown-content :deep(code) {
  padding: 2px 5px;
  border: 1px solid var(--qdd-border);
  border-radius: 4px;
  background: var(--qdd-bg);
  font: .88em/1.6 Consolas, "SFMono-Regular", monospace;
}
.markdown-content :deep(pre) {
  max-width: 100%;
  margin: 14px 0;
  padding: 14px 16px;
  overflow-x: auto;
  border: 1px solid var(--qdd-border);
  border-radius: 8px;
  background: var(--qdd-bg);
  line-height: 1.65;
  white-space: pre;
  overflow-wrap: normal;
  tab-size: 2;
}
.markdown-content :deep(pre code) {
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  white-space: pre;
}
.markdown-content :deep(.markdown-table-scroll) { margin: 14px 0; overflow-x: auto; }
.markdown-content :deep(table) { width: 100%; border-collapse: collapse; font-size: .95em; }
.markdown-content :deep(th),
.markdown-content :deep(td) { min-width: 88px; padding: 8px 12px; border: 1px solid var(--qdd-border); }
.markdown-content :deep(th) { background: var(--qdd-bg); font-weight: 600; }
.markdown-content :deep(hr) { margin: 22px 0; border: 0; border-top: 1px solid var(--qdd-border); }
.markdown-content :deep(img) { display: block; max-width: 100%; height: auto; margin: 12px 0; border-radius: 6px; }
</style>

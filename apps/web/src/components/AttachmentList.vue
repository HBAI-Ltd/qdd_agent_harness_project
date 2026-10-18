<script setup lang="ts">
import { computed } from "vue";
import AgentIcon from "@/components/AgentIcon.vue";
import ChatMedia from "@/components/ChatMedia.vue";
import { mediaKind } from "@/utils/media";
import { formatSize } from "@/composables/useComposer";

export interface AttachmentItem {
  key: string;
  path: string;
  size: number;
  status?: "uploading" | "done" | "error";
  error?: string;
  /** 已上传的附件 id，可下载 */
  id?: string;
  mime?: string;
}

const props = defineProps<{ items: AttachmentItem[]; removable?: boolean; gatewayUrl?: string; token?: string }>();
const emit = defineEmits<{ remove: [key: string]; removeFolder: [folder: string]; open: [item: AttachmentItem] }>();
const media = computed(() => props.items.flatMap((item) => {
  const kind = mediaKind(item.path, item.mime);
  return kind && item.id && item.status !== "uploading" && item.status !== "error" ? [{ item, kind }] : [];
}));

type Group =
  | { kind: "file"; key: string; item: AttachmentItem }
  | { kind: "folder"; key: string; name: string; count: number; size: number; uploading: number; failed: number };

/** 文件夹上传按顶层目录合并成一张卡片 */
const groups = computed<Group[]>(() => {
  const out: Group[] = [];
  const folders = new Map<string, Extract<Group, { kind: "folder" }>>();
  for (const item of props.items) {
    const slash = item.path.indexOf("/");
    if (slash === -1) {
      out.push({ kind: "file", key: item.key, item });
      continue;
    }
    const name = item.path.slice(0, slash);
    let folder = folders.get(name);
    if (!folder) {
      folder = { kind: "folder", key: `folder:${name}`, name, count: 0, size: 0, uploading: 0, failed: 0 };
      folders.set(name, folder);
      out.push(folder);
    }
    folder.count++;
    folder.size += item.size;
    if (item.status === "uploading") folder.uploading++;
    if (item.status === "error") folder.failed++;
  }
  return out;
});

function fileTitle(item: AttachmentItem): string {
  return item.error ? `${item.path}：${item.error}` : item.path;
}
</script>

<template>
  <div v-if="items.length" class="attachments">
    <ul class="attachment-list">
      <li v-for="group in groups" :key="group.key" class="attachment-chip" :data-status="group.kind === 'file' ? group.item.status : group.failed ? 'error' : group.uploading ? 'uploading' : 'done'">
        <template v-if="group.kind === 'file'">
          <button type="button" class="attachment-main" :title="fileTitle(group.item)" :disabled="!group.item.id" @click="emit('open', group.item)">
            <AgentIcon name="file" :size="16" />
            <span class="attachment-name">{{ group.item.path }}</span>
            <span class="attachment-meta">{{ group.item.status === "uploading" ? "上传中…" : group.item.status === "error" ? (group.item.error || "失败") : formatSize(group.item.size) }}</span>
          </button>
          <button v-if="removable" type="button" class="attachment-remove" aria-label="移除附件" @click="emit('remove', group.item.key)"><AgentIcon name="close" :size="12" /></button>
        </template>
        <template v-else>
          <span class="attachment-main" :title="group.name">
            <AgentIcon name="folder" :size="16" />
            <span class="attachment-name">{{ group.name }}</span>
            <span class="attachment-meta">
              {{ group.count }} 个文件 · {{ formatSize(group.size) }}<template v-if="group.uploading"> · 上传中 {{ group.uploading }}</template><template v-if="group.failed"> · 失败 {{ group.failed }}</template>
            </span>
          </span>
          <button v-if="removable" type="button" class="attachment-remove" aria-label="移除文件夹" @click="emit('removeFolder', group.name)"><AgentIcon name="close" :size="12" /></button>
        </template>
      </li>
    </ul>
    <ChatMedia v-for="{ item, kind } in media" :key="item.key" :attachment-id="item.id" :label="item.path"
      :kind="kind" :gateway-url="gatewayUrl" :token="token" />
  </div>
</template>

<style scoped>
.attachment-list { display: flex; flex-wrap: wrap; gap: 8px; margin: 0; padding: 0; list-style: none; }
.attachment-chip { display: flex; align-items: center; max-width: 280px; border: 1px solid var(--qdd-border); border-radius: 10px; background: var(--qdd-surface); }
.attachment-chip[data-status="error"] { border-color: var(--el-color-danger); }
.attachment-chip[data-status="uploading"] { opacity: .7; }
.attachment-main { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 6px 10px; border: 0; background: none; color: var(--qdd-text); font: 12px/1.4 var(--qdd-font); text-align: left; }
button.attachment-main:not(:disabled) { cursor: pointer; }
.attachment-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attachment-meta { flex: 0 0 auto; color: var(--qdd-muted); font-size: 11px; }
.attachment-remove { display: grid; place-items: center; width: 22px; height: 22px; margin-right: 4px; padding: 0; border: 0; border-radius: 6px; background: none; color: var(--qdd-muted); cursor: pointer; }
.attachment-remove:hover { background: var(--qdd-border); color: var(--qdd-text); }
</style>

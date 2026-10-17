import { computed, ref, watch } from "vue";
import * as api from "@/api/workspace";
import type { useWorkspace } from "./useWorkspace";

export interface ComposerAttachment {
  key: string;
  /** 文件名；文件夹上传时为含目录的相对路径 */
  path: string;
  size: number;
  status: "uploading" | "done" | "error";
  ref?: api.AttachmentRef;
  error?: string;
}

export interface PickedFile {
  file: File;
  path: string;
}

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_COUNT = 500;
const UPLOAD_CONCURRENCY = 4;

/**
 * 输入框的附件与模型选择（参考 dsh-client-ui-attachment / model-selection）：
 * 附件任意扩展名，可整夹上传；模型选择对已有会话立即提交、下一轮生效，新会话随首条消息提交。
 */
export function useComposer(workspace: ReturnType<typeof useWorkspace>) {
  const { gatewayUrl, token, connected, activeSessionId, activeSession, sessions, error } = workspace;
  const catalog = ref<api.ModelCatalog | null>(null);
  const draftModel = ref<string | null>(null);
  const attachments = ref<ComposerAttachment[]>([]);
  let sequence = 0;
  const controllers = new Map<string, AbortController>();

  watch([connected, gatewayUrl], async ([online]) => {
    if (!online) return;
    try {
      catalog.value = await api.listModels(gatewayUrl.value, token.value);
    } catch {
      catalog.value = null;
    }
  }, { immediate: true });

  const sessionModel = computed(() => {
    const id = activeSessionId.value;
    if (!id) return undefined;
    return (activeSession.value?.id === id ? activeSession.value : sessions.value.find((s) => s.id === id))?.model;
  });
  const currentModel = computed(() => {
    const models = catalog.value?.models ?? [];
    const wanted = activeSessionId.value ? sessionModel.value : draftModel.value;
    return models.find((m) => m.id === wanted) ?? models.find((m) => m.id === catalog.value?.default);
  });

  async function selectModel(id: string): Promise<void> {
    const sessionId = activeSessionId.value;
    if (!sessionId) {
      draftModel.value = id;
      return;
    }
    try {
      workspace.applyResponseMeta(await api.selectSessionModel(gatewayUrl.value, token.value, sessionId, id));
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "切换模型失败";
    }
  }

  const uploading = computed(() => attachments.value.some((a) => a.status === "uploading"));
  const ready = computed(() => attachments.value.filter((a) => a.status === "done" && a.ref).map((a) => a.ref!));

  function addFiles(picked: PickedFile[]): void {
    const room = MAX_COUNT - attachments.value.length;
    if (picked.length > room) error.value = `一条消息最多 ${MAX_COUNT} 个附件，已忽略多出的 ${picked.length - Math.max(room, 0)} 个。`;
    const queue: { item: ComposerAttachment; file: File }[] = [];
    for (const { file, path } of picked.slice(0, Math.max(room, 0))) {
      const item: ComposerAttachment = { key: `a${++sequence}`, path, size: file.size, status: "uploading" };
      if (file.size > MAX_BYTES) Object.assign(item, { status: "error", error: "超过 50 MB" });
      attachments.value.push(item);
      if (item.status === "uploading") queue.push({ item, file });
    }
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await upload(next.item.key, next.file);
    };
    for (let i = 0; i < UPLOAD_CONCURRENCY; i++) void worker();
  }

  async function upload(key: string, file: File): Promise<void> {
    const item = attachments.value.find((a) => a.key === key);
    if (!item) return;
    const controller = new AbortController();
    controllers.set(key, controller);
    try {
      const ref = await api.uploadAttachment(gatewayUrl.value, token.value, file, item.path, controller.signal);
      update(key, { status: "done", ref });
    } catch (cause) {
      if (!controller.signal.aborted) update(key, { status: "error", error: cause instanceof Error ? cause.message : "上传失败" });
    } finally {
      controllers.delete(key);
    }
  }

  function update(key: string, patch: Partial<ComposerAttachment>) {
    const index = attachments.value.findIndex((a) => a.key === key);
    if (index !== -1) attachments.value[index] = { ...attachments.value[index]!, ...patch };
  }

  function removeAttachment(key: string): void {
    controllers.get(key)?.abort();
    attachments.value = attachments.value.filter((a) => a.key !== key);
  }

  /** 移除某个文件夹下的全部附件 */
  function removeFolder(folder: string): void {
    for (const a of attachments.value) if (a.path.startsWith(`${folder}/`)) controllers.get(a.key)?.abort();
    attachments.value = attachments.value.filter((a) => !a.path.startsWith(`${folder}/`));
  }

  function clearAttachments(sent?: readonly api.AttachmentRef[]): void {
    const ids = sent ? new Set(sent.map((r) => r.id)) : undefined;
    for (const a of attachments.value) if (!ids) controllers.get(a.key)?.abort();
    attachments.value = ids ? attachments.value.filter((a) => !a.ref || !ids.has(a.ref.id)) : [];
  }

  return {
    catalog, currentModel, draftModel, selectModel,
    attachments, uploading, ready, addFiles, removeAttachment, removeFolder, clearAttachments,
  };
}

/** 从拖放数据中收集文件，文件夹递归展开并保留相对路径。 */
export async function filesFromDrop(data: DataTransfer): Promise<PickedFile[]> {
  const entries = [...data.items].map((item) => item.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return [...data.files].map((file) => ({ file, path: file.name }));
  const out: PickedFile[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ file, path });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries 每次最多返回一批，读到空数组为止
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child, path);
      }
    }
  };
  for (const entry of entries) await walk(entry, "");
  return out;
}

/** 文件选择框的结果；选择文件夹时浏览器提供 webkitRelativePath */
export function filesFromInput(list: FileList | null): PickedFile[] {
  return [...(list ?? [])].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

export function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

import { computed, onScopeDispose, ref, watch } from "vue";
import * as api from "../api/workspace.ts";
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
  const modelLoading = ref(false);
  const modelError = ref("");
  const draftModel = ref<string | null>(null);
  const attachments = ref<ComposerAttachment[]>([]);
  let sequence = 0;
  const controllers = new Map<string, AbortController>();
  const pendingModels = ref(new Map<string, { id: string; version: number }>());
  const modelRequests = new Map<string, Promise<void>>();
  const modelControllers = new Set<AbortController>();
  let catalogController: AbortController | undefined;
  let contextVersion = 0;
  let modelVersion = 0;
  let disposed = false;
  const attachmentDrafts = new Map<string, ComposerAttachment[]>();
  const attachmentRevisions = new Map<string, number>();
  let attachmentGeneration = 0;
  let attachmentIntent = 0;
  let attachmentEpoch = 0;
  const attachmentKey = (id: string | null) => JSON.stringify(id === null ? ["draft", attachmentGeneration] : ["session", id]);
  let currentAttachmentKey = attachmentKey(activeSessionId.value);
  type UploadJob = { key: string; draftKey: string; epoch: number; base: string; token: string; file: File };
  const uploadJobs = new Set<UploadJob>();
  const fileCollections = new Set<{ draftKey: string; epoch: number; base: string; token: string }>();
  const pendingCollections = ref(new Map<string, number>());
  const attachmentSends = new Set<{ key: string; intent: number; epoch: number; sessionId: string | null }>();

  function draftItems(key: string): ComposerAttachment[] {
    return key === currentAttachmentKey ? attachments.value : attachmentDrafts.get(key) ?? [];
  }
  function setDraftItems(key: string, items: ComposerAttachment[]): void {
    attachmentDrafts.set(key, items);
    if (key === currentAttachmentKey) attachments.value = items;
  }
  function changedAttachments(key = currentAttachmentKey): void {
    attachmentRevisions.set(key, (attachmentRevisions.get(key) ?? 0) + 1);
  }
  function abortUploads(message?: string): void {
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
    if (message) for (const job of uploadJobs) update(job, { status: "error", error: message });
    uploadJobs.clear();
    fileCollections.clear();
    pendingCollections.value.clear();
  }
  function resetAttachments(): void {
    attachmentEpoch++;
    attachmentIntent++;
    abortUploads();
    attachmentDrafts.clear();
    attachmentRevisions.clear();
    attachmentSends.clear();
    currentAttachmentKey = attachmentKey(activeSessionId.value);
    attachments.value = [];
  }

  watch([gatewayUrl, token], resetAttachments, { flush: "sync" });
  watch(connected, (online) => { if (!online) abortUploads("连接已断开，请移除附件后重新上传。"); }, { flush: "sync" });
  watch(activeSessionId, (id, previousId) => {
    const nextKey = attachmentKey(id);
    if (nextKey === currentAttachmentKey) return;
    const previousKey = currentAttachmentKey;
    attachmentDrafts.set(previousKey, attachments.value);
    const creation = id !== null && previousId === null
      ? [...attachmentSends].find((send) => send.key === previousKey && send.sessionId === null
        && send.intent === attachmentIntent && send.epoch === attachmentEpoch)
      : undefined;
    currentAttachmentKey = nextKey;
    if (creation) {
      creation.key = nextKey;
      creation.sessionId = id;
      for (const job of uploadJobs) if (job.draftKey === previousKey) job.draftKey = nextKey;
      for (const collection of fileCollections) if (collection.draftKey === previousKey) collection.draftKey = nextKey;
      const pending = pendingCollections.value.get(previousKey);
      if (pending) {
        pendingCollections.value.set(nextKey, pending);
        pendingCollections.value.delete(previousKey);
      }
      attachmentRevisions.set(nextKey, attachmentRevisions.get(previousKey) ?? 0);
      attachmentRevisions.delete(previousKey);
      attachmentDrafts.set(nextKey, attachmentDrafts.get(previousKey) ?? []);
      attachmentDrafts.delete(previousKey);
    }
    attachments.value = attachmentDrafts.get(nextKey) ?? [];
  }, { flush: "sync" });

  async function refreshModels(): Promise<void> {
    catalogController?.abort();
    if (!connected.value || disposed) return;
    const controller = new AbortController();
    catalogController = controller;
    modelLoading.value = true;
    modelError.value = "";
    try {
      const result = await api.listModels(gatewayUrl.value, token.value, controller.signal);
      if (!controller.signal.aborted && !disposed && catalogController === controller) catalog.value = result;
    } catch (cause) {
      if (!controller.signal.aborted && !disposed && catalogController === controller) {
        catalog.value = null;
        modelError.value = cause instanceof Error ? cause.message : "加载模型失败";
      }
    } finally {
      if (catalogController === controller) modelLoading.value = false;
    }
  }

  function resetModelRequests(): void {
    contextVersion++;
    catalogController?.abort();
    for (const controller of modelControllers) controller.abort();
    modelControllers.clear();
    modelRequests.clear();
    pendingModels.value.clear();
    catalog.value = null;
    modelLoading.value = false;
    modelError.value = "";
  }

  watch([connected, gatewayUrl, token], ([online, base, key], previous) => {
    if (base !== previous[1] || key !== previous[2]) draftModel.value = null;
    resetModelRequests();
    if (online) void refreshModels();
  }, { immediate: true, flush: "sync" });
  watch(activeSessionId, () => { modelError.value = ""; }, { flush: "sync" });
  onScopeDispose(() => {
    disposed = true;
    resetModelRequests();
    resetAttachments();
  });

  const sessionModel = computed(() => {
    const id = activeSessionId.value;
    if (!id) return undefined;
    return (activeSession.value?.id === id ? activeSession.value : sessions.value.find((s) => s.id === id))?.model;
  });
  const currentModel = computed(() => {
    const models = catalog.value?.models ?? [];
    const wanted = activeSessionId.value
      ? pendingModels.value.get(activeSessionId.value)?.id ?? sessionModel.value
      : draftModel.value;
    return models.find((m) => m.id === wanted) ?? models.find((m) => m.id === catalog.value?.default);
  });
  const modelChanging = computed(() => !!activeSessionId.value && pendingModels.value.has(activeSessionId.value));

  // Both APIs describe the same model IDs. Keep per-turn effort choices attached
  // to the model displayed here, including optimistic changes while PUT waits.
  watch([() => currentModel.value?.id, workspace.chatOptions, () => workspace.chatSelection.value?.model], ([id]) => {
    if (id && workspace.chatSelection.value?.model !== id) workspace.selectChatModel(id);
  }, { immediate: true, flush: "sync" });

  async function selectModel(id: string): Promise<void> {
    if (disposed || !connected.value) return;
    const model = catalog.value?.models.find((entry) => entry.id === id);
    if (!model || !model.available) {
      modelError.value = model ? "该模型未配置 API Key，暂不可用" : "模型不存在，请刷新模型列表";
      return;
    }
    modelError.value = "";
    const sessionId = activeSessionId.value;
    if (!sessionId) {
      draftModel.value = id;
      return;
    }
    const version = ++modelVersion;
    const context = contextVersion;
    const base = gatewayUrl.value;
    const key = token.value;
    pendingModels.value.set(sessionId, { id, version });
    // Serialize writes to a session and coalesce superseded queued selections.
    // Ignoring an old response alone cannot stop it from overwriting the server.
    const request = (modelRequests.get(sessionId) ?? Promise.resolve()).then(async () => {
      if (disposed || context !== contextVersion || pendingModels.value.get(sessionId)?.version !== version) return;
      const controller = new AbortController();
      modelControllers.add(controller);
      try {
        const meta = await api.selectSessionModel(base, key, sessionId, id, controller.signal);
        if (!controller.signal.aborted && !disposed && context === contextVersion
          && pendingModels.value.get(sessionId)?.version === version) workspace.applyResponseMeta(meta);
      } catch (cause) {
        if (!controller.signal.aborted && !disposed && context === contextVersion
          && pendingModels.value.get(sessionId)?.version === version && activeSessionId.value === sessionId) {
          modelError.value = cause instanceof Error ? cause.message : "切换模型失败";
          error.value = modelError.value;
        }
      } finally {
        modelControllers.delete(controller);
        if (context === contextVersion && pendingModels.value.get(sessionId)?.version === version) pendingModels.value.delete(sessionId);
      }
    });
    modelRequests.set(sessionId, request);
    await request;
    if (modelRequests.get(sessionId) === request) modelRequests.delete(sessionId);
  }

  const uploading = computed(() => attachments.value.some((a) => a.status === "uploading")
    || (pendingCollections.value.get(currentAttachmentKey) ?? 0) > 0);
  const ready = computed(() => attachments.value.filter((a) => a.status === "done" && a.ref).map((a) => a.ref!));

  function addFiles(picked: PickedFile[], target = {
    draftKey: currentAttachmentKey, epoch: attachmentEpoch, base: gatewayUrl.value, token: token.value,
  }): void {
    if (disposed || !connected.value || target.epoch !== attachmentEpoch) return;
    const items = [...draftItems(target.draftKey)];
    const room = MAX_COUNT - items.length;
    if (picked.length > room) error.value = `一条消息最多 ${MAX_COUNT} 个附件，已忽略多出的 ${picked.length - Math.max(room, 0)} 个。`;
    const queue: UploadJob[] = [];
    for (const { file, path } of picked.slice(0, Math.max(room, 0))) {
      const item: ComposerAttachment = { key: `a${++sequence}`, path, size: file.size, status: "uploading" };
      if (file.size > MAX_BYTES) Object.assign(item, { status: "error", error: "超过 50 MB" });
      items.push(item);
      if (item.status === "uploading") {
        const job: UploadJob = { key: item.key, ...target, file };
        uploadJobs.add(job);
        queue.push(job);
      }
    }
    setDraftItems(target.draftKey, items);
    if (picked.length) changedAttachments(target.draftKey);
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await upload(next);
    };
    for (let i = 0; i < UPLOAD_CONCURRENCY; i++) void worker();
  }

  async function addFilesFrom(load: () => Promise<PickedFile[]>): Promise<void> {
    if (disposed || !connected.value) return;
    const target = { draftKey: currentAttachmentKey, epoch: attachmentEpoch, base: gatewayUrl.value, token: token.value };
    fileCollections.add(target);
    pendingCollections.value.set(target.draftKey, (pendingCollections.value.get(target.draftKey) ?? 0) + 1);
    try {
      const files = await load();
      if (fileCollections.has(target)) addFiles(files, target);
    } catch (cause) {
      if (!disposed && target.epoch === attachmentEpoch && target.draftKey === currentAttachmentKey) {
        error.value = cause instanceof Error ? cause.message : "读取拖放文件失败，请重新选择文件。";
      }
    } finally {
      if (fileCollections.delete(target)) {
        const remaining = (pendingCollections.value.get(target.draftKey) ?? 1) - 1;
        if (remaining > 0) pendingCollections.value.set(target.draftKey, remaining);
        else pendingCollections.value.delete(target.draftKey);
      }
    }
  }

  async function upload(job: UploadJob): Promise<void> {
    if (disposed || !connected.value || !uploadJobs.has(job) || job.epoch !== attachmentEpoch) return;
    const item = draftItems(job.draftKey).find((a) => a.key === job.key);
    if (!item) { uploadJobs.delete(job); return; }
    const controller = new AbortController();
    controllers.set(job.key, controller);
    try {
      const ref = await api.uploadAttachment(job.base, job.token, job.file, item.path, controller.signal);
      if (!controller.signal.aborted) update(job, { status: "done", ref });
    } catch (cause) {
      if (!controller.signal.aborted) update(job, { status: "error", error: cause instanceof Error ? cause.message : "上传失败" });
    } finally {
      if (controllers.get(job.key) === controller) controllers.delete(job.key);
      uploadJobs.delete(job);
    }
  }

  function update(job: UploadJob, patch: Partial<ComposerAttachment>) {
    if (disposed || job.epoch !== attachmentEpoch) return;
    const items = draftItems(job.draftKey);
    const index = items.findIndex((a) => a.key === job.key);
    if (index !== -1) setDraftItems(job.draftKey, items.map((item, i) => i === index ? { ...item, ...patch } : item));
  }

  function removeAttachment(key: string): void {
    controllers.get(key)?.abort();
    attachments.value = attachments.value.filter((a) => a.key !== key);
    changedAttachments();
  }

  /** 移除某个文件夹下的全部附件 */
  function removeFolder(folder: string): void {
    for (const a of attachments.value) if (a.path.startsWith(`${folder}/`)) controllers.get(a.key)?.abort();
    attachments.value = attachments.value.filter((a) => !a.path.startsWith(`${folder}/`));
    changedAttachments();
  }

  function clearAttachments(sent?: readonly api.AttachmentRef[]): void {
    const ids = sent ? new Set(sent.map((r) => r.id)) : undefined;
    for (const a of attachments.value) if (!ids) controllers.get(a.key)?.abort();
    attachments.value = ids ? attachments.value.filter((a) => !a.ref || !ids.has(a.ref.id)) : [];
    changedAttachments();
  }

  function beginSelection(): void { attachmentIntent++; }
  function startNewDraft(): void {
    attachmentDrafts.set(currentAttachmentKey, attachments.value);
    attachmentIntent++;
    attachmentGeneration++;
    currentAttachmentKey = attachmentKey(null);
    attachments.value = [];
  }

  /** Snapshot the files with the message; later edits and selections own their own draft. */
  async function sendWithAttachments(send: (items: api.AttachmentRef[]) => Promise<boolean>): Promise<boolean> {
    if (disposed || !connected.value || uploading.value) return false;
    const submission = { key: currentAttachmentKey, intent: attachmentIntent, epoch: attachmentEpoch, sessionId: activeSessionId.value };
    if ([...attachmentSends].some((entry) => entry.key === submission.key && entry.epoch === submission.epoch)) return false;
    const sent = attachments.value.filter((item) => item.status === "done" && item.ref);
    const keys = new Set(sent.map((item) => item.key));
    const revision = attachmentRevisions.get(submission.key) ?? 0;
    setDraftItems(submission.key, attachments.value.filter((item) => !keys.has(item.key)));
    attachmentSends.add(submission);
    function restore(): void {
      if (disposed || submission.epoch !== attachmentEpoch || (attachmentRevisions.get(submission.key) ?? 0) !== revision) return;
      setDraftItems(submission.key, [...sent, ...draftItems(submission.key)]);
    }
    try {
      const success = await send(sent.map((item) => item.ref!));
      if (!success) restore();
      return success;
    } catch (cause) {
      restore();
      throw cause;
    } finally {
      attachmentSends.delete(submission);
    }
  }

  return {
    catalog, currentModel, draftModel, selectModel, modelLoading, modelError, modelChanging, refreshModels,
    attachments, uploading, ready, addFiles, addFilesFrom, removeAttachment, removeFolder, clearAttachments,
    beginSelection, startNewDraft, sendWithAttachments,
  };
}

/** 从拖放数据中收集文件，文件夹递归展开并保留相对路径。 */
export async function filesFromDrop(data: DataTransfer): Promise<PickedFile[]> {
  const entries = [...data.items].map((item) => item.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return [...data.files].map((file) => ({ file, path: file.name }));
  const out: PickedFile[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string, depth = 0): Promise<void> => {
    if (out.length > MAX_COUNT) return;
    if (depth > 100) throw new Error("文件夹层级过深，请选择较浅的文件夹。");
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
        for (const child of batch) {
          await walk(child, path, depth + 1);
          if (out.length > MAX_COUNT) return;
        }
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

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as api from "@/api/workspace";
import type { AssistantKind, Conversation, TaskStatus, WorkspaceTask } from "@/api/workspace";

export type { ChatMessage, Conversation, WorkspaceTask } from "@/api/workspace";

interface Preferences {
  theme: "light" | "dark";
  enterToSend: boolean;
  assistant: AssistantKind;
}

const STORAGE_KEY = "harness-preferences-v1";
const DEFAULT_PREFERENCES: Preferences = { theme: "light", enterToSend: true, assistant: "general" };

function errorMessage(error: unknown): string {
  if (error instanceof TypeError) return "无法连接后端服务，请检查服务与代理地址后重试。";
  return error instanceof Error ? error.message : "请求失败，请稍后重试。";
}

export function useWorkspace() {
  const conversations = ref<Conversation[]>([]);
  const activeConversationId = ref<string | null>(null);
  const activeConversation = ref<Conversation>();
  const tasks = ref<WorkspaceTask[]>([]);
  const activeTaskId = ref<string | null>(null);
  const activeTask = ref<WorkspaceTask>();
  const preferences = ref<Preferences>({ ...DEFAULT_PREFERENCES });
  const storageError = ref("");
  const listError = ref("");
  const conversationListError = ref("");
  const detailError = ref("");
  const conversationError = ref("");
  const actionError = ref("");
  const loadingTasks = ref(false);
  const loadingConversations = ref(false);
  const loadingTask = ref(false);
  const loadingConversation = ref(false);
  const creatingConversation = ref(false);
  const mutatingTask = ref(false);
  const mutatingConversation = ref(false);
  const stoppingReply = ref(false);
  const pendingConversationId = ref<string | null>(null);
  let taskListController: AbortController | undefined;
  let conversationListController: AbortController | undefined;
  let taskDetailController: AbortController | undefined;
  let conversationDetailController: AbortController | undefined;
  let sendController: AbortController | undefined;
  let conversationSelectionRequest: Promise<void> = Promise.resolve();
  let taskSelectionRequest: Promise<void> = Promise.resolve();
  const actionControllers = new Set<AbortController>();
  let installingConversation = false;
  let disposed = false;

  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved && typeof saved === "object") {
      const value = saved as Record<string, unknown>;
      preferences.value = {
        theme: value.theme === "dark" ? "dark" : "light",
        enterToSend: typeof value.enterToSend === "boolean" ? value.enterToSend : true,
        assistant: value.assistant === "store" || value.assistant === "code" ? value.assistant : "general",
      };
    }
  } catch {
    storageError.value = "无法读取本地偏好，本次会话仍可正常使用。";
  }

  watch(preferences, () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences.value));
      storageError.value = "";
    } catch {
      storageError.value = "浏览器存储不可用，刷新后可能丢失本次偏好设置。";
    }
  }, { deep: true });

  const sortedConversations = computed(() => [...conversations.value].sort((a, b) => b.updatedAt - a.updatedAt));
  const sortedTasks = computed(() => [...tasks.value].sort((a, b) => b.updatedAt - a.updatedAt));

  function applyConversation(conversation: Conversation) {
    const index = conversations.value.findIndex((entry) => entry.id === conversation.id);
    if (index < 0) conversations.value.unshift(conversation);
    else conversations.value[index] = conversation;
    if (activeConversationId.value === conversation.id) activeConversation.value = conversation;
  }

  function applyTask(task: WorkspaceTask) {
    const index = tasks.value.findIndex((entry) => entry.id === task.id);
    if (index < 0) tasks.value.unshift(task);
    else tasks.value[index] = task;
    if (activeTaskId.value === task.id) activeTask.value = task;
  }

  async function fetchConversation(id: string | null) {
    conversationDetailController?.abort();
    activeConversation.value = undefined;
    loadingConversation.value = Boolean(id);
    conversationError.value = "";
    if (!id) return;
    const controller = new AbortController();
    conversationDetailController = controller;
    try {
      const conversation = await api.getConversation(id, controller.signal);
      if (!controller.signal.aborted && !disposed && activeConversationId.value === id) applyConversation(conversation);
    } catch (error) {
      if (!controller.signal.aborted && !disposed && activeConversationId.value === id) conversationError.value = errorMessage(error);
    } finally {
      if (conversationDetailController === controller) loadingConversation.value = false;
    }
  }

  async function fetchTask(id: string | null) {
    taskDetailController?.abort();
    activeTask.value = undefined;
    loadingTask.value = Boolean(id);
    detailError.value = "";
    if (!id) return;
    const controller = new AbortController();
    taskDetailController = controller;
    try {
      const task = await api.getTask(id, controller.signal);
      if (!controller.signal.aborted && !disposed && activeTaskId.value === id) applyTask(task);
    } catch (error) {
      if (!controller.signal.aborted && !disposed && activeTaskId.value === id) detailError.value = errorMessage(error);
    } finally {
      if (taskDetailController === controller) loadingTask.value = false;
    }
  }

  watch(activeConversationId, (id) => {
    if (installingConversation) return;
    conversationSelectionRequest = fetchConversation(id);
  }, { flush: "sync" });
  watch(activeTaskId, (id) => {
    taskSelectionRequest = fetchTask(id);
  }, { flush: "sync" });

  async function selectConversation(id: string): Promise<void> {
    actionError.value = "";
    if (activeConversationId.value === id) conversationSelectionRequest = fetchConversation(id);
    else activeConversationId.value = id;
    await conversationSelectionRequest;
    await nextTick();
  }

  async function selectTask(id: string): Promise<void> {
    actionError.value = "";
    if (activeTaskId.value === id) taskSelectionRequest = fetchTask(id);
    else activeTaskId.value = id;
    await taskSelectionRequest;
  }

  async function loadConversations() {
    conversationListController?.abort();
    const controller = new AbortController();
    conversationListController = controller;
    loadingConversations.value = true;
    conversationListError.value = "";
    try {
      const result = await api.listConversations(controller.signal);
      if (controller.signal.aborted || disposed) return;
      conversations.value = result;
      const selectedId = activeConversationId.value && result.some((item) => item.id === activeConversationId.value)
        ? activeConversationId.value : sortedConversations.value[0]?.id;
      if (selectedId) await selectConversation(selectedId);
      else activeConversationId.value = null;
    } catch (error) {
      if (!controller.signal.aborted && !disposed) conversationListError.value = errorMessage(error);
    } finally {
      if (conversationListController === controller) loadingConversations.value = false;
    }
  }

  async function loadTasks() {
    taskListController?.abort();
    const controller = new AbortController();
    taskListController = controller;
    loadingTasks.value = true;
    listError.value = "";
    try {
      const result = await api.listTasks(controller.signal);
      if (controller.signal.aborted || disposed) return;
      tasks.value = result;
      if (activeTaskId.value) {
        if (result.some((task) => task.id === activeTaskId.value)) await selectTask(activeTaskId.value);
        else activeTaskId.value = null;
      }
    } catch (error) {
      if (!controller.signal.aborted && !disposed) listError.value = errorMessage(error);
    } finally {
      if (taskListController === controller) loadingTasks.value = false;
    }
  }

  function actionController() {
    const controller = new AbortController();
    actionControllers.add(controller);
    return controller;
  }

  function invalidateConversationList() {
    conversationListController?.abort();
    loadingConversations.value = false;
    conversationListError.value = "";
  }

  function invalidateTaskList() {
    taskListController?.abort();
    loadingTasks.value = false;
    listError.value = "";
  }

  function showConversation(conversation: Conversation) {
    conversationDetailController?.abort();
    loadingConversation.value = false;
    conversationError.value = "";
    installingConversation = true;
    activeConversationId.value = conversation.id;
    installingConversation = false;
    applyConversation(conversation);
  }

  async function newConversation(): Promise<Conversation | undefined> {
    if (creatingConversation.value || mutatingConversation.value || disposed) return;
    creatingConversation.value = true;
    actionError.value = "";
    const controller = actionController();
    try {
      const conversation = await api.createConversation(preferences.value.assistant, controller.signal);
      if (controller.signal.aborted || disposed) return;
      invalidateConversationList();
      showConversation(conversation);
      return conversation;
    } catch (error) {
      if (!controller.signal.aborted && !disposed) actionError.value = errorMessage(error);
      return;
    } finally {
      creatingConversation.value = false;
      actionControllers.delete(controller);
    }
  }

  async function renameConversation(id: string, title: string): Promise<boolean> {
    if (!title.trim() || mutatingConversation.value || creatingConversation.value || pendingConversationId.value === id || disposed) return false;
    mutatingConversation.value = true;
    actionError.value = "";
    const controller = actionController();
    try {
      const conversation = await api.updateConversation(id, title.trim().slice(0, 80), controller.signal);
      if (controller.signal.aborted || disposed) return false;
      invalidateConversationList();
      if (activeConversationId.value === id) {
        conversationDetailController?.abort();
        loadingConversation.value = false;
        conversationError.value = "";
      }
      applyConversation(conversation);
      await loadTasks();
      return true;
    } catch (error) {
      if (!controller.signal.aborted && !disposed) actionError.value = errorMessage(error);
      return false;
    } finally {
      mutatingConversation.value = false;
      actionControllers.delete(controller);
    }
  }

  async function deleteConversation(id: string): Promise<boolean> {
    if (mutatingConversation.value || creatingConversation.value || pendingConversationId.value === id || disposed) return false;
    mutatingConversation.value = true;
    actionError.value = "";
    const controller = actionController();
    try {
      await api.removeConversation(id, controller.signal);
      if (controller.signal.aborted || disposed) return false;
      invalidateConversationList();
      conversations.value = conversations.value.filter((conversation) => conversation.id !== id);
      if (activeConversationId.value === id) {
        activeConversationId.value = null;
        const next = sortedConversations.value[0];
        if (next) await selectConversation(next.id);
      }
      await loadTasks();
      return true;
    } catch (error) {
      if (!controller.signal.aborted && !disposed) actionError.value = errorMessage(error);
      return false;
    } finally {
      mutatingConversation.value = false;
      actionControllers.delete(controller);
    }
  }

  async function createTaskFromConversation(
    conversationId: string, title: string, description: string, sourceMessageId: string,
  ): Promise<WorkspaceTask | undefined> {
    if (!title.trim() || !conversationId || !sourceMessageId || mutatingTask.value || disposed) return;
    mutatingTask.value = true;
    actionError.value = "";
    const controller = actionController();
    try {
      const task = await api.createTask({
        conversationId, sourceMessageId, title: title.trim().slice(0, 80), description: description.slice(0, 8000),
      }, controller.signal);
      if (controller.signal.aborted || disposed) return;
      invalidateTaskList();
      applyTask(task);
      return task;
    } catch (error) {
      if (!controller.signal.aborted && !disposed) actionError.value = errorMessage(error);
      return;
    } finally {
      mutatingTask.value = false;
      actionControllers.delete(controller);
    }
  }

  async function mutateTask(id: string, changes: { title?: string; status?: TaskStatus }): Promise<boolean> {
    if (mutatingTask.value || disposed) return false;
    mutatingTask.value = true;
    actionError.value = "";
    const controller = actionController();
    try {
      const task = await api.updateTask(id, changes, controller.signal);
      if (controller.signal.aborted || disposed) return false;
      invalidateTaskList();
      if (activeTaskId.value === id) {
        taskDetailController?.abort();
        loadingTask.value = false;
        detailError.value = "";
      }
      applyTask(task);
      return true;
    } catch (error) {
      if (!controller.signal.aborted && !disposed) actionError.value = errorMessage(error);
      return false;
    } finally {
      mutatingTask.value = false;
      actionControllers.delete(controller);
    }
  }

  async function renameTask(id: string, title: string): Promise<boolean> {
    if (!title.trim()) return false;
    return mutateTask(id, { title: title.trim().slice(0, 80) });
  }

  async function setTaskStatus(id: string, status: TaskStatus): Promise<boolean> {
    if (status !== "todo" && status !== "in_progress" && status !== "done") return false;
    return mutateTask(id, { status });
  }

  async function deleteTask(id: string): Promise<boolean> {
    if (mutatingTask.value || disposed) return false;
    mutatingTask.value = true;
    actionError.value = "";
    const controller = actionController();
    try {
      await api.removeTask(id, controller.signal);
      if (controller.signal.aborted || disposed) return false;
      invalidateTaskList();
      tasks.value = tasks.value.filter((task) => task.id !== id);
      if (activeTaskId.value === id) activeTaskId.value = null;
      return true;
    } catch (error) {
      if (!controller.signal.aborted && !disposed) actionError.value = errorMessage(error);
      return false;
    } finally {
      mutatingTask.value = false;
      actionControllers.delete(controller);
    }
  }

  async function sendMessage(content: string): Promise<boolean> {
    const text = content.trim();
    if (!text || text.length > 8000 || pendingConversationId.value || creatingConversation.value
      || loadingConversation.value || mutatingConversation.value || disposed) return false;
    const conversation = activeConversation.value ?? (activeConversationId.value ? undefined : await newConversation());
    if (!conversation || disposed) return false;
    pendingConversationId.value = conversation.id;
    actionError.value = "";
    const controller = new AbortController();
    sendController = controller;
    try {
      const result = await api.sendConversationMessage(conversation.id, text, preferences.value.assistant, controller.signal);
      if (controller.signal.aborted || disposed) return false;
      invalidateConversationList();
      if (activeConversationId.value === result.id) {
        conversationDetailController?.abort();
        loadingConversation.value = false;
        conversationError.value = "";
      }
      applyConversation(result);
      return true;
    } catch (error) {
      if (!controller.signal.aborted && !disposed) actionError.value = errorMessage(error);
      return false;
    } finally {
      if (sendController === controller) pendingConversationId.value = null;
    }
  }

  async function stopReply(): Promise<boolean> {
    const id = pendingConversationId.value;
    const pendingController = sendController;
    if (!id || !pendingController || stoppingReply.value || disposed) return false;
    stoppingReply.value = true;
    actionError.value = "";
    const controller = actionController();
    try {
      await api.stopConversation(id, controller.signal);
      if (controller.signal.aborted || disposed) return false;
      if (sendController === pendingController) {
        pendingController.abort();
        pendingConversationId.value = null;
      }
      if (activeConversationId.value === id) await selectConversation(id);
      return true;
    } catch (error) {
      if (!controller.signal.aborted && !disposed) actionError.value = errorMessage(error);
      return false;
    } finally {
      stoppingReply.value = false;
      actionControllers.delete(controller);
    }
  }

  onMounted(() => {
    void loadTasks();
    void loadConversations();
  });
  onBeforeUnmount(() => {
    disposed = true;
    taskListController?.abort();
    conversationListController?.abort();
    taskDetailController?.abort();
    conversationDetailController?.abort();
    sendController?.abort();
    for (const controller of actionControllers) controller.abort();
  });

  return {
    conversations, activeConversationId, activeConversation, sortedConversations,
    tasks, activeTaskId, activeTask, sortedTasks, preferences, pendingConversationId, storageError,
    listError, conversationListError, detailError, conversationError, actionError,
    loadingTasks, loadingConversations, loadingTask, loadingConversation,
    creatingConversation, mutatingConversation, mutatingTask, stoppingReply,
    loadTasks, loadConversations, selectTask, selectConversation,
    newConversation, deleteConversation, renameConversation, createTaskFromConversation,
    setTaskStatus, renameTask, deleteTask, sendMessage, stopReply,
  };
}

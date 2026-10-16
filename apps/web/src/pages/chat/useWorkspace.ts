import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ClarifyAnswers, PageView, SessionDetail, SessionEvent, SessionMeta } from "@qdd/shared";
import * as api from "@/api/workspace";

export type { PageView, SessionDetail, SessionEvent, SessionMeta } from "@qdd/shared";

interface Preferences {
  theme: "light" | "dark";
  enterToSend: boolean;
}

const PREFERENCES_KEY = "harness-preferences-v1";
const GATEWAY_KEY = "harness-gateway-url";
const TOKEN_KEY = "harness-gateway-token";

function errorMessage(error: unknown): string {
  if (error instanceof TypeError) return "无法连接网关，请检查地址、服务状态与 gateway.corsOrigins 中的前端来源。";
  return error instanceof Error ? error.message : "请求失败，请稍后重试。";
}

function retryDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, 2000);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

export function useWorkspace() {
  const sessions = ref<SessionMeta[]>([]);
  const activeSessionId = ref<string | null>(null);
  const activeSession = ref<SessionDetail>();
  const pages = ref<PageView[]>([]);
  const activePageSlug = ref<string | null>(null);
  const activePage = computed(() => pages.value.find((page) => page.slug === activePageSlug.value));
  const revisionPageSlug = ref<string | null>(null);
  const preferences = ref<Preferences>({ theme: "light", enterToSend: true });
  const token = ref("");
  const gatewayUrl = ref(api.DEFAULT_GATEWAY_URL);
  const loadingSessions = ref(false);
  const loadingPages = ref(false);
  const loadingSession = ref(false);
  const error = ref("");
  const connected = ref(false);
  const pendingSend = ref(false);
  const sending = computed(() => pendingSend.value || activeSession.value?.status === "running" || activeSession.value?.status === "waiting");
  const cancelling = ref(false);
  const eventActionBusy = ref(false);
  let disposed = false;
  let connectionVersion = 0;
  let selectionVersion = 0;
  let workspaceController: AbortController | undefined;
  let pageController: AbortController | undefined;
  let detailController: AbortController | undefined;
  let globalController: AbortController | undefined;
  let sessionController: AbortController | undefined;
  let sendController: AbortController | undefined;
  const actionControllers = new Set<AbortController>();
  const reconnectingStreams = new Set<AbortController>();

  try {
    const saved: unknown = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || "null");
    if (saved && typeof saved === "object") {
      const value = saved as Record<string, unknown>;
      preferences.value = {
        theme: value.theme === "dark" ? "dark" : "light",
        enterToSend: typeof value.enterToSend === "boolean" ? value.enterToSend : true,
      };
    }
    gatewayUrl.value = localStorage.getItem(GATEWAY_KEY) || api.DEFAULT_GATEWAY_URL;
  } catch {
    // 浏览器禁用存储时仍可在当前页面设置连接与偏好。
  }
  try {
    token.value = sessionStorage.getItem(TOKEN_KEY) || "";
  } catch {
    // token 只在当前标签页保存，存储不可用时留在内存。
  }

  watch(preferences, () => {
    try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences.value)); } catch { /* 保留内存中的偏好。 */ }
  }, { deep: true });

  function stopConnections() {
    connectionVersion++;
    selectionVersion++;
    workspaceController?.abort();
    pageController?.abort();
    detailController?.abort();
    globalController?.abort();
    sessionController?.abort();
    sendController?.abort();
    sendController = undefined;
    for (const controller of actionControllers) controller.abort();
    actionControllers.clear();
    reconnectingStreams.clear();
    connected.value = false;
    loadingSessions.value = false;
    loadingPages.value = false;
    loadingSession.value = false;
    pendingSend.value = false;
    cancelling.value = false;
    eventActionBusy.value = false;
  }

  watch([token, gatewayUrl], () => {
    stopConnections();
    sessions.value = [];
    pages.value = [];
    activeSessionId.value = null;
    activeSession.value = undefined;
    activePageSlug.value = null;
    revisionPageSlug.value = null;
    error.value = "";
    try { sessionStorage.setItem(TOKEN_KEY, token.value); } catch { /* token 不写入 localStorage。 */ }
    try { localStorage.setItem(GATEWAY_KEY, gatewayUrl.value); } catch { /* 地址仍可在当前页面使用。 */ }
  }, { flush: "sync" });

  function applyMeta(meta: SessionMeta) {
    const entry: SessionMeta = {
      id: meta.id, title: meta.title, summary: meta.summary, slug: meta.slug,
      status: meta.status, createdAt: meta.createdAt, updatedAt: meta.updatedAt,
    };
    const index = sessions.value.findIndex((session) => session.id === meta.id);
    if (index === -1) sessions.value.push(entry);
    else sessions.value[index] = entry;
    sessions.value.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (activeSession.value?.id === meta.id) activeSession.value = { ...activeSession.value, ...entry };
  }

  async function refreshPages() {
    if (!connected.value || disposed) return;
    pageController?.abort();
    const controller = new AbortController();
    pageController = controller;
    loadingPages.value = true;
    try {
      const result = await api.listPages(gatewayUrl.value, token.value, controller.signal);
      if (controller.signal.aborted || disposed) return;
      pages.value = result;
      if (activePageSlug.value && !result.some((page) => page.slug === activePageSlug.value)) activePageSlug.value = null;
    } catch (cause) {
      if (!controller.signal.aborted && !disposed) error.value = errorMessage(cause);
    } finally {
      if (pageController === controller) loadingPages.value = false;
    }
  }

  function streamOpened(controller: AbortController) {
    reconnectingStreams.delete(controller);
    if (!reconnectingStreams.size && error.value.startsWith("事件连接中断，正在重连。")) error.value = "";
  }

  function streamError(cause: unknown, controller: AbortController): boolean {
    if (cause instanceof api.GatewayError && (cause.status === 401 || cause.status === 403)) {
      stopConnections();
      error.value = errorMessage(cause);
      return true;
    }
    reconnectingStreams.add(controller);
    error.value = `事件连接中断，正在重连。${errorMessage(cause)}`;
    return false;
  }

  async function followGateway(controller: AbortController) {
    const version = connectionVersion;
    let reconnecting = false;
    while (!controller.signal.aborted && !disposed && version === connectionVersion) {
      try {
        await api.gatewayEvents(gatewayUrl.value, token.value, (event) => {
          if (controller.signal.aborted || disposed || version !== connectionVersion) return;
          if (event.type === "pages_changed") void refreshPages();
          else applyMeta(event.session);
        }, controller.signal, () => {
          streamOpened(controller);
          if (reconnecting) {
            void refreshPages();
            void refreshSessionList(controller.signal, version);
          }
        });
        if (!controller.signal.aborted) throw new Error("网关关闭了事件流。");
      } catch (cause) {
        if (controller.signal.aborted || disposed || version !== connectionVersion) return;
        if (streamError(cause, controller)) return;
      }
      reconnecting = true;
      await retryDelay(controller.signal);
    }
  }

  async function refreshSessionList(signal: AbortSignal, version: number) {
    try {
      const result = await api.listSessions(gatewayUrl.value, token.value, signal);
      if (signal.aborted || disposed || version !== connectionVersion) return;
      sessions.value = result;
      const selected = result.find((session) => session.id === activeSessionId.value);
      if (selected) applyMeta(selected);
    } catch (cause) {
      if (!signal.aborted && !disposed && version === connectionVersion) error.value = errorMessage(cause);
    }
  }

  function receiveEvent(id: string, event: SessionEvent) {
    const session = activeSession.value;
    if (!session || session.id !== id) return;
    session.events.push(event);
    if (event.type === "status") session.status = event.status;
    if (event.type === "published") {
      session.slug = event.page.slug;
      session.title = event.page.title;
      void refreshPages();
    }
    session.updatedAt = event.at;
    applyMeta(session);
  }

  async function followSession(id: string, controller: AbortController) {
    const version = connectionVersion;
    while (!controller.signal.aborted && !disposed && version === connectionVersion && activeSessionId.value === id) {
      try {
        // 以已加载的事件数量续传，历史回放和重连不会重复追加消息。
        const since = activeSession.value?.events.length ?? 0;
        await api.sessionEvents(gatewayUrl.value, token.value, id, since, (event) => {
          if (!controller.signal.aborted && !disposed && activeSessionId.value === id) receiveEvent(id, event);
        }, controller.signal, () => streamOpened(controller));
        if (!controller.signal.aborted) throw new Error("网关关闭了会话事件流。");
      } catch (cause) {
        if (controller.signal.aborted || disposed || version !== connectionVersion) return;
        if (streamError(cause, controller)) return;
      }
      await retryDelay(controller.signal);
    }
  }

  async function selectSession(id: string): Promise<void> {
    if (!connected.value || disposed) return;
    selectionVersion++;
    detailController?.abort();
    sessionController?.abort();
    if (sessionController) reconnectingStreams.delete(sessionController);
    const controller = new AbortController();
    detailController = controller;
    activeSessionId.value = id;
    activeSession.value = undefined;
    revisionPageSlug.value = null;
    loadingSession.value = true;
    error.value = "";
    try {
      const detail = await api.getSession(gatewayUrl.value, token.value, id, controller.signal);
      if (controller.signal.aborted || disposed || activeSessionId.value !== id) return;
      activeSession.value = detail;
      applyMeta(detail);
      sessionController = new AbortController();
      void followSession(id, sessionController);
    } catch (cause) {
      if (!controller.signal.aborted && !disposed) error.value = errorMessage(cause);
    } finally {
      if (detailController === controller) loadingSession.value = false;
    }
  }

  function startConversation() {
    selectionVersion++;
    detailController?.abort();
    sessionController?.abort();
    if (sessionController) reconnectingStreams.delete(sessionController);
    activeSessionId.value = null;
    activeSession.value = undefined;
    revisionPageSlug.value = null;
    loadingSession.value = false;
    error.value = "";
  }

  function revisePage(slug: string) {
    startConversation();
    revisionPageSlug.value = slug;
  }

  async function loadWorkspace(): Promise<void> {
    if (disposed) return;
    const selectedId = activeSessionId.value;
    stopConnections();
    error.value = "";
    if (!token.value.trim()) {
      error.value = "请先填写网关 token。";
      return;
    }
    try {
      gatewayUrl.value = api.normalizeGatewayUrl(gatewayUrl.value);
    } catch (cause) {
      error.value = errorMessage(cause);
      return;
    }
    const controller = new AbortController();
    workspaceController = controller;
    loadingSessions.value = true;
    loadingPages.value = true;
    try {
      const [sessionList, pageList] = await Promise.all([
        api.listSessions(gatewayUrl.value, token.value, controller.signal),
        api.listPages(gatewayUrl.value, token.value, controller.signal),
      ]);
      if (controller.signal.aborted || disposed) return;
      sessions.value = sessionList;
      pages.value = pageList;
      if (activePageSlug.value && !pageList.some((page) => page.slug === activePageSlug.value)) activePageSlug.value = null;
      connected.value = true;
      globalController = new AbortController();
      void followGateway(globalController);
      const id = sessionList.find((session) => session.id === selectedId)?.id ?? sessionList[0]?.id;
      if (id) await selectSession(id);
      else startConversation();
    } catch (cause) {
      if (!controller.signal.aborted && !disposed) error.value = errorMessage(cause);
    } finally {
      if (workspaceController === controller) {
        loadingSessions.value = false;
        loadingPages.value = false;
      }
    }
  }

  async function sendMessage(content: string): Promise<boolean> {
    const text = content.trim();
    if (!text || sending.value || loadingSession.value || disposed) return false;
    if (!connected.value) {
      error.value = "请在设置中连接网关后发送消息。";
      return false;
    }
    const id = activeSessionId.value;
    const selection = selectionVersion;
    const controller = new AbortController();
    sendController = controller;
    pendingSend.value = true;
    error.value = "";
    try {
      const meta = id
        ? await api.sendMessage(gatewayUrl.value, token.value, id, text, controller.signal)
        : await api.createWish(gatewayUrl.value, token.value, {
          wish: text, ...(revisionPageSlug.value ? { slug: revisionPageSlug.value } : {}),
        }, controller.signal);
      if (controller.signal.aborted || disposed) return false;
      applyMeta(meta);
      if (selection === selectionVersion) await selectSession(meta.id);
      return true;
    } catch (cause) {
      if (!controller.signal.aborted && !disposed) error.value = errorMessage(cause);
      return false;
    } finally {
      if (sendController === controller) pendingSend.value = false;
    }
  }

  async function eventAction(action: (id: string, signal: AbortSignal) => Promise<void>): Promise<boolean> {
    const id = activeSessionId.value;
    if (!id || !connected.value || eventActionBusy.value || disposed) return false;
    const controller = new AbortController();
    actionControllers.add(controller);
    eventActionBusy.value = true;
    error.value = "";
    try {
      await action(id, controller.signal);
      if (controller.signal.aborted || disposed) return false;
      if (activeSessionId.value === id) await selectSession(id);
      return true;
    } catch (cause) {
      if (!controller.signal.aborted && !disposed) error.value = errorMessage(cause);
      return false;
    } finally {
      actionControllers.delete(controller);
      if (!controller.signal.aborted) eventActionBusy.value = false;
    }
  }

  function answerQuestions(requestId: string, answers: ClarifyAnswers): Promise<boolean> {
    return eventAction((id, signal) => api.answerQuestions(gatewayUrl.value, token.value, id, requestId, answers, signal));
  }

  function resolveApproval(requestId: string, approved: boolean): Promise<boolean> {
    return eventAction((id, signal) => api.resolveApproval(gatewayUrl.value, token.value, id, requestId, approved, signal));
  }

  async function cancel(): Promise<boolean> {
    const id = activeSessionId.value;
    if (!id || !connected.value || cancelling.value || disposed) return false;
    const controller = new AbortController();
    actionControllers.add(controller);
    cancelling.value = true;
    error.value = "";
    try {
      const meta = await api.cancelSession(gatewayUrl.value, token.value, id, controller.signal);
      if (controller.signal.aborted || disposed) return false;
      applyMeta(meta);
      if (activeSessionId.value === id) await selectSession(id);
      return true;
    } catch (cause) {
      if (!controller.signal.aborted && !disposed) error.value = errorMessage(cause);
      return false;
    } finally {
      actionControllers.delete(controller);
      if (!controller.signal.aborted) cancelling.value = false;
    }
  }

  onMounted(() => {
    if (token.value.trim()) void loadWorkspace();
  });
  onBeforeUnmount(() => {
    disposed = true;
    stopConnections();
  });

  return {
    sessions, activeSessionId, activeSession, pages, activePageSlug, activePage, revisionPageSlug,
    preferences, token, gatewayUrl, loadingSessions, loadingPages, loadingSession,
    error, connected, sending, cancelling, eventActionBusy,
    loadWorkspace, selectSession, startConversation, sendMessage, answerQuestions, resolveApproval, cancel, revisePage,
  };
}

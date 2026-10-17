import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ClarifyAnswers, CreateWishBody, PageView, SessionDetail, SessionEvent, SessionMeta } from "@qdd/shared";
import * as api from "@/api/workspace";
import { createConversationSelection } from "./conversationSelection";
import type { LiveBlocks } from "@/utils/chatTimeline";

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
  /** 当前会话尚未完成的流式块 */
  const liveBlocks = ref<{ sessionId: string | null; blocks: LiveBlocks }>({ sessionId: null, blocks: {} });
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
  const gatewayChanges = ref({ overview: 0, pending: 0, skills: 0, schedules: 0, connectors: 0 });
  const selectionVersion = ref(0);
  const pendingSends = ref(new Set<string>());
  const pendingMessages = ref(new Map<string, { event: Extract<SessionEvent, { type: "user" }>; cursor: number }>());
  const pendingStops = ref(new Set<string>());
  const pendingCancellations = ref(new Set<string>());
  const pendingActions = ref(new Set<string>());
  const pendingPagePins = ref(new Set<string>());
  const sendTarget = () => activeSessionId.value ?? `draft:${selectionVersion.value}`;
  const pendingSend = computed(() => pendingSends.value.has(sendTarget()));
  const conversationStatus = computed(() => activeSession.value?.status
    ?? sessions.value.find((session) => session.id === activeSessionId.value)?.status);
  const responding = computed(() => pendingSend.value || conversationStatus.value === "running");
  const cancelling = computed(() => pendingStops.value.has(sendTarget())
    || (!!activeSessionId.value && pendingCancellations.value.has(activeSessionId.value)));
  const sending = computed(() => responding.value || conversationStatus.value === "waiting" || cancelling.value);
  const canCancel = computed(() => pendingSend.value || conversationStatus.value === "running" || conversationStatus.value === "waiting");
  const pendingMessage = computed(() => {
    const pending = pendingMessages.value.get(sendTarget());
    if (!pending) return undefined;
    const received = activeSession.value?.events.slice(pending.cursor)
      .some((event) => event.type === "user" && event.text === pending.event.text);
    return received ? undefined : pending.event;
  });
  const eventActionBusy = computed(() => !!activeSessionId.value && pendingActions.value.has(activeSessionId.value));
  let disposed = false;
  let documentSuspended = false;
  let connectionVersion = 0;
  let pageRequestVersion = 0;
  let workspaceController: AbortController | undefined;
  let pageController: AbortController | undefined;
  let detailController: AbortController | undefined;
  let globalController: AbortController | undefined;
  let sessionController: AbortController | undefined;
  const sendControllers = new Set<AbortController>();
  const sendRequests = new Map<string, { stopRequested: boolean; sessionId: string | undefined; signal: AbortSignal }>();
  const actionControllers = new Set<AbortController>();
  const reconnectingStreams = new Set<AbortController>();
  let conversationStorage: Storage | undefined;
  try { conversationStorage = localStorage; } catch { /* Retain the choice in memory if storage is unavailable. */ }
  const conversationSelection = createConversationSelection(conversationStorage);

  function normalizedGateway(base = gatewayUrl.value): string | null {
    try { return api.normalizeGatewayUrl(base); } catch { return null; }
  }

  try {
    const saved: unknown = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || "null");
    if (saved && typeof saved === "object") {
      const value = saved as Record<string, unknown>;
      preferences.value = {
        theme: value.theme === "dark" ? "dark" : "light",
        enterToSend: typeof value.enterToSend === "boolean" ? value.enterToSend : true,
      };
    }
    gatewayUrl.value = localStorage.getItem(GATEWAY_KEY) || __DEV_GATEWAY_URL__ || api.DEFAULT_GATEWAY_URL;
    // 开发时网关与前端同机：主机名跟随当前访问地址，否则任务页面 iframe 属跨站，页面 cookie 不会带上。
    if (import.meta.env.DEV) {
      try {
        const url = new URL(gatewayUrl.value);
        url.hostname = window.location.hostname;
        gatewayUrl.value = url.origin;
      } catch { /* 保留原地址，由连接设置提示错误。 */ }
    }
  } catch {
    // 浏览器禁用存储时仍可在当前页面设置连接与偏好。
  }
  try {
    token.value = sessionStorage.getItem(TOKEN_KEY) || __DEV_GATEWAY_TOKEN__;
  } catch {
    // token 只在当前标签页保存，存储不可用时留在内存。
  }

  watch(preferences, () => {
    try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences.value)); } catch { /* 保留内存中的偏好。 */ }
  }, { deep: true });

  function stopConnections() {
    connectionVersion++;
    selectionVersion.value++;
    workspaceController?.abort();
    pageController?.abort();
    detailController?.abort();
    globalController?.abort();
    sessionController?.abort();
    for (const controller of sendControllers) controller.abort();
    sendControllers.clear();
    for (const controller of actionControllers) controller.abort();
    actionControllers.clear();
    reconnectingStreams.clear();
    connected.value = false;
    loadingSessions.value = false;
    loadingPages.value = false;
    loadingSession.value = false;
    pendingSends.value.clear();
    pendingMessages.value.clear();
    pendingStops.value.clear();
    sendRequests.clear();
    pendingCancellations.value.clear();
    pendingActions.value.clear();
    pendingPagePins.value.clear();
  }

  watch([token, gatewayUrl], ([, nextGateway], [, previousGateway]) => {
    const previousKey = normalizedGateway(previousGateway);
    const sameGateway = previousKey !== null && previousKey === normalizedGateway(nextGateway);
    stopConnections();
    sessions.value = [];
    pages.value = [];
    activeSessionId.value = null;
    activeSession.value = undefined;
    activePageSlug.value = null;
    if (!sameGateway) revisionPageSlug.value = null;
    error.value = "";
    try { sessionStorage.setItem(TOKEN_KEY, token.value); } catch { /* token 不写入 localStorage。 */ }
    try { localStorage.setItem(GATEWAY_KEY, gatewayUrl.value); } catch { /* 地址仍可在当前页面使用。 */ }
  }, { flush: "sync" });

  function applyMeta(meta: SessionMeta) {
    const current = sessions.value.find((session) => session.id === meta.id);
    if (current && current.updatedAt > meta.updatedAt) return;
    if (meta.status === "idle" || meta.status === "error") pendingStops.value.delete(meta.id);
    const entry: SessionMeta = {
      id: meta.id, title: meta.title, summary: meta.summary, slug: meta.slug,
      status: meta.status, createdAt: meta.createdAt, updatedAt: meta.updatedAt,
      ...(meta.origin ? { origin: meta.origin } : {}),
    };
    const index = sessions.value.findIndex((session) => session.id === meta.id);
    if (index === -1) sessions.value.push(entry);
    else sessions.value[index] = entry;
    sessions.value.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (activeSession.value?.id === meta.id) activeSession.value = { ...activeSession.value, ...entry };
  }

  function applyResponseMeta(meta: SessionMeta) {
    const current = sessions.value.find((session) => session.id === meta.id);
    // Live events may advance the session before a mutation response arrives.
    if (!current || meta.updatedAt >= current.updatedAt) applyMeta(meta);
  }

  async function refreshPages() {
    if (!connected.value || disposed) return;
    const version = ++pageRequestVersion;
    pageController?.abort();
    const controller = new AbortController();
    pageController = controller;
    loadingPages.value = true;
    try {
      const result = await api.listPages(gatewayUrl.value, token.value, controller.signal);
      if (controller.signal.aborted || disposed || version !== pageRequestVersion) return;
      pages.value = result;
      if (activePageSlug.value && !result.some((page) => page.slug === activePageSlug.value)) activePageSlug.value = null;
    } catch (cause) {
      if (!controller.signal.aborted && !disposed) error.value = errorMessage(cause);
    } finally {
      if (pageController === controller && version === pageRequestVersion) loadingPages.value = false;
    }
  }

  async function setPagePinned(slug: string, pinned: boolean): Promise<boolean> {
    if (!connected.value || disposed || pendingPagePins.value.has(slug)) return false;
    const controller = new AbortController();
    actionControllers.add(controller);
    pendingPagePins.value.add(slug);
    error.value = "";
    try {
      await api.setPagePinned(gatewayUrl.value, token.value, slug, pinned, controller.signal);
      if (controller.signal.aborted || disposed) return false;
      // The gateway owns pin order, including pins made from another window.
      await refreshPages();
      return !controller.signal.aborted && !disposed;
    } catch (cause) {
      if (!controller.signal.aborted && !disposed) error.value = errorMessage(cause);
      return false;
    } finally {
      actionControllers.delete(controller);
      if (!controller.signal.aborted) pendingPagePins.value.delete(slug);
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
          else if (event.type === "session_updated") applyMeta(event.session);
          else if (event.type === "pending_changed") gatewayChanges.value.pending++;
          else if (event.type === "skills_changed") gatewayChanges.value.skills++;
          else if (event.type === "schedules_changed") {
            gatewayChanges.value.schedules++;
            void refreshPages();
          }
          else if (event.type === "connectors_changed") gatewayChanges.value.connectors++;
          gatewayChanges.value.overview++;
        }, controller.signal, () => {
          streamOpened(controller);
          if (reconnecting) {
            void refreshPages();
            void refreshSessionList(controller.signal, version);
            for (const key of Object.keys(gatewayChanges.value) as (keyof typeof gatewayChanges.value)[]) gatewayChanges.value[key]++;
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
    if (liveBlocks.value.sessionId !== id) liveBlocks.value = { sessionId: id, blocks: {} };
    if ((event.type === "text" || event.type === "thinking") && event.delta !== undefined) {
      // 流式增量不落盘，不能进入 events，否则会打乱 since 续传偏移
      const block = liveBlocks.value.blocks[event.blockId] ??= { type: event.type, content: "" };
      block.content += event.delta;
      return;
    }
    if ((event.type === "text" || event.type === "thinking") && event.done) delete liveBlocks.value.blocks[event.blockId];
    session.events.push(event);
    if (event.type === "status" && event.at >= session.updatedAt) session.status = event.status;
    if (event.type === "published") {
      session.slug = event.page.slug;
      session.title = event.page.title;
      if (revisionPageSlug.value === event.page.slug) revisionPageSlug.value = null;
      void refreshPages();
    }
    session.updatedAt = event.at > session.updatedAt ? event.at : session.updatedAt;
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
    if (activeSessionId.value === id && activeSession.value?.id === id && sessionController && !sessionController.signal.aborted) return;
    const selection = ++selectionVersion.value;
    detailController?.abort();
    sessionController?.abort();
    if (sessionController) reconnectingStreams.delete(sessionController);
    const controller = new AbortController();
    detailController = controller;
    if (activeSessionId.value !== id) revisionPageSlug.value = null;
    activeSessionId.value = id;
    const gateway = normalizedGateway();
    if (gateway) conversationSelection.remember(gateway, id);
    activeSession.value = undefined;
    loadingSession.value = true;
    error.value = "";
    try {
      const detail = await api.getSession(gatewayUrl.value, token.value, id, controller.signal);
      if (controller.signal.aborted || disposed || selection !== selectionVersion.value) return;
      const current = sessions.value.find((session) => session.id === id);
      activeSession.value = current && current.updatedAt > detail.updatedAt ? { ...detail, ...current } : detail;
      applyResponseMeta(activeSession.value);
      sessionController = new AbortController();
      void followSession(id, sessionController);
    } catch (cause) {
      if (!controller.signal.aborted && !disposed && selection === selectionVersion.value) error.value = errorMessage(cause);
    } finally {
      if (detailController === controller) loadingSession.value = false;
    }
  }

  function startNewConversation(): void {
    if (disposed) return;
    selectionVersion.value++;
    detailController?.abort();
    sessionController?.abort();
    if (sessionController) reconnectingStreams.delete(sessionController);
    activeSessionId.value = null;
    activeSession.value = undefined;
    revisionPageSlug.value = null;
    loadingSession.value = false;
    error.value = "";
    const gateway = normalizedGateway();
    if (gateway) conversationSelection.remember(gateway, null);
  }

  async function openConversation(): Promise<void> {
    if (!connected.value || disposed || pendingSend.value || loadingSession.value) return;
    const gateway = normalizedGateway();
    if (!gateway) return;
    const id = conversationSelection.choose(gateway, sessions.value, activeSessionId.value);
    if (id && (activeSessionId.value !== id || !activeSession.value)) await selectSession(id);
  }

  async function revisePage(slug: string): Promise<boolean> {
    revisionPageSlug.value = null;
    if (!connected.value || disposed) {
      error.value = "请先连接网关，再通过对话修改页面。";
      return false;
    }
    if (pendingSend.value || loadingSession.value) {
      error.value = "正在加载或发送当前对话，请稍后重试。";
      return false;
    }
    const page = pages.value.find((entry) => entry.slug === slug);
    const current = activeSession.value ?? sessions.value.find((session) => session.id === activeSessionId.value);
    const origin = current?.slug === slug ? current
      : page?.sessionId ? sessions.value.find((session) => session.id === page.sessionId) : undefined;
    if (!page || !origin) {
      error.value = "这个页面的原始对话尚不可用，请刷新工作空间后重试；不会为此新增对话。";
      return false;
    }
    const selection = activeSession.value?.id !== origin.id
      ? selectSession(origin.id) : undefined;
    const version = selectionVersion.value;
    await selection;
    if (version !== selectionVersion.value) return false;
    if (!activeSession.value || activeSession.value.id !== origin.id || activeSession.value.slug !== slug) {
      if (!error.value) error.value = "页面与原始对话的关联尚不可用，请刷新工作空间后重试。";
      return false;
    }
    revisionPageSlug.value = slug;
    return true;
  }

  async function loadWorkspace(): Promise<void> {
    if (disposed || documentSuspended) return;
    // Refreshing history must not abort a POST that may already have created a session.
    // Keep the current identity, pending sends, and live streams on an existing connection.
    const refreshing = connected.value;
    if (!refreshing) stopConnections();
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
    workspaceController?.abort();
    pageController?.abort();
    const pageVersion = ++pageRequestVersion;
    const controller = new AbortController();
    const sessionSnapshot = new Map(sessions.value.map((session) => [session.id, session.updatedAt]));
    workspaceController = controller;
    loadingSessions.value = true;
    loadingPages.value = true;
    try {
      const [sessionList, pageList] = await Promise.all([
        api.listSessions(gatewayUrl.value, token.value, controller.signal),
        api.listPages(gatewayUrl.value, token.value, controller.signal),
      ]);
      if (controller.signal.aborted || disposed) return;
      const previous = sessions.value;
      sessions.value = sessionList.map((entry) => {
        const current = previous.find((session) => session.id === entry.id);
        return current && current.updatedAt > entry.updatedAt ? current : entry;
      });
      for (const entry of previous) {
        if (!sessions.value.some((session) => session.id === entry.id)
          && (!sessionSnapshot.has(entry.id) || sessionSnapshot.get(entry.id) !== entry.updatedAt
            || pendingSends.value.has(entry.id))) applyResponseMeta(entry);
      }
      if (pageVersion === pageRequestVersion) {
        pages.value = pageList;
        if (activePageSlug.value && !pageList.some((page) => page.slug === activePageSlug.value)) activePageSlug.value = null;
      }
      connected.value = true;
      if (!refreshing) {
        globalController = new AbortController();
        void followGateway(globalController);
      }
      if (pendingSend.value) return;
      const selected = sessions.value.find((session) => session.id === activeSessionId.value);
      if (selected) applyResponseMeta(selected);
      const id = conversationSelection.choose(gatewayUrl.value, sessions.value, activeSessionId.value);
      if (id) await selectSession(id);
      else {
        detailController?.abort();
        sessionController?.abort();
        if (sessionController) reconnectingStreams.delete(sessionController);
        activeSessionId.value = null;
        activeSession.value = undefined;
      }
    } catch (cause) {
      if (!controller.signal.aborted && !disposed) error.value = errorMessage(cause);
    } finally {
      if (workspaceController === controller) {
        loadingSessions.value = false;
        if (pageVersion === pageRequestVersion) loadingPages.value = false;
      }
    }
  }

  async function sendMessage(content: string, options: Pick<CreateWishBody, "skillId" | "model"> & { attachments?: api.AttachmentRef[] } = {}): Promise<boolean> {
    const text = content.trim();
    if (!text || sending.value || loadingSession.value || disposed) return false;
    if (!connected.value) {
      error.value = "请在设置中连接网关后发送消息。";
      return false;
    }
    const gateway = normalizedGateway();
    if (!gateway) return false;
    const id = activeSessionId.value;
    const meta = activeSession.value ?? sessions.value.find((session) => session.id === id);
    if (meta?.status === "running" || meta?.status === "waiting") {
      error.value = "请先完成当前对话的问题、授权确认或执行。";
      return false;
    }
    if (revisionPageSlug.value && (!id || meta?.slug !== revisionPageSlug.value)) {
      revisionPageSlug.value = null;
      error.value = "页面与当前对话的关联已变化，请重新打开页面的原始对话后修改。";
      return false;
    }
    const selection = selectionVersion.value;
    const target = sendTarget();
    const controller = new AbortController();
    const request = { stopRequested: false, sessionId: undefined as string | undefined, signal: controller.signal };
    let responseTarget = target;
    sendControllers.add(controller);
    sendRequests.set(target, request);
    pendingSends.value.add(target);
    pendingMessages.value.set(target, {
      event: { type: "user", text, ...(options.attachments?.length ? { attachments: options.attachments } : {}), at: new Date().toISOString() },
      cursor: activeSession.value?.events.length ?? 0,
    });
    error.value = "";
    const extra = {
      ...(options.attachments?.length ? { attachments: options.attachments.map((a) => a.id) } : {}),
      ...(options.model ? { model: options.model } : {}),
    };
    try {
      const meta = id
        ? await api.sendMessage(gatewayUrl.value, token.value, id, text, controller.signal, extra)
        : await api.createWish(gatewayUrl.value, token.value, {
          wish: text, ...(revisionPageSlug.value ? { slug: revisionPageSlug.value } : {}),
          ...(options.skillId ? { skillId: options.skillId } : {}), ...extra,
        }, controller.signal);
      if (controller.signal.aborted || disposed) return false;
      // Keep the identity even if the following detail/SSE request fails.
      applyResponseMeta(meta);
      responseTarget = meta.id;
      request.sessionId = meta.id;
      // Transfer the draft's pending state before exposing its new session identity.
      pendingSends.value.add(meta.id);
      sendRequests.set(meta.id, request);
      const pending = pendingMessages.value.get(target);
      if (pending) pendingMessages.value.set(meta.id, pending);
      let cancellationError = "";
      if (request.stopRequested) {
        if (!await cancelSession(meta.id, controller.signal, selection)) cancellationError = error.value;
        if (controller.signal.aborted || disposed) return false;
      }
      if (selection === selectionVersion.value) {
        conversationSelection.remember(gateway, meta.id);
        activeSessionId.value = meta.id;
        revisionPageSlug.value = null;
        await selectSession(meta.id);
        if (cancellationError && activeSessionId.value === meta.id) error.value = cancellationError;
      }
      return true;
    } catch (cause) {
      if (sendRequests.get(target) === request) pendingMessages.value.delete(target);
      if (sendRequests.get(responseTarget) === request) pendingMessages.value.delete(responseTarget);
      if (!controller.signal.aborted && !disposed && selection === selectionVersion.value) error.value = errorMessage(cause);
      return false;
    } finally {
      sendControllers.delete(controller);
      if (sendRequests.get(target) === request) sendRequests.delete(target);
      if (sendRequests.get(responseTarget) === request) sendRequests.delete(responseTarget);
      if (!controller.signal.aborted) {
        pendingSends.value.delete(target);
        pendingSends.value.delete(responseTarget);
        if (target !== responseTarget || !request.stopRequested || !request.sessionId) pendingStops.value.delete(target);
        if (target !== responseTarget) pendingMessages.value.delete(target);
      }
    }
  }

  async function eventAction(action: (id: string, signal: AbortSignal) => Promise<void>): Promise<boolean> {
    const id = activeSessionId.value;
    if (!id || !connected.value || eventActionBusy.value || disposed) return false;
    const selection = selectionVersion.value;
    const controller = new AbortController();
    actionControllers.add(controller);
    pendingActions.value.add(id);
    error.value = "";
    try {
      await action(id, controller.signal);
      if (controller.signal.aborted || disposed) return false;
      return true;
    } catch (cause) {
      if (!controller.signal.aborted && !disposed && selection === selectionVersion.value) error.value = errorMessage(cause);
      return false;
    } finally {
      actionControllers.delete(controller);
      if (!controller.signal.aborted) pendingActions.value.delete(id);
    }
  }

  function answerQuestions(requestId: string, answers: ClarifyAnswers): Promise<boolean> {
    return eventAction((id, signal) => api.answerQuestions(gatewayUrl.value, token.value, id, requestId, answers, signal));
  }

  function resolveApproval(requestId: string, approved: boolean): Promise<boolean> {
    return eventAction((id, signal) => api.resolveApproval(gatewayUrl.value, token.value, id, requestId, approved, signal));
  }

  async function cancelSession(id: string, signal: AbortSignal, selection: number): Promise<boolean> {
    pendingCancellations.value.add(id);
    pendingStops.value.add(id);
    error.value = "";
    try {
      const meta = await api.cancelSession(gatewayUrl.value, token.value, id, signal);
      if (signal.aborted || disposed) return false;
      applyResponseMeta(meta);
      const latest = sessions.value.find((session) => session.id === id);
      if (latest?.status === "idle" || latest?.status === "error") pendingStops.value.delete(id);
      return true;
    } catch (cause) {
      if (!signal.aborted) pendingStops.value.delete(id);
      if (!signal.aborted && !disposed && selection === selectionVersion.value) error.value = errorMessage(cause);
      return false;
    } finally {
      if (!signal.aborted) pendingCancellations.value.delete(id);
    }
  }

  async function cancel(): Promise<boolean> {
    if (!connected.value || cancelling.value || disposed) return false;
    const target = sendTarget();
    const request = sendRequests.get(target);
    if (request) {
      // Aborting the creation request can orphan a real session. Cancel it once
      // the server returns its identity, and keep submissions locked meanwhile.
      request.stopRequested = true;
      pendingStops.value.add(target);
      if (request.sessionId) return cancelSession(request.sessionId, request.signal, selectionVersion.value);
      return true;
    }
    const id = activeSessionId.value;
    if (!id) return false;
    const controller = new AbortController();
    actionControllers.add(controller);
    try {
      return await cancelSession(id, controller.signal, selectionVersion.value);
    } finally {
      actionControllers.delete(controller);
    }
  }

  function pageHide() {
    documentSuspended = true;
    // Full navigation does not unmount Vue. Release SSE before the old document freezes.
    stopConnections();
  }

  function pageShow() {
    if (disposed || !documentSuspended) return;
    documentSuspended = false;
    if (token.value.trim()) void loadWorkspace();
  }

  onMounted(() => {
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", pageHide);
      window.addEventListener("pageshow", pageShow);
    }
    if (token.value.trim()) void loadWorkspace();
  });
  onBeforeUnmount(() => {
    disposed = true;
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", pageHide);
      window.removeEventListener("pageshow", pageShow);
    }
    stopConnections();
  });

  return {
    sessions, activeSessionId, activeSession, liveBlocks, pages, activePageSlug, activePage, revisionPageSlug,
    preferences, token, gatewayUrl, loadingSessions, loadingPages, loadingSession,
    error, connected, gatewayChanges, sending, responding, pendingMessage, canCancel, cancelling, eventActionBusy, pendingPagePins,
    loadWorkspace, openConversation, selectSession, startNewConversation,
    sendMessage, answerQuestions, resolveApproval, cancel, revisePage, setPagePinned, applyResponseMeta,
  };
}

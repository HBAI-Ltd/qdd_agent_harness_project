import type { BrowserInput, BrowserSessionState, BrowserStreamEvent } from "@qdd/shared";
import * as browserApi from "../api/browser";

type Frame = Extract<BrowserStreamEvent, { type: "frame" }>;
export interface BrowserViewerState {
  session: BrowserSessionState | undefined;
  frame: (Frame & { sequence: number }) | undefined;
  connecting: boolean;
  online: boolean;
  manual: boolean;
  inputBusy: boolean;
  error: string;
}
export const emptyBrowserViewer = (): BrowserViewerState => ({
  session: undefined, frame: undefined, connecting: false, online: false,
  manual: false, inputBusy: false, error: "",
});

export function frameCoordinates(clientX: number, clientY: number, bounds: { left: number; top: number; width: number; height: number }, frame: { width: number; height: number }): { x: number; y: number } | undefined {
  const x = clientX - bounds.left;
  const y = clientY - bounds.top;
  if (![x, y, bounds.width, bounds.height, frame.width, frame.height].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0 || frame.width <= 0 || frame.height <= 0
    || x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return;
  return { x: Math.min(frame.width - 1, Math.floor(x * frame.width / bounds.width)), y: Math.min(frame.height - 1, Math.floor(y * frame.height / bounds.height)) };
}

export function createBrowserViewer(state: BrowserViewerState, credentials: () => { base: string; token: string }, api = browserApi) {
  let version = 0;
  let stateVersion = 0;
  let sequence = 0;
  let streamController: AbortController | undefined;
  let inputController: AbortController | undefined;
  let connection: { base: string; token: string; id: string } | undefined;
  type KeyboardAction = Extract<BrowserInput, { type: "text" | "key" }>;
  type PointerAction = Extract<BrowserInput, { type: "mouse" | "wheel" }>;
  type QueuedInput = { action: KeyboardAction | PointerAction; resolve: (sent: boolean) => void };
  let queueVersion = 0;
  let drainingVersion: number | undefined;
  let inputQueue: QueuedInput[] = [];
  let activeInput: QueuedInput | undefined;
  const inputIdle = new Set<() => void>();

  function wakeInputWaiters() {
    for (const resolve of inputIdle) resolve();
    inputIdle.clear();
  }
  function clearInputQueue() {
    queueVersion++;
    drainingVersion = undefined;
    for (const item of inputQueue) item.resolve(false);
    inputQueue = [];
    activeInput?.resolve(false);
    activeInput = undefined;
    wakeInputWaiters();
  }
  function controlReady(): boolean {
    return state.manual && state.online && !!state.frame && !!state.session && !!connection
      && state.session.status === "running" && state.frame.tabId === state.session.tabId
      && state.frame.sessionId === connection.id;
  }

  function release(tabId = state.session?.tabId) {
    if (!connection || !tabId) return;
    const { base, token, id } = connection;
    void api.browserInput(base, token, id, tabId, { type: "release" }).catch(() => undefined);
  }
  function stop() {
    version++;
    streamController?.abort();
    inputController?.abort();
    streamController = undefined;
    inputController = undefined;
    clearInputQueue();
    release();
    connection = undefined;
    state.frame = undefined;
    state.online = false;
    state.connecting = false;
    state.manual = false;
    state.inputBusy = false;
  }
  function markClosed() {
    const session = state.session;
    stop();
    if (session) state.session = { ...session, status: "closed" };
    state.error = "";
  }
  function applyState(session: BrowserSessionState): boolean {
    if (!connection || session.browserSessionId !== connection.id) return false;
    if (state.session?.tabId !== session.tabId || state.session?.url !== session.url) {
      inputController?.abort();
      inputController = undefined;
      state.inputBusy = false;
      clearInputQueue();
      if (state.manual) release();
      state.manual = false;
      state.frame = undefined;
    }
    state.session = session;
    stateVersion++;
    if (session.status === "closed") stop();
    return true;
  }
  function accept(event: BrowserStreamEvent, expectedVersion: number) {
    if (expectedVersion !== version || streamController?.signal.aborted || !connection) return;
    if (event.type === "state") {
      if (applyState(event.session) && event.session.status === "running") {
        state.online = true;
        state.connecting = false;
      }
    } else if (event.type === "frame") {
      if (event.sessionId !== connection.id || event.tabId !== state.session?.tabId || state.session.status !== "running"
        || event.mimeType !== "image/jpeg" || !event.data || !/^[A-Za-z0-9+/=\r\n]+$/.test(event.data)
        || !Number.isInteger(event.width) || !Number.isInteger(event.height)
        || event.width <= 0 || event.height <= 0 || event.width > 10000 || event.height > 10000) return;
      state.frame = { ...event, sequence: ++sequence };
      state.online = true;
      state.connecting = false;
    } else if (event.type === "closed") {
      if (event.sessionId !== connection.id) return;
      if (state.session) state.session = { ...state.session, status: "closed" };
      stop();
    } else {
      stop();
      state.error = event.message;
    }
  }
  async function start(session: BrowserSessionState) {
    stop();
    state.session = session;
    state.error = "";
    if (session.status === "closed") return;
    connection = { ...credentials(), id: session.browserSessionId };
    const config = connection;
    const controller = new AbortController();
    streamController = controller;
    const current = version;
    state.connecting = true;
    try {
      const latest = await api.getBrowser(config.base, config.token, config.id, controller.signal);
      if (current !== version || controller.signal.aborted) return;
      if (!applyState(latest)) throw new Error("浏览器会话与当前对话不匹配。");
      if (latest.status === "closed") return;
      await api.browserEvents(config.base, config.token, config.id, (event) => accept(event, current), controller.signal);
      if (current === version && !controller.signal.aborted) throw new Error("实时画面连接已中断，请重新连接。");
    } catch (cause) {
      if (current !== version || controller.signal.aborted) return;
      if (cause && typeof cause === "object" && "status" in cause && cause.status === 404) {
        markClosed();
        return;
      }
      stop();
      state.error = cause instanceof Error ? cause.message : "无法连接浏览器画面。";
    }
  }
  function releaseInput() {
    inputController?.abort();
    inputController = undefined;
    state.inputBusy = false;
    clearInputQueue();
    release();
  }
  function setManual(manual: boolean) {
    if (!manual) releaseInput();
    state.manual = manual && state.online && !!state.frame && state.session?.status === "running";
    if (state.manual) state.error = "";
  }
  async function input(action: BrowserInput): Promise<boolean> {
    if (!controlReady() || !state.session || !connection || state.inputBusy) return false;
    if (["navigate", "back", "forward", "reload"].includes(action.type)) clearInputQueue();
    const { base, token, id } = connection;
    const tabId = state.session.tabId;
    const current = version;
    const currentState = stateVersion;
    const controller = new AbortController();
    inputController = controller;
    state.inputBusy = true;
    try {
      const result = await api.browserInput(base, token, id, tabId, action, controller.signal);
      if (current !== version || controller.signal.aborted || !state.manual || state.session.tabId !== tabId) return false;
      if (result.browserSessionId !== id) throw new Error("浏览器响应与当前会话不匹配。");
      if (currentState === stateVersion) applyState(result);
      return true;
    } catch (cause) {
      if (current !== version || controller.signal.aborted) return false;
      if (cause && typeof cause === "object" && "status" in cause && cause.status === 404) {
        markClosed();
        return false;
      }
      clearInputQueue();
      release(tabId);
      state.error = cause instanceof Error ? cause.message : "浏览器操作失败。";
      if (cause && typeof cause === "object" && "status" in cause && cause.status === 409) {
        state.frame = undefined;
        state.manual = false;
        state.error = "页面状态已变化，这次输入未重试。请等待新画面后重新开启人工接管。";
      }
      return false;
    } finally {
      if (inputController === controller) {
        inputController = undefined;
        state.inputBusy = false;
        wakeInputWaiters();
      }
    }
  }
  async function drainInputQueue() {
    if (drainingVersion !== undefined) return;
    const current = queueVersion;
    drainingVersion = current;
    try {
      while (current === queueVersion && inputQueue.length) {
        if (state.inputBusy) {
          await new Promise<void>((resolve) => inputIdle.add(resolve));
          continue;
        }
        if (!controlReady()) {
          clearInputQueue();
          return;
        }
        const item = inputQueue.shift();
        if (!item) break;
        activeInput = item;
        const sent = await input(item.action);
        if (activeInput === item) activeInput = undefined;
        item.resolve(sent);
        if (current !== queueVersion) return;
        if (!sent) {
          clearInputQueue();
          return;
        }
      }
    } finally {
      if (drainingVersion === current) drainingVersion = undefined;
    }
  }
  function queueInput(action: KeyboardAction | PointerAction): Promise<boolean> {
    if (!controlReady()) return Promise.resolve(false);
    return new Promise((resolve) => {
      const last = inputQueue.at(-1);
      // Preserve press/release/key boundaries while bounding a burst of pointer movement.
      if (action.type === "mouse" && action.event === "move"
        && last?.action.type === "mouse" && last.action.event === "move") {
        last.resolve(false);
        inputQueue[inputQueue.length - 1] = { action: { ...action }, resolve };
      } else inputQueue.push({ action: { ...action }, resolve });
      void drainInputQueue();
    });
  }
  const queueKeyboard = (action: KeyboardAction) => queueInput(action);
  const queuePointer = (action: PointerAction) => queueInput(action);
  return { start, stop, setManual, releaseInput, input, queueKeyboard, queuePointer };
}

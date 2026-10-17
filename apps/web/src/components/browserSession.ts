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
  type QueuedKeyboard = { action: KeyboardAction; resolve: (sent: boolean) => void };
  let keyboardVersion = 0;
  let drainingVersion: number | undefined;
  let keyboardQueue: QueuedKeyboard[] = [];
  let activeKeyboard: QueuedKeyboard | undefined;
  const inputIdle = new Set<() => void>();

  function wakeInputWaiters() {
    for (const resolve of inputIdle) resolve();
    inputIdle.clear();
  }
  function clearKeyboardQueue() {
    keyboardVersion++;
    drainingVersion = undefined;
    for (const item of keyboardQueue) item.resolve(false);
    keyboardQueue = [];
    activeKeyboard?.resolve(false);
    activeKeyboard = undefined;
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
    clearKeyboardQueue();
    release();
    connection = undefined;
    state.frame = undefined;
    state.online = false;
    state.connecting = false;
    state.manual = false;
    state.inputBusy = false;
  }
  function applyState(session: BrowserSessionState): boolean {
    if (!connection || session.browserSessionId !== connection.id) return false;
    if (state.session?.tabId !== session.tabId || state.session?.url !== session.url) {
      inputController?.abort();
      inputController = undefined;
      state.inputBusy = false;
      clearKeyboardQueue();
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
      stop();
      state.error = cause instanceof Error ? cause.message : "无法连接浏览器画面。";
    }
  }
  function releaseInput() {
    inputController?.abort();
    inputController = undefined;
    state.inputBusy = false;
    clearKeyboardQueue();
    release();
  }
  function setManual(manual: boolean) {
    if (!manual) releaseInput();
    state.manual = manual && state.online && !!state.frame && state.session?.status === "running";
    if (state.manual) state.error = "";
  }
  async function input(action: BrowserInput): Promise<boolean> {
    if (!controlReady() || !state.session || !connection || state.inputBusy) return false;
    if (["navigate", "back", "forward", "reload"].includes(action.type)) clearKeyboardQueue();
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
      clearKeyboardQueue();
      state.error = cause instanceof Error ? cause.message : "浏览器操作失败。";
      if (cause && typeof cause === "object" && "status" in cause && cause.status === 409) {
        state.frame = undefined;
        state.manual = false;
        release(tabId);
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
  async function drainKeyboardQueue() {
    if (drainingVersion !== undefined) return;
    const current = keyboardVersion;
    drainingVersion = current;
    try {
      while (current === keyboardVersion && keyboardQueue.length) {
        if (state.inputBusy) {
          await new Promise<void>((resolve) => inputIdle.add(resolve));
          continue;
        }
        if (!controlReady()) {
          clearKeyboardQueue();
          return;
        }
        const item = keyboardQueue.shift();
        if (!item) break;
        activeKeyboard = item;
        const sent = await input(item.action);
        if (activeKeyboard === item) activeKeyboard = undefined;
        item.resolve(sent);
        if (current !== keyboardVersion) return;
        if (!sent) {
          clearKeyboardQueue();
          return;
        }
      }
    } finally {
      if (drainingVersion === current) drainingVersion = undefined;
    }
  }
  function queueKeyboard(action: KeyboardAction): Promise<boolean> {
    if (!controlReady()) return Promise.resolve(false);
    return new Promise((resolve) => {
      keyboardQueue.push({ action: { ...action }, resolve });
      void drainKeyboardQueue();
    });
  }
  return { start, stop, setManual, releaseInput, input, queueKeyboard };
}

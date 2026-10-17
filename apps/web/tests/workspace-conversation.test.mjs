import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createRenderer, h } from "vue";

// Resolve the same source modules as Vite while testing the actual composable.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/api/workspace") {
      return { url: new URL("../src/api/workspace.ts", import.meta.url).href, shortCircuit: true };
    }
    if (specifier === "./conversationSelection" && context.parentURL?.endsWith("/useWorkspace.ts")) {
      return { url: new URL("../src/composables/conversationSelection.ts", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { useWorkspace } = await import("../src/composables/useWorkspace.ts");
const originalFetch = globalThis.fetch;
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const mounted = [];
const gateway = "http://127.0.0.1:3000";

function browserStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

function session(id, updatedAt = "2026-10-17T01:00:00Z", slug = null) {
  return { id, title: id, summary: "", slug, status: "idle", createdAt: updatedAt, updatedAt, events: [] };
}

function backend(initial = [], pages = []) {
  const sessions = new Map(initial.map((value) => [value.id, value]));
  const calls = [];
  const globalStreams = new Set();
  const sessionStreams = new Map();
  const detailFailures = new Set();
  const delays = [];
  let nextId = 0;
  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
  const metadata = ({ events: _events, ...meta }) => meta;
  const route = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, search: url.search, method: init.method ?? "GET", body: init.body, signal: init.signal });
    if (url.pathname.endsWith("/events")) {
      const global = url.pathname === "/api/events";
      return new Response(new ReadableStream({
        start(controller) {
          if (global) globalStreams.add(controller);
          const id = global ? null : decodeURIComponent(url.pathname.split("/")[3]);
          if (id) {
            if (!sessionStreams.has(id)) sessionStreams.set(id, new Set());
            sessionStreams.get(id).add(controller);
            const since = Number(url.searchParams.get("since") ?? 0);
            for (const event of sessions.get(id).events.slice(since)) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
          }
          init.signal?.addEventListener("abort", () => {
            globalStreams.delete(controller);
            if (id) sessionStreams.get(id).delete(controller);
            try { controller.close(); } catch { /* The reader may already be closed. */ }
          }, { once: true });
        },
        cancel() {},
      }), { headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.pathname === "/api/sessions") return json([...sessions.values()].map(metadata));
    if (url.pathname === "/api/pages") return json(pages);
    const pin = /^\/api\/pages\/([^/]+)\/pin$/.exec(url.pathname);
    if (pin) {
      const page = pages.find((entry) => entry.slug === decodeURIComponent(pin[1]));
      if (!page) return json({ error: "页面不存在" }, 404);
      page.pinnedAt = init.method === "PUT" ? new Date().toISOString() : null;
      pages.sort((a, b) => Number(!!b.pinnedAt) - Number(!!a.pinnedAt));
      return json({ slug: page.slug, pinnedAt: page.pinnedAt });
    }
    if (url.pathname === "/api/wishes") {
      const value = session(`created-${++nextId}`);
      sessions.set(value.id, value);
      return json(metadata(value), 201);
    }
    const match = /^\/api\/sessions\/([^/]+)(\/messages|\/cancel|\/questions\/[^/]+|\/approvals\/[^/]+)?$/.exec(url.pathname);
    if (match) {
      const value = sessions.get(decodeURIComponent(match[1]));
      assert.ok(value, "Requests must keep using an existing conversation");
      if (match[2]) return json(match[2] === "/messages" || match[2] === "/cancel" ? metadata(value) : { ok: true }, 202);
      if (detailFailures.delete(value.id)) return json({ error: "Temporary detail failure" }, 500);
      return json(value);
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const index = delays.findIndex((delay) => delay.path === url.pathname && delay.method === (init.method ?? "GET"));
    const delay = index === -1 ? undefined : delays.splice(index, 1)[0];
    const response = await route(input, init);
    // Deliberately permit a response after abort to exercise stale-response guards.
    return delay ? (await delay.promise) ?? response : response;
  };
  return {
    sessions,
    calls,
    hold(path, method = "GET") {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      delays.push({ path, method, promise });
      return {
        release,
        respond: (value, status = 202) => release(json(value, status)),
        fail: (message) => release(json({ error: message }, 500)),
      };
    },
    emitSession(id, event) {
      // Match the gateway: block deltas are realtime-only and have no since offset.
      if (!(event.type === "text" || event.type === "thinking") || event.delta === undefined) sessions.get(id).events.push(event);
      const data = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
      for (const stream of sessionStreams.get(id) ?? []) stream.enqueue(data);
    },
    streamCount(id) { return sessionStreams.get(id)?.size ?? 0; },
    closeSessionStream(id) {
      for (const stream of sessionStreams.get(id) ?? []) stream.close();
      sessionStreams.get(id)?.clear();
    },
    failNextDetail(id) { detailFailures.add(id); },
    gatewayEvent(event) {
      const data = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
      for (const stream of globalStreams) stream.enqueue(data);
    },
    publish(value) {
      sessions.set(value.id, value);
      const data = new TextEncoder().encode(`data: ${JSON.stringify({ type: "session_updated", session: metadata(value) })}\n\n`);
      for (const stream of globalStreams) stream.enqueue(data);
    },
  };
}

function mountWorkspace(local = browserStorage({ "harness-gateway-url": gateway })) {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: browserStorage({ "harness-gateway-token": "test-gateway-token" }),
  });
  const renderer = createRenderer({
    patchProp() {},
    insert() {},
    remove() {},
    createElement: (tag) => ({ tag }),
    createText: (text) => ({ text }),
    createComment: (text) => ({ text }),
    setText() {},
    setElementText() {},
    parentNode: () => null,
    nextSibling: () => null,
  });
  let workspace;
  const app = renderer.createApp({
    setup() { workspace = useWorkspace(); return () => h("div"); },
  });
  app.mount({});
  mounted.push(app);
  return { workspace, local, app };
}

async function ready(workspace) {
  for (let i = 0; i < 30; i++) {
    if (workspace.connected.value && !workspace.loadingSessions.value && !workspace.loadingSession.value) return;
    await setImmediate();
  }
  assert.fail(`Workspace did not connect: ${workspace.error.value}`);
}

async function until(predicate, message) {
  for (let i = 0; i < 30; i++) {
    if (predicate()) return;
    await setImmediate();
  }
  assert.fail(message);
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  globalThis.fetch = originalFetch;
  if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
  if (originalSessionStorage) Object.defineProperty(globalThis, "sessionStorage", originalSessionStorage);
  else Reflect.deleteProperty(globalThis, "sessionStorage");
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

test("document navigation closes SSE before unmount and restoring the document reconnects once", async () => {
  const browserWindow = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: browserWindow });
  const service = backend([session("selected")]);
  const { workspace, app } = mountWorkspace();
  await ready(workspace);
  await until(() => service.streamCount("selected") === 1, "The selected conversation must have one stream");
  const oldStreams = service.calls.filter((call) => call.path.endsWith("/events"));
  assert.equal(oldStreams.length, 2);
  browserWindow.dispatchEvent(new Event("pagehide"));
  assert.equal(workspace.connected.value, false);
  assert.ok(oldStreams.every((call) => call.signal.aborted));
  assert.equal(service.streamCount("selected"), 0);
  browserWindow.dispatchEvent(new Event("pageshow"));
  await ready(workspace);
  await until(() => service.streamCount("selected") === 1, "Restoring must reconnect the selected conversation");
  assert.equal(workspace.activeSessionId.value, "selected");
  const count = service.calls.length;
  browserWindow.dispatchEvent(new Event("pageshow"));
  await setImmediate();
  assert.equal(service.calls.length, count, "Duplicate pageshow must not open additional requests");
  app.unmount();
  assert.equal(service.streamCount("selected"), 0);
  browserWindow.dispatchEvent(new Event("pageshow"));
  await setImmediate();
  assert.equal(service.calls.length, count, "Unmount must remove document lifecycle listeners");
});

function taskPage(slug) {
  return {
    slug, title: slug, summary: "", wish: "查看经营数据", version: 1,
    url: `/pages/${slug}/?page_token=test`, pinnedAt: null, kind: "once", schedules: [],
    updatedAt: "2026-10-17T01:00:00Z", sessionId: "", stale: null,
  };
}

test("page pin actions retain the gateway order and allow multiple pinned pages", async () => {
  const service = backend([], [taskPage("sales"), taskPage("inventory")]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  assert.equal(await workspace.setPagePinned("inventory", true), true);
  assert.equal(workspace.pages.value[0].slug, "inventory");
  assert.ok(workspace.pages.value[0].pinnedAt);
  assert.equal(await workspace.setPagePinned("sales", true), true);
  assert.equal(workspace.pages.value.filter((page) => page.pinnedAt).length, 2);
  assert.equal(await workspace.setPagePinned("inventory", false), true);
  assert.equal(workspace.pages.value[0].slug, "sales");
  assert.equal(workspace.pages.value.find((page) => page.slug === "inventory").pinnedAt, null);
  assert.equal(service.calls.filter((call) => call.path.endsWith("/pin")).length, 3);
});

test("pinning blocks duplicate actions per page, permits other pages, and recovers from errors", async () => {
  const service = backend([], [taskPage("sales"), taskPage("inventory")]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const held = service.hold("/api/pages/sales/pin", "PUT");
  const pinning = workspace.setPagePinned("sales", true);
  assert.equal(workspace.pendingPagePins.value.has("sales"), true);
  assert.equal(await workspace.setPagePinned("sales", false), false);
  assert.equal(await workspace.setPagePinned("inventory", true), true);
  held.fail("置顶保存失败");
  assert.equal(await pinning, false);
  assert.equal(workspace.pendingPagePins.value.has("sales"), false);
  assert.match(workspace.error.value, /置顶保存失败/);
  assert.equal(await workspace.setPagePinned("sales", true), true);
});

test("old pin responses cannot clear a new connection's pending action or restore its pages", async () => {
  const service = backend([], [taskPage("sales")]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const oldHold = service.hold("/api/pages/sales/pin", "PUT");
  const oldPin = workspace.setPagePinned("sales", true);
  workspace.token.value = "another-gateway-token";
  assert.equal(workspace.pages.value.length, 0);
  assert.equal(workspace.pendingPagePins.value.size, 0);
  assert.equal(await workspace.setPagePinned("sales", true), false);
  await workspace.loadWorkspace();
  const newHold = service.hold("/api/pages/sales/pin", "DELETE");
  const newPin = workspace.setPagePinned("sales", false);
  oldHold.release();
  assert.equal(await oldPin, false);
  assert.equal(workspace.pendingPagePins.value.has("sales"), true);
  newHold.release();
  assert.equal(await newPin, true);
  assert.equal(workspace.pages.value[0].pinnedAt, null);
});

test("a workspace snapshot started before pinning cannot overwrite the refreshed page order", async () => {
  const service = backend([], [taskPage("sales"), taskPage("inventory")]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const snapshot = service.hold("/api/pages");
  const refreshing = workspace.loadWorkspace();
  assert.equal(await workspace.setPagePinned("inventory", true), true);
  snapshot.release();
  await refreshing;
  assert.equal(workspace.pages.value[0].slug, "inventory");
  assert.ok(workspace.pages.value[0].pinnedAt);
  assert.equal(workspace.loadingPages.value, false);
});

test("schedule changes refresh task classification and its linked schedules", async () => {
  const pages = [taskPage("sales")];
  const service = backend([], pages);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  pages[0].kind = "scheduled";
  pages[0].schedules = [{ id: "daily", name: "经营日报", enabled: false }];
  service.gatewayEvent({ type: "schedules_changed" });
  await until(() => workspace.pages.value[0]?.kind === "scheduled", "Schedule metadata was not refreshed");
  assert.deepEqual(workspace.pages.value[0].schedules, pages[0].schedules);
});

test("only the first message creates a conversation and navigation keeps reusing it", async () => {
  const service = backend();
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const firstMessage = workspace.sendMessage("查看销售");
  assert.equal(await workspace.sendMessage("重复点击发送"), false);
  assert.equal(await firstMessage, true);
  assert.equal(workspace.activeSessionId.value, "created-1");
  await workspace.openConversation();
  assert.equal(await workspace.sendMessage("继续分析"), true);
  assert.equal(await workspace.sendMessage("按天展示"), true);
  assert.equal(service.calls.filter((call) => call.path === "/api/wishes").length, 1);
  assert.equal(service.calls.filter((call) => call.path === "/api/sessions/created-1/messages").length, 2);
  assert.equal(typeof workspace.startNewConversation, "function");
  assert.equal(typeof workspace.selectSession, "function");
});

test("new backend sessions never switch the conversation on SSE, reconnect, or reload", async () => {
  const service = backend([session("chosen")]);
  const { workspace, local, app } = mountWorkspace();
  await ready(workspace);
  service.publish(session("later-cli", "2026-10-17T02:00:00Z"));
  await setImmediate();
  assert.equal(workspace.activeSessionId.value, "chosen");
  await workspace.loadWorkspace();
  assert.equal(workspace.activeSessionId.value, "chosen");
  workspace.gatewayUrl.value = gateway + "/";
  await workspace.loadWorkspace();
  assert.equal(workspace.activeSessionId.value, "chosen");
  app.unmount();
  mounted.splice(mounted.indexOf(app), 1);
  const reloaded = mountWorkspace(local).workspace;
  await ready(reloaded);
  assert.equal(reloaded.activeSessionId.value, "chosen");
  assert.equal(await reloaded.sendMessage("继续当前对话"), true);
  assert.equal(service.calls.filter((call) => call.path === "/api/wishes").length, 0);
  assert.equal(service.calls.filter((call) => call.path === "/api/sessions/chosen/messages").length, 1);
});

test("a failed detail request after creation never causes the next send to create again", async () => {
  const service = backend();
  const { workspace } = mountWorkspace();
  await ready(workspace);
  service.failNextDetail("created-1");
  assert.equal(await workspace.sendMessage("第一条消息"), true);
  assert.equal(workspace.activeSessionId.value, "created-1");
  assert.match(workspace.error.value, /Temporary detail failure/);
  assert.equal(await workspace.sendMessage("继续已有对话"), true);
  assert.equal(service.calls.filter((call) => call.path === "/api/wishes").length, 1);
  assert.equal(service.calls.filter((call) => call.path === "/api/sessions/created-1/messages").length, 1);
});

test("page editing explicitly reuses and remembers its existing original conversation", async () => {
  const origin = session("page-origin", "2026-10-17T01:00:00Z", "sales");
  const latest = session("latest", "2026-10-17T02:00:00Z", "inventory");
  const service = backend([origin, latest], [{ slug: "sales", sessionId: origin.id }]);
  const { workspace, local } = mountWorkspace();
  await ready(workspace);
  assert.equal(workspace.activeSessionId.value, latest.id);
  assert.equal(await workspace.revisePage("sales"), true);
  assert.equal(workspace.activeSessionId.value, origin.id);
  assert.equal(workspace.revisionPageSlug.value, "sales");
  assert.equal(await workspace.sendMessage("改为按天展示"), true);
  assert.equal(workspace.revisionPageSlug.value, null);
  assert.equal(service.calls.filter((call) => call.path === "/api/wishes").length, 0);
  assert.equal(service.calls.filter((call) => call.path === "/api/sessions/page-origin/messages").length, 1);
  assert.equal(local.values.get("harness-conversation-v1:" + gateway), origin.id);
});

test("an unavailable page origin never creates an extra conversation or blocks ordinary follow-ups", async () => {
  const service = backend([session("chosen")], [{ slug: "sales", sessionId: "missing" }]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  assert.equal(await workspace.revisePage("sales"), false);
  assert.equal(workspace.activeSessionId.value, "chosen");
  assert.equal(workspace.revisionPageSlug.value, null);
  assert.match(workspace.error.value, /原始对话/);
  assert.equal(await workspace.sendMessage("继续当前对话"), true);
  assert.equal(service.calls.filter((call) => call.path === "/api/wishes").length, 0);
  assert.equal(service.calls.filter((call) => call.path === "/api/sessions/chosen/messages").length, 1);
});

test("a page origin removed during reconnect cannot turn a pending edit into a new conversation", async () => {
  const origin = session("page-origin", "2026-10-17T01:00:00Z", "sales");
  const service = backend([origin], [{ slug: "sales", sessionId: origin.id }]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  assert.equal(await workspace.revisePage("sales"), true);
  service.sessions.clear();
  await workspace.loadWorkspace();
  assert.equal(workspace.activeSessionId.value, null);
  assert.equal(workspace.revisionPageSlug.value, "sales");
  assert.equal(await workspace.sendMessage("修改这个页面"), false);
  assert.equal(workspace.revisionPageSlug.value, null);
  assert.match(workspace.error.value, /原始对话/);
  assert.equal(service.calls.filter((call) => call.path === "/api/wishes").length, 0);
  assert.equal(await workspace.sendMessage("开始查看销售数据"), true);
  const creations = service.calls.filter((call) => call.path === "/api/wishes");
  assert.equal(creations.length, 1);
  assert.deepEqual(JSON.parse(creations[0].body), { wish: "开始查看销售数据" });
});

test("new conversation stays a draft until first send, even with existing history or a reload", async () => {
  const origin = session("existing", "2026-10-17T01:00:00Z", "sales");
  const service = backend([origin], [{ slug: "sales", sessionId: origin.id }]);
  const { workspace, local, app } = mountWorkspace();
  await ready(workspace);
  assert.equal(await workspace.revisePage("sales"), true);
  workspace.startNewConversation();
  assert.equal(workspace.activeSessionId.value, null);
  assert.equal(workspace.activeSession.value, undefined);
  assert.equal(workspace.revisionPageSlug.value, null);
  assert.equal(service.streamCount(origin.id), 0);
  await workspace.openConversation();
  service.publish(session("newer", "2026-10-17T02:00:00Z"));
  await workspace.loadWorkspace();
  assert.equal(workspace.activeSessionId.value, null);
  assert.equal(service.calls.filter((call) => call.method === "POST").length, 0);
  app.unmount();
  mounted.splice(mounted.indexOf(app), 1);
  const reloaded = mountWorkspace(local).workspace;
  await ready(reloaded);
  assert.equal(reloaded.activeSessionId.value, null);
  assert.equal(await reloaded.sendMessage("独立的新需求"), true);
  assert.equal(reloaded.activeSessionId.value, "created-1");
  assert.equal(await reloaded.sendMessage("继续新的需求"), true);
  const creations = service.calls.filter((call) => call.path === "/api/wishes");
  assert.equal(creations.length, 1);
  assert.deepEqual(JSON.parse(creations[0].body), { wish: "独立的新需求" });
  assert.equal(service.calls.filter((call) => call.path === "/api/sessions/existing/messages").length, 0);
});

test("choosing a draft while reconnecting overrides the session selected before reconnect", async () => {
  const service = backend([session("existing")]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const delay = service.hold("/api/sessions");
  const reconnecting = workspace.loadWorkspace();
  workspace.startNewConversation();
  delay.release();
  await reconnecting;
  assert.equal(workspace.connected.value, true);
  assert.equal(workspace.activeSessionId.value, null);
  assert.equal(workspace.activeSession.value, undefined);
  assert.equal(service.calls.filter((call) => call.path === "/api/wishes").length, 0);
});

test("history switching loads actual detail and follows only the selected session from its event cursor", async () => {
  const older = session("older");
  older.events = [{ type: "say", text: "已有记录", at: older.createdAt }];
  const newer = session("newer", "2026-10-17T02:00:00Z");
  const service = backend([older, newer]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  assert.equal(service.streamCount(newer.id), 1);
  await workspace.selectSession(older.id);
  assert.equal(service.streamCount(newer.id), 0);
  assert.equal(service.streamCount(older.id), 1);
  assert.equal(workspace.activeSession.value.events[0].text, "已有记录");
  assert.equal(service.calls.findLast((call) => call.path === "/api/sessions/older/events").search, "?since=1");
  service.emitSession(older.id, { type: "say", text: "新的进度", at: "2026-10-17T03:00:00Z" });
  await setImmediate();
  assert.equal(workspace.activeSession.value.events.length, 2);
  await workspace.selectSession(newer.id);
  assert.equal(workspace.activeSession.value.events.length, 0);
  await workspace.selectSession(older.id);
  assert.equal(workspace.activeSession.value.events.length, 2);
  assert.equal(service.calls.findLast((call) => call.path === "/api/sessions/older/events").search, "?since=2");
});

test("rapid A to B to A switching ignores older detail even when the old request returns after abort", async () => {
  const service = backend([session("A"), session("B", "2026-10-17T02:00:00Z")]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const delay = service.hold("/api/sessions/A");
  const stale = workspace.selectSession("A");
  await workspace.selectSession("B");
  service.sessions.get("A").events.push({ type: "say", text: "最新历史", at: "2026-10-17T03:00:00Z" });
  await workspace.selectSession("A");
  delay.release();
  await stale;
  assert.equal(workspace.activeSessionId.value, "A");
  assert.equal(workspace.activeSession.value.events[0].text, "最新历史");
  assert.equal(service.streamCount("A"), 1);
  assert.equal(service.streamCount("B"), 0);
  assert.equal(service.calls.filter((call) => call.path === "/api/sessions/A" && call.signal.aborted).length, 1);
});

test("new conversation interrupts an in-flight history load without allowing its response to restore history", async () => {
  const service = backend([session("A"), session("B", "2026-10-17T02:00:00Z")]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const delay = service.hold("/api/sessions/A");
  const loading = workspace.selectSession("A");
  workspace.startNewConversation();
  assert.equal(workspace.loadingSession.value, false);
  delay.release();
  await loading;
  assert.equal(workspace.activeSessionId.value, null);
  assert.equal(workspace.activeSession.value, undefined);
  assert.equal(service.streamCount("A"), 0);
  assert.equal(await workspace.sendMessage("新对话"), true);
  assert.equal(workspace.activeSessionId.value, "created-1");
});

test("a pending send never steals a later selection, and each conversation retains its own send state", async () => {
  const service = backend([session("A", "2026-10-17T02:00:00Z"), session("B")]);
  const { workspace, local } = mountWorkspace();
  await ready(workspace);
  const delay = service.hold("/api/sessions/A/messages", "POST");
  const pending = workspace.sendMessage("A 的请求");
  assert.equal(workspace.sending.value, true);
  await workspace.selectSession("B");
  assert.equal(workspace.sending.value, false);
  assert.equal(await workspace.sendMessage("B 的请求"), true);
  delay.release();
  assert.equal(await pending, true);
  assert.equal(workspace.activeSessionId.value, "B");
  assert.equal(workspace.activeSession.value.id, "B");
  assert.equal(local.values.get("harness-conversation-v1:" + gateway), "B");
  assert.equal(workspace.sending.value, false);
});

test("switching away and back cannot submit twice to the same pending conversation", async () => {
  const service = backend([session("A", "2026-10-17T02:00:00Z"), session("B")]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const delay = service.hold("/api/sessions/A/messages", "POST");
  const pending = workspace.sendMessage("第一次请求");
  await workspace.selectSession("B");
  await workspace.selectSession("A");
  assert.equal(workspace.sending.value, true);
  assert.equal(await workspace.sendMessage("重复请求"), false);
  delay.release();
  await pending;
  assert.equal(workspace.sending.value, false);
  assert.equal(service.calls.filter((call) => call.path === "/api/sessions/A/messages").length, 1);
});

test("a late send response cannot overwrite newer live status after switching away and back", async () => {
  const service = backend([session("A", "2026-10-17T02:00:00Z"), session("B")]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const delay = service.hold("/api/sessions/A/messages", "POST");
  const pending = workspace.sendMessage("A 的请求");
  await workspace.selectSession("B");
  await workspace.selectSession("A");
  service.emitSession("A", { type: "status", status: "waiting", at: "2026-10-17T03:00:00Z" });
  await setImmediate();
  assert.equal(workspace.activeSession.value.status, "waiting");
  delay.release();
  await pending;
  assert.equal(workspace.activeSession.value.status, "waiting");
  assert.equal(workspace.sessions.value.find((entry) => entry.id === "A").status, "waiting");
  assert.equal(workspace.sending.value, true);
});

test("a late wish creation is added to history without overriding a subsequently chosen draft", async () => {
  const service = backend([session("existing")]);
  const { workspace, local } = mountWorkspace();
  await ready(workspace);
  workspace.startNewConversation();
  const delay = service.hold("/api/wishes", "POST");
  const pending = workspace.sendMessage("第一份独立需求");
  workspace.startNewConversation();
  delay.release();
  assert.equal(await pending, true);
  assert.equal(workspace.activeSessionId.value, null);
  assert.equal(workspace.activeSession.value, undefined);
  assert.ok(workspace.sessions.value.some((entry) => entry.id === "created-1"));
  assert.equal(local.values.get("harness-conversation-v1:" + gateway), "__draft__");
  assert.equal(await workspace.sendMessage("第二份独立需求"), true);
  assert.equal(workspace.activeSessionId.value, "created-2");
  assert.equal(service.calls.filter((call) => call.path === "/api/wishes").length, 2);
});

test("two explicitly started new conversations keep the latest selection when creation responses arrive out of order", async () => {
  const service = backend();
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const delay = service.hold("/api/wishes", "POST");
  const first = workspace.sendMessage("第一份需求");
  workspace.startNewConversation();
  assert.equal(workspace.sending.value, false);
  assert.equal(await workspace.sendMessage("第二份需求"), true);
  assert.equal(workspace.activeSessionId.value, "created-2");
  delay.release();
  assert.equal(await first, true);
  assert.equal(workspace.activeSessionId.value, "created-2");
  assert.equal(workspace.sessions.value.length, 2);
  assert.equal(workspace.sending.value, false);
});

test("answer, approval, and cancellation responses cannot reload or select an obsolete conversation", async () => {
  const service = backend([session("A", "2026-10-17T02:00:00Z"), session("B")]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  for (const [path, invoke] of [
    ["questions/q-1", () => workspace.answerQuestions("q-1", { range: ["最近 7 天"] })],
    ["approvals/a-1", () => workspace.resolveApproval("a-1", true)],
    ["cancel", () => workspace.cancel()],
  ]) {
    await workspace.selectSession("A");
    const delay = service.hold(`/api/sessions/A/${path}`, "POST");
    const pending = invoke();
    await workspace.selectSession("B");
    const detailCount = service.calls.filter((call) => call.path === "/api/sessions/B").length;
    delay.release();
    assert.equal(await pending, true);
    assert.equal(workspace.activeSessionId.value, "B");
    assert.equal(workspace.activeSession.value.id, "B");
    assert.equal(service.calls.filter((call) => call.path === "/api/sessions/B").length, detailCount);
    assert.equal(workspace.eventActionBusy.value, false);
    assert.equal(workspace.cancelling.value, false);
  }
});

test("errors from an obsolete send are kept out of the newly selected conversation", async () => {
  const service = backend([session("A", "2026-10-17T02:00:00Z"), session("B")]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const delay = service.hold("/api/sessions/A/messages", "POST");
  const pending = workspace.sendMessage("A 的请求");
  await workspace.selectSession("B");
  delay.fail("A 的请求失败");
  assert.equal(await pending, false);
  assert.equal(workspace.activeSessionId.value, "B");
  assert.equal(workspace.error.value, "");
});

test("selecting history or a new conversation clears the previous page revision context", async () => {
  const origin = session("page-origin", "2026-10-17T02:00:00Z", "sales");
  const service = backend([origin, session("other")], [{ slug: "sales", sessionId: origin.id }]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  assert.equal(await workspace.revisePage("sales"), true);
  await workspace.selectSession("other");
  assert.equal(workspace.revisionPageSlug.value, null);
  assert.equal(await workspace.sendMessage("其他会话的需求"), true);
  assert.equal(await workspace.revisePage("sales"), true);
  workspace.startNewConversation();
  assert.equal(workspace.revisionPageSlug.value, null);
  assert.equal(await workspace.sendMessage("全新需求"), true);
  assert.deepEqual(JSON.parse(service.calls.find((call) => call.path === "/api/wishes").body), { wish: "全新需求" });
});

test("skill execution preloads the selected skill only on a newly created wish", async () => {
  const service = backend([session("existing")]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  workspace.startNewConversation();
  assert.equal(await workspace.sendMessage("运行经营日报", { skillId: "daily-report" }), true);
  assert.deepEqual(JSON.parse(service.calls.find((call) => call.path === "/api/wishes").body), {
    wish: "运行经营日报", skillId: "daily-report",
  });
  assert.equal(await workspace.sendMessage("调整日报内容"), true);
  assert.deepEqual(JSON.parse(service.calls.find((call) => call.path.endsWith("/messages")).body), { text: "调整日报内容" });
});

test("new global resource events refresh their own resource and overview without changing conversation", async () => {
  const service = backend([session("selected")]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  for (const key of ["skills", "schedules", "connectors", "pending"]) {
    service.gatewayEvent({ type: `${key}_changed` });
    await setImmediate();
    assert.equal(workspace.gatewayChanges.value[key], 1);
    assert.equal(workspace.activeSessionId.value, "selected");
  }
  assert.equal(workspace.gatewayChanges.value.overview, 4);
  assert.equal(workspace.error.value, "");
});

test("schedule origin survives detail loading and live metadata updates", async () => {
  const original = { ...session("scheduled"), origin: { kind: "schedule", scheduleId: "daily", scheduleName: "经营日报" } };
  const service = backend([original]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  assert.deepEqual(workspace.sessions.value[0].origin, original.origin);
  service.publish({ ...original, status: "waiting", updatedAt: "2026-10-17T04:00:00Z" });
  await setImmediate();
  assert.deepEqual(workspace.sessions.value[0].origin, original.origin);
  assert.deepEqual(workspace.activeSession.value.origin, original.origin);
  assert.equal(workspace.gatewayChanges.value.overview, 1);
});

test("refreshing while the first wish is pending preserves its draft, request, and submission lock", async () => {
  const service = backend();
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const delay = service.hold("/api/wishes", "POST");
  const pending = workspace.sendMessage("帮我创建获取信息的 skill");
  const creation = service.calls.find((call) => call.path === "/api/wishes");
  assert.equal(workspace.pendingMessage.value.text, "帮我创建获取信息的 skill");
  assert.equal(workspace.responding.value, true);
  await workspace.loadWorkspace();
  await workspace.openConversation();
  assert.equal(creation.signal.aborted, false);
  assert.equal(workspace.activeSessionId.value, null);
  assert.equal(workspace.sending.value, true);
  assert.equal(workspace.pendingMessage.value.text, "帮我创建获取信息的 skill");
  assert.equal(await workspace.sendMessage("重复提交同一需求"), false);
  delay.release();
  assert.equal(await pending, true);
  assert.equal(workspace.activeSessionId.value, "created-1");
  assert.equal(await workspace.sendMessage("继续刚才的对话"), true);
  assert.equal(service.calls.filter((call) => call.path === "/api/wishes").length, 1);
  assert.equal(service.calls.filter((call) => call.path === "/api/sessions/created-1/messages").length, 1);
});

for (const existingHistory of [false, true]) {
  test(`an old refresh snapshot cannot undo a wish completed during refresh (${existingHistory ? "existing history" : "empty history"})`, async () => {
    const service = backend(existingHistory ? [session("existing")] : []);
    const { workspace, local } = mountWorkspace();
    await ready(workspace);
    workspace.startNewConversation();
    const delay = service.hold("/api/sessions");
    const refreshing = workspace.loadWorkspace();
    assert.equal(await workspace.sendMessage("刷新期间创建的新对话"), true);
    assert.equal(workspace.activeSessionId.value, "created-1");
    const detailCount = service.calls.filter((call) => call.path === "/api/sessions/created-1").length;
    delay.release();
    await refreshing;
    assert.equal(workspace.activeSessionId.value, "created-1");
    assert.equal(workspace.activeSession.value.id, "created-1");
    assert.equal(local.values.get("harness-conversation-v1:" + gateway), "created-1");
    assert.ok(workspace.sessions.value.some((entry) => entry.id === "created-1"));
    assert.equal(service.streamCount("created-1"), 1);
    assert.equal(service.streamCount("existing"), 0);
    assert.equal(service.calls.filter((call) => call.path === "/api/sessions/created-1").length, detailCount);
    assert.equal(await workspace.sendMessage("刷新结束后继续此对话"), true);
    assert.equal(service.calls.filter((call) => call.path === "/api/wishes").length, 1);
    assert.equal(service.calls.filter((call) => call.path === "/api/sessions/created-1/messages").length, 1);
  });
}

test("follow-ups, refresh, answers, approvals, and stopping retain existing messages and the live stream", async () => {
  const original = session("selected");
  original.events = [{ type: "say", text: "之前的回复仍然可见", at: original.createdAt }];
  const service = backend([original]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const detailCount = () => service.calls.filter((call) => call.path === "/api/sessions/selected").length;
  const streamCount = () => service.calls.filter((call) => call.path === "/api/sessions/selected/events").length;
  const initialDetailCount = detailCount();
  const initialStreamCount = streamCount();
  const stream = service.calls.find((call) => call.path === "/api/sessions/selected/events");
  for (const [path, invoke] of [
    ["messages", () => workspace.sendMessage("继续分析")],
    ["questions/q-1", () => workspace.answerQuestions("q-1", { range: ["最近 7 天"] })],
    ["approvals/a-1", () => workspace.resolveApproval("a-1", true)],
    ["cancel", () => workspace.cancel()],
  ]) {
    const delay = service.hold(`/api/sessions/selected/${path}`, "POST");
    const action = invoke();
    assert.equal(workspace.activeSession.value.events[0].text, "之前的回复仍然可见");
    assert.equal(workspace.loadingSession.value, false);
    if (path === "messages") {
      await workspace.loadWorkspace();
      assert.equal(workspace.sending.value, true);
      assert.equal(await workspace.sendMessage("重复发送"), false);
    }
    delay.release();
    assert.equal(await action, true);
    assert.equal(workspace.activeSession.value.events[0].text, "之前的回复仍然可见");
    assert.equal(workspace.loadingSession.value, false);
    assert.equal(detailCount(), initialDetailCount);
    assert.equal(streamCount(), initialStreamCount);
    assert.equal(stream.signal.aborted, false);
    assert.equal(service.streamCount("selected"), 1);
  }
});

test("optimistic messages appear immediately and only a new matching user event acknowledges them", async () => {
  const original = session("selected");
  original.events = [
    { type: "user", text: "重新查询", at: original.createdAt },
    { type: "say", text: "之前的查询结果", at: original.createdAt },
  ];
  const service = backend([original]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const delay = service.hold("/api/sessions/selected/messages", "POST");
  const pending = workspace.sendMessage("重新查询");
  assert.equal(workspace.pendingMessage.value.text, "重新查询");
  assert.equal(workspace.activeSession.value.events.length, 2);
  service.emitSession("selected", { type: "say", text: "正在处理", at: "2026-10-17T03:00:00Z" });
  await setImmediate();
  assert.equal(workspace.pendingMessage.value.text, "重新查询");
  service.emitSession("selected", { type: "user", text: "重新查询", at: "2026-10-17T03:00:01Z" });
  await setImmediate();
  assert.equal(workspace.pendingMessage.value, undefined);
  assert.equal(workspace.activeSession.value.events.filter((event) => event.type === "user").length, 2);
  delay.release();
  assert.equal(await pending, true);
  assert.equal(workspace.pendingMessage.value, undefined);
});

test("stopping before creation returns waits for the real session id without aborting or unlocking submission", async () => {
  const service = backend();
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const creation = service.hold("/api/wishes", "POST");
  const cancellation = service.hold("/api/sessions/created-1/cancel", "POST");
  const pending = workspace.sendMessage("获取最新信息");
  const request = service.calls.find((call) => call.path === "/api/wishes");
  assert.equal(workspace.canCancel.value, true);
  assert.equal(await workspace.cancel(), true);
  assert.equal(workspace.cancelling.value, true);
  assert.equal(workspace.sending.value, true);
  assert.equal(request.signal.aborted, false);
  assert.equal(service.calls.filter((call) => call.path.endsWith("/cancel")).length, 0);
  await workspace.loadWorkspace();
  assert.equal(workspace.activeSessionId.value, null);
  assert.equal(workspace.cancelling.value, true);
  assert.equal(await workspace.sendMessage("仍不能重复提交"), false);
  creation.release();
  await until(() => service.calls.some((call) => call.path.endsWith("/cancel")), "Creation never sent its deferred cancellation");
  assert.equal(workspace.sending.value, true);
  assert.equal(workspace.cancelling.value, true);
  assert.equal(await workspace.cancel(), false);
  assert.equal(await workspace.sendMessage("停止完成前禁止重复提交"), false);
  cancellation.release();
  assert.equal(await pending, true);
  assert.equal(workspace.activeSessionId.value, "created-1");
  assert.equal(workspace.sending.value, false);
  assert.equal(workspace.cancelling.value, false);
  assert.equal(request.signal.aborted, false);
  assert.equal(service.calls.filter((call) => call.path === "/api/wishes").length, 1);
  assert.equal(service.calls.filter((call) => call.path === "/api/sessions/created-1/cancel").length, 1);
  assert.equal(await workspace.sendMessage("停止后继续同一对话"), true);
  assert.equal(service.calls.filter((call) => call.path === "/api/wishes").length, 1);
});

test("stopping an existing conversation waits for its in-flight message acknowledgement before cancelling that turn", async () => {
  const original = session("selected");
  const service = backend([original]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const message = service.hold("/api/sessions/selected/messages", "POST");
  const cancellation = service.hold("/api/sessions/selected/cancel", "POST");
  const pending = workspace.sendMessage("开始新一轮执行");
  const request = service.calls.find((call) => call.path.endsWith("/messages"));
  assert.equal(await workspace.cancel(), true);
  // A known session id alone does not establish that /messages reached the server:
  // cancellation must follow acknowledgement so it cannot stop the previous idle turn.
  assert.equal(service.calls.filter((call) => call.path.endsWith("/cancel")).length, 0);
  assert.equal(request.signal.aborted, false);
  assert.equal(workspace.sending.value, true);
  assert.equal(workspace.cancelling.value, true);
  message.respond({ ...original, status: "running", updatedAt: "2026-10-17T03:00:00Z" });
  await until(() => service.calls.some((call) => call.path.endsWith("/cancel")), "The acknowledged message never received its cancellation");
  assert.equal(workspace.sending.value, true);
  assert.equal(workspace.cancelling.value, true);
  cancellation.respond({ ...original, status: "idle", updatedAt: "2026-10-17T03:00:01Z" });
  assert.equal(await pending, true);
  assert.equal(workspace.sending.value, false);
  assert.equal(workspace.cancelling.value, false);
  assert.equal(service.calls.filter((call) => call.path.endsWith("/cancel")).length, 1);
  assert.equal(service.calls.filter((call) => call.path === "/api/wishes").length, 0);
});

test("a failed deferred cancellation remains visible after the created conversation loads and permits retrying stop", async () => {
  const service = backend();
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const creation = service.hold("/api/wishes", "POST");
  const cancellation = service.hold("/api/sessions/created-1/cancel", "POST");
  const pending = workspace.sendMessage("创建并执行");
  Object.assign(service.sessions.get("created-1"), { status: "running", updatedAt: "2026-10-17T03:00:00Z" });
  assert.equal(await workspace.cancel(), true);
  creation.release();
  await until(() => service.calls.some((call) => call.path.endsWith("/cancel")), "The deferred cancellation never started");
  cancellation.fail("停止失败，请重试");
  assert.equal(await pending, true);
  assert.equal(workspace.activeSessionId.value, "created-1");
  assert.equal(workspace.activeSession.value.status, "running");
  assert.equal(workspace.error.value, "停止失败，请重试");
  assert.equal(workspace.cancelling.value, false);
  assert.equal(workspace.canCancel.value, true);
  assert.equal(workspace.sending.value, true);
  assert.equal(await workspace.cancel(), true);
  assert.equal(workspace.error.value, "");
  assert.equal(service.calls.filter((call) => call.path === "/api/sessions/created-1/cancel").length, 2);
});

test("stopping after creation returns can cancel while its initial detail is still loading", async () => {
  const service = backend();
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const detail = service.hold("/api/sessions/created-1");
  const cancellation = service.hold("/api/sessions/created-1/cancel", "POST");
  const pending = workspace.sendMessage("创建并执行");
  await until(() => workspace.activeSessionId.value === "created-1" && workspace.loadingSession.value,
    "The created conversation never began loading its detail");
  assert.equal(workspace.pendingMessage.value.text, "创建并执行");
  assert.equal(workspace.sending.value, true);
  const stopping = workspace.cancel();
  assert.equal(workspace.cancelling.value, true);
  assert.equal(service.calls.filter((call) => call.path === "/api/sessions/created-1/cancel").length, 1);
  cancellation.release();
  assert.equal(await stopping, true);
  assert.equal(workspace.sending.value, true);
  assert.equal(await workspace.sendMessage("详情返回前不重复发送"), false);
  detail.release();
  assert.equal(await pending, true);
  assert.equal(workspace.sending.value, false);
  assert.equal(workspace.cancelling.value, false);
  assert.equal(workspace.activeSessionId.value, "created-1");
  assert.equal(service.calls.filter((call) => call.path === "/api/sessions/created-1/cancel").length, 1);
});

test("an older initial detail cannot unlock a created conversation after cancellation still reports running", async () => {
  const service = backend();
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const detail = service.hold("/api/sessions/created-1");
  const cancellation = service.hold("/api/sessions/created-1/cancel", "POST");
  const pending = workspace.sendMessage("创建并执行");
  await until(() => workspace.activeSessionId.value === "created-1" && workspace.loadingSession.value,
    "The created conversation never began loading its detail");
  const stopping = workspace.cancel();
  cancellation.respond({ ...service.sessions.get("created-1"), status: "running", updatedAt: "2026-10-17T03:00:00Z" });
  assert.equal(await stopping, true);
  detail.release();
  assert.equal(await pending, true);
  assert.equal(workspace.activeSession.value.status, "running");
  assert.equal(workspace.sessions.value.find((entry) => entry.id === "created-1").status, "running");
  assert.equal(workspace.sending.value, true);
  assert.equal(workspace.cancelling.value, true);
  assert.equal(await workspace.cancel(), false);
  assert.equal(await workspace.sendMessage("执行尚未结束时不能再次提交"), false);
  service.emitSession("created-1", { type: "status", status: "idle", at: "2026-10-17T03:00:01Z" });
  await setImmediate();
  assert.equal(workspace.sending.value, false);
  assert.equal(workspace.cancelling.value, false);
});

test("waiting conversations can stop and a running 202 response stays locked until the terminal live event", async () => {
  const original = { ...session("selected"), status: "waiting" };
  const service = backend([original]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  assert.equal(workspace.canCancel.value, true);
  assert.equal(workspace.sending.value, true);
  assert.equal(workspace.responding.value, false);
  const cancellation = service.hold("/api/sessions/selected/cancel", "POST");
  const stopping = workspace.cancel();
  assert.equal(workspace.cancelling.value, true);
  cancellation.respond({ ...original, status: "running", updatedAt: "2026-10-17T03:00:00Z" });
  assert.equal(await stopping, true);
  assert.equal(workspace.activeSession.value.status, "running");
  assert.equal(workspace.sending.value, true);
  assert.equal(workspace.responding.value, true);
  assert.equal(workspace.cancelling.value, true);
  assert.equal(await workspace.cancel(), false);
  assert.equal(service.calls.filter((call) => call.path === "/api/sessions/selected/cancel").length, 1);
  assert.equal(await workspace.sendMessage("收到停止响应后仍等待执行结束"), false);
  service.emitSession("selected", { type: "status", status: "idle", at: "2026-10-17T03:00:01Z" });
  await setImmediate();
  assert.equal(workspace.sending.value, false);
  assert.equal(workspace.responding.value, false);
  assert.equal(workspace.cancelling.value, false);
  assert.equal(workspace.canCancel.value, false);
  assert.equal(await workspace.sendMessage("执行结束后继续"), true);
  assert.equal(service.calls.filter((call) => call.path === "/api/wishes").length, 0);
});

test("a failed send removes only its optimistic message and permits retrying the same conversation", async () => {
  const original = session("selected");
  original.events = [{ type: "say", text: "已有回复", at: original.createdAt }];
  const service = backend([original]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const delay = service.hold("/api/sessions/selected/messages", "POST");
  const pending = workspace.sendMessage("需要重试的消息");
  assert.equal(workspace.pendingMessage.value.text, "需要重试的消息");
  assert.equal(workspace.responding.value, true);
  delay.fail("发送失败，请重试");
  assert.equal(await pending, false);
  assert.equal(workspace.error.value, "发送失败，请重试");
  assert.equal(workspace.pendingMessage.value, undefined);
  assert.equal(workspace.sending.value, false);
  assert.equal(workspace.responding.value, false);
  assert.equal(workspace.activeSession.value.events[0].text, "已有回复");
  assert.equal(await workspace.sendMessage("需要重试的消息"), true);
  assert.equal(workspace.error.value, "");
  assert.equal(service.calls.filter((call) => call.path === "/api/wishes").length, 0);
  assert.equal(service.calls.filter((call) => call.path === "/api/sessions/selected/messages").length, 2);
});

test("an obsolete send failure cannot clear another conversation's optimistic message or submission lock", async () => {
  const service = backend([session("A", "2026-10-17T02:00:00Z"), session("B")]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const firstDelay = service.hold("/api/sessions/A/messages", "POST");
  const first = workspace.sendMessage("A 的请求");
  await workspace.selectSession("B");
  const secondDelay = service.hold("/api/sessions/B/messages", "POST");
  const second = workspace.sendMessage("B 的请求");
  firstDelay.fail("A 失败了");
  assert.equal(await first, false);
  assert.equal(workspace.activeSessionId.value, "B");
  assert.equal(workspace.error.value, "");
  assert.equal(workspace.pendingMessage.value.text, "B 的请求");
  assert.equal(workspace.sending.value, true);
  assert.equal(await workspace.sendMessage("B 的重复请求"), false);
  secondDelay.release();
  assert.equal(await second, true);
  assert.equal(workspace.sending.value, false);
  assert.equal(service.calls.filter((call) => call.path === "/api/sessions/B/messages").length, 1);
});

test("an aborted old connection's send failure cannot clear a new send to the same session", async () => {
  const service = backend([session("selected")]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const oldDelay = service.hold("/api/sessions/selected/messages", "POST");
  const oldSend = workspace.sendMessage("旧连接中的请求");
  const oldRequest = service.calls.find((call) => call.path.endsWith("/messages"));
  workspace.token.value = "replacement-gateway-token";
  assert.equal(oldRequest.signal.aborted, true);
  await workspace.loadWorkspace();
  await ready(workspace);
  const newDelay = service.hold("/api/sessions/selected/messages", "POST");
  const newSend = workspace.sendMessage("新连接中的请求");
  assert.equal(workspace.pendingMessage.value.text, "新连接中的请求");
  oldDelay.fail("旧连接的延迟失败");
  assert.equal(await oldSend, false);
  assert.equal(workspace.activeSessionId.value, "selected");
  assert.equal(workspace.pendingMessage.value.text, "新连接中的请求");
  assert.equal(workspace.error.value, "");
  assert.equal(workspace.sending.value, true);
  assert.equal(await workspace.sendMessage("新连接的重复请求"), false);
  newDelay.release();
  assert.equal(await newSend, true);
  assert.equal(workspace.sending.value, false);
});

test("streamed text and thinking accumulate separately while only snapshots, done and tool events advance history", async () => {
  const service = backend([session("selected")]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const at = "2026-10-17T03:00:00Z";
  service.emitSession("selected", { type: "status", status: "running", at });
  service.emitSession("selected", { type: "thinking", blockId: "reply:0", delta: "检查", at });
  service.emitSession("selected", { type: "text", blockId: "reply:1", delta: "初稿", at });
  service.emitSession("selected", { type: "thinking", blockId: "reply:0", delta: "库存", at });
  await setImmediate();
  assert.deepEqual(workspace.liveBlocks.value, { sessionId: "selected", blocks: { "reply:0": { type: "thinking", content: "检查库存" }, "reply:1": { type: "text", content: "初稿" } } });
  assert.equal(workspace.activeSession.value.events.length, 1);
  service.emitSession("selected", { type: "text", blockId: "reply:1", content: "新的完整快照", done: false, at });
  service.emitSession("selected", { type: "text", blockId: "reply:1", delta: "。", at });
  await setImmediate();
  assert.equal(workspace.liveBlocks.value.blocks["reply:1"].content, "新的完整快照。");
  assert.equal(workspace.activeSession.value.events.length, 2);
  service.emitSession("selected", { type: "text", blockId: "reply:1", content: "最终正文", done: true, at });
  for (const tool of [
    { id: "tool-1", name: "store__inventory", status: "running" },
    { id: "tool-1", name: "store__inventory", status: "running", progress: "正在查询", args: { sku: "A" } },
    { id: "tool-1", name: "store__inventory", status: "success", result: "库存 2 件" },
  ]) service.emitSession("selected", { type: "tool", blockId: "reply:2", tool, at });
  await setImmediate();
  assert.equal(workspace.liveBlocks.value.blocks["reply:1"], undefined);
  assert.equal(workspace.liveBlocks.value.blocks["reply:0"].content, "检查库存");
  assert.equal(workspace.activeSession.value.events.length, 6);
  service.emitSession("selected", { type: "thinking", blockId: "reply:0", content: "完整思考", done: true, at });
  service.emitSession("selected", { type: "text", blockId: "reply:1", delta: "迟到的重复片段", at });
  await setImmediate();
  assert.deepEqual(workspace.liveBlocks.value.blocks, {});
  assert.equal(workspace.activeSession.value.events.length, 7);
  assert.deepEqual(workspace.activeSession.value.events, service.sessions.get("selected").events);
});

test("content snapshots replace partial stream text instead of appending it twice", async () => {
  const service = backend([session("selected")]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const at = "2026-10-17T03:00:00Z";
  service.emitSession("selected", { type: "text", blockId: "reply:0", delta: "已经", at });
  service.emitSession("selected", { type: "text", blockId: "reply:0", content: "已经完成", delta: "完成", at });
  await setImmediate();
  assert.equal(workspace.liveBlocks.value.blocks["reply:0"].content, "已经完成");
  assert.equal(workspace.activeSession.value.events.length, 0);
  service.emitSession("selected", { type: "text", blockId: "reply:0", content: "", done: true, at });
  await setImmediate();
  assert.equal(workspace.liveBlocks.value.blocks["reply:0"], undefined);
  assert.equal(workspace.activeSession.value.events[0].content, "");
});

test("user and terminal events discard interrupted fragments while waiting and running preserve them", async () => {
  const service = backend([session("selected")]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const at = "2026-10-17T03:00:00Z";
  for (const event of [
    { type: "user", text: "下一轮" },
    { type: "status", status: "idle" },
    { type: "status", status: "error" },
    { type: "error", message: "执行中断" },
  ]) {
    service.emitSession("selected", { type: "status", status: "running", at });
    service.emitSession("selected", { type: "thinking", blockId: "interrupted:0", delta: "未完成思考", at });
    service.emitSession("selected", { type: "text", blockId: "interrupted:1", delta: "未完成正文", at });
    await setImmediate();
    assert.equal(Object.keys(workspace.liveBlocks.value.blocks).length, 2);
    service.emitSession("selected", { ...event, at });
    await setImmediate();
    assert.deepEqual(workspace.liveBlocks.value.blocks, {});
  }
  service.emitSession("selected", { type: "status", status: "running", at });
  service.emitSession("selected", { type: "text", blockId: "pending:0", delta: "待确认正文", at });
  for (const status of ["waiting", "running"]) service.emitSession("selected", { type: "status", status, at });
  await setImmediate();
  assert.equal(workspace.liveBlocks.value.blocks["pending:0"].content, "待确认正文");
  assert.equal(workspace.activeSession.value.events.some((event) => event.delta !== undefined), false);
});

test("history selection, new draft, credentials and document disposal never retain another conversation's fragments", async () => {
  const service = backend([session("A", "2026-10-17T02:00:00Z"), session("B")]);
  const { workspace, app } = mountWorkspace();
  await ready(workspace);
  const stream = (id) => service.emitSession(id, { type: "text", blockId: "partial:0", delta: `来自 ${id}`, at: "2026-10-17T03:00:00Z" });
  stream("A"); await setImmediate();
  const selecting = workspace.selectSession("B");
  assert.deepEqual(workspace.liveBlocks.value, { sessionId: "B", blocks: {} });
  await selecting; stream("B"); await setImmediate();
  assert.equal(workspace.liveBlocks.value.blocks["partial:0"].content, "来自 B");
  workspace.startNewConversation();
  assert.deepEqual(workspace.liveBlocks.value, { sessionId: null, blocks: {} });
  await workspace.selectSession("A"); stream("A"); await setImmediate();
  workspace.token.value = "replacement-token";
  assert.deepEqual(workspace.liveBlocks.value, { sessionId: null, blocks: {} });
  await workspace.loadWorkspace(); await ready(workspace); stream("A"); await setImmediate();
  app.unmount(); mounted.splice(mounted.indexOf(app), 1);
  assert.deepEqual(workspace.liveBlocks.value, { sessionId: null, blocks: {} });
});

test("starting an optimistic next turn and receiving a terminal cancellation drop leftover partial content", async () => {
  const service = backend([session("selected")]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const at = "2026-10-17T03:00:00Z";
  service.emitSession("selected", { type: "text", blockId: "old:0", delta: "上轮残片", at });
  await setImmediate();
  const held = service.hold("/api/sessions/selected/messages", "POST");
  const pending = workspace.sendMessage("下一轮问题");
  assert.equal(workspace.pendingMessage.value.text, "下一轮问题");
  assert.deepEqual(workspace.liveBlocks.value.blocks, {});
  held.release(); await pending;
  service.emitSession("selected", { type: "text", blockId: "cancelled:0", delta: "停止中的残片", at });
  await setImmediate();
  assert.equal(await workspace.cancel(), true);
  assert.deepEqual(workspace.liveBlocks.value.blocks, {});
});

test("session reconnect resets partial text, replays only persisted events and resumes at their exact cursor", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = session("selected");
  original.events = [{ type: "user", text: "查询库存", at: original.createdAt }];
  const service = backend([original]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const at = "2026-10-17T03:00:00Z";
  service.emitSession("selected", { type: "text", blockId: "reply:0", delta: "连接中断前", at });
  service.emitSession("selected", { type: "tool", blockId: "reply:1", tool: { id: "tool", name: "inventory", status: "running" }, at });
  await setImmediate();
  assert.equal(workspace.activeSession.value.events.length, 2);
  service.closeSessionStream("selected");
  await until(() => workspace.error.value.startsWith("事件连接中断"), "Stream interruption was not detected");
  // These persisted events occur while disconnected and must arrive through since replay.
  service.emitSession("selected", { type: "text", blockId: "reply:0", content: "最终的完整正文", done: true, at });
  service.emitSession("selected", { type: "tool", blockId: "reply:1", tool: { id: "tool", name: "inventory", status: "success", result: "完成" }, at });
  t.mock.timers.tick(2000);
  await until(() => service.streamCount("selected") === 1 && workspace.activeSession.value.events.length === 4, "Reconnect failed to replay persisted events");
  assert.equal(service.calls.filter((call) => call.path === "/api/sessions/selected/events").at(-1).search, "?since=2");
  assert.deepEqual(workspace.liveBlocks.value.blocks, {});
  assert.deepEqual(workspace.activeSession.value.events, service.sessions.get("selected").events);
  service.emitSession("selected", { type: "thinking", blockId: "next:0", delta: "重连后新片段", at });
  await setImmediate();
  assert.equal(workspace.liveBlocks.value.blocks["next:0"].content, "重连后新片段");
  assert.equal(workspace.activeSession.value.events.length, 4);
  service.closeSessionStream("selected");
  await until(() => workspace.error.value.startsWith("事件连接中断"), "Second interruption was not detected");
  t.mock.timers.tick(2000);
  await until(() => service.streamCount("selected") === 1, "Second reconnect failed");
  assert.equal(service.calls.filter((call) => call.path === "/api/sessions/selected/events").at(-1).search, "?since=4");
  assert.deepEqual(workspace.liveBlocks.value.blocks, {});
  service.emitSession("selected", { type: "thinking", blockId: "next:0", delta: "重新发送片段", at });
  await setImmediate();
  assert.equal(workspace.liveBlocks.value.blocks["next:0"].content, "重新发送片段");
});

test("late deltas after persisted stop, error or idle stay discarded until a new persisted turn starts", async () => {
  const service = backend([session("selected")]);
  const { workspace } = mountWorkspace();
  await ready(workspace);
  const at = "2026-10-17T03:00:00Z";
  const boundaries = [
    { type: "status", status: "idle" },
    { type: "status", status: "error" },
    { type: "error", message: "执行已取消" },
  ];
  for (const [index, terminal] of boundaries.entries()) {
    service.emitSession("selected", { type: "status", status: "running", at });
    service.emitSession("selected", { type: "text", blockId: `old-${index}:0`, delta: "执行中的内容", at });
    service.emitSession("selected", { ...terminal, at });
    await setImmediate();
    assert.deepEqual(workspace.liveBlocks.value.blocks, {});
    const cursor = workspace.activeSession.value.events.length;
    service.emitSession("selected", { type: "text", blockId: `old-${index}:0`, delta: "迟到正文", at });
    service.emitSession("selected", { type: "thinking", blockId: `old-${index}:1`, delta: "迟到思考", at });
    await setImmediate();
    assert.deepEqual(workspace.liveBlocks.value.blocks, {});
    assert.equal(workspace.activeSession.value.events.length, cursor);
    // A waiting notification is not the start of another user/agent turn.
    service.emitSession("selected", { type: "status", status: "waiting", at });
    service.emitSession("selected", { type: "text", blockId: `old-${index}:0`, delta: "仍然迟到", at });
    await setImmediate();
    assert.deepEqual(workspace.liveBlocks.value.blocks, {});
    assert.equal(workspace.activeSession.value.events.length, cursor + 1);
    const start = index % 2 ? { type: "status", status: "running", at } : { type: "user", text: "开始下一轮", at };
    service.emitSession("selected", start);
    await setImmediate();
    // Global metadata can arrive ahead of done events; it must not close a turn.
    service.publish({ ...service.sessions.get("selected"), status: "idle", updatedAt: "2026-10-17T03:00:01Z" });
    await setImmediate();
    service.emitSession("selected", { type: "text", blockId: `new-${index}:0`, delta: "新一轮片段", at });
    await setImmediate();
    assert.equal(workspace.liveBlocks.value.blocks[`new-${index}:0`].content, "新一轮片段");
    assert.equal(workspace.activeSession.value.events.length, cursor + 2);
    assert.deepEqual(workspace.activeSession.value.events, service.sessions.get("selected").events);
  }
});

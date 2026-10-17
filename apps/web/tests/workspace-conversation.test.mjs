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
      return { release, fail: (message) => release(json({ error: message }, 500)) };
    },
    emitSession(id, event) {
      sessions.get(id).events.push(event);
      const data = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
      for (const stream of sessionStreams.get(id) ?? []) stream.enqueue(data);
    },
    streamCount(id) { return sessionStreams.get(id)?.size ?? 0; },
    failNextDetail(id) { detailFailures.add(id); },
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

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  globalThis.fetch = originalFetch;
  if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
  if (originalSessionStorage) Object.defineProperty(globalThis, "sessionStorage", originalSessionStorage);
  else Reflect.deleteProperty(globalThis, "sessionStorage");
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

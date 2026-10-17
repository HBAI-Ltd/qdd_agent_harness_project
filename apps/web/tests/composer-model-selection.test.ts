import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { effectScope, ref } from "vue";
import type { ChatOptions, ChatSelection, ModelCatalog, SessionDetail, SessionMeta } from "@qdd/shared";
import { useComposer } from "../src/composables/useComposer.ts";

const models: ModelCatalog = {
  default: "a",
  models: [
    { id: "a", label: "模型 A", provider: "第一服务商", model: "provider-a", available: true },
    { id: "b", label: "模型 B", provider: "第二服务商", model: "provider-b", available: true },
    { id: "c", label: "模型 C", provider: "第二服务商", model: "provider-c", available: true },
    { id: "unavailable", label: "未配置", provider: "第二服务商", model: "no-key", available: false },
  ],
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function meta(id: string, model: string, reasoningEffort: SessionMeta["reasoningEffort"] = "high"): SessionMeta {
  return {
    id, model, reasoningEffort, title: id, summary: "", status: "idle", slug: null,
    createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z",
  };
}

function setup(t: TestContext, initialId: string | null = "session-a") {
  const scope = effectScope();
  const gatewayUrl = ref("http://127.0.0.1:3000");
  const token = ref("gateway-token");
  const connected = ref(true);
  const activeSessionId = ref<string | null>(initialId);
  const activeSession = ref<SessionDetail | undefined>(initialId ? { ...meta(initialId, "a"), events: [] } : undefined);
  const sessions = ref<SessionMeta[]>([meta("session-a", "a"), meta("session-b", "b")]);
  const chatOptions = ref<ChatOptions>({
    defaults: { model: "a", reasoningEffort: "default" },
    models: models.models.map((model) => ({ ...model, reasoningEfforts: ["default", "high"], defaultReasoningEffort: "default" })),
  });
  const chatSelection = ref<ChatSelection>({ model: "a", reasoningEffort: "high" });
  const error = ref("");
  const applied: SessionMeta[] = [];
  const workspace = {
    gatewayUrl, token, connected, activeSessionId, activeSession, sessions, chatOptions, chatSelection, error,
    selectChatModel(id: string) {
      const model = chatOptions.value.models.find((entry) => entry.id === id);
      if (model) chatSelection.value = { model: id, reasoningEffort: model.defaultReasoningEffort };
    },
    applyResponseMeta(value: SessionMeta) {
      applied.push(value);
      const index = sessions.value.findIndex((entry) => entry.id === value.id);
      if (index >= 0) sessions.value[index] = value;
      if (activeSession.value?.id === value.id) {
        activeSession.value = { ...activeSession.value, ...value };
        chatSelection.value = { model: value.model!, reasoningEffort: value.reasoningEffort! };
      }
    },
  };
  const composer = scope.run(() => useComposer(workspace as unknown as Parameters<typeof useComposer>[0]))!;
  t.after(() => { scope.stop(); });
  return { composer, workspace, applied, scope };
}

test("catalog refresh observes token changes and ignores stale gateway results", async (t) => {
  const old = deferred<Response>();
  const requests: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    requests.push({ url: String(url), init });
    return requests.length === 1 ? old.promise : json({ ...models, default: "b" });
  });
  const { composer, workspace } = setup(t, null);
  assert.equal(composer.modelLoading.value, true);
  workspace.gatewayUrl.value = "http://127.0.0.1:4000";
  workspace.token.value = "replacement-token";
  await settle();
  assert.equal(composer.catalog.value?.default, "b");
  assert.equal(composer.currentModel.value?.id, "b");
  assert.equal(requests[0]?.init.signal?.aborted, true);
  assert.equal(requests.at(-1)?.url, "http://127.0.0.1:4000/api/models");
  assert.equal(new Headers(requests.at(-1)?.init.headers).get("Authorization"), "Bearer replacement-token");
  old.resolve(json(models));
  await settle();
  assert.equal(composer.catalog.value?.default, "b");
  assert.equal(composer.modelLoading.value, false);
});

test("catalog failures expose retry state and cleanup aborts a pending reload", async (t) => {
  const pending = deferred<Response>();
  const requests: RequestInit[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(init);
    return requests.length === 1 ? json({ error: "目录暂不可用" }, 500)
      : requests.length === 2 ? json(models) : pending.promise;
  });
  const { composer, scope } = setup(t);
  await settle();
  assert.equal(composer.modelError.value, "目录暂不可用");
  assert.equal(composer.modelLoading.value, false);
  await composer.refreshModels();
  assert.equal(composer.modelError.value, "");
  assert.deepEqual(composer.catalog.value, models);
  const reloading = composer.refreshModels();
  scope.stop();
  assert.equal(requests.at(-1)?.signal?.aborted, true);
  pending.resolve(json(models));
  await reloading;
  assert.equal(composer.catalog.value, null);
});

test("new draft choices use configured IDs and cannot select an unavailable model", async (t) => {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return json(models);
  });
  const { composer, workspace } = setup(t, null);
  await settle();
  await composer.selectModel("b");
  assert.equal(composer.currentModel.value?.id, "b");
  assert.equal(composer.draftModel.value, "b");
  assert.equal(workspace.chatSelection.value.model, "b");
  assert.equal(composer.modelChanging.value, false);
  await composer.selectModel("unavailable");
  assert.match(composer.modelError.value, /API Key/);
  assert.equal(composer.currentModel.value?.id, "b");
  await composer.selectModel("missing");
  assert.match(composer.modelError.value, /模型不存在/);
  assert.equal(calls.length, 1, "draft selection must wait until the first message to persist");
});

test("rapid session choices serialize PUTs and keep the latest choice visible until saved", async (t) => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  const puts: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    if (init.method !== "PUT") return json(models);
    puts.push({ url: String(url), init });
    return puts.length === 1 ? first.promise : second.promise;
  });
  const { composer, workspace, applied } = setup(t);
  await settle();
  const chooseB = composer.selectModel("b");
  await settle();
  const chooseC = composer.selectModel("c");
  assert.equal(puts.length, 1, "a later write must not race an unfinished write on the server");
  assert.equal(composer.currentModel.value?.id, "c");
  assert.equal(workspace.chatSelection.value.model, "c");
  assert.equal(composer.modelChanging.value, true);
  // A global SSE event for the first selection must not revert the latest choice.
  workspace.applyResponseMeta(meta("session-a", "b"));
  assert.equal(workspace.chatSelection.value.model, "c");
  first.resolve(json(meta("session-a", "b")));
  await chooseB;
  await settle();
  assert.equal(puts.length, 2);
  assert.equal(composer.currentModel.value?.id, "c");
  assert.equal(composer.modelChanging.value, true);
  assert.equal(puts[1]?.url, "http://127.0.0.1:3000/api/sessions/session-a/model");
  assert.deepEqual(JSON.parse(String(puts[1]?.init.body)), { model: "c" });
  second.resolve(json(meta("session-a", "c", "high")));
  await chooseC;
  assert.equal(composer.currentModel.value?.id, "c");
  assert.equal(composer.modelChanging.value, false);
  assert.equal(applied.length, 2, "the obsolete PUT response is not applied twice after SSE");
  assert.equal(workspace.chatSelection.value.reasoningEffort, "high", "the server retains a compatible effort");
});

test("superseded queued model choices are coalesced before contacting the server", async (t) => {
  const puts: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    if (init.method !== "PUT") return json(models);
    const { model } = JSON.parse(String(init.body)) as { model: string };
    puts.push(model);
    return json(meta("session-a", model));
  });
  const { composer } = setup(t);
  await settle();
  await Promise.all([composer.selectModel("b"), composer.selectModel("c")]);
  assert.deepEqual(puts, ["c"]);
  assert.equal(composer.currentModel.value?.id, "c");
  assert.equal(composer.modelChanging.value, false);
});

test("failed model writes restore saved selection and do not affect another session", async (t) => {
  const pending = deferred<Response>();
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => init.method === "PUT" ? pending.promise : json(models));
  const { composer, workspace } = setup(t);
  await settle();
  const changing = composer.selectModel("b");
  await settle();
  pending.resolve(json({ error: "切换被拒绝" }, 400));
  await changing;
  assert.equal(composer.currentModel.value?.id, "a");
  assert.equal(workspace.chatSelection.value.model, "a");
  assert.equal(composer.modelChanging.value, false);
  assert.equal(composer.modelError.value, "切换被拒绝");

  workspace.activeSessionId.value = "session-b";
  workspace.activeSession.value = { ...meta("session-b", "b"), events: [] };
  assert.equal(composer.currentModel.value?.id, "b");
  assert.equal(composer.modelError.value, "");
});

test("connection changes abort model writes and prevent stale metadata from crossing accounts", async (t) => {
  const pending = deferred<Response>();
  let putSignal: AbortSignal | null | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    if (init.method !== "PUT") return json(models);
    putSignal = init.signal;
    return pending.promise;
  });
  const { composer, workspace, applied } = setup(t);
  await settle();
  const changing = composer.selectModel("b");
  await settle();
  workspace.token.value = "other-account";
  assert.equal(putSignal?.aborted, true);
  assert.equal(composer.modelChanging.value, false);
  pending.resolve(json(meta("session-a", "b")));
  await changing;
  assert.equal(applied.length, 0);
  assert.equal(composer.modelError.value, "");
});

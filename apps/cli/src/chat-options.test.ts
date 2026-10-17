import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ChatOptions, HarnessConfig, SessionMeta } from "@qdd/shared";
import { chatOptions, resolveChatSelection } from "./agent/chat-options.js";
import { createChat, type ChatFn } from "./agent/llm.js";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { startGateway } from "./gateway/server.js";
import { SessionHub } from "./sessions.js";
import { ensureWorkspace } from "./web/site.js";

test("模型选项保留配置的默认模型，且只公开声明支持的强度", () => {
  const llm = { ...DEFAULT_CONFIG.llm, models: [{ id: "custom-chat", label: "自定义模型", reasoningEfforts: ["none", "medium"] as const }] };
  const options = chatOptions({ ...llm, models: llm.models.map((model) => ({ ...model, reasoningEfforts: [...model.reasoningEfforts] })) });
  assert.deepEqual(options.defaults, { model: DEFAULT_CONFIG.llm.model, reasoningEffort: "default" });
  assert.deepEqual(options.models[0]?.reasoningEfforts, ["default", "none", "low", "high", "max"]);
  assert.deepEqual(options.models[1], { id: "custom-chat", label: "自定义模型", reasoningEfforts: ["none", "medium"], defaultReasoningEffort: "none" });
  const compatible = { ...DEFAULT_CONFIG.llm, baseUrl: "https://compatible.example/v1" };
  assert.deepEqual(chatOptions(compatible).models[0]?.reasoningEfforts, ["default"]);
  assert.throws(() => resolveChatSelection(compatible, { reasoningEffort: "none" }), /不支持/);
  assert.deepEqual(chatOptions({ ...DEFAULT_CONFIG.llm, thinking: "disabled" }).defaults, { model: DEFAULT_CONFIG.llm.model, reasoningEffort: "none" });
  assert.throws(() => resolveChatSelection(DEFAULT_CONFIG.llm, { model: "not-configured" }), /未配置/);
  assert.throws(() => resolveChatSelection(DEFAULT_CONFIG.llm, { reasoningEffort: "medium" }), /不支持/);
});

test("配置加载拒绝重复模型、无效强度与不在候选中的默认强度", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qdd-model-config-"));
  for (const models of [
    [{ id: "repeat" }, { id: "repeat" }],
    [{ id: "bad", reasoningEfforts: ["invalid"] }],
    [{ id: "bad", reasoningEfforts: [] }],
    [{ id: "bad", reasoningEfforts: ["low"], defaultReasoningEffort: "high" }],
  ]) {
    await writeFile(path.join(root, "harness.config.json"), JSON.stringify({ llm: { models } }));
    await assert.rejects(loadConfig(root));
  }
});

test("DeepSeek 请求实际透传模型与思考强度，关闭与默认也显式控制 thinking", async (t) => {
  const apiKeyEnv = "QDD_CHAT_OPTIONS_TEST_KEY";
  const previous = process.env[apiKeyEnv];
  process.env[apiKeyEnv] = "test-key";
  t.after(() => {
    if (previous === undefined) delete process.env[apiKeyEnv];
    else process.env[apiKeyEnv] = previous;
  });
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "完成" } }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  });
  for (const reasoningEffort of ["default", "none", "low", "high", "max"] as const) {
    const chat = createChat({ ...DEFAULT_CONFIG.llm, apiKeyEnv, model: "configured-model", reasoningEffort });
    assert.equal((await chat([{ role: "user", content: "检查" }], [])).content, "完成");
  }
  assert.deepEqual(bodies.map((body) => body.model), Array(5).fill("configured-model"));
  assert.equal(Object.hasOwn(bodies[0]!, "reasoning_effort"), false);
  assert.deepEqual(bodies.map((body) => body.thinking), ["enabled", "disabled", "enabled", "enabled", "enabled"].map((type) => ({ type })));
  assert.deepEqual(bodies.slice(1).map((body) => body.reasoning_effort), ["none", "low", "high", "max"]);
  const compatible = createChat({ ...DEFAULT_CONFIG.llm, apiKeyEnv, baseUrl: "https://compatible.example/v1", reasoningEffort: "medium" });
  await compatible([{ role: "user", content: "检查" }], []);
  assert.equal(bodies.at(-1)?.reasoning_effort, "medium");
  assert.equal(Object.hasOwn(bodies.at(-1)!, "thinking"), false);
});

test("网关校验模型与强度，续聊切换真实生效并跨会话重载保留", { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "qdd-chat-options-"));
  const loaded = await loadConfig(root);
  loaded.config.gateway.port = 0;
  loaded.config.llm.models = [
    { id: "reasoning-model", label: "推理模型", reasoningEfforts: ["none", "low", "high"], defaultReasoningEffort: "high" },
    { id: "plain-model", reasoningEfforts: ["none"], defaultReasoningEffort: "none" },
  ];
  await ensureWorkspace(loaded.paths);
  const sources = await DataSources.open(loaded);
  const calls: HarnessConfig["llm"][] = [];
  const histories: string[][] = [];
  const chat: ChatFn = async (messages) => {
    histories.push(messages.filter((message) => message.role === "user").map((message) => message.content ?? ""));
    return { role: "assistant", content: null, tool_calls: [{ id: "reply", type: "function", function: { name: "reply", arguments: JSON.stringify({ text: "完成", gaps: [] }) } }] };
  };
  const factory = (llm: HarnessConfig["llm"]) => { calls.push(llm); return chat; };
  const token = "chat-options-gateway-token-0123456789";
  const gateway = await startGateway(loaded, sources, { token, chat: factory, scheduler: false });
  t.after(async () => { await gateway.close(); await sources.close(); });
  const api = (endpoint: string, body?: unknown) => fetch(`${gateway.url}${endpoint}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal((await fetch(`${gateway.url}/api/chat/options`)).status, 401);
  const optionsResponse = await api("/api/chat/options");
  assert.equal(optionsResponse.status, 200);
  const options = await optionsResponse.json() as ChatOptions;
  assert.deepEqual(options.models.map((model) => model.id), [loaded.config.llm.model, "reasoning-model", "plain-model"]);
  assert.equal(JSON.stringify(options).includes("apiKeyEnv"), false);
  assert.equal(JSON.stringify(options).includes("baseUrl"), false);
  for (const selection of [{ model: "not-configured" }, { model: 1 }, { reasoningEffort: "invalid" }, { model: "plain-model", reasoningEffort: "high" }]) {
    assert.equal((await api("/api/wishes", { wish: "检查无效选项", ...selection })).status, 400);
  }
  assert.equal((await gateway.hub.list()).length, 0, "无效选项不能写入孤立的会话");

  const createdResponse = await api("/api/wishes", { wish: "首轮", model: "reasoning-model", reasoningEffort: "low" });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as SessionMeta;
  await gateway.hub.wait(created.id);
  assert.equal(calls[0]?.model, "reasoning-model");
  assert.equal(calls[0]?.reasoningEffort, "low");

  assert.equal((await api(`/api/sessions/${created.id}/messages`, { text: "续聊", reasoningEffort: "high" })).status, 202);
  await gateway.hub.wait(created.id);
  assert.equal(calls[1]?.model, "reasoning-model");
  assert.equal(calls[1]?.reasoningEffort, "high");
  assert.equal((await api(`/api/sessions/${created.id}/messages`, { text: "无效切换", reasoningEffort: "max" })).status, 400);
  assert.equal(calls.length, 2);
  assert.equal((await gateway.hub.detail(created.id)).events.filter((event) => event.type === "user").length, 2);

  assert.equal((await api(`/api/sessions/${created.id}/messages`, { text: "换模型", model: "plain-model" })).status, 202);
  await gateway.hub.wait(created.id);
  const meta = await gateway.hub.meta(created.id);
  assert.equal(meta.model, "plain-model");
  assert.equal(meta.reasoningEffort, "none");
  assert.deepEqual(histories.at(-1)?.map((text) => text.replace(/\n\n[\s\S]*$/, "")), ["首轮", "续聊", "换模型"]);

  const reopened = new SessionHub(loaded, sources, factory);
  await reopened.send(created.id, "重载后继续");
  await reopened.wait(created.id);
  assert.equal(calls.at(-1)?.model, "plain-model");
  assert.equal(calls.at(-1)?.reasoningEffort, "none");
  assert.equal((await api("/health")).status, 200);
  assert.deepEqual(await (await api("/health")).json(), { status: "ok" });
  assert.equal((await api("/api/unknown-route")).status, 404);
});

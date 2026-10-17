import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AttachmentRef, ChatOptions, HarnessConfig, ModelCatalog, SessionMeta } from "@qdd/shared";
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

test("传入模型目录的别名、服务商配置与默认值一致，运行中切换及重载后仍生效", { timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "qdd-provider-options-"));
  await writeFile(path.join(root, "harness.config.json"), JSON.stringify({
    llm: {
      model: "unused-global-model",
      models: [
        {
          id: "store-reasoner",
          label: "门店推理",
          model: "deepseek-provider-model",
          provider: "DeepSeek",
          baseUrl: "https://api.deepseek.com",
          apiKeyEnv: "QDD_PROVIDER_DEEPSEEK_KEY",
          maxTokens: 1024,
          thinking: "enabled",
          reasoningEfforts: ["default", "none", "low", "high"],
          defaultReasoningEffort: "high",
        },
        {
          id: "store-compatible",
          label: "门店轻量",
          model: "compatible-provider-model",
          provider: "兼容服务",
          baseUrl: "https://compatible.example/v1",
          apiKeyEnv: "QDD_PROVIDER_COMPATIBLE_KEY",
          maxTokens: 2048,
          thinking: "disabled",
        },
      ],
    },
  }));
  const loaded = await loadConfig(root);
  loaded.config.gateway.port = 0;
  await ensureWorkspace(loaded.paths);
  const sources = await DataSources.open(loaded);
  const calls: HarnessConfig["llm"][] = [];
  const histories: string[][] = [];
  let releaseFirst!: () => void;
  const firstReply = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const factory = (llm: HarnessConfig["llm"]): ChatFn => {
    calls.push({ ...llm });
    const first = calls.length === 1;
    return async (messages) => {
      histories.push(messages.filter((message) => message.role === "user").map((message) => message.content ?? ""));
      if (first) await firstReply;
      return { role: "assistant", content: null, tool_calls: [{ id: "reply", type: "function", function: { name: "reply", arguments: JSON.stringify({ text: "完成", gaps: [] }) } }] };
    };
  };
  const token = "provider-options-gateway-token-0123456789";
  const gateway = await startGateway(loaded, sources, { token, chat: factory, scheduler: false });
  t.after(async () => { releaseFirst(); await gateway.close(); await sources.close(); });
  const api = (endpoint: string, body?: unknown, method = body === undefined ? "GET" : "POST") => fetch(`${gateway.url}${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const catalog = await (await api("/api/models")).json() as ModelCatalog;
  const options = await (await api("/api/chat/options")).json() as ChatOptions;
  assert.deepEqual(catalog.models.map((model) => model.id), ["store-reasoner", "store-compatible"]);
  assert.deepEqual(options.models.map((model) => model.id), catalog.models.map((model) => model.id));
  assert.equal(catalog.default, "store-reasoner");
  assert.deepEqual(options.defaults, { model: catalog.default, reasoningEffort: "high" });
  assert.deepEqual(options.models[1]?.reasoningEfforts, ["default"], "兼容服务不能继承全局 DeepSeek 的强度");
  assert.equal(options.models[1]?.defaultReasoningEffort, "default");
  for (const response of [catalog, options]) {
    assert.equal(JSON.stringify(response).includes("apiKeyEnv"), false);
    assert.equal(JSON.stringify(response).includes("baseUrl"), false);
  }
  assert.equal((await api("/api/wishes", { wish: "无效别名", model: "deepseek-provider-model" })).status, 400);
  assert.equal((await gateway.hub.list()).length, 0);

  const upload = await fetch(`${gateway.url}/api/attachments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent("报表/销售.csv") },
    body: "日期,销售额\n2026-10-17,1200\n",
  });
  assert.equal(upload.status, 201);
  const attachment = await upload.json() as AttachmentRef;
  const createdResponse = await api("/api/wishes", { wish: "首轮看看报表", attachments: [attachment.id] });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as SessionMeta;
  assert.equal(created.model, "store-reasoner");
  assert.equal(created.reasoningEffort, "high");
  assert.equal(gateway.hub.isRunning(created.id), true);
  const providerFields = (llm: HarnessConfig["llm"] | undefined) => llm && ({
    model: llm.model,
    baseUrl: llm.baseUrl,
    apiKeyEnv: llm.apiKeyEnv,
    maxTokens: llm.maxTokens,
    thinking: llm.thinking,
    reasoningEffort: llm.reasoningEffort,
  });
  const reasoner = {
    model: "deepseek-provider-model", baseUrl: "https://api.deepseek.com", apiKeyEnv: "QDD_PROVIDER_DEEPSEEK_KEY",
    maxTokens: 1024, thinking: "enabled", reasoningEffort: "high",
  };
  const compatible = {
    model: "compatible-provider-model", baseUrl: "https://compatible.example/v1", apiKeyEnv: "QDD_PROVIDER_COMPATIBLE_KEY",
    maxTokens: 2048, thinking: "disabled", reasoningEffort: "default",
  };
  assert.deepEqual(providerFields(calls[0]), reasoner);

  const switchedResponse = await api(`/api/sessions/${created.id}/model`, { model: "store-compatible" }, "PUT");
  assert.equal(switchedResponse.status, 200);
  const switched = await switchedResponse.json() as SessionMeta;
  assert.equal(switched.model, "store-compatible");
  assert.equal(switched.reasoningEffort, "default");
  assert.equal(calls.length, 1, "切换不改变已启动的模型请求");
  releaseFirst();
  await gateway.hub.wait(created.id);
  assert.equal((await gateway.hub.meta(created.id)).model, "store-compatible", "本轮完成不能覆盖下一轮选定的模型");
  assert.ok(histories[0]?.[0]?.includes(`id=${attachment.id}`));
  const user = (await gateway.hub.detail(created.id)).events.find((event) => event.type === "user");
  assert.deepEqual(user?.type === "user" ? user.attachments : undefined, [attachment]);

  assert.equal((await api(`/api/sessions/${created.id}/messages`, { text: "下一轮" })).status, 202);
  await gateway.hub.wait(created.id);
  assert.deepEqual(providerFields(calls[1]), compatible);
  assert.equal((await api(`/api/sessions/${created.id}/messages`, { text: "换回推理模型", model: "store-reasoner", reasoningEffort: "low" })).status, 202);
  await gateway.hub.wait(created.id);
  assert.deepEqual(providerFields(calls[2]), { ...reasoner, reasoningEffort: "low" });
  assert.equal((await api(`/api/sessions/${created.id}/model`, { model: "store-compatible" }, "PUT")).status, 200);

  const reopened = new SessionHub(loaded, sources, factory);
  await reopened.send(created.id, "重载后继续");
  await reopened.wait(created.id);
  assert.deepEqual(providerFields(calls[3]), compatible);
  assert.equal((await reopened.meta(created.id)).model, "store-compatible");
  assert.deepEqual(histories.at(-1)?.map((text) => text.replace(/\n\n[\s\S]*$/, "")), ["首轮看看报表", "下一轮", "换回推理模型", "重载后继续"]);
});

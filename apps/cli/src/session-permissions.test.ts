import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { JsonObject, PendingItem, PermissionMode, SessionDetail, SessionMeta, Skill } from "@qdd/shared";
import type { ChatFn, ChatMessage } from "./agent/llm.js";
import { loadConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { startGateway } from "./gateway/server.js";
import { SessionHub } from "./sessions.js";
import { ensureWorkspace, writeAtomic } from "./web/site.js";

const TOKEN = "session-permissions-test-token";
const TOOL = "mcp__android__android_control";

function call(name: string, args: JsonObject): ChatMessage {
  return { role: "assistant", content: null, tool_calls: [{ id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}

const reply = () => call("reply", { text: "完成" });

async function fixture(t: TestContext) {
  const parent = path.resolve(tmpdir());
  const root = await mkdtemp(path.join(parent, "qdd-session-permissions-"));
  const loaded = await loadConfig(root);
  loaded.config.gateway.port = 0;
  loaded.config.llm.clarify = "auto";
  await ensureWorkspace(loaded.paths);
  const sources = await DataSources.open(loaded, { connectMcp: false });
  const executed: string[] = [];
  sources.tools.push({
    name: TOOL, title: "门店手机操作", description: "权限回归测试的 MCP 工具", inputSchema: { type: "object" },
    source: "mcp:android", mutating: true, preauthorized: false,
    call: async (args) => { executed.push(String(args.label)); return { ok: true }; },
  });
  const prompts: string[] = [];
  let chat: ChatFn = async (messages) => {
    if (messages.at(-1)?.role === "tool") return reply();
    const label = messages.filter((message) => message.role === "user").at(-1)?.content?.split("\n\n")[0] ?? "";
    return call(TOOL, { label });
  };
  const factory = (): ChatFn => async (...args) => {
    prompts.push(args[0].find((message) => message.role === "system")?.content ?? "");
    return chat(...args);
  };
  const gateway = await startGateway(loaded, sources, { token: TOKEN, chat: factory, scheduler: false });
  const hubs = [gateway.hub];
  t.after(async () => {
    for (const hub of hubs) {
      const sessions = await hub.list();
      for (const session of sessions) hub.cancel(session.id);
      await Promise.all(sessions.map((session) => hub.wait(session.id)));
    }
    await gateway.close();
    await sources.close();
    const target = path.resolve(root);
    assert.equal(path.dirname(target), parent);
    assert.ok(path.basename(target).startsWith("qdd-session-permissions-"));
    await rm(target, { recursive: true, force: true });
  });
  const api = (route: string, body?: unknown, method = body === undefined ? "GET" : "POST") => fetch(gateway.url + route, {
    method, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const create = async (wish: string, permissionMode?: PermissionMode) => {
    const response = await api("/api/wishes", { wish, ...(permissionMode ? { permissionMode } : {}) });
    assert.equal(response.status, 201, await response.clone().text());
    return await response.json() as SessionMeta;
  };
  const select = async (id: string, permissionMode: PermissionMode) => {
    const response = await api(`/api/sessions/${id}/permissions`, { permissionMode }, "PUT");
    assert.equal(response.status, 200, await response.clone().text());
    const meta = await response.json() as SessionMeta;
    assert.equal(meta.permissionMode, permissionMode);
    return meta;
  };
  const pending = async (id: string, kind: PendingItem["kind"] = "approval") => {
    const deadline = Date.now() + 5000;
    while (true) {
      const items = await (await api("/api/pending")).json() as PendingItem[];
      const item = items.find((candidate) => candidate.sessionId === id && candidate.kind === kind);
      if (item && (await gateway.hub.meta(id)).status === "waiting") return item;
      assert.ok(Date.now() < deadline, `Expected ${kind} request for session ${id}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  };
  const approve = async (item: PendingItem) => {
    assert.equal((await api(`/api/sessions/${item.sessionId}/approvals/${item.requestId}`, { approved: true })).status, 200);
  };
  return {
    root, loaded, sources, gateway, api, create, select, pending, approve, executed, prompts,
    setChat(value: ChatFn) { chat = value; },
    reopen() {
      const hub = new SessionHub(loaded, sources, factory);
      hubs.push(hub);
      return hub;
    },
  };
}

test("new conversations default to approval and MCP writes wait for authenticated consent", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.create("默认审批");
  assert.equal(session.permissionMode, "approval");
  const item = await f.pending(session.id);
  assert.equal(item.kind, "approval");
  if (item.kind === "approval") {
    assert.equal(item.tool, TOOL);
    assert.equal(item.source, "mcp:android");
  }
  assert.deepEqual(f.executed, []);
  assert.doesNotMatch(f.prompts[0]!, /当前权限为完全访问/);
  assert.match(f.prompts[0]!, /歧义调用 clarify/);
  await f.approve(item);
  assert.equal((await f.gateway.hub.wait(session.id)).status, "idle");
  assert.deepEqual(f.executed, ["默认审批"]);
});

test("full access executes MCP writes without waiting and persists across turns and reload", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.create("完全访问首轮", "full-access");
  assert.equal((await f.gateway.hub.wait(session.id)).status, "idle");
  assert.equal((await f.gateway.hub.meta(session.id)).permissionMode, "full-access");
  assert.match(f.prompts[0]!, /当前权限为完全访问/);
  assert.match(f.prompts[0]!, /不再询问是否允许调用或执行/);
  assert.match(f.prompts[0]!, /业务需求缺少关键信息时仍可澄清/);
  assert.equal((await f.api(`/api/sessions/${session.id}/messages`, { text: "完全访问续聊" })).status, 202);
  await f.gateway.hub.wait(session.id);
  const reopened = f.reopen();
  assert.equal((await reopened.meta(session.id)).permissionMode, "full-access");
  await reopened.send(session.id, "完全访问重载");
  assert.equal((await reopened.wait(session.id)).status, "idle");
  assert.deepEqual(f.executed, ["完全访问首轮", "完全访问续聊", "完全访问重载"]);
  const detail = await (await f.api(`/api/sessions/${session.id}`)).json() as SessionDetail;
  assert.equal(detail.permissionMode, "full-access");
  assert.ok(detail.events.every((event) => event.type !== "approval_required" && !(event.type === "status" && event.status === "waiting")));
  assert.deepEqual(await f.gateway.hub.pending(), []);
});

test("switching a waiting session to full access releases its approval and isolates other conversations", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const first = await f.create("会话一");
  const second = await f.create("会话二");
  const firstApproval = await f.pending(first.id);
  const secondApproval = await f.pending(second.id);
  await f.select(first.id, "full-access");
  assert.equal((await f.gateway.hub.wait(first.id)).status, "idle");
  assert.deepEqual(f.executed, ["会话一"]);
  assert.equal((await f.gateway.hub.meta(second.id)).status, "waiting");
  assert.equal((await f.gateway.hub.meta(second.id)).permissionMode, "approval");
  assert.deepEqual((await f.gateway.hub.pending()).map((item) => item.requestId), [secondApproval.requestId]);
  assert.equal((await f.api(`/api/sessions/${first.id}/approvals/${firstApproval.requestId}`, { approved: true })).status, 404);
  const detail = await f.gateway.hub.detail(first.id);
  assert.ok(detail.events.some((event) => event.type === "approval_resolved" && event.requestId === firstApproval.requestId && event.approved));
  assert.match(f.prompts.at(-1)!, /当前权限为完全访问/, "The next model step must receive the changed permission promptly");
  await f.approve(secondApproval);
  await f.gateway.hub.wait(second.id);
  assert.deepEqual(f.executed, ["会话一", "会话二"]);
});

test("returning to approval restores future MCP consent and sending can explicitly change modes", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.create("已授权", "full-access");
  await f.gateway.hub.wait(session.id);
  await f.select(session.id, "approval");
  const reopened = f.reopen();
  assert.equal((await reopened.meta(session.id)).permissionMode, "approval");
  assert.equal((await f.api(`/api/sessions/${session.id}/messages`, { text: "恢复审批" })).status, 202);
  const approval = await f.pending(session.id);
  assert.deepEqual(f.executed, ["已授权"]);
  assert.doesNotMatch(f.prompts.at(-1)!, /当前权限为完全访问/);
  await f.approve(approval);
  await f.gateway.hub.wait(session.id);
  assert.equal((await f.api(`/api/sessions/${session.id}/messages`, { text: "续聊指定完全访问", permissionMode: "full-access" })).status, 202);
  assert.equal((await f.gateway.hub.wait(session.id)).permissionMode, "full-access");
  assert.deepEqual(f.executed, ["已授权", "恢复审批", "续聊指定完全访问"]);
});

test("concurrent idle permission and model changes cannot restore revoked full access", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  f.setChat(async () => reply());
  const session = await f.create("并发修改设置", "full-access");
  const hub = f.gateway.hub;
  await hub.wait(session.id);
  const internals = hub as unknown as { saveMeta(meta: SessionMeta): Promise<void> };
  const readMeta = hub.meta.bind(hub);
  const saveMeta = internals.saveMeta.bind(hub);
  let persisted = await readMeta(session.id);
  // Serve the persisted snapshot immediately so concurrent unqueued operations
  // deterministically read the same old permissions, regardless of disk timing.
  const readMock = t.mock.method(hub, "meta", async (id: string) => id === session.id ? structuredClone(persisted) : readMeta(id));
  const writeMock = t.mock.method(internals, "saveMeta", async (meta: SessionMeta) => {
    const snapshot = structuredClone(meta);
    await saveMeta(meta);
    if (meta.id === session.id) persisted = snapshot;
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    await hub.selectPermissionMode(session.id, "full-access");
    const [permissions, model] = await Promise.all([
      hub.selectPermissionMode(session.id, "approval"),
      hub.selectModel(session.id, session.model ?? f.loaded.config.llm.model),
    ]);
    assert.equal(permissions.permissionMode, "approval");
    assert.equal(permissions.model, session.model);
    assert.equal(model.permissionMode, "approval", "Selecting a model must retain the concurrent permission downgrade");
    assert.equal(model.model, session.model);
    assert.equal(persisted.permissionMode, "approval");
    assert.equal((await f.reopen().meta(session.id)).permissionMode, "approval");
  }
  readMock.mock.restore();
  writeMock.mock.restore();
  assert.equal((await hub.meta(session.id)).permissionMode, "approval");
});

test("switching a running session back to approval applies before its next tool executes", { timeout: 10_000 }, async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  f.setChat(async (messages) => {
    if (messages.at(-1)?.role === "tool") return reply();
    entered();
    await gate;
    return call(TOOL, { label: "运行中恢复审批" });
  });
  const session = await f.create("运行中切换", "full-access");
  await started;
  await f.select(session.id, "approval");
  release();
  const approval = await f.pending(session.id);
  assert.deepEqual(f.executed, [], "A previously started model request cannot retain revoked full access");
  await f.approve(approval);
  assert.equal((await f.gateway.hub.wait(session.id)).permissionMode, "approval");
  assert.deepEqual(f.executed, ["运行中恢复审批"]);
});

test("full access covers built-in harness approvals as well as MCP tools", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  f.setChat(async (messages) => {
    if (messages.at(-1)?.role === "tool") return reply();
    const name = messages.filter((message) => message.role === "user").at(-1)?.content?.split("\n\n")[0] ?? "";
    return call("save_skill", { name, description: "权限测试", steps: ["检查门店手机"], tools: [TOOL] });
  });
  const approvalSession = await f.create("审批技能");
  const approval = await f.pending(approvalSession.id);
  assert.equal(approval.kind === "approval" ? approval.tool : "", "save_skill");
  assert.ok(!(await (await f.api("/api/skills")).json() as Skill[]).some((skill) => skill.name === "审批技能"));
  await f.approve(approval);
  await f.gateway.hub.wait(approvalSession.id);
  const fullSession = await f.create("完全访问技能", "full-access");
  assert.equal((await f.gateway.hub.wait(fullSession.id)).status, "idle");
  const skills = await (await f.api("/api/skills")).json() as Skill[];
  assert.ok(skills.some((skill) => skill.name === "审批技能"));
  assert.ok(skills.some((skill) => skill.name === "完全访问技能"));
  assert.ok((await f.gateway.hub.detail(fullSession.id)).events.every((event) => event.type !== "approval_required"));
});

test("full access preserves ordinary clarification questions and does not authorize another session", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  let step = 0;
  f.setChat(async () => step++ === 0
    ? call("clarify", { questions: [{ id: "scope", question: "操作哪家门店？", options: [{ label: "门店一" }, { label: "门店二" }] }] })
    : reply());
  const session = await f.create("选择门店", "full-access");
  const question = await f.pending(session.id, "question");
  assert.equal(question.kind, "question");
  await f.select(session.id, "full-access");
  assert.equal((await f.gateway.hub.meta(session.id)).status, "waiting");
  assert.equal((await f.gateway.hub.pending())[0]?.requestId, question.requestId);
  assert.equal((await f.api(`/api/sessions/${session.id}/questions/${question.requestId}`, { answers: { scope: ["门店一"] } })).status, 200);
  assert.equal((await f.gateway.hub.wait(session.id)).status, "idle");
  assert.deepEqual(f.executed, []);
  assert.ok((await f.gateway.hub.detail(session.id)).events.some((event) => event.type === "question_answered" && event.answers?.scope?.[0] === "门店一"));
});

test("permissions endpoint authenticates and rejects invalid modes before mutating state", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  f.setChat(async () => reply());
  for (const permissionMode of ["invalid", "full", "", 1, true, null, {}]) {
    assert.equal((await f.api("/api/wishes", { wish: "无效权限", permissionMode })).status, 400);
  }
  assert.deepEqual(await f.gateway.hub.list(), []);
  const session = await f.create("权限校验");
  await f.gateway.hub.wait(session.id);
  assert.equal((await fetch(`${f.gateway.url}/api/sessions/${session.id}/permissions`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ permissionMode: "full-access" }),
  })).status, 401);
  for (const permissionMode of ["invalid", "full", "", 1, true, null, {}]) {
    assert.equal((await f.api(`/api/sessions/${session.id}/permissions`, { permissionMode }, "PUT")).status, 400);
    assert.equal((await f.api(`/api/sessions/${session.id}/messages`, { text: "无效权限续聊", permissionMode })).status, 400);
  }
  assert.equal((await f.api(`/api/sessions/${session.id}/permissions`, {}, "PUT")).status, 400);
  assert.equal((await f.gateway.hub.meta(session.id)).permissionMode, "approval");
  assert.equal((await f.gateway.hub.detail(session.id)).events.filter((event) => event.type === "user").length, 1);
});

test("legacy conversations without permission metadata remain in approval mode when resumed", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  f.setChat(async () => reply());
  const session = await f.create("旧版对话");
  await f.gateway.hub.wait(session.id);
  const file = path.join(f.loaded.paths.sessions, `${session.id}.meta.json`);
  const legacy = JSON.parse(await readFile(file, "utf8")) as SessionMeta;
  delete legacy.permissionMode;
  await writeAtomic(file, JSON.stringify(legacy));
  const reopened = f.reopen();
  f.setChat(async (messages) => messages.at(-1)?.role === "tool" ? reply() : call(TOOL, { label: "旧版续聊" }));
  await reopened.send(session.id, "旧版续聊");
  const deadline = Date.now() + 5000;
  let item: PendingItem | undefined;
  while (!item) {
    item = (await reopened.pending()).find((candidate) => candidate.kind === "approval");
    assert.ok(Date.now() < deadline, "Legacy conversation should request approval");
    if (!item) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await reopened.meta(session.id)).permissionMode, "approval");
  assert.deepEqual(f.executed, []);
  reopened.approve(session.id, item.requestId, true);
  assert.equal((await reopened.wait(session.id)).status, "idle");
  assert.deepEqual(f.executed, ["旧版续聊"]);
});

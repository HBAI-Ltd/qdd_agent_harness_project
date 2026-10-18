import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { GatewayEvent, Overview, PendingItem, Schedule, SessionDetail, SessionEvent, SessionMeta } from "@qdd/shared";
import type { ChatFn, ChatMessage } from "./agent/llm.js";
import { loadConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { startGateway } from "./gateway/server.js";
import { SessionHub } from "./sessions.js";
import { ensureWorkspace, readPages } from "./web/site.js";

const TOKEN = "schedule-isolation-test-token";
const KINDS = ["meta.json", "events.jsonl", "messages.json"] as const;

function tool(name: string, args: object): ChatMessage {
  return { role: "assistant", content: null, tool_calls: [{ id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}

const reply = () => tool("reply", { text: "检查完成", gaps: [] });

async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("等待测试条件超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function fixture(t: TestContext, chat: ChatFn = async () => reply()) {
  const root = await mkdtemp(path.join(tmpdir(), "qdd-schedule-sessions-"));
  const loaded = await loadConfig(root);
  loaded.config.gateway.port = 0;
  loaded.config.llm.clarify = "auto";
  await ensureWorkspace(loaded.paths);
  const sources = await DataSources.open(loaded);
  const options = { token: TOKEN, chat: () => chat, scheduler: false };
  const state = {
    loaded,
    sources,
    gateway: await startGateway(loaded, sources, options),
    api: (url: string, init: RequestInit = {}) => fetch(state.gateway.url + url, {
      ...init,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...init.headers },
    }),
    post: (url: string, body: unknown) => state.api(url, { method: "POST", body: JSON.stringify(body) }),
    restart: async () => {
      await state.gateway.close();
      state.gateway = await startGateway(loaded, sources, options);
    },
  };
  t.after(async () => {
    for (const item of await state.gateway.hub.pending()) {
      state.gateway.hub.cancel(item.sessionId);
      await state.gateway.hub.wait(item.sessionId);
    }
    await state.gateway.close();
    await sources.close();
  });
  return state;
}

/** Read the stream continuously; each assertion waits for a concrete later event as a flush barrier. */
async function collectSse<T>(api: (url: string, init?: RequestInit) => Promise<Response>, url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const response = await api(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const events: T[] = [];
  const reading = (async () => {
    let buffered = "";
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffered += decoder.decode(chunk.value, { stream: true });
        let boundary: number;
        while ((boundary = buffered.indexOf("\n\n")) !== -1) {
          const frame = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)) as T);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      clearTimeout(timeout);
    }
  })();
  return { events, stop: async () => { controller.abort(); await reading; } };
}

test("定时发布不记录任务提示词，已有页面保留 wish，新页面 wish 为空", { timeout: 15000 }, async (t) => {
  const prompts: string[] = [];
  const f = await fixture(t, async (messages) => {
    const last = messages.at(-1)!;
    if (last.role === "user") {
      prompts.push(String(last.content));
      return tool("write_file", { path: "index.html", content: "<p>检查完成</p>" });
    }
    return tool("finish", { title: "检查结果", summary: "检查完成", tools: [], useAgent: false, gaps: [] });
  });
  const originalWish = "创建检查页面";
  const ordinary = await f.gateway.hub.create(originalWish);
  const ordinaryResult = await f.gateway.hub.wait(ordinary.id);
  assert.equal(ordinaryResult.status, "idle");
  assert.ok(ordinaryResult.slug);
  assert.equal((await readPages(f.loaded.paths)).find((page) => page.slug === ordinaryResult.slug)?.wish, originalWish);

  for (const slug of [ordinaryResult.slug, undefined]) {
    const prompt = slug ? "定时刷新已有检查页面" : "定时创建检查页面";
    const schedule = await f.gateway.scheduler.create({ name: "检查任务", cron: "0 8 * * *", prompt, ...(slug ? { slug } : {}) });
    const manualId = await f.gateway.scheduler.runNow(schedule.id);
    await until(async () => (await f.gateway.scheduler.get(schedule.id)).lastRun?.sessionId === manualId ? true : undefined);
    const manual = await f.gateway.hub.detail(manualId);
    assert.equal(manual.status, "idle");
    assert.ok(manual.slug);
    const expectedWish = slug ? originalWish : "";
    const published = manual.events.find((event) => event.type === "published");
    assert.ok(published?.type === "published");
    assert.equal(published.page.wish, expectedWish);
    assert.equal((await readPages(f.loaded.paths)).find((page) => page.slug === manual.slug)?.wish, expectedWish);
    assert.ok(prompts.some((text) => text.includes(prompt)));

    await f.gateway.scheduler.update(schedule.id, { slug: manual.slug });
    const stored = JSON.parse(await readFile(f.loaded.paths.schedules, "utf8")) as { schedules: Schedule[] };
    stored.schedules.find((entry) => entry.id === schedule.id)!.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await writeFile(f.loaded.paths.schedules, JSON.stringify(stored));
    await f.gateway.scheduler.tick();
    const dueId = await until(async () => {
      const run = (await f.gateway.scheduler.get(schedule.id)).lastRun;
      return run?.sessionId && run.sessionId !== manualId ? run.sessionId : undefined;
    });
    assert.equal((await f.gateway.hub.detail(dueId)).status, "idle");
    const refreshed = (await readPages(f.loaded.paths)).find((page) => page.slug === manual.slug);
    assert.equal(refreshed?.wish, expectedWish);
    assert.equal(refreshed?.version, published.page.version + 1);
  }

  const update = await f.gateway.hub.create("手动修改检查页面", { slug: ordinaryResult.slug });
  assert.equal((await f.gateway.hub.wait(update.id)).status, "idle");
  assert.equal((await readPages(f.loaded.paths)).find((page) => page.slug === ordinaryResult.slug)?.wish, `${originalWish} → 手动修改检查页面`);
});

test("重启遗留的授权请求返回 404，取消接口返回持久化终态且 SSE 可回放中断", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  const at = "2026-10-17T01:00:00Z";
  const meta: SessionMeta = {
    id, title: "等待授权时重启", summary: "", slug: null, status: "waiting",
    createdAt: at, updatedAt: at,
    origin: { kind: "schedule", scheduleId: randomUUID(), scheduleName: "测试任务" },
  };
  await writeFile(path.join(f.loaded.paths.scheduleSessions, `${id}.meta.json`), JSON.stringify(meta));
  await writeFile(path.join(f.loaded.paths.scheduleSessions, `${id}.events.jsonl`), JSON.stringify({
    type: "approval_required", requestId: "expired", tool: "save_skill", source: "builtin", args: {}, at,
  }) + "\n");
  const approval = await f.post(`/api/sessions/${id}/approvals/expired`, { approved: true });
  assert.equal(approval.status, 404);
  assert.match((await approval.json() as { error: string }).error, /授权请求不存在或已过期/);
  const cancellation = await f.post(`/api/sessions/${id}/cancel`, {});
  assert.equal(cancellation.status, 202);
  assert.equal((await cancellation.json() as SessionMeta).status, "error");
  const stream = await collectSse<SessionEvent>(f.api, `/api/sessions/${id}/events?since=1`);
  t.after(stream.stop);
  await until(async () => stream.events.some((event) => event.type === "status" && event.status === "error") ? true : undefined);
  assert.ok(stream.events.some((event) => event.type === "error" && event.message.includes("中断")));
  assert.equal(JSON.parse(await readFile(path.join(f.loaded.paths.scheduleSessions, `${id}.meta.json`), "utf8")).status, "error");
});

test("立即运行与到期任务分目录保存，不进入会话列表或全局会话更新；重启后仍能查看和续聊", { timeout: 15000 }, async (t) => {
  const seen: ChatMessage[][] = [];
  const f = await fixture(t, async (messages) => { seen.push(structuredClone(messages)); return reply(); });
  const health = await f.api("/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  assert.equal((await f.api("/api/unknown-route")).status, 404);
  const stream = await collectSse<GatewayEvent>(f.api, "/api/events");
  t.after(stream.stop);
  const schedule = await (await f.post("/api/schedules", { name: "库存检查", cron: "0 8 * * *", prompt: "检查定时任务库存" })).json() as Schedule;
  const manual = await (await f.post(`/api/schedules/${schedule.id}/run`, {})).json() as { sessionId: string };
  await until(async () => (await f.gateway.scheduler.get(schedule.id)).lastRun?.sessionId === manual.sessionId ? true : undefined);

  const schedules = JSON.parse(await readFile(f.loaded.paths.schedules, "utf8")) as { schedules: Schedule[] };
  schedules.schedules[0]!.nextRunAt = new Date(Date.now() - 60_000).toISOString();
  await writeFile(f.loaded.paths.schedules, JSON.stringify(schedules));
  await f.gateway.scheduler.tick();
  const due = await until(async () => {
    const run = (await f.gateway.scheduler.get(schedule.id)).lastRun;
    return run?.sessionId && run.sessionId !== manual.sessionId ? run.sessionId : undefined;
  });

  // This ordinary idle event arrives after both scheduled runs and bounds the SSE assertion.
  const ordinary = await (await f.post("/api/wishes", { wish: "普通聊天" })).json() as SessionMeta;
  await f.gateway.hub.wait(ordinary.id);
  await until(async () => stream.events.some((e) => e.type === "session_updated" && e.session.id === ordinary.id && e.session.status === "idle") ? true : undefined);
  const updates = stream.events.filter((e) => e.type === "session_updated");
  assert.ok(updates.length > 0);
  assert.ok(updates.every((e) => e.session.id === ordinary.id));
  assert.ok(stream.events.some((e) => e.type === "schedules_changed"));
  await stream.stop();

  const listed = await (await f.api("/api/sessions")).json() as SessionMeta[];
  assert.deepEqual(listed.map((session) => session.id), [ordinary.id]);
  const overview = await (await f.api("/api/overview")).json() as Overview;
  assert.equal(overview.sessions.total, 1);
  assert.equal(f.loaded.paths.scheduleSessions, path.join(f.loaded.paths.workspace, "schedule-sessions"));
  assert.deepEqual((await readdir(f.loaded.paths.sessions)).sort(), KINDS.map((kind) => `${ordinary.id}.${kind}`).sort());
  assert.deepEqual((await readdir(f.loaded.paths.scheduleSessions)).sort(), [manual.sessionId, due].flatMap((id) => KINDS.map((kind) => `${id}.${kind}`)).sort());
  for (const id of [manual.sessionId, due]) {
    const meta = JSON.parse(await readFile(path.join(f.loaded.paths.scheduleSessions, `${id}.meta.json`), "utf8")) as SessionMeta;
    assert.deepEqual(meta.origin, { kind: "schedule", scheduleId: schedule.id, scheduleName: schedule.name });
    const events = (await readFile(path.join(f.loaded.paths.scheduleSessions, `${id}.events.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as SessionEvent);
    assert.ok(events.some((e) => e.type === "user" && e.text === schedule.prompt));
    const messages = JSON.parse(await readFile(path.join(f.loaded.paths.scheduleSessions, `${id}.messages.json`), "utf8")) as ChatMessage[];
    assert.ok(messages.some((message) => message.role === "user" && message.content?.startsWith(schedule.prompt)));
  }

  await f.restart();
  const detail = await (await f.api(`/api/sessions/${manual.sessionId}`)).json() as SessionDetail;
  assert.equal(detail.status, "idle");
  assert.equal(detail.origin?.scheduleId, schedule.id);
  assert.ok(detail.events.some((e) => e.type === "user" && e.text === schedule.prompt));
  assert.equal((await f.api(`/api/sessions/${ordinary.id}`)).status, 200);
  const before = seen.length;
  assert.equal((await f.post(`/api/sessions/${manual.sessionId}/messages`, { text: "继续执行" })).status, 202);
  assert.equal((await f.gateway.hub.wait(manual.sessionId)).status, "idle");
  assert.ok(seen[before]!.some((message) => message.role === "user" && message.content?.startsWith(schedule.prompt)), "续聊应读取已保存的模型对话");
  const continued = await f.gateway.hub.detail(manual.sessionId);
  assert.ok(continued.events.some((e) => e.type === "user" && e.text === "继续执行"));
  assert.deepEqual((await f.gateway.hub.list()).map((session) => session.id), [ordinary.id]);
  assert.ok(!(await readdir(f.loaded.paths.sessions)).some((name) => name.startsWith(manual.sessionId)));
});

test("工作区初始化完整迁移旧定时会话且可重复执行，后来出现的旧记录仍不进入列表", { timeout: 10000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "qdd-schedule-migration-"));
  const loaded = await loadConfig(root);
  await ensureWorkspace(loaded.paths);
  const at = "2026-10-17T01:00:00.000Z";
  const ordinary: SessionMeta = { id: randomUUID(), title: "原有聊天", summary: "聊天摘要", slug: null, status: "idle", createdAt: at, updatedAt: at };
  const scheduled: SessionMeta = { ...ordinary, id: randomUUID(), title: "旧定时任务", origin: { kind: "schedule", scheduleId: randomUUID(), scheduleName: "旧定时任务" } };
  const record = (meta: SessionMeta) => [JSON.stringify(meta), `${JSON.stringify({ type: "user", text: meta.title, at })}\n`, JSON.stringify([{ role: "user", content: meta.title }])];
  for (const meta of [ordinary, scheduled]) {
    await Promise.all(KINDS.map((kind, index) => writeFile(path.join(loaded.paths.sessions, `${meta.id}.${kind}`), record(meta)[index]!)));
  }
  // A previous interrupted migration may already have copied a file.
  await writeFile(path.join(loaded.paths.scheduleSessions, `${scheduled.id}.events.jsonl`), record(scheduled)[1]!);
  await ensureWorkspace(loaded.paths);
  await ensureWorkspace(loaded.paths);
  assert.deepEqual((await readdir(loaded.paths.sessions)).sort(), KINDS.map((kind) => `${ordinary.id}.${kind}`).sort());
  assert.deepEqual((await readdir(loaded.paths.scheduleSessions)).sort(), KINDS.map((kind) => `${scheduled.id}.${kind}`).sort());
  for (const [index, kind] of KINDS.entries()) {
    assert.equal(await readFile(path.join(loaded.paths.scheduleSessions, `${scheduled.id}.${kind}`), "utf8"), record(scheduled)[index]);
    assert.equal(await readFile(path.join(loaded.paths.sessions, `${ordinary.id}.${kind}`), "utf8"), record(ordinary)[index]);
  }
  const late = { ...scheduled, id: randomUUID() };
  await Promise.all(KINDS.map((kind, index) => writeFile(path.join(loaded.paths.sessions, `${late.id}.${kind}`), record(late)[index]!)));
  const sources = await DataSources.open(loaded);
  t.after(() => sources.close());
  const hub = new SessionHub(loaded, sources, () => async () => reply());
  assert.deepEqual((await hub.list()).map((session) => session.id), [ordinary.id]);
  for (const meta of [scheduled, late]) {
    const detail = await hub.detail(meta.id);
    assert.deepEqual(detail.origin, scheduled.origin);
    assert.ok(detail.events.some((event) => event.type === "user" && event.text === meta.title));
  }
  const conflict = { ...scheduled, id: randomUUID() };
  await Promise.all(KINDS.map((kind, index) => writeFile(path.join(loaded.paths.sessions, `${conflict.id}.${kind}`), record(conflict)[index]!)));
  const existingEvents = `${JSON.stringify({ type: "user", text: "另一个已保存的事件", at })}\n`;
  await writeFile(path.join(loaded.paths.scheduleSessions, `${conflict.id}.events.jsonl`), existingEvents);
  await assert.rejects(ensureWorkspace(loaded.paths), /目标文件已存在且内容不同/);
  assert.equal(await readFile(path.join(loaded.paths.scheduleSessions, `${conflict.id}.events.jsonl`), "utf8"), existingEvents);
  for (const [index, kind] of KINDS.entries()) {
    assert.equal(await readFile(path.join(loaded.paths.sessions, `${conflict.id}.${kind}`), "utf8"), record(conflict)[index], "迁移冲突应完整保留旧文件");
  }
});

test("定时任务立即运行、到期执行及重启后续聊自动授权，保留来源与事件回放", { timeout: 15000 }, async (t) => {
  let writes = 0;
  const f = await fixture(t, async (messages, tools) => {
    assert.match(String(messages[0]!.content), /所有工具调用.*由 harness 自动授权/);
    assert.match(String(messages[0]!.content), /当前提问策略：off/);
    assert.doesNotMatch(String(messages[0]!.content), /写入类操作会进入店长的工作台待办/);
    assert.ok(!tools.some((entry) => entry.function.name === "create_schedule"));
    assert.match(tools.find((entry) => entry.function.name === "test__write")!.function.description, /定时任务自动授权/);
    const last = messages.at(-1)!;
    if (last.role === "user") return tool("test__write", {});
    if (last.role === "tool" && messages.at(-2)?.tool_calls?.[0]?.function.name === "test__write")
      return tool("save_skill", { name: `检查技能${writes}`, description: "检查库存", steps: ["检查库存"] });
    return reply();
  });
  f.sources.tools.push({
    name: "test__write", description: "测试写入", inputSchema: { type: "object" },
    source: "mcp:test", mutating: true, preauthorized: false,
    call: async () => { writes++; return { ok: true }; },
  });
  const schedule = await f.gateway.scheduler.create({ name: "自动授权的任务", cron: "0 8 * * *", prompt: "执行写入并保存检查技能" });
  const sessionId = await f.gateway.scheduler.runNow(schedule.id);
  await until(async () => (await f.gateway.scheduler.get(schedule.id)).lastRun?.sessionId === sessionId ? true : undefined);
  assert.equal(writes, 1);

  const stream = await collectSse<SessionEvent>(f.api, `/api/sessions/${sessionId}/events`);
  t.after(stream.stop);
  await until(async () => stream.events.some((event) => event.type === "status" && event.status === "idle") ? true : undefined);
  assert.ok(stream.events.some((event) => event.type === "tool" && event.tool.name === "test__write" && event.tool.status === "success"));
  assert.ok(!stream.events.some((event) => event.type === "approval_required"));
  await stream.stop();

  const stored = JSON.parse(await readFile(f.loaded.paths.schedules, "utf8")) as { schedules: Schedule[] };
  stored.schedules[0]!.nextRunAt = new Date(Date.now() - 60_000).toISOString();
  await writeFile(f.loaded.paths.schedules, JSON.stringify(stored));
  await f.gateway.scheduler.tick();
  const dueId = await until(async () => {
    const run = (await f.gateway.scheduler.get(schedule.id)).lastRun;
    return run?.sessionId && run.sessionId !== sessionId ? run.sessionId : undefined;
  });
  assert.equal(writes, 2);
  assert.equal((await f.gateway.scheduler.get(schedule.id)).lastRun!.status, "ok");

  await f.restart();
  assert.equal((await f.post(`/api/sessions/${sessionId}/messages`, { text: "继续执行" })).status, 202);
  assert.equal((await f.gateway.hub.wait(sessionId)).status, "idle");
  assert.equal(writes, 3);
  assert.equal((await f.gateway.workbench.skills.list()).filter((skill) => skill.source !== "builtin").length, 3);
  for (const id of [sessionId, dueId]) {
    const detail = await f.gateway.hub.detail(id);
    assert.equal(detail.status, "idle");
    assert.deepEqual(detail.origin, { kind: "schedule", scheduleId: schedule.id, scheduleName: schedule.name });
    assert.ok(!detail.events.some((event) => event.type === "approval_required" || event.type === "question_required"
      || (event.type === "status" && event.status === "waiting")));
  }
  assert.deepEqual(await (await f.api("/api/pending")).json(), []);
  assert.deepEqual(await (await f.api("/api/sessions")).json(), []);
  assert.equal((await f.gateway.scheduler.get(schedule.id)).currentRun, undefined);
  assert.doesNotMatch(await readFile(f.loaded.paths.schedules, "utf8"), /currentRun/);
});

test("普通会话即使无人值守也仍需授权，支持拒绝与取消", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, async (messages) => messages.at(-1)!.role === "user"
    ? tool("save_skill", { name: "需确认的技能", description: "检查库存", steps: ["检查库存"] })
    : reply());
  for (const unattended of [false, true]) {
    const session = await f.gateway.hub.create("保存检查技能", { unattended });
    const pending = await until(async () => {
      const items = await (await f.api("/api/pending")).json() as PendingItem[];
      return items.find((item) => item.sessionId === session.id);
    });
    assert.equal(pending.kind, "approval");
    assert.equal(pending.origin, undefined);
    await until(async () => (await f.gateway.hub.meta(session.id)).status === "waiting" ? true : undefined);
    if (unattended) {
      assert.equal((await f.post(`/api/sessions/${session.id}/cancel`, {})).status, 202);
      assert.equal((await f.gateway.hub.wait(session.id)).status, "error");
    } else {
      assert.equal((await f.post(`/api/sessions/${session.id}/approvals/${pending.requestId}`, { approved: false })).status, 200);
      assert.equal((await f.gateway.hub.wait(session.id)).status, "idle");
    }
    assert.deepEqual((await f.gateway.workbench.skills.list()).filter((skill) => skill.source !== "builtin"), []);
    assert.deepEqual(await f.gateway.hub.pending(), []);
  }
});

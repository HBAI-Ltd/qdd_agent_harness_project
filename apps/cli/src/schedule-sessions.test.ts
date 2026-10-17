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
import { ensureWorkspace } from "./web/site.js";

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

test("隔离后的定时执行保留授权来源、事件回放与授权和取消入口", { timeout: 15000 }, async (t) => {
  const script = [
    tool("save_skill", { name: "盘点检查", description: "检查库存", steps: ["检查库存"] }),
    reply(),
    tool("save_skill", { name: "补货检查", description: "检查补货", steps: ["检查补货"] }),
    reply(),
  ];
  const f = await fixture(t, async () => script.shift() ?? reply());
  const schedule = await f.gateway.scheduler.create({ name: "等待授权的任务", cron: "0 8 * * *", prompt: "保存检查技能" });
  const sessionId = await f.gateway.scheduler.runNow(schedule.id);
  const pending = await until(async () => {
    const items = await (await f.api("/api/pending")).json() as PendingItem[];
    return items.find((item) => item.sessionId === sessionId);
  });
  assert.equal(pending.kind, "approval");
  assert.deepEqual(pending.origin, { kind: "schedule", scheduleId: schedule.id, scheduleName: schedule.name });
  assert.deepEqual(await (await f.api("/api/sessions")).json(), []);
  const waiting = await until(async () => {
    const current = await (await f.api(`/api/schedules/${schedule.id}`)).json() as Schedule;
    return current.currentRun?.status === "waiting" ? current.currentRun : undefined;
  });
  assert.equal(waiting.sessionId, sessionId);
  const listed = await (await f.api("/api/schedules")).json() as Schedule[];
  assert.deepEqual(listed[0]!.currentRun, waiting);
  assert.doesNotMatch(await readFile(f.loaded.paths.schedules, "utf8"), /currentRun/);

  const stream = await collectSse<SessionEvent>(f.api, `/api/sessions/${sessionId}/events`);
  t.after(stream.stop);
  await until(async () => stream.events.some((event) => event.type === "approval_required" && event.requestId === pending.requestId) ? true : undefined);
  assert.equal((await f.post(`/api/sessions/${sessionId}/approvals/${pending.requestId}`, { approved: true })).status, 200);
  await until(async () => stream.events.some((event) => event.type === "status" && event.status === "idle") ? true : undefined);
  assert.ok(stream.events.some((event) => event.type === "approval_resolved" && event.requestId === pending.requestId && event.approved));
  const finished = await until(async () => {
    const current = await f.gateway.scheduler.get(schedule.id);
    return current.lastRun?.sessionId === sessionId ? current : undefined;
  });
  assert.equal(finished.lastRun!.status, "ok");
  assert.equal(finished.currentRun, undefined);
  assert.equal((await f.gateway.workbench.skills.list())[0]!.name, "盘点检查");
  await stream.stop();

  const cancelledId = await f.gateway.scheduler.runNow(schedule.id);
  await until(async () => (await f.gateway.hub.pending()).some((item) => item.sessionId === cancelledId) ? true : undefined);
  assert.equal((await f.post(`/api/sessions/${cancelledId}/cancel`, {})).status, 202);
  assert.equal((await f.gateway.hub.wait(cancelledId)).status, "error");
  await until(async () => (await f.gateway.scheduler.get(schedule.id)).lastRun?.sessionId === cancelledId ? true : undefined);
  assert.deepEqual(await f.gateway.hub.pending(), []);
  assert.ok((await f.gateway.hub.detail(cancelledId)).events.some((event) => event.type === "error" && event.message === "已取消"));
  assert.deepEqual(await (await f.api("/api/sessions")).json(), []);
  assert.doesNotMatch(await readFile(f.loaded.paths.schedules, "utf8"), /currentRun/);
});

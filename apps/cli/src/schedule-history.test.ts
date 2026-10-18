import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Schedule, SessionDetail, SessionMeta } from "@qdd/shared";
import { loadConfig, type LoadedConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { startGateway, type Gateway } from "./gateway/server.js";
import { ensureWorkspace } from "./web/site.js";

const token = "schedule-history-test-token";
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
let root: string;
let loaded: LoadedConfig;
let sources: DataSources;
let gateway: Gateway;
let schedule: Schedule;
let expected: SessionMeta[];
let normal: SessionMeta;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "qdd-schedule-history-"));
  loaded = await loadConfig(root);
  loaded.config.gateway.port = 0;
  loaded.config.gateway.host = "127.0.0.1";
  await ensureWorkspace(loaded.paths);
  sources = await DataSources.open(loaded);
  gateway = await startGateway(loaded, sources, { token, scheduler: false, chat: () => async () => ({ role: "assistant", content: "ok" }) });
  const response = await fetch(`${gateway.url}/api/schedules`, {
    method: "POST", headers, body: JSON.stringify({ name: "日报", cron: "0 8 * * *", prompt: "整理日报", enabled: false }),
  });
  assert.equal(response.status, 201);
  schedule = await response.json() as Schedule;
  const make = (createdAt: string, extra: Partial<SessionMeta> = {}): SessionMeta => ({
    id: randomUUID(), title: "日报", summary: "执行结论", slug: null, status: "idle", createdAt, updatedAt: createdAt, ...extra,
  });
  const origin = { kind: "schedule" as const, scheduleId: schedule.id, scheduleName: schedule.name };
  const legacy = make("2026-10-15T00:00:00Z", { origin, updatedAt: "2026-10-18T00:00:00Z" });
  const recent = make("2026-10-17T00:00:00Z", { origin, status: "error" });
  const other = make("2026-10-18T00:00:00Z", { origin: { ...origin, scheduleId: "other-task" } });
  normal = make("2026-10-18T00:00:00Z", { title: "普通对话" });
  expected = [recent, legacy];
  for (const [directory, meta] of [
    [loaded.paths.sessions, normal], [loaded.paths.sessions, legacy],
    [loaded.paths.scheduleSessions, recent], [loaded.paths.scheduleSessions, other],
  ] as const) {
    await writeFile(path.join(directory, `${meta.id}.meta.json`), JSON.stringify(meta));
    await writeFile(path.join(directory, `${meta.id}.events.jsonl`), JSON.stringify({ type: "user", text: meta.title, at: meta.createdAt }) + "\n");
  }
});

after(async () => {
  await gateway?.close();
  await sources?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

test("history merges legacy and isolated sessions for exactly one task, newest execution first", async () => {
  const response = await fetch(`${gateway.url}/api/schedules/${schedule.id}/sessions`, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  const regular = await fetch(`${gateway.url}/api/sessions`, { headers });
  assert.deepEqual(await regular.json(), [normal]);
  for (const meta of expected) {
    const detail = await fetch(`${gateway.url}/api/sessions/${meta.id}`, { headers });
    assert.equal(detail.status, 200);
    const body = await detail.json() as SessionDetail;
    assert.equal(body.id, meta.id);
    assert.equal(body.events[0]?.type, "user");
  }
});

test("history requires authentication, reports unknown tasks and returns empty histories", async () => {
  assert.equal((await fetch(`${gateway.url}/api/schedules/${schedule.id}/sessions`)).status, 401);
  assert.equal((await fetch(`${gateway.url}/api/schedules/${randomUUID()}/sessions`, { headers })).status, 404);
  const response = await fetch(`${gateway.url}/api/schedules`, {
    method: "POST", headers, body: JSON.stringify({ name: "尚未执行", cron: "0 8 * * *", prompt: "整理日报", enabled: false }),
  });
  assert.equal(response.status, 201);
  const empty = await response.json() as Schedule;
  const history = await fetch(`${gateway.url}/api/schedules/${empty.id}/sessions`, { headers });
  assert.equal(history.status, 200);
  assert.deepEqual(await history.json(), []);
  assert.equal((await fetch(`${gateway.url}/api/schedules/${empty.id}/sessions`, { method: "POST", headers })).status, 404);
});

test("gateway health and unknown routes retain their status codes", async () => {
  const response = await fetch(`${gateway.url}/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { status: string }).status, "ok");
  assert.equal((await fetch(`${gateway.url}/api/not-a-route`, { headers })).status, 404);
});

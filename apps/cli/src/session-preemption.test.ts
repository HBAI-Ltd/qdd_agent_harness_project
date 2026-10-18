import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { SessionMeta } from "@qdd/shared";
import type { ChatFn, ChatMessage } from "./agent/llm.js";
import { loadConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { Conflict, SessionHub } from "./sessions.js";
import { ensureWorkspace, upsertPage } from "./web/site.js";

const slug = "scheduled-page";
const origin = { kind: "schedule", scheduleId: randomUUID(), scheduleName: "Every minute" } as const;
const reply = (): ChatMessage => ({
  role: "assistant", content: null,
  tool_calls: [{ id: randomUUID(), type: "function", function: { name: "reply", arguments: '{"text":"Done"}' } }],
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "qdd-preemption-"));
  const loaded = await loadConfig(root);
  loaded.config.llm.clarify = "off";
  await ensureWorkspace(loaded.paths);
  const sources = await DataSources.open(loaded);
  let chat: ChatFn = async () => reply();
  const hub = new SessionHub(loaded, sources, () => chat);
  const created: string[] = [];
  const releases: (() => void)[] = [];
  t.after(async () => {
    for (const id of created) hub.cancel(id);
    for (const release of releases) release();
    await Promise.all(created.map((id) => hub.wait(id)));
    await sources.close();
    await rm(root, { recursive: true, force: true });
  });
  const owner = await hub.create("Original conversation");
  created.push(owner.id);
  await hub.wait(owner.id);
  await upsertPage(loaded.paths, {
    slug, sessionId: owner.id, title: "Scheduled page", wish: "Create page", summary: "",
    tools: [], useAgent: false, metrics: [], datasets: {}, version: 1, stale: null, gaps: [],
    createdAt: owner.createdAt, updatedAt: owner.updatedAt,
  });
  // Bind an existing conversation as a successful publication would.
  const internals = hub as unknown as { saveMeta(meta: SessionMeta): Promise<void> };
  await internals.saveMeta({ ...await hub.meta(owner.id), slug });
  return {
    hub, owner,
    setChat(value: ChatFn) { chat = value; },
    gate() {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      releases.push(resolve);
      return { promise, resolve };
    },
    async create(scheduled: boolean) {
      const meta = await hub.create("Modify page", { slug, ...(scheduled ? { unattended: true, origin } : {}) });
      created.push(meta.id);
      return meta;
    },
  };
}

for (const mode of ["continue", "create", "cancel"] as const) {
  test(`manual edit stops a scheduled run and retains the lock until exit (${mode})`, { timeout: 10000 }, async (t) => {
    const cancelManual = mode === "cancel";
    const f = await fixture(t);
    const entered = f.gate();
    const exit = f.gate();
    const aborted = f.gate();
    f.setChat(async (_messages, _tools, signal) => {
      signal!.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve();
      await exit.promise;
      signal!.throwIfAborted();
      return reply();
    });
    const scheduled = await f.create(true);
    await entered.promise;
    let manualCalls = 0;
    const manualEntered = f.gate();
    const manualExit = f.gate();
    f.setChat(async () => {
      manualCalls++;
      assert.equal(f.hub.isRunning(scheduled.id), false);
      manualEntered.resolve();
      await manualExit.promise;
      return reply();
    });
    const manual = mode === "create" ? await f.create(false) : await f.hub.send(f.owner.id, "Manual edit");
    await aborted.promise;
    if (mode !== "create") assert.equal(manual.id, f.owner.id);
    assert.equal(manual.status, "running");
    assert.equal(manualCalls, 0, "Abort alone must not permit concurrent page writes");
    assert.equal(f.hub.isRunning(scheduled.id), true);
    if (cancelManual) f.hub.cancel(manual.id);
    await assert.rejects(f.create(true), Conflict);
    await assert.rejects(f.create(false), Conflict);
    await assert.rejects(f.hub.send(manual.id, "Duplicate"), Conflict);
    exit.resolve();
    assert.equal((await f.hub.wait(scheduled.id)).status, "error");
    if (!cancelManual) {
      await manualEntered.promise;
      await assert.rejects(f.create(true), Conflict);
      await assert.rejects(f.create(false), Conflict);
    }
    manualExit.resolve();
    assert.equal((await f.hub.wait(manual.id)).status, cancelManual ? "error" : "idle");
    assert.equal(manualCalls, cancelManual ? 0 : 1);
    const detail = await f.hub.detail(manual.id);
    assert.ok(detail.events.some((event) => event.type === "say" && event.text.includes(origin.scheduleName)));
    f.setChat(async () => reply());
    const next = await f.create(true);
    assert.notEqual(next.id, scheduled.id);
    assert.equal((await f.hub.wait(next.id)).status, "idle", "Future scheduled runs remain allowed");
  });
}

test("ordinary page edits cannot be interrupted by another manual or scheduled session", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const entered = f.gate();
  const exit = f.gate();
  let signal: AbortSignal | undefined;
  f.setChat(async (_messages, _tools, current) => {
    signal = current;
    entered.resolve();
    await exit.promise;
    return reply();
  });
  const manual = await f.create(false);
  await entered.promise;
  await assert.rejects(f.create(false), Conflict);
  await assert.rejects(f.create(true), Conflict);
  assert.equal(signal?.aborted, false);
  exit.resolve();
  assert.equal((await f.hub.wait(manual.id)).status, "idle");
});

test("failed manual startup restores the scheduled owner's lock without cancelling it", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const entered = f.gate();
  const exit = f.gate();
  let signal: AbortSignal | undefined;
  f.setChat(async (_messages, _tools, current) => {
    signal = current;
    entered.resolve();
    await exit.promise;
    current!.throwIfAborted();
    return reply();
  });
  const scheduled = await f.create(true);
  await entered.promise;
  const internals = f.hub as unknown as { setStatus(meta: SessionMeta, status: SessionMeta["status"]): Promise<void> };
  const setStatus = internals.setStatus.bind(f.hub);
  const mock = t.mock.method(internals, "setStatus", async (meta: SessionMeta, status: SessionMeta["status"]) => {
    if (meta.id === f.owner.id && status === "running") throw new Error("Storage unavailable");
    await setStatus(meta, status);
  });
  await assert.rejects(f.hub.send(f.owner.id, "Manual edit"), /Storage unavailable/);
  assert.equal(f.hub.isRunning(f.owner.id), false);
  assert.equal(signal?.aborted, false);
  await assert.rejects(f.create(true), Conflict);
  mock.mock.restore();
  f.setChat(async () => reply());
  const retried = await f.hub.send(f.owner.id, "Retry edit");
  assert.equal(signal?.aborted, true);
  exit.resolve();
  assert.equal((await f.hub.wait(scheduled.id)).status, "error");
  assert.equal((await f.hub.wait(retried.id)).status, "idle");
});

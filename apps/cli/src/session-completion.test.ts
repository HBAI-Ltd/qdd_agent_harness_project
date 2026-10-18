import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { SessionMeta } from "@qdd/shared";
import type { ChatFn } from "./agent/llm.js";
import { loadConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { Conflict, NotFound, SessionHub } from "./sessions.js";
import { ensureWorkspace } from "./web/site.js";

for (const terminal of ["idle", "error"] as const) {
  test(`会话 ${terminal} 状态持久化完成之前保持运行锁，meta 与 wait 不提前结束`, { timeout: 5000 }, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "qdd-completion-"));
    const loaded = await loadConfig(root);
    await ensureWorkspace(loaded.paths);
    const sources = await DataSources.open(loaded);
    const chat: ChatFn = async () => {
      if (terminal === "error") throw new Error("测试用模型失败");
      return {
        role: "assistant", content: null,
        tool_calls: [{ id: "reply", type: "function", function: { name: "reply", arguments: JSON.stringify({ text: "已完成", gaps: [] }) } }],
      };
    };
    const hub = new SessionHub(loaded, sources, () => chat);
    let entered!: () => void;
    let release!: () => void;
    const reachedPersistence = new Promise<void>((resolve) => { entered = resolve; });
    const persistenceGate = new Promise<void>((resolve) => { release = resolve; });
    // 在最终元数据落盘之前暂停，确定性重现磁盘仍为 running 的窗口。
    const internals = hub as unknown as { setStatus(meta: SessionMeta, status: SessionMeta["status"]): Promise<void> };
    const setStatus = internals.setStatus.bind(hub);
    internals.setStatus = async (meta, status) => {
      if (status === terminal) {
        entered();
        await persistenceGate;
      }

      await setStatus(meta, status);
    };
    let sessionId: string | undefined;
    t.after(async () => {
      release();
      if (sessionId) await hub.wait(sessionId);
      await sources.close();
    });
    const created = await hub.create("检查会话结束状态");
    sessionId = created.id;
    await reachedPersistence;
    assert.equal(hub.isRunning(created.id), true, "终态落盘之前不得释放会话");
    assert.equal((await hub.meta(created.id)).status, "running", "不得将完成中的会话误判为重启遗留错误");
    await assert.rejects(hub.send(created.id, "继续"), Conflict);

    // wait 应继续等待运行锁，不得在旧元数据上读取最终结果。
    const meta = t.mock.method(hub, "meta");
    const finished = hub.wait(created.id);
    assert.equal(meta.mock.callCount(), 0);
    release();
    const final = await finished;
    assert.equal(final.status, terminal);
    assert.equal(hub.isRunning(created.id), false);
    const detail = await hub.detail(created.id);
    assert.ok(detail.events.some((event) => event.type === "status" && event.status === terminal));
  });
}

for (const status of ["running", "waiting"] as const) {
  test(`重启后恢复 ${status} 会话并持久化终态，旧授权失效且原会话可续聊`, { timeout: 5000 }, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "qdd-recovery-"));
    const loaded = await loadConfig(root);
    await ensureWorkspace(loaded.paths);
    const sources = await DataSources.open(loaded);
    const hub = new SessionHub(loaded, sources, () => async () => ({
      role: "assistant", content: null,
      tool_calls: [{ id: "reply", type: "function", function: { name: "reply", arguments: JSON.stringify({ text: "已恢复", gaps: [] }) } }],
    }));
    const id = randomUUID();
    t.after(async () => {
      hub.cancel(id);
      await hub.wait(id);
      await sources.close();
      await rm(root, { recursive: true, force: true });
    });
    const meta: SessionMeta = {
      id, title: "中断的授权", summary: "", slug: null, status,
      createdAt: "2026-10-17T01:00:00Z", updatedAt: "2026-10-17T01:00:00Z",
    };
    const metaPath = path.join(loaded.paths.sessions, `${id}.meta.json`);
    await writeFile(metaPath, JSON.stringify(meta));
    await writeFile(path.join(loaded.paths.sessions, `${id}.events.jsonl`), JSON.stringify({
      type: "approval_required", requestId: "expired", tool: "save_skill", source: "builtin", args: {}, at: meta.updatedAt,
    }) + "\n");
    assert.throws(() => hub.approve(id, "expired", true), NotFound);
    hub.cancel(id);
    const recovered = await Promise.all([hub.meta(id), hub.meta(id), hub.wait(id)]);
    assert.ok(recovered.every((value) => value.status === "error"));
    assert.equal(JSON.parse(await readFile(metaPath, "utf8")).status, "error");
    const detail = await hub.detail(id);
    assert.equal(detail.events.filter((event) => event.type === "error").length, 1);
    assert.deepEqual(detail.events.at(-1), { type: "status", status: "error", at: detail.events.at(-1)?.at });
    assert.ok(detail.updatedAt > meta.updatedAt);
    assert.equal((await hub.pending()).length, 0);
    await hub.send(id, "继续");
    assert.equal((await hub.wait(id)).status, "idle");
  });
}

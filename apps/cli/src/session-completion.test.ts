import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { SessionMeta } from "@qdd/shared";
import type { ChatFn } from "./agent/llm.js";
import { loadConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { Conflict, SessionHub } from "./sessions.js";
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

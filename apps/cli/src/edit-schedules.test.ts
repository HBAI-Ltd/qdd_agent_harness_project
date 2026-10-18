import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { ConnectorView, JsonObject, Schedule } from "@qdd/shared";
import { runWish, type WishRequest } from "./agent/agent.js";
import type { ChatMessage } from "./agent/llm.js";
import { loadConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { SessionHub } from "./sessions.js";
import { ensureWorkspace, upsertPage } from "./web/site.js";
import { openWorkbench } from "./workbench/index.js";
import { Scheduler } from "./workbench/scheduler.js";

function call(name: string, args: JsonObject): ChatMessage {
  return { role: "assistant", content: null, tool_calls: [
    { id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } },
  ] };
}

async function setup(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "qdd-edit-schedules-"));
  const loaded = await loadConfig(root);
  loaded.config.llm.clarify = "off";
  await ensureWorkspace(loaded.paths);
  const sources = await DataSources.open(loaded);
  t.after(async () => {
    await sources.close();
    await rm(root, { recursive: true, force: true });
  });
  const workbench = await openWorkbench(loaded);
  const hub = new SessionHub(loaded, sources, () => async () => call("reply", { text: "完成" }), workbench);
  const scheduler = new Scheduler(loaded, hub, workbench);
  workbench.scheduler = scheduler;
  const skill = await workbench.skills.create({ name: "日报", description: "汇总数据", steps: ["汇总销售"] }, "user");
  const connector: ConnectorView = {
    id: "test-notifier", name: "经营群", type: "feishu", origin: "installed", permission: "confirm",
    status: "connected", detail: "", config: {}, lastVerifiedAt: null, createdAt: null,
  };
  t.mock.method(workbench.connectors, "list", async () => [connector]);
  t.mock.method(workbench.connectors, "describe", async (id: string) => {
    assert.equal(id, connector.id);
    return connector;
  });
  const now = new Date().toISOString();
  await upsertPage(loaded.paths, {
    slug: "daily", title: "日报", wish: "日报", summary: "", tools: [], useAgent: false,
    metrics: [], datasets: {}, version: 1, stale: null, gaps: [], sessionId: randomUUID(),
    createdAt: now, updatedAt: now,
  });
  const original = await scheduler.create({
    name: "每日汇总", cron: "0 8 * * *", prompt: "汇总每日销售", skillId: skill.id,
    slug: "daily", notify: { connectorId: connector.id },
  }, { kind: "agent", sessionId: randomUUID() });

  async function invoke(name: string, args: JsonObject, options: {
    approve?: boolean;
    interactive?: boolean;
    origin?: WishRequest["origin"];
    onApproval?: () => Promise<void>;
  } = {}) {
    const before = await scheduler.get(original.id);
    const approvals: JsonObject[] = [];
    let output = "";
    let step = 0;
    const available = options.interactive !== false && options.origin?.kind !== "schedule";
    await runWish(loaded, sources, async (messages, tools) => {
      if (step++ === 0) {
        assert.equal(tools.some((tool) => tool.function.name === "edit_schedules"), available);
        if (available) {
          const tool = tools.find((tool) => tool.function.name === "edit_schedules")!;
          assert.deepEqual(tool.function.parameters.required, ["id"]);
        }
        return call(name, args);
      }
      output = messages.findLast((message) => message.role === "tool")?.content ?? "";
      return call("reply", { text: "完成" });
    }, {
      wish: "调整定时任务", sessionId: randomUUID(), workbench,
      ...(options.origin ? { origin: options.origin } : {}),
    }, {
      onEvent: () => {},
      ...(options.interactive === false ? {} : { clarify: async () => null }),
      authorize: async (tool, preview) => {
        assert.equal(tool.name, "edit_schedules");
        assert.deepEqual(await scheduler.get(original.id), before, "No edits before approval");
        approvals.push(preview);
        await options.onApproval?.();
        return options.approve ?? true;
      },
    });
    return { output, approvals };
  }
  return { loaded, sources, workbench, scheduler, original, skill, connector, invoke };
}

for (const automaticNotify of [true, false]) {
  test(`a schedule can be created and completed with one delivery path (automatic: ${automaticNotify})`, async (t) => {
    const { loaded, sources, workbench, scheduler, original, connector } = await setup(t);
    const prompt = automaticNotify
      ? "检查监控画面，用 reply 输出实况摘要，由调度器推送，不调用 send_notification。"
      : `检查监控画面，仅发现异常时用 send_notification 向 ${connector.id} 推送完整通知；用 reply 说明执行结果。`;
    let step = 0;
    let approvals = 0;
    t.mock.method(workbench.connectors, "send", async () => {
      assert.fail("Creating a schedule must not send an unrequested test notification");
    });
    const result = await runWish(loaded, sources, async (messages, tools) => {
      if (step++ === 0) {
        const create = tools.find((tool) => tool.function.name === "create_schedule")!.function;
        const edit = tools.find((tool) => tool.function.name === "edit_schedules")!.function;
        const notify = tools.find((tool) => tool.function.name === "send_notification")!.function;
        assert.match(create.description, /唯一推送路径/);
        assert.match(create.description, /不改用 edit_schedules 修改旧任务/);
        assert.match(JSON.stringify(create.parameters), /send_notification 二选一/);
        assert.match(edit.description, /不可用名称代替 id/);
        assert.match(edit.description, /不得用来绕过创建被拒/);
        assert.match(JSON.stringify(edit.parameters), /需同时传 null/);
        assert.match(notify.description, /不要再调用本工具重复推送/);
        return call("create_schedule", {
          name: "监控通知", cron: "* * * * *", prompt,
          ...(automaticNotify ? { notify: connector.id } : {}),
        });
      }
      assert.equal(step, 2, "Creation should be followed by the final reply");
      assert.match(messages.at(-1)!.content!, /已创建定时任务/);
      return call("reply", { text: "监控通知任务已创建。" });
    }, { wish: "创建监控通知任务", sessionId: randomUUID(), workbench }, {
      onEvent: () => {},
      clarify: async () => null,
      authorize: async (tool) => {
        assert.equal(tool.name, "create_schedule");
        approvals++;
        return true;
      },
    });
    const schedules = await scheduler.list();
    assert.equal(schedules.length, 2);
    assert.deepEqual(await scheduler.get(original.id), original, "Existing tasks must remain unchanged");
    const created = schedules.find((schedule) => schedule.id !== original.id)!;
    assert.equal(created.prompt, prompt);
    assert.equal(created.cron, "* * * * *");
    assert.equal(created.enabled, true);
    assert.deepEqual(created.notify, automaticNotify ? { connectorId: connector.id } : undefined);
    assert.equal(approvals, 1);
    assert.deepEqual(
      result.messages.flatMap((message) => message.tool_calls?.map((tool) => tool.function.name) ?? []),
      ["create_schedule", "reply"],
    );
  });
}

test("edit_schedules persists only approved fields and preserves identity, bindings and history", async (t) => {
  const { loaded, scheduler, original, invoke } = await setup(t);
  const { output, approvals } = await invoke("edit_schedules", {
    id: original.id, name: " 新日报 ", cron: "30 9 * * *", prompt: " 汇总昨天销售 ",
  });
  assert.match(output, /已更新定时任务/);
  assert.deepEqual(approvals, [{
    id: original.id, name: original.name,
    changes: { name: "新日报", cron: "30 9 * * *", prompt: "汇总昨天销售" },
  }]);
  const updated = await scheduler.get(original.id);
  assert.notEqual(updated.nextRunAt, original.nextRunAt);
  assert.equal(new Date(updated.nextRunAt!).getHours(), 9);
  assert.equal(new Date(updated.nextRunAt!).getMinutes(), 30);
  assert.deepEqual(updated, {
    ...original, name: "新日报", cron: "30 9 * * *", prompt: "汇总昨天销售",
    nextRunAt: updated.nextRunAt, updatedAt: updated.updatedAt,
  });
  const stored = JSON.parse(await readFile(loaded.paths.schedules, "utf8")) as { schedules: Schedule[] };
  assert.deepEqual(stored.schedules, [updated]);
});

test("list_schedules includes the configuration needed for partial edits", async (t) => {
  const { original, invoke } = await setup(t);
  const { output, approvals } = await invoke("list_schedules", {});
  assert.deepEqual(approvals, []);
  const [listed] = JSON.parse(output) as Schedule[];
  for (const key of ["id", "name", "cron", "prompt", "enabled", "skillId", "slug", "notify"] as const) {
    assert.deepEqual(listed![key], original[key]);
  }
});

test("edits can disable and clear bindings, then enable and restore them", async (t) => {
  const { scheduler, original, skill, connector, invoke } = await setup(t);
  const first = await invoke("edit_schedules", {
    id: original.id, enabled: false, skill: null, slug: null, notify: null,
  });
  assert.match(first.output, /已停用/);
  const disabled = await scheduler.get(original.id);
  assert.equal(disabled.nextRunAt, null);
  for (const key of ["skillId", "slug", "notify"] as const) assert.equal(disabled[key], undefined);
  const restored = await invoke("edit_schedules", {
    id: original.id, enabled: true, skill: skill.name, slug: "daily", notify: "auto",
  });
  assert.match(restored.output, /已启用/);
  const updated = await scheduler.get(original.id);
  assert.ok(updated.nextRunAt);
  assert.equal(updated.skillId, skill.id);
  assert.deepEqual(updated.notify, { connectorId: connector.id });
});

test("declining an edit leaves persisted state unchanged", async (t) => {
  const { scheduler, original, invoke } = await setup(t);
  const result = await invoke("edit_schedules", { id: original.id, enabled: false }, { approve: false });
  assert.match(result.output, /没有确认修改/);
  assert.equal(result.approvals.length, 1);
  assert.deepEqual(await scheduler.get(original.id), original);
});

test("content-only edits preserve the next execution time", async (t) => {
  const { scheduler, original, invoke } = await setup(t);
  const result = await invoke("edit_schedules", { id: original.id, prompt: "汇总昨日销售和库存" });
  assert.match(result.output, /已更新/);
  const updated = await scheduler.get(original.id);
  assert.equal(updated.prompt, "汇总昨日销售和库存");
  assert.equal(updated.nextRunAt, original.nextRunAt);
});

test("invalid edits are rejected before approval and never mutate schedules", async (t) => {
  const { scheduler, original, invoke } = await setup(t);
  for (const patch of [
    {}, { cron: "invalid" }, { cron: "0 0 31 2 *" }, { name: "" }, { prompt: null },
    { enabled: "false" }, { skill: "missing" }, { skill: false }, { slug: "missing" },
    { notify: "missing" }, { notify: false }, { notify: "" }, { unsupported: true },
    { enabled: false, confirmed: true },
  ]) {
    const result = await invoke("edit_schedules", { id: original.id, ...patch });
    assert.match(result.output, /^错误：/);
    assert.equal(result.approvals.length, 0);
    assert.deepEqual(await scheduler.get(original.id), original);
  }
  for (const id of ["missing", "", null]) {
    const result = await invoke("edit_schedules", { id, enabled: false });
    assert.match(result.output, /^错误：/);
    assert.equal(result.approvals.length, 0);
  }
});

test("editing remains unavailable without interaction or during scheduled execution", async (t) => {
  const { original, invoke } = await setup(t);
  for (const options of [
    { interactive: false },
    { origin: { kind: "schedule" as const, scheduleId: original.id, scheduleName: original.name } },
  ]) {
    const result = await invoke("edit_schedules", { id: original.id, enabled: false }, options);
    assert.match(result.output, /不能编辑定时任务/);
    assert.equal(result.approvals.length, 0);
  }
});

test("editing does not overwrite unrelated changes made while awaiting approval", async (t) => {
  const { scheduler, original, invoke } = await setup(t);
  const result = await invoke("edit_schedules", { id: original.id, enabled: false }, {
    onApproval: async () => { await scheduler.update(original.id, { prompt: "新的执行内容" }); },
  });
  assert.match(result.output, /已更新/);
  const updated = await scheduler.get(original.id);
  assert.equal(updated.prompt, "新的执行内容");
  assert.equal(updated.enabled, false);
});

test("a task deleted during approval reports failure instead of recreating it", async (t) => {
  const { scheduler, original, invoke } = await setup(t);
  const result = await invoke("edit_schedules", { id: original.id, enabled: false }, {
    onApproval: async () => { await scheduler.remove(original.id); },
  });
  assert.match(result.output, /^错误：编辑定时任务失败：定时任务不存在/);
  assert.deepEqual(await scheduler.list(), []);
});

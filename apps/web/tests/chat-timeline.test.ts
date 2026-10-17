import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent } from "@qdd/shared";
import { buildChatTimeline, toolStatus, toolTitle, type ChatEvent, type ChatToolEvent } from "../src/utils/chatTimeline.ts";

const at = "2026-10-17T03:00:00Z";
const user = (text: string): Extract<SessionEvent, { type: "user" }> => ({ type: "user", text, at });
const say = (text: string): SessionEvent => ({ type: "say", text, at });
// Frontend compatibility fixtures do not assume a gateway protocol change.
const tool = (callId: string, status?: ChatToolEvent["status"], extra: Partial<ChatToolEvent> = {}): ChatToolEvent =>
  ({ type: "tool", callId, name: "inventory", text: "查询 inventory", at, ...(status ? { status } : {}), ...extra });

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

test("one assistant entry groups activities and answers without mutating the event log", () => {
  const events = deepFreeze<ChatEvent[]>([
    user("查库存"),
    { type: "thinking", text: "先核对数据", at },
    tool("call-1", "running", { input: { store: "A" } }),
    tool("call-1", undefined, { text: "读取中" }),
    tool("call-1", undefined, { text: "读取中" }),
    say("已取得数据。"),
    tool("call-1", "completed", { output: "120 件" }),
    say("库存稳定。"),
  ]);
  const snapshot = JSON.stringify(events);
  const timeline = buildChatTimeline(events);
  assert.equal(JSON.stringify(events), snapshot);
  assert.equal(events.length, 8);
  assert.equal(timeline.length, 2);
  const assistant = timeline[1];
  assert.equal(assistant?.kind, "assistant");
  if (assistant?.kind !== "assistant") return;
  assert.equal(assistant.activities.length, 2);
  assert.equal(assistant.messages.length, 2);
  assert.deepEqual(assistant.messages.map(({ event }) => event.type === "say" && event.text), ["已取得数据。", "库存稳定。"]);
  const activity = assistant.activities[1]!;
  assert.equal(activity.key, 2);
  assert.equal(activity.event.type, "tool");
  if (activity.event.type !== "tool") return;
  assert.equal(activity.event.status, "completed");
  assert.deepEqual(activity.event.input, { store: "A" });
  assert.equal(activity.event.output, "120 件");
  assert.deepEqual(activity.progress, ["读取中"]);
  assert.notEqual(activity.event, events[2]);
});

test("reused call IDs merge only inside their own user turn and anonymous legacy calls remain separate", () => {
  const timeline = buildChatTimeline([
    user("第一次查询"),
    tool("reused", "completed", { output: "第一轮" }),
    user("第二次查询"),
    tool("reused", "running", { input: { store: "B" } }),
    tool("reused", "failed", { output: "第二轮失败" }),
    { type: "tool", text: "旧版查询记录", at },
    { type: "tool", text: "旧版返回记录", at },
  ]);
  const first = timeline[1];
  const second = timeline[3];
  assert.equal(first?.kind, "assistant");
  assert.equal(second?.kind, "assistant");
  if (first?.kind !== "assistant" || second?.kind !== "assistant") return;
  assert.equal(first.activities.length, 1);
  assert.equal(second.activities.length, 3);
  assert.equal(first.activities[0]!.event.type === "tool" && first.activities[0]!.event.output, "第一轮");
  assert.equal(second.activities[0]!.event.type === "tool" && second.activities[0]!.event.status, "failed");
  assert.equal(second.activities[1]!.event.type === "tool" && toolStatus(second.activities[1]!.event), "执行记录");
});

test("late running events cannot regress a terminal tool status and progress cannot clear its result", () => {
  for (const status of ["completed", "failed", "cancelled"] as const) {
    const timeline = buildChatTimeline([
      user("查询"),
      tool("call", status, { output: "结束结果" }),
      tool("call", "running"),
      tool("call", undefined, { text: "迟到的进度" }),
    ]);
    const assistant = timeline[1];
    assert.equal(assistant?.kind, "assistant");
    if (assistant?.kind !== "assistant") continue;
    assert.equal(assistant.activities.length, 1);
    const event = assistant.activities[0]!.event;
    assert.equal(event.type, "tool");
    if (event.type !== "tool") continue;
    assert.equal(event.status, status);
    assert.equal(event.output, "结束结果");
    assert.deepEqual(assistant.activities[0]!.progress, ["迟到的进度"]);
  }
});

test("optimistic pending message appears after history without a synthetic assistant or control-event rows", () => {
  const pending = user("下一条问题");
  const timeline = buildChatTimeline([
    { type: "status", status: "running", at },
    user("已有问题"),
    say("已有回答"),
    { type: "approval_resolved", requestId: "approval-1", approved: true, at },
  ], pending);
  assert.deepEqual(timeline.map((entry) => entry.kind), ["user", "assistant", "user"]);
  assert.deepEqual(timeline.at(-1), { kind: "user", key: "pending", event: pending });
  assert.deepEqual(buildChatTimeline([], pending), [{ kind: "user", key: "pending", event: pending }]);
  assert.deepEqual(buildChatTimeline([{ type: "status", status: "done", at }]), []);
});

test("tool labels use structured lifecycle information and preserve useful legacy titles", () => {
  assert.equal(toolTitle(tool("structured", "running", { name: "store__get_inventory" })), "store__get_inventory");
  assert.equal(toolTitle({ type: "tool", text: "查询 store__get_inventory · 门店 A", at }), "store__get_inventory");
  assert.equal(toolTitle({ type: "tool", text: "操作工具\n第二行详情", at }), "操作工具");
  assert.equal(toolTitle({ type: "tool", text: "", at }), "工具调用");
  assert.equal(toolStatus(tool("running", "running")), "调用中…");
  assert.equal(toolStatus(tool("completed", "completed")), "已完成");
  assert.equal(toolStatus(tool("failed", "failed")), "调用失败");
  assert.equal(toolStatus(tool("cancelled", "cancelled")), "已中断");
  assert.equal(toolStatus({ type: "tool", text: "历史记录", at }), "执行记录");
});

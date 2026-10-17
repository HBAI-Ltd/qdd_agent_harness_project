import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentToolCall, SessionEvent } from "@qdd/shared";
import { buildChatTimeline, toolStatus, toolTitle, type AssistantEntry, type ChatToolEvent } from "../src/utils/chatTimeline.ts";

const at = "2026-10-17T03:00:00Z";
const user = (text: string): Extract<SessionEvent, { type: "user" }> => ({ type: "user", text, at });
const say = (text: string): SessionEvent => ({ type: "say", text, at });
const block = (type: "text" | "thinking", blockId: string, content: string): SessionEvent =>
  ({ type, blockId, content, done: true, at });
const tool = (id: string, status: AgentToolCall["status"], extra: Partial<AgentToolCall> = {}, blockId = "reply:1"): SessionEvent =>
  ({ type: "tool", blockId, tool: { id, name: "inventory", status, ...extra }, at });
// Persisted conversations created before structured tool blocks remain readable.
const legacy = (text: string): SessionEvent => ({ type: "tool", text, at }) as unknown as SessionEvent;
const activities = (entry: AssistantEntry) => entry.parts.filter((part) => part.kind === "activity");
const messages = (entry: AssistantEntry) => entry.parts.filter((part) => part.kind === "message");

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

test("structured blocks group into an assistant turn and merge tool progress without mutating the persisted log", () => {
  const events = deepFreeze<SessionEvent[]>([
    user("查库存"),
    block("thinking", "reply:0", "先核对数据"),
    tool("call-1", "running", { args: { store: "A" } }, "reply:1"),
    tool("call-1", "running", { progress: "读取中" }, "reply:1"),
    tool("call-1", "running", { progress: "读取中" }, "reply:1"),
    block("text", "reply:2", "已取得数据。"),
    tool("call-1", "success", { result: "120 件" }, "reply:1"),
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
  assert.deepEqual(assistant.parts.map(({ kind, event }) => [kind, event.type]), [["activity", "thinking"], ["activity", "tool"], ["message", "say"], ["message", "say"]]);
  assert.deepEqual(messages(assistant).map(({ event }) => event.type === "say" && event.text), ["已取得数据。", "库存稳定。"]);
  const activity = activities(assistant)[1]!;
  assert.equal(activity.key, "tool:call-1");
  assert.equal(activity.event.type, "tool");
  if (activity.event.type !== "tool") return;
  assert.equal(activity.event.status, "completed");
  assert.deepEqual(activity.event.input, { store: "A" });
  assert.equal(activity.event.output, "120 件");
  assert.deepEqual(activity.progress, ["读取中"]);
  assert.notEqual(activity.event, events[2]);
});

test("tool IDs merge only inside their own user turn and anonymous legacy records remain separate", () => {
  const timeline = buildChatTimeline([
    user("第一次查询"),
    tool("reused", "success", { result: "第一轮" }),
    user("第二次查询"),
    tool("reused", "running", { args: { store: "B" } }),
    tool("reused", "error", { result: "第二轮失败" }),
    legacy("旧版查询记录"),
    legacy("旧版返回记录"),
  ]);
  const first = timeline[1];
  const second = timeline[3];
  assert.equal(first?.kind, "assistant");
  assert.equal(second?.kind, "assistant");
  if (first?.kind !== "assistant" || second?.kind !== "assistant") return;
  assert.notEqual(first.key, second.key);
  assert.equal(first.parts.length, 1);
  assert.equal(second.parts.length, 3);
  assert.equal(first.parts[0]!.event.type === "tool" && first.parts[0]!.event.output, "第一轮");
  assert.equal(second.parts[0]!.event.type === "tool" && second.parts[0]!.event.status, "failed");
  assert.equal(second.parts[1]!.event.type === "tool" && toolStatus(second.parts[1]!.event), "执行记录");
});

test("late running events cannot regress success or failure and progress cannot clear the result", () => {
  for (const [status, expected] of [["success", "completed"], ["error", "failed"]] as const) {
    const timeline = buildChatTimeline([
      user("查询"),
      tool("call", status, { result: "结束结果" }),
      tool("call", "running"),
      tool("call", "running", { progress: "迟到的进度" }),
    ]);
    const assistant = timeline[1];
    assert.equal(assistant?.kind, "assistant");
    if (assistant?.kind !== "assistant") continue;
    assert.equal(assistant.parts.length, 1);
    const activity = activities(assistant)[0]!;
    const event = activity.event;
    assert.equal(event.type, "tool");
    if (event.type !== "tool") continue;
    assert.equal(event.status, expected);
    assert.equal(event.output, "结束结果");
    assert.deepEqual(activity.progress, ["迟到的进度"]);
  }
});

test("live text and thinking keep stable keys when persisted done snapshots replace them", () => {
  const events = [user("查询")];
  const live = deepFreeze({
    "reply:0": { type: "thinking" as const, content: "**分析中**" },
    "reply:1": { type: "text" as const, content: "初步答案" },
  });
  const first = buildChatTimeline(events, undefined, live)[1];
  assert.equal(first?.kind, "assistant");
  if (first?.kind !== "assistant") return;
  assert.deepEqual(first.parts.map(({ key }) => key), ["block:reply:0", "block:reply:1"]);
  const completed = buildChatTimeline([
    ...events,
    block("thinking", "reply:0", "分析完成"),
    block("text", "reply:1", "最终答案"),
  ], undefined, live)[1];
  assert.equal(completed?.kind, "assistant");
  if (completed?.kind !== "assistant") return;
  assert.equal(completed.key, first.key);
  assert.deepEqual(completed.parts.map(({ key }) => key), first.parts.map(({ key }) => key));
  assert.equal(completed.parts[0]?.event.type === "thinking" && completed.parts[0].event.text, "分析完成");
  assert.equal(completed.parts[1]?.event.type === "say" && completed.parts[1].event.text, "最终答案");
  assert.equal(live["reply:0"].content, "**分析中**");
});

test("blocks follow the backend sequence even when completed snapshots arrive out of order", () => {
  const assistant = buildChatTimeline([
    user("查库存"),
    tool("inventory", "success", { result: "120 件" }, "reply:1"),
    block("thinking", "reply:3", "总结结果"),
    block("text", "reply:4", "第二段答案"),
    block("thinking", "reply:0", "检查来源"),
    block("text", "reply:2", "第一段答案"),
    block("thinking", "next:0", "下一次思考"),
  ])[1];
  assert.equal(assistant?.kind, "assistant");
  if (assistant?.kind !== "assistant") return;
  assert.deepEqual(assistant.parts.map(({ key }) => key), ["block:reply:0", "tool:inventory", "block:reply:2", "block:reply:3", "block:reply:4", "block:next:0"]);
});

test("answers and repeated tool calls remain interleaved when earlier tool results arrive later", () => {
  const events = [
    user("检查库存并分析销售"),
    block("text", "reply:0", "先查询库存。"),
    tool("inventory", "running", { args: { store: "A" } }, "reply:1"),
    block("text", "reply:2", "库存已经取得，再查询销售。"),
    tool("sales", "running", { name: "sales" }, "reply:3"),
    block("text", "reply:4", "正在汇总。"),
  ];
  const first = buildChatTimeline(events)[1];
  const completed = buildChatTimeline([
    ...events,
    tool("inventory", "success", { result: "120 件" }, "reply:1"),
    tool("sales", "success", { result: "100 元" }, "reply:3"),
  ])[1];
  assert.equal(first?.kind, "assistant");
  assert.equal(completed?.kind, "assistant");
  if (first?.kind !== "assistant" || completed?.kind !== "assistant") return;
  const expected = ["block:reply:0", "tool:inventory", "block:reply:2", "tool:sales", "block:reply:4"];
  assert.deepEqual(first.parts.map(({ key }) => key), expected);
  assert.deepEqual(completed.parts.map(({ key }) => key), expected);
  assert.deepEqual(completed.parts.map(({ kind }) => kind), ["message", "activity", "message", "activity", "message"]);
  assert.deepEqual(activities(completed).map(({ event }) => event.type === "tool" && event.status), ["completed", "completed"]);
});

test("skill and browser activity remain between the text blocks that surround their first arrival", () => {
  const assistant = buildChatTimeline([
    user("检查网页并汇总"),
    block("text", "reply:0", "先加载技能。"),
    { type: "skill", skill: { id: "skill-1", name: "网页检查" }, action: "loaded", at },
    block("text", "reply:1", "现在打开网页。"),
    { type: "browser", browser: { browserSessionId: "browser-1", tabId: "tab-1", url: "https://example.com/", title: "门店", canGoBack: false, canGoForward: false, status: "running" }, at },
    block("text", "reply:2", "网页已打开。"),
    legacy("旧版工具调用"),
    say("完整汇总。"),
  ])[1];
  assert.equal(assistant?.kind, "assistant");
  if (assistant?.kind !== "assistant") return;
  assert.deepEqual(assistant.parts.map(({ event }) => event.type), ["say", "skill", "say", "browser", "say", "tool", "say"]);
});

test("warnings and errors remain after the answer that preceded them", () => {
  const assistant = buildChatTimeline([
    user("查询"),
    block("text", "reply:0", "已读取的数据"),
    { type: "warn", text: "部分数据缺失", at },
    { type: "error", message: "连接已中断", at },
  ])[1];
  assert.equal(assistant?.kind, "assistant");
  if (assistant?.kind !== "assistant") return;
  assert.deepEqual(assistant.parts.map(({ event }) => event.type), ["say", "warn", "error"]);
});

test("terminal sessions mark unfinished tools cancelled only after explicit cancellation", () => {
  for (const [status, ending, expected] of [
    ["idle", { type: "error", message: "已取消", at }, "cancelled"],
    ["idle", { type: "error", message: "请求失败", at }, "ended"],
    ["idle", { type: "status", status: "idle", at }, "ended"],
  ] as const) {
    const assistant = buildChatTimeline([user("查询"), tool("call", "running"), ending], undefined, {}, status)[1];
    assert.equal(assistant?.kind, "assistant");
    if (assistant?.kind !== "assistant") continue;
    const event = assistant.parts[0]?.event;
    assert.equal(event?.type === "tool" && event.status, expected);
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
  assert.deepEqual(buildChatTimeline([{ type: "status", status: "idle", at }]), []);
});

test("tool labels show structured lifecycle information and useful legacy titles", () => {
  const display = (status: NonNullable<ChatToolEvent["status"]>): ChatToolEvent => ({ type: "tool", at, text: "", name: "store__get_inventory", status });
  assert.equal(toolTitle(display("running")), "store__get_inventory");
  assert.equal(toolTitle({ type: "tool", text: "查询 store__get_inventory · 门店 A", at }), "store__get_inventory");
  assert.equal(toolTitle({ type: "tool", text: "操作工具\n第二行详情", at }), "操作工具");
  assert.equal(toolTitle({ type: "tool", text: "", at }), "工具调用");
  assert.equal(toolStatus(display("running")), "调用中…");
  assert.equal(toolStatus(display("completed")), "已完成");
  assert.equal(toolStatus(display("failed")), "调用失败");
  assert.equal(toolStatus(display("cancelled")), "已中断");
  assert.equal(toolStatus(display("ended")), "未完成");
  assert.equal(toolStatus({ type: "tool", text: "历史记录", at }), "执行记录");
});

import type { SessionEvent } from "@qdd/shared";

/** 流式增量（不落盘）：按 blockId 累积，done 事件到达后以落盘内容为准。 */
export type LiveBlocks = Record<string, { type: "text" | "thinking"; content: string }>;

// 结构化工具块（blockId + tool）与旧版仅含进度文本的 tool 事件统一成这一种展示形态。
export interface ChatToolEvent {
  type: "tool";
  at: string;
  text: string;
  callId?: string;
  name?: string;
  status?: "running" | "completed" | "failed" | "cancelled";
  input?: Record<string, unknown>;
  output?: string;
}
export interface ChatThinkingEvent {
  type: "thinking";
  at: string;
  text: string;
  done: boolean;
}
type ActivityEvent = ChatThinkingEvent | ChatToolEvent | Extract<SessionEvent, { type: "skill" | "browser" }>;
type MessageEvent = Extract<SessionEvent, { type: "say" | "warn" | "error" | "published" | "gaps" }>;

export interface ChatActivity {
  key: number | string;
  event: ActivityEvent;
  progress: string[];
}

export interface AssistantEntry {
  kind: "assistant";
  key: number;
  at: string;
  /** 思考与工具调用按模型输出顺序放在同一数组（与 Toonflow 会话 parts 对齐）。 */
  activities: ChatActivity[];
  messages: { key: number | string; event: MessageEvent }[];
}

export type ChatEntry = AssistantEntry | {
  kind: "user";
  key: number | "pending";
  event: Extract<SessionEvent, { type: "user" }>;
};

const TOOL_STATUS = { running: "running", success: "completed", error: "failed" } as const;

/** 「回复id:块序号」排序键：同一回复内按块序号，回复之间按首次出现顺序。 */
function blockRank(order: string[], blockId: string): number {
  const [reply = "", index] = blockId.split(":");
  if (!order.includes(reply)) order.push(reply);
  return order.indexOf(reply) * 1e4 + (Number(index) || 0);
}

// Keep source events intact: SSE reconnect cursors count persisted events.
export function buildChatTimeline(events: readonly SessionEvent[], pending?: Extract<SessionEvent, { type: "user" }>, live: LiveBlocks = {}): ChatEntry[] {
  const entries: ChatEntry[] = [];
  let assistant: AssistantEntry | undefined;
  let tools = new Map<string, ChatActivity>();
  let blocks = new Map<string, { event: ChatThinkingEvent | { type: "say"; at: string; text: string } }>();
  let ranks = new Map<ChatActivity | AssistantEntry["messages"][number], number>();
  let order: string[] = [];
  const open = (at: string, key: number) => {
    if (!assistant) {
      assistant = { kind: "assistant", key, at, activities: [], messages: [] };
      entries.push(assistant);
    }
    return assistant;
  };
  const addBlock = (blockId: string, type: "text" | "thinking", content: string, done: boolean, at: string, key: number | string) => {
    const existing = blocks.get(blockId);
    if (existing) {
      existing.event.text = content;
      if (existing.event.type === "thinking") existing.event.done = done;
      return;
    }
    const entry = open(at, typeof key === "number" ? key : events.length);
    const rank = blockRank(order, blockId);
    if (type === "thinking") {
      const event: ChatThinkingEvent = { type: "thinking", at, text: content, done };
      const activity: ChatActivity = { key, event, progress: [] };
      entry.activities.push(activity);
      ranks.set(activity, rank);
      blocks.set(blockId, { event });
    } else {
      const event = { type: "say" as const, at, text: content };
      const message = { key, event };
      entry.messages.push(message);
      ranks.set(message, rank);
      blocks.set(blockId, { event });
    }
  };
  const finish = () => {
    if (!assistant) return;
    const rank = (item: ChatActivity | AssistantEntry["messages"][number]) => ranks.get(item) ?? -1;
    assistant.activities.sort((a, b) => rank(a) - rank(b));
    assistant.messages.sort((a, b) => rank(a) - rank(b));
  };

  for (const [index, event] of events.entries()) {
    if (event.type === "user") {
      finish();
      entries.push({ kind: "user", key: index, event });
      assistant = undefined;
      tools = new Map();
      blocks = new Map();
      ranks = new Map();
      order = [];
      continue;
    }
    if (event.type === "text" || event.type === "thinking") {
      if (event.delta === undefined) addBlock(event.blockId, event.type, event.content ?? "", Boolean(event.done), event.at, index);
      continue;
    }
    if (!["tool", "skill", "browser", "say", "warn", "error", "published", "gaps"].includes(event.type)) continue;
    const entry = open(event.at, index);
    if (event.type === "tool") {
      const at = event.at;
      const legacy = (event as { text?: string }).text;
      const tool: ChatToolEvent = "tool" in event
        ? {
          type: "tool", at: event.at, callId: event.tool.id, name: event.tool.name, status: TOOL_STATUS[event.tool.status],
          text: event.tool.progress ?? event.tool.name,
          ...(event.tool.args ? { input: event.tool.args } : {}),
          ...(event.tool.result !== undefined ? { output: event.tool.result } : {}),
        }
        : { type: "tool", at, text: legacy ?? "" };
      const progress = "tool" in event ? event.tool.progress : legacy;
      const previous = tool.callId ? tools.get(tool.callId) : undefined;
      if (previous && previous.event.type === "tool") {
        previous.event = { ...previous.event, ...tool };
        if (progress && !previous.progress.includes(progress)) previous.progress.push(progress);
      } else {
        const activity: ChatActivity = { key: index, event: tool, progress: progress ? [progress] : [] };
        entry.activities.push(activity);
        if ("blockId" in event) ranks.set(activity, blockRank(order, event.blockId));
        if (tool.callId) tools.set(tool.callId, activity);
      }
    } else if (event.type === "skill" || event.type === "browser") {
      entry.activities.push({ key: index, event, progress: [] });
    } else if (event.type === "say" || event.type === "warn" || event.type === "error" || event.type === "published" || event.type === "gaps") {
      entry.messages.push({ key: index, event });
    }
  }
  for (const [blockId, block] of Object.entries(live)) {
    const existing = blocks.get(blockId);
    if (existing && existing.event.type === "thinking" && existing.event.done) continue;
    if (existing && existing.event.type === "say") continue;
    addBlock(blockId, block.type, block.content, false, new Date().toISOString(), `live:${blockId}`);
  }
  finish();
  if (pending) entries.push({ kind: "user", key: "pending", event: pending });
  return entries;
}

export function toolTitle(event: ChatToolEvent): string {
  if (event.name) return event.name;
  const query = /^查询\s+(\S+)/.exec(event.text);
  if (query?.[1]) return query[1];
  return event.text.split(/\r?\n/, 1)[0]?.slice(0, 80) || "工具调用";
}

export function toolStatus(event: ChatToolEvent): string {
  const labels = { running: "调用中…", completed: "已完成", failed: "调用失败", cancelled: "已中断" };
  return event.status ? labels[event.status] : "执行记录";
}

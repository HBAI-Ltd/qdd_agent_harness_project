import type { SessionEvent, SessionStatus } from "@qdd/shared";

/** Delta events stay outside persisted history and its SSE cursor. */
export type LiveBlocks = Record<string, { type: "text" | "thinking"; content: string }>;
interface LegacyToolEvent { type: "tool"; at: string; text: string }
export type ChatEvent = SessionEvent | LegacyToolEvent;

export interface ChatToolEvent extends LegacyToolEvent {
  callId?: string;
  name?: string;
  status?: "running" | "completed" | "failed" | "cancelled" | "ended";
  input?: Record<string, unknown>;
  output?: string;
}
export interface ChatThinkingEvent { type: "thinking"; at: string; text: string; done: boolean }
type ActivityEvent = ChatThinkingEvent | ChatToolEvent | Extract<SessionEvent, { type: "skill" | "browser" }>;
type MessageEvent = Extract<SessionEvent, { type: "say" | "warn" | "error" | "published" | "gaps" }>;

export interface ChatActivity { kind: "activity"; key: number | string; event: ActivityEvent; progress: string[] }
export interface ChatMessage { kind: "message"; key: number | string; event: MessageEvent }
export type ChatPart = ChatActivity | ChatMessage;
export interface AssistantEntry {
  kind: "assistant";
  key: string;
  at: string;
  parts: ChatPart[];
}
export type ChatEntry = AssistantEntry | {
  kind: "user";
  key: number | "pending";
  event: Extract<SessionEvent, { type: "user" }>;
};

const TOOL_STATUS = { running: "running", success: "completed", error: "failed" } as const;
type DisplayItem = ChatPart;

/** Build display rows without modifying persisted events or their cursor. */
export function buildChatTimeline(events: readonly ChatEvent[], pending?: Extract<SessionEvent, { type: "user" }>, live: LiveBlocks = {}, status?: SessionStatus): ChatEntry[] {
  const entries: ChatEntry[] = [];
  let assistant: AssistantEntry | undefined;
  let userIndex = -1;
  let tools = new Map<string, ChatActivity>();
  let browsers = new Map<string, ChatActivity>();
  let blocks = new Map<string, { event: ChatThinkingEvent | Extract<MessageEvent, { type: "say" }>; done: boolean }>();
  let ranks = new Map<DisplayItem, [number, number]>();
  let replies = new Map<string, number>();
  let sequence = 0;
  let terminal: "cancelled" | "ended" | undefined;

  const open = (at: string) => {
    if (!assistant) {
      assistant = { kind: "assistant", key: `assistant:${userIndex}`, at, parts: [] };
      entries.push(assistant);
    }
    return assistant;
  };
  const rank = (item: DisplayItem, blockId?: string) => {
    if (!blockId || !assistant) return;
    const split = blockId.lastIndexOf(":");
    const reply = split === -1 ? blockId : blockId.slice(0, split);
    const part = split === -1 ? 0 : Number(blockId.slice(split + 1));
    if (!replies.has(reply)) replies.set(reply, sequence++);
    const position: [number, number] = [replies.get(reply)!, Number.isFinite(part) ? part : 0];
    ranks.set(item, position);
    // Only insert late blocks before later model blocks. Auxiliary events keep
    // their place between already received text and subsequent tool calls.
    const before = assistant.parts.findIndex((existing) => {
      const other = ranks.get(existing);
      return existing !== item && other && (other[0] > position[0] || (other[0] === position[0] && other[1] > position[1]));
    });
    if (before !== -1) {
      assistant.parts.splice(assistant.parts.indexOf(item), 1);
      assistant.parts.splice(before, 0, item);
    }
  };
  const addBlock = (blockId: string, type: "text" | "thinking", content: string, done: boolean, at: string) => {
    const previous = blocks.get(blockId);
    if (previous) {
      if (previous.done && !done) return;
      previous.event.text = content;
      previous.done ||= done;
      if (previous.event.type === "thinking") previous.event.done = previous.done;
      return;
    }
    const entry = open(at);
    const key = `block:${blockId}`;
    if (type === "thinking") {
      const event: ChatThinkingEvent = { type: "thinking", at, text: content, done };
      const item: ChatActivity = { kind: "activity", key, event, progress: [] };
      entry.parts.push(item);
      blocks.set(blockId, { event, done });
      rank(item, blockId);
    } else {
      const event = { type: "say" as const, at, text: content };
      const item: ChatMessage = { kind: "message", key, event };
      entry.parts.push(item);
      blocks.set(blockId, { event, done });
      rank(item, blockId);
    }
  };
  const finish = (end = terminal) => {
    if (!assistant) return;
    if (end) {
      for (const item of assistant.parts) {
        if (item.event.type === "tool" && item.event.status === "running") item.event = { ...item.event, status: end };
      }
    }
  };

  for (const [index, event] of events.entries()) {
    if (event.type === "user") {
      finish();
      entries.push({ kind: "user", key: index, event });
      userIndex = index;
      assistant = undefined;
      tools = new Map(); browsers = new Map(); blocks = new Map(); ranks = new Map(); replies = new Map(); sequence = 0; terminal = undefined;
      continue;
    }
    if (event.type === "status") {
      if (event.status === "idle" || event.status === "error") terminal ??= "ended";
      continue;
    }
    if (event.type === "text" || event.type === "thinking") {
      if (event.delta === undefined) addBlock(event.blockId, event.type, event.content ?? "", Boolean(event.done), event.at);
      continue;
    }
    if (!["tool", "skill", "browser", "say", "warn", "error", "published", "gaps"].includes(event.type)) continue;
    const entry = open(event.at);
    if (event.type === "tool") {
      const tool: ChatToolEvent = "tool" in event ? {
        type: "tool", at: event.at, callId: event.tool.id, name: event.tool.name, status: TOOL_STATUS[event.tool.status],
        text: event.tool.progress ?? event.tool.name,
        ...(event.tool.args ? { input: event.tool.args } : {}),
        ...(event.tool.result !== undefined ? { output: event.tool.result } : {}),
      } : { type: "tool", at: event.at, text: event.text };
      const progress = "tool" in event ? event.tool.progress : event.text;
      const previous = tool.callId ? tools.get(tool.callId) : undefined;
      if (previous && previous.event.type === "tool") {
        const previousStatus = previous.event.status;
        const lateRunning = previousStatus && previousStatus !== "running" && tool.status === "running";
        previous.event = { ...previous.event, ...tool, ...(lateRunning ? { status: previousStatus, output: previous.event.output } : {}) };
        if (progress && !previous.progress.includes(progress)) previous.progress.push(progress);
      } else {
        const item: ChatActivity = { kind: "activity", key: tool.callId ? `tool:${tool.callId}` : index, event: tool, progress: progress ? [progress] : [] };
        entry.parts.push(item);
        rank(item, "blockId" in event ? event.blockId : undefined);
        if (tool.callId) tools.set(tool.callId, item);
      }
    } else if (event.type === "browser") {
      const id = event.browser.browserSessionId;
      const previous = browsers.get(id);
      if (previous) {
        if (previous.event.type === "browser" && previous.event.browser.status === "closed" && event.browser.status === "running") continue;
        previous.event = event;
      } else {
        const item: ChatActivity = { kind: "activity", key: `browser:${id}`, event, progress: [] };
        entry.parts.push(item);
        browsers.set(id, item);
      }
    } else if (event.type === "skill") {
      const item: ChatActivity = { kind: "activity", key: index, event, progress: [] };
      entry.parts.push(item); rank(item);
    } else if (event.type === "say" || event.type === "warn" || event.type === "error" || event.type === "published" || event.type === "gaps") {
      const item: ChatMessage = { kind: "message", key: index, event };
      entry.parts.push(item); rank(item);
      if (event.type === "error") terminal = event.message === "已取消" ? "cancelled" : "ended";
    }
  }
  for (const [blockId, block] of Object.entries(live)) {
    addBlock(blockId, block.type, block.content, false, events.at(-1)?.at ?? "");
  }
  finish(terminal ?? (status === "idle" || status === "error" ? "ended" : undefined));
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
  const labels = { running: "调用中…", completed: "已完成", failed: "调用失败", cancelled: "已中断", ended: "未完成" };
  return event.status ? labels[event.status] : "执行记录";
}

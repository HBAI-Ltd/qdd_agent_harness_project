import type { SessionEvent } from "@qdd/shared";

// Display fields are optional until the gateway exposes structured activity.
// Existing text-only tool events remain readable without inventing a status.
export type ChatToolEvent = Extract<SessionEvent, { type: "tool" }> & {
  callId?: string;
  name?: string;
  status?: "running" | "completed" | "failed" | "cancelled";
  input?: Record<string, unknown>;
  output?: string;
};
export type ChatEvent = Exclude<SessionEvent, { type: "tool" | "thinking" }> | ChatToolEvent | {
  type: "thinking";
  text: string;
  at: string;
};
type ActivityEvent = Extract<ChatEvent, { type: "thinking" | "tool" | "skill" | "browser" }>;
type MessageEvent = Extract<SessionEvent, { type: "say" | "warn" | "error" | "published" | "gaps" }>;

export interface ChatActivity {
  key: number;
  event: ActivityEvent;
  progress: string[];
}

export interface AssistantEntry {
  kind: "assistant";
  key: number;
  at: string;
  activities: ChatActivity[];
  messages: { key: number; event: MessageEvent }[];
}

export type ChatEntry = AssistantEntry | {
  kind: "user";
  key: number | "pending";
  event: Extract<SessionEvent, { type: "user" }>;
};

// Keep source events intact: SSE reconnect cursors count persisted events.
export function buildChatTimeline(events: readonly ChatEvent[], pending?: Extract<SessionEvent, { type: "user" }>): ChatEntry[] {
  const entries: ChatEntry[] = [];
  let assistant: AssistantEntry | undefined;
  let tools = new Map<string, ChatActivity>();

  for (const [index, event] of events.entries()) {
    if (event.type === "user") {
      entries.push({ kind: "user", key: index, event });
      assistant = undefined;
      tools = new Map();
      continue;
    }
    if (!["thinking", "tool", "skill", "browser", "say", "warn", "error", "published", "gaps"].includes(event.type)) continue;
    if (!assistant) {
      assistant = { kind: "assistant", key: index, at: event.at, activities: [], messages: [] };
      entries.push(assistant);
    }
    if (event.type === "tool") {
      const previous = event.callId ? tools.get(event.callId) : undefined;
      if (previous && previous.event.type === "tool") {
        const status = previous.event.status && previous.event.status !== "running" && event.status === "running"
          ? previous.event.status : event.status ?? previous.event.status;
        previous.event = { ...previous.event, ...event, ...(status ? { status } : {}) };
        if (!event.status && event.text && !previous.progress.includes(event.text)) previous.progress.push(event.text);
      } else {
        const activity = { key: index, event: { ...event }, progress: !event.status && event.text ? [event.text] : [] };
        assistant.activities.push(activity);
        if (event.callId) tools.set(event.callId, activity);
      }
    } else if (event.type === "thinking" || event.type === "skill" || event.type === "browser") {
      assistant.activities.push({ key: index, event, progress: [] });
    } else if (event.type === "say" || event.type === "warn" || event.type === "error" || event.type === "published" || event.type === "gaps") {
      assistant.messages.push({ key: index, event });
    }
  }
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

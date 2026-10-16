export type AssistantKind = "general" | "store" | "code";
export type TaskStatus = "todo" | "in_progress" | "done";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  assistant?: AssistantKind;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface TaskContent {
  html: string;
  script: string;
  css: string;
}

export interface WorkspaceTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  conversationId: string | null;
  sourceMessageId: string | null;
  sourceConversationTitle: string;
  content: TaskContent | null;
}

export interface CreateTaskInput {
  conversationId: string;
  sourceMessageId: string;
  title: string;
  description: string;
}

// TODO: 接入后端时确认 API 前缀、认证方式及部署地址；开发代理见 vite.config.ts。
const API_BASE_URL = "/api";

export const WORKSPACE_ENDPOINTS = {
  // TODO: 确认获取对话列表 GET 与新建对话 POST 地址。
  conversations: "/conversations",
  // TODO: 确认对话详情 GET、重命名 PATCH 与删除 DELETE 地址。
  conversation: (id: string) => `/conversations/${encodeURIComponent(id)}`,
  // TODO: 确认发送消息 POST 地址，约定返回更新后的完整对话。
  messages: (id: string) => `/conversations/${encodeURIComponent(id)}/messages`,
  // TODO: 确认停止回复 POST 地址，服务端需要停止实际 Agent 执行。
  stop: (id: string) => `/conversations/${encodeURIComponent(id)}/stop`,
  // TODO: 确认任务列表 GET 与从对话创建任务 POST 地址。
  tasks: "/tasks",
  // TODO: 确认任务详情 GET、修改标题或状态 PATCH 与删除 DELETE 地址。
  task: (id: string) => `/tasks/${encodeURIComponent(id)}`,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseTimestamp(value: unknown, field: string): number {
  const timestamp = typeof value === "string" ? Date.parse(value) : value;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || Math.abs(timestamp) > 8.64e15) {
    throw new Error(`${field} 格式不正确，应为毫秒时间戳或 ISO 日期字符串。`);
  }
  return timestamp;
}

function parseBase(value: unknown, label: string) {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()
    || typeof value.title !== "string") {
    throw new Error(`${label}数据格式不正确，请检查后端返回的 id 和 title。`);
  }
  const updatedAt = parseTimestamp(value.updatedAt, `${label} updatedAt`);
  const createdAt = value.createdAt === undefined ? updatedAt : parseTimestamp(value.createdAt, `${label} createdAt`);
  return { id: value.id, title: value.title, createdAt, updatedAt };
}

function parseMessage(value: unknown): ChatMessage {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()
    || (value.role !== "user" && value.role !== "assistant") || typeof value.content !== "string") {
    throw new Error("对话消息格式不正确，请检查后端返回的 id、role 和 content。");
  }
  const message: ChatMessage = {
    id: value.id,
    role: value.role,
    content: value.content,
    createdAt: parseTimestamp(value.createdAt, "消息 createdAt"),
  };
  if (value.assistant === "general" || value.assistant === "store" || value.assistant === "code") {
    message.assistant = value.assistant;
  }
  return message;
}

function assertUniqueIds<T extends { id: string }>(items: T[], label: string): T[] {
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error(`${label}包含重复 id。`);
  return items;
}

export function parseConversation(value: unknown): Conversation {
  const base = parseBase(value, "对话");
  if (!isRecord(value)) throw new Error("对话详情格式不正确。");
  if (value.messages !== undefined && !Array.isArray(value.messages)) throw new Error("对话 messages 应为数组。");
  const messages = assertUniqueIds((value.messages ?? []).map(parseMessage), "对话消息");
  return { ...base, messages };
}

function parseOptionalString(value: unknown, field: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error(`${field} 应为字符串。`);
  return value;
}

function parseNullableId(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 应为非空字符串或 null。`);
  return value;
}

export function parseTask(value: unknown): WorkspaceTask {
  const base = parseBase(value, "任务");
  if (!isRecord(value)) throw new Error("任务详情格式不正确。");
  const status = value.status ?? "todo";
  if (status !== "todo" && status !== "in_progress" && status !== "done") throw new Error("任务状态应为 todo、in_progress 或 done。");
  let content: TaskContent | null = null;
  if (value.content !== undefined && value.content !== null) {
    if (!isRecord(value.content) || typeof value.content.html !== "string"
      || (value.content.script !== undefined && typeof value.content.script !== "string")
      || (value.content.css !== undefined && typeof value.content.css !== "string")) {
      throw new Error("任务内容格式不正确，应包含 html、script 和 css 字符串。");
    }
    content = { html: value.content.html, script: value.content.script ?? "", css: value.content.css ?? "" };
  }
  return {
    ...base,
    description: parseOptionalString(value.description, "任务 description"),
    status,
    conversationId: parseNullableId(value.conversationId, "任务 conversationId"),
    sourceMessageId: parseNullableId(value.sourceMessageId, "任务 sourceMessageId"),
    sourceConversationTitle: parseOptionalString(value.sourceConversationTitle, "任务 sourceConversationTitle"),
    content,
  };
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: "same-origin",
    headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  if (!response.ok) {
    if (response.status === 404 || response.status === 501) {
      throw new Error("接口尚未接入或资源不存在，请稍后重试。");
    }
    throw new Error(`请求失败（HTTP ${response.status}），请稍后重试。`);
  }
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("后端响应不是有效 JSON，请检查接口地址与代理配置。");
  }
}

function assertRequestedId<T extends { id: string }>(item: T, id: string): T {
  if (item.id !== id) throw new Error("后端返回的 id 与请求不匹配。");
  return item;
}

export async function listConversations(signal: AbortSignal): Promise<Conversation[]> {
  // TODO: 如后端采用 { data: [...] } 或分页，调整对话列表响应映射。
  const data = await request(WORKSPACE_ENDPOINTS.conversations, { signal });
  if (!Array.isArray(data)) throw new Error("对话列表格式不正确，预期返回数组。");
  return assertUniqueIds(data.map(parseConversation), "对话列表");
}

export async function getConversation(id: string, signal: AbortSignal): Promise<Conversation> {
  // TODO: 按真实后端字段映射对话详情和消息。
  return assertRequestedId(parseConversation(await request(WORKSPACE_ENDPOINTS.conversation(id), { signal })), id);
}

export async function createConversation(assistant: AssistantKind, signal: AbortSignal): Promise<Conversation> {
  // TODO: 确认新建对话请求参数，约定返回完整对话。
  return parseConversation(await request(WORKSPACE_ENDPOINTS.conversations, {
    method: "POST", body: JSON.stringify({ title: "新对话", assistant }), signal,
  }));
}

export async function updateConversation(id: string, title: string, signal: AbortSignal): Promise<Conversation> {
  // TODO: 确认 PATCH 重命名后返回完整对话。
  return assertRequestedId(parseConversation(await request(WORKSPACE_ENDPOINTS.conversation(id), {
    method: "PATCH", body: JSON.stringify({ title }), signal,
  })), id);
}

export async function removeConversation(id: string, signal: AbortSignal): Promise<void> {
  // TODO: 后端删除对话时保留其任务，并将任务来源关联置空。
  await request(WORKSPACE_ENDPOINTS.conversation(id), { method: "DELETE", signal });
}

export async function sendConversationMessage(id: string, content: string, assistant: AssistantKind, signal: AbortSignal): Promise<Conversation> {
  // TODO: 接入真实 Agent 消息接口；SSE / WebSocket 流式协议在此适配。
  return assertRequestedId(parseConversation(await request(WORKSPACE_ENDPOINTS.messages(id), {
    method: "POST", body: JSON.stringify({ content, assistant }), signal,
  })), id);
}

export async function stopConversation(id: string, signal: AbortSignal): Promise<void> {
  // TODO: 后端确认停止实际执行后，客户端才取消等待并重新获取对话。
  await request(WORKSPACE_ENDPOINTS.stop(id), { method: "POST", signal });
}

export async function listTasks(signal: AbortSignal): Promise<WorkspaceTask[]> {
  // TODO: 按后端分页或包装结构调整任务列表映射；列表可省略 content。
  const data = await request(WORKSPACE_ENDPOINTS.tasks, { signal });
  if (!Array.isArray(data)) throw new Error("任务列表格式不正确，预期返回数组。");
  return assertUniqueIds(data.map(parseTask), "任务列表");
}

export async function getTask(id: string, signal: AbortSignal): Promise<WorkspaceTask> {
  // TODO: 按实际后端字段映射任务详情与原生 HTML / JavaScript / CSS 内容。
  return assertRequestedId(parseTask(await request(WORKSPACE_ENDPOINTS.task(id), { signal })), id);
}

export async function createTask(input: CreateTaskInput, signal: AbortSignal): Promise<WorkspaceTask> {
  // TODO: 确认从对话创建任务的参数和返回完整任务详情的约定。
  return parseTask(await request(WORKSPACE_ENDPOINTS.tasks, { method: "POST", body: JSON.stringify(input), signal }));
}

export async function updateTask(id: string, changes: { title?: string; status?: TaskStatus }, signal: AbortSignal): Promise<WorkspaceTask> {
  // TODO: 确认修改标题或进度使用 PATCH，并返回完整任务详情。
  return assertRequestedId(parseTask(await request(WORKSPACE_ENDPOINTS.task(id), {
    method: "PATCH", body: JSON.stringify(changes), signal,
  })), id);
}

export async function removeTask(id: string, signal: AbortSignal): Promise<void> {
  // TODO: 确认删除任务接口，成功返回 204、空响应或 JSON。
  await request(WORKSPACE_ENDPOINTS.task(id), { method: "DELETE", signal });
}

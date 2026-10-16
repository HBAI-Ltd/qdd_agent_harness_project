import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  createTask,
  getTask,
  listConversations,
  listTasks,
  parseConversation,
  parseTask,
  removeTask,
  updateTask,
} from "../src/api/workspace.ts";

const originalFetch = globalThis.fetch;
const timestamp = 1_760_000_000_000;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function backendTask(overrides: Record<string, unknown> = {}) {
  return { id: "task-1", title: "销售看板", updatedAt: timestamp, ...overrides };
}

function signal() {
  return new AbortController().signal;
}

function stubJsonResponse(payload: unknown, status = 200) {
  const calls: { input: string | URL | Request; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return calls;
}

test("task content preserves backend HTML, JavaScript, CSS, and source associations", () => {
  const content = {
    html: '<main id="report"><button>刷新</button></main>',
    script: 'document.querySelector("button").onclick = () => { window.count = 1; };',
    css: "#report { color: black; background: white; }",
  };
  const task = parseTask(backendTask({
    createdAt: timestamp - 1000,
    description: "后端生成的任务",
    status: "in_progress",
    conversationId: "chat-1",
    sourceMessageId: "message-1",
    sourceConversationTitle: "销售分析",
    content,
  }));

  assert.deepEqual(task, {
    id: "task-1",
    title: "销售看板",
    createdAt: timestamp - 1000,
    updatedAt: timestamp,
    description: "后端生成的任务",
    status: "in_progress",
    conversationId: "chat-1",
    sourceMessageId: "message-1",
    sourceConversationTitle: "销售分析",
    content,
  });
});

test("task list records can omit content and optional metadata", () => {
  assert.deepEqual(parseTask(backendTask()), {
    id: "task-1",
    title: "销售看板",
    createdAt: timestamp,
    updatedAt: timestamp,
    description: "",
    status: "todo",
    conversationId: null,
    sourceMessageId: null,
    sourceConversationTitle: "",
    content: null,
  });
});

test("nullable task metadata and content use their documented defaults", () => {
  const task = parseTask(backendTask({
    description: null,
    conversationId: null,
    sourceMessageId: null,
    sourceConversationTitle: null,
    content: null,
  }));
  assert.equal(task.description, "");
  assert.equal(task.sourceConversationTitle, "");
  assert.equal(task.conversationId, null);
  assert.equal(task.sourceMessageId, null);
  assert.equal(task.content, null);
});

test("HTML-only task content defaults missing JavaScript and CSS to empty strings", () => {
  assert.deepEqual(parseTask(backendTask({ content: { html: "<p>Ready</p>" } })).content, {
    html: "<p>Ready</p>",
    script: "",
    css: "",
  });
  assert.deepEqual(parseTask(backendTask({ content: { html: "", script: "", css: "" } })).content, {
    html: "",
    script: "",
    css: "",
  });
});

test("task timestamps accept milliseconds and ISO dates and normalize both to numbers", () => {
  const date = "2026-10-17T10:30:00+08:00";
  const task = parseTask(backendTask({ createdAt: 0, updatedAt: date }));
  assert.equal(task.createdAt, 0);
  assert.equal(task.updatedAt, Date.parse(date));
  const isoTask = parseTask(backendTask({ createdAt: date, updatedAt: timestamp }));
  assert.equal(isoTask.createdAt, Date.parse(date));
  assert.equal(isoTask.updatedAt, timestamp);
});

test("tasks reject invalid identities and base payload shapes", () => {
  const invalid = [
    null,
    [],
    "task-1",
    backendTask({ id: " " }),
    backendTask({ id: 1 }),
    backendTask({ title: undefined }),
    backendTask({ title: 1 }),
  ];
  for (const value of invalid) assert.throws(() => parseTask(value), /任务数据格式不正确/);
});

test("tasks reject invalid status, metadata, and source identifiers", () => {
  const invalid = [
    { status: "running" },
    { description: 1 },
    { sourceConversationTitle: [] },
    { conversationId: " " },
    { sourceMessageId: 1 },
  ];
  for (const overrides of invalid) assert.throws(() => parseTask(backendTask(overrides)));
});

test("task content requires string HTML and rejects non-string JavaScript or CSS", () => {
  const invalid = [
    "<p>Invalid wrapper</p>",
    [],
    {},
    { html: 1 },
    { html: null },
    { html: "<p>Ready</p>", script: false },
    { html: "<p>Ready</p>", script: null },
    { html: "<p>Ready</p>", css: [] },
    { html: "<p>Ready</p>", css: null },
  ];
  for (const content of invalid) {
    assert.throws(() => parseTask(backendTask({ content })), /任务内容格式不正确/);
  }
});

test("tasks reject missing, invalid, non-finite, and out-of-range timestamps", () => {
  const invalid = [undefined, null, "not-a-date", {}, Number.NaN, Infinity, -Infinity, 8.64e15 + 1];
  for (const updatedAt of invalid) {
    assert.throws(() => parseTask(backendTask({ updatedAt })), /updatedAt 格式不正确/);
  }
  for (const createdAt of invalid.filter((value) => value !== undefined)) {
    assert.throws(() => parseTask(backendTask({ createdAt })), /createdAt 格式不正确/);
  }
});

test("conversations retain their messages separately from task content", () => {
  const conversation = parseConversation({
    id: "chat-1",
    title: "销售分析",
    updatedAt: timestamp,
    messages: [{ id: "message-1", role: "assistant", content: "已生成看板", createdAt: timestamp, assistant: "store" }],
  });
  assert.deepEqual(conversation.messages, [
    { id: "message-1", role: "assistant", content: "已生成看板", createdAt: timestamp, assistant: "store" },
  ]);
  assert.deepEqual(parseConversation({ id: "chat-2", title: "新对话", updatedAt: timestamp }).messages, []);
});

test("conversations reject duplicate or malformed messages", () => {
  const message = { id: "message-1", role: "user", content: "生成看板", createdAt: timestamp };
  const conversation = { id: "chat-1", title: "销售分析", updatedAt: timestamp };
  assert.throws(() => parseConversation({ ...conversation, messages: [message, message] }), /重复 id/);
  assert.throws(() => parseConversation({ ...conversation, messages: {} }), /messages 应为数组/);
  assert.throws(() => parseConversation({ ...conversation, messages: [{ ...message, role: "system" }] }), /对话消息格式不正确/);
});

test("task list fetches the backend array with caller cancellation and same-origin credentials", async () => {
  const calls = stubJsonResponse([backendTask(), backendTask({ id: "task-2", title: "库存看板" })]);
  const requestSignal = signal();
  const tasks = await listTasks(requestSignal);
  assert.deepEqual(tasks.map((task) => task.id), ["task-1", "task-2"]);
  assert.equal(tasks[0]?.content, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, "/api/tasks");
  assert.equal(calls[0]?.init?.signal, requestSignal);
  assert.equal(calls[0]?.init?.credentials, "same-origin");
  assert.equal(new Headers(calls[0]?.init?.headers).get("Accept"), "application/json");
});

test("task list rejects response wrappers and duplicate task ids", async () => {
  stubJsonResponse({ data: [backendTask()] });
  await assert.rejects(listTasks(signal()), /任务列表格式不正确/);
  stubJsonResponse([backendTask(), backendTask({ title: "不同标题仍然重复" })]);
  await assert.rejects(listTasks(signal()), /任务列表包含重复 id/);
});

test("conversation list uses its own endpoint and rejects duplicate conversation ids", async () => {
  const conversation = { id: "chat-1", title: "销售分析", updatedAt: timestamp };
  const calls = stubJsonResponse([conversation]);
  const conversations = await listConversations(signal());
  assert.equal(calls[0]?.input, "/api/conversations");
  assert.deepEqual(conversations[0]?.messages, []);
  stubJsonResponse([conversation, conversation]);
  await assert.rejects(listConversations(signal()), /对话列表包含重复 id/);
});

test("task detail URL-encodes backend ids containing path, query, and Unicode characters", async () => {
  const id = "任务 /?#%&";
  const calls = stubJsonResponse(backendTask({ id, content: { html: "<main>Rendered</main>" } }));
  const task = await getTask(id, signal());
  assert.equal(calls[0]?.input, `/api/tasks/${encodeURIComponent(id)}`);
  assert.equal(task.id, id);
  assert.equal(task.content?.html, "<main>Rendered</main>");
});

test("creating a task sends conversation and message associations as JSON", async () => {
  const input = { conversationId: "chat-1", sourceMessageId: "message-1", title: "销售看板", description: "生成任务" };
  const calls = stubJsonResponse(backendTask(input));
  const task = await createTask(input, signal());
  assert.equal(task.conversationId, input.conversationId);
  assert.equal(calls[0]?.input, "/api/tasks");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), input);
  assert.equal(new Headers(calls[0]?.init?.headers).get("Content-Type"), "application/json");
});

test("task updates use encoded ids and send only requested fields", async () => {
  const id = "task/1";
  const calls = stubJsonResponse(backendTask({ id, status: "done" }));
  const task = await updateTask(id, { status: "done" }, signal());
  assert.equal(task.status, "done");
  assert.equal(calls[0]?.input, "/api/tasks/task%2F1");
  assert.equal(calls[0]?.init?.method, "PATCH");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { status: "done" });
});

test("task detail and updates reject a backend response for another task", async () => {
  stubJsonResponse(backendTask({ id: "unexpected-task" }));
  await assert.rejects(getTask("task-1", signal()), /id 与请求不匹配/);
  await assert.rejects(updateTask("task-1", { title: "新标题" }, signal()), /id 与请求不匹配/);
});

test("task deletion accepts HTTP 204 without trying to parse JSON", async () => {
  let calledUrl: string | URL | Request | undefined;
  let calledMethod: string | undefined;
  globalThis.fetch = async (input, init) => {
    calledUrl = input;
    calledMethod = init?.method;
    return new Response(null, { status: 204 });
  };
  await removeTask("task/1", signal());
  assert.equal(calledUrl, "/api/tasks/task%2F1");
  assert.equal(calledMethod, "DELETE");
});

for (const status of [400, 401, 404, 500, 501]) {
  test(`HTTP ${status} fails before accepting backend task content`, async () => {
    stubJsonResponse(backendTask(), status);
    const expected = status === 404 || status === 501 ? /接口尚未接入或资源不存在/ : new RegExp(`HTTP ${status}`);
    await assert.rejects(getTask("task-1", signal()), expected);
  });
}

test("a successful non-JSON response reports the backend format error", async () => {
  globalThis.fetch = async () => new Response("<!doctype html><title>Wrong proxy target</title>", { status: 200 });
  await assert.rejects(listTasks(signal()), /后端响应不是有效 JSON/);
});

test("transport failures propagate without returning fabricated tasks", async () => {
  const error = new TypeError("Backend unavailable");
  globalThis.fetch = async () => { throw error; };
  await assert.rejects(listTasks(signal()), (actual) => actual === error);
});

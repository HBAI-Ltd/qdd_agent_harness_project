import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { effectScope, nextTick } from "vue";
import { useWorkspace } from "../src/pages/chat/useWorkspace.ts";

const storageKey = "harness-workspace-v2";
const legacyKey = "harness-workspace-v1";
const scopes = [];
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function openWorkspace(entries = {}) {
  const storage = new Map(Object.entries(entries));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
  });
  const scope = effectScope();
  scopes.push(scope);
  return { workspace: scope.run(useWorkspace), storage };
}

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

function discuss(workspace, content = "安排门店盘点") {
  assert.equal(workspace.sendMessage(content), true);
  workspace.stopReply();
  return workspace.activeConversation.value;
}

test("legacy chat tasks migrate to conversations and preserve a recovery copy", () => {
  const legacy = JSON.stringify({
    tasks: [{ id: "legacy-chat", title: "旧对话", updatedAt: 20, messages: [{ id: "message", role: "user", content: "盘点", createdAt: 10 }] }],
    activeId: "legacy-chat",
    preferences: { theme: "dark", enterToSend: false, assistant: "store" },
  });
  const { workspace, storage } = openWorkspace({ [legacyKey]: legacy });
  assert.equal(workspace.activeConversationId.value, "legacy-chat");
  assert.equal(workspace.activeConversation.value.messages[0].content, "盘点");
  assert.deepEqual(workspace.preferences.value, { theme: "dark", enterToSend: false, assistant: "store" });
  assert.deepEqual(workspace.tasks.value, []);
  assert.equal(JSON.parse(storage.get(storageKey)).version, 2);
  assert.equal(storage.get(legacyKey), legacy);
});

test("messages create conversations and only explicit actions create independent tasks", () => {
  const { workspace } = openWorkspace();
  assert.equal(workspace.sendMessage("   "), false);
  assert.equal(workspace.conversations.value.length, 0);
  const conversation = discuss(workspace);
  assert.equal(workspace.conversations.value.length, 1);
  assert.equal(workspace.tasks.value.length, 0);
  const task = workspace.createTaskFromConversation(conversation.id, "  安排盘点  ", "  周五盘点库存  ");
  assert.equal(task.title, "安排盘点");
  assert.equal(task.description, "周五盘点库存");
  assert.equal(task.status, "todo");
  assert.equal(task.conversationId, conversation.id);
  assert.equal(task.sourceMessageId, conversation.messages[0].id);
  assert.equal(task.sourceConversationTitle, conversation.title);
  discuss(workspace, "由小王负责");
  assert.equal(workspace.tasks.value.length, 1);
  assert.equal(workspace.activeConversation.value.messages.length, 4);
});

test("task creation requires meaningful conversation, title and source within that conversation", () => {
  const { workspace } = openWorkspace();
  const empty = workspace.newConversation();
  assert.equal(workspace.createTaskFromConversation(empty.id, "任务", ""), undefined);
  const conversation = discuss(workspace);
  assert.equal(workspace.createTaskFromConversation(conversation.id, "  ", ""), undefined);
  assert.equal(workspace.createTaskFromConversation(conversation.id, "a".repeat(81), ""), undefined);
  assert.equal(workspace.createTaskFromConversation(conversation.id, "任务", "a".repeat(8001)), undefined);
  assert.equal(workspace.createTaskFromConversation(conversation.id, "任务", "", "missing"), undefined);
  const assistant = conversation.messages.at(-1);
  assistant.content = "";
  assert.equal(workspace.createTaskFromConversation(conversation.id, "任务", "", assistant.id), undefined);
  assistant.content = "盘点并整理结果";
  const task = workspace.createTaskFromConversation(conversation.id, "盘点", assistant.content, assistant.id);
  assert.equal(task.sourceMessageId, assistant.id);
  workspace.newConversation();
  const other = discuss(workspace, "另外一段对话");
  assert.equal(workspace.createTaskFromConversation(other.id, "任务", "", assistant.id), undefined);
});

test("conversation rename updates origins and deletion preserves detached tasks", async () => {
  const { workspace, storage } = openWorkspace();
  const conversation = discuss(workspace);
  const first = workspace.createTaskFromConversation(conversation.id, "盘点", "记录库存");
  workspace.createTaskFromConversation(conversation.id, "汇总", "整理结果");
  assert.equal(workspace.renameConversation(conversation.id, "门店计划"), true);
  assert.ok(workspace.tasks.value.every((task) => task.sourceConversationTitle === "门店计划"));
  const next = workspace.newConversation();
  workspace.activeConversationId.value = conversation.id;
  workspace.deleteConversation(conversation.id);
  assert.equal(workspace.activeConversationId.value, next.id);
  assert.equal(workspace.tasks.value.length, 2);
  assert.ok(workspace.tasks.value.every((task) => task.conversationId === null && task.sourceMessageId === null));
  assert.equal(workspace.tasks.value.find((task) => task.id === first.id).description, "记录库存");
  await nextTick();
  const restored = openWorkspace({ [storageKey]: storage.get(storageKey) }).workspace;
  assert.equal(restored.tasks.value[0].sourceConversationTitle, "门店计划");
  assert.equal(restored.tasks.value[0].conversationId, null);
});

test("task status and title changes persist; task deletion leaves conversation intact", async () => {
  const { workspace, storage } = openWorkspace();
  const conversation = discuss(workspace);
  const task = workspace.createTaskFromConversation(conversation.id, "盘点", "");
  assert.equal(workspace.setTaskStatus(task.id, "in_progress"), true);
  assert.equal(workspace.setTaskStatus(task.id, "unknown"), false);
  assert.equal(workspace.tasks.value[0].status, "in_progress");
  assert.equal(workspace.renameTask(task.id, "  核对库存  "), true);
  assert.equal(workspace.renameTask(task.id, "  "), false);
  assert.equal(workspace.setTaskStatus(task.id, "done"), true);
  await nextTick();
  assert.equal(JSON.parse(storage.get(storageKey)).tasks[0].status, "done");
  assert.equal(JSON.parse(storage.get(storageKey)).tasks[0].title, "核对库存");
  workspace.deleteTask(task.id);
  assert.equal(workspace.tasks.value.length, 0);
  assert.equal(workspace.conversations.value[0].id, conversation.id);
  assert.equal(workspace.conversations.value[0].messages.length, 2);
});

test("stored data filters invalid values and repairs missing conversation and message links", () => {
  const message = { id: "valid-message", role: "user", content: "盘点", createdAt: 10 };
  const conversation = { id: "valid-chat", title: "库存计划", updatedAt: 20, messages: [message, null, { ...message }] };
  const task = { id: "valid-task", title: "盘点", description: "", status: "todo", createdAt: 10, updatedAt: 20,
    conversationId: "valid-chat", sourceMessageId: "missing-message", sourceConversationTitle: "原始标题" };
  const saved = JSON.stringify({ version: 2, conversations: [conversation, conversation, { id: "bad" }], activeConversationId: "missing-chat",
    tasks: [task, { ...task, id: "orphan", conversationId: "missing-chat" }, { ...task, id: "bad-status", status: "unknown" }],
    preferences: { theme: "invalid", enterToSend: "true", assistant: "invalid" } });
  const { workspace } = openWorkspace({ [storageKey]: saved });
  assert.equal(workspace.conversations.value.length, 1);
  assert.equal(workspace.conversations.value[0].messages.length, 1);
  assert.equal(workspace.activeConversationId.value, null);
  assert.equal(workspace.tasks.value.length, 2);
  assert.equal(workspace.tasks.value[0].conversationId, "valid-chat");
  assert.equal(workspace.tasks.value[0].sourceMessageId, null);
  assert.equal(workspace.tasks.value[0].sourceConversationTitle, "库存计划");
  assert.equal(workspace.tasks.value[1].conversationId, null);
  assert.equal(workspace.tasks.value[1].sourceMessageId, null);
  assert.equal(workspace.tasks.value[1].sourceConversationTitle, "原始标题");
  assert.deepEqual(workspace.preferences.value, { theme: "light", enterToSend: true, assistant: "general" });
});

test("corrupted v2 storage falls back to the untouched legacy recovery data", () => {
  const legacy = JSON.stringify({ tasks: [{ id: "recovered", title: "恢复对话", updatedAt: 1, messages: [] }], activeId: "recovered" });
  const { workspace, storage } = openWorkspace({ [storageKey]: "{invalid", [legacyKey]: legacy });
  assert.equal(workspace.activeConversationId.value, "recovered");
  assert.equal(storage.get(legacyKey), legacy);
  assert.equal(JSON.parse(storage.get(storageKey)).conversations[0].id, "recovered");
});

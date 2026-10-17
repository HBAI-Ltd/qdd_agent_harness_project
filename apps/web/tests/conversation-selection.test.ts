import assert from "node:assert/strict";
import { test } from "node:test";
import { CONVERSATION_DRAFT_VALUE, CONVERSATION_STORAGE_PREFIX, createConversationSelection } from "../src/composables/conversationSelection.ts";

function storage(entries: Record<string, string> = {}) {
  const values = new Map(Object.entries(entries));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

const gateway = "http://127.0.0.1:3000";
const original = { id: "original", updatedAt: "2026-10-17T01:00:00Z" };
const later = { id: "later-cli-session", updatedAt: "2026-10-17T02:00:00Z" };

test("the initial conversation is the newest existing session even when the list is unsorted", () => {
  const saved = storage();
  const choice = createConversationSelection(saved);
  assert.equal(choice.choose(gateway, [original, later]), later.id);
  assert.equal(saved.values.get(CONVERSATION_STORAGE_PREFIX + gateway), later.id);
});

test("reconnect and page reload retain the chosen conversation when newer sessions appear", () => {
  const saved = storage();
  const choice = createConversationSelection(saved);
  assert.equal(choice.choose(gateway, [original]), original.id);
  assert.equal(choice.choose(gateway, [later, original]), original.id);
  const reloaded = createConversationSelection(saved);
  assert.equal(reloaded.choose(gateway, [later, original]), original.id);
});

test("conversation choices are isolated by normalized gateway", () => {
  const saved = storage();
  const choice = createConversationSelection(saved);
  const otherGateway = "http://127.0.0.1:4000";
  choice.remember(gateway, original.id);
  choice.remember(otherGateway, later.id);
  assert.equal(choice.choose(gateway, [later, original]), original.id);
  assert.equal(choice.choose(otherGateway, [original, later]), later.id);
  assert.deepEqual([...saved.values.values()].sort(), [later.id, original.id].sort());
});

test("a missing chosen session falls back to an existing conversation without creating one", () => {
  const saved = storage({ [CONVERSATION_STORAGE_PREFIX + gateway]: "removed-session" });
  const choice = createConversationSelection(saved);
  assert.equal(choice.choose(gateway, [original, later]), later.id);
  assert.equal(choice.choose(gateway, []), null);
  assert.equal(choice.read(gateway), null);
});

test("a newly created conversation is remembered before a later detail request", () => {
  const saved = storage();
  const choice = createConversationSelection(saved);
  assert.equal(choice.choose(gateway, []), null);
  choice.remember(gateway, original.id);
  assert.equal(createConversationSelection(saved).choose(gateway, [later, original]), original.id);
});

test("blocked browser storage still retains the in-memory conversation", () => {
  const choice = createConversationSelection({
    getItem() { throw new Error("Storage blocked"); },
    setItem() { throw new Error("Storage blocked"); },
  });
  assert.equal(choice.choose(gateway, [original]), original.id);
  assert.equal(choice.choose(gateway, [later, original]), original.id);
});

test("an intentional new conversation survives navigation, reconnect, and page reload", () => {
  const saved = storage();
  const choice = createConversationSelection(saved);
  choice.remember(gateway, original.id);
  choice.remember(gateway, null);
  assert.equal(saved.values.get(CONVERSATION_STORAGE_PREFIX + gateway), CONVERSATION_DRAFT_VALUE);
  assert.equal(choice.choose(gateway, [later, original]), null);
  assert.equal(createConversationSelection(saved).choose(gateway, [later, original]), null);
  choice.remember(gateway, later.id);
  assert.equal(choice.choose(gateway, [original, later]), later.id);
});

test("an initially empty history does not pin an unchosen draft", () => {
  const choice = createConversationSelection(storage());
  assert.equal(choice.choose(gateway, []), null);
  assert.equal(choice.choose(gateway, [original]), original.id);
});

test("an intentional draft is scoped to its gateway, including when storage is blocked", () => {
  const choice = createConversationSelection({
    getItem() { throw new Error("Storage blocked"); },
    setItem() { throw new Error("Storage blocked"); },
  });
  choice.remember(gateway, null);
  assert.equal(choice.choose(gateway, [original]), null);
  assert.equal(choice.choose("http://127.0.0.1:4000", [original]), original.id);
});

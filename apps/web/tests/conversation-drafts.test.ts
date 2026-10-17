import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { effectScope, ref } from "vue";
import { useConversationDrafts } from "../src/composables/useConversationDrafts.ts";
import type { MarkdownAttachment } from "../src/utils/attachmentMarkdown.ts";

function attachment(id: string, markdown = `内容 ${id}`): MarkdownAttachment {
  return { id, name: id, size: new TextEncoder().encode(markdown).length, markdown };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(t: TestContext, send: (text: string) => Promise<boolean>, initialId: string | null = "a") {
  const scope = effectScope();
  const gatewayUrl = ref("http://127.0.0.1:3000");
  const activeSessionId = ref<string | null>(initialId);
  const drafts = scope.run(() => useConversationDrafts(gatewayUrl, activeSessionId, send));
  assert.ok(drafts);
  t.after(() => { scope.stop(); });
  const select = (id: string | null) => {
    drafts.beginSelection();
    activeSessionId.value = id;
  };
  return { ...drafts, gatewayUrl, activeSessionId, select };
}

test("switching sessions and gateways restores their independent unsent drafts", (t) => {
  const state = setup(t, async () => true);
  state.draft.value = "draft a";
  state.select("b");
  state.draft.value = "draft b";
  state.select("a");
  assert.equal(state.draft.value, "draft a");
  state.gatewayUrl.value = "http://127.0.0.1:4000";
  assert.equal(state.draft.value, "");
  state.draft.value = "other gateway";
  state.gatewayUrl.value = "http://127.0.0.1:3000";
  assert.equal(state.draft.value, "draft a");
  state.select("b");
  assert.equal(state.draft.value, "draft b");
});

test("submitting clears the composer synchronously before the request settles", async (t) => {
  const pending = deferred<boolean>();
  const state = setup(t, (text) => {
    assert.equal(text, "send immediately");
    assert.equal(state.draft.value, "");
    return pending.promise;
  });
  state.draft.value = "send immediately";
  const request = state.submitMessage();
  assert.equal(state.draft.value, "");
  pending.resolve(true);
  assert.equal(await request, true);
  assert.equal(state.draft.value, "");
});

test("empty drafts and repeated submissions to a pending conversation never send", async (t) => {
  const pending = deferred<boolean>();
  let calls = 0;
  const state = setup(t, () => { calls++; return pending.promise; });
  state.draft.value = "  \n";
  assert.equal(await state.submitMessage(), false);
  assert.equal(state.draft.value, "  \n");
  state.draft.value = "first message";
  const request = state.submitMessage();
  assert.equal(await state.submitMessage(), false);
  state.draft.value = "next message";
  assert.equal(await state.submitMessage(), false);
  assert.equal(state.draft.value, "next message");
  assert.equal(calls, 1);
  pending.resolve(true);
  await request;
});

test("a successful background send clears only its original saved draft", async (t) => {
  const pending = deferred<boolean>();
  const state = setup(t, async (text) => {
    assert.equal(text, "send a");
    return pending.promise;
  });
  state.draft.value = "send a";
  const request = state.submitMessage();
  state.select("b");
  state.draft.value = "keep b";
  pending.resolve(true);
  assert.equal(await request, true);
  assert.equal(state.draft.value, "keep b");
  state.select("a");
  assert.equal(state.draft.value, "");
});

test("edits made during an existing-session send survive success and later switches", async (t) => {
  const pending = deferred<boolean>();
  const state = setup(t, () => pending.promise);
  state.draft.value = "send a";
  const request = state.submitMessage();
  state.draft.value = "next question";
  state.select("b");
  pending.resolve(true);
  await request;
  state.select("a");
  assert.equal(state.draft.value, "next question");
});

test("retyping an identical message during a send remains a new unsent draft", async (t) => {
  const pending = deferred<boolean>();
  const state = setup(t, () => pending.promise);
  state.draft.value = "same question";
  const request = state.submitMessage();
  assert.equal(state.draft.value, "");
  state.draft.value = "same question";
  state.select("b");
  pending.resolve(true);
  await request;
  state.select("a");
  assert.equal(state.draft.value, "same question");
});

test("first creation clears the submitted text and carries new unsent input to the created session", async (t) => {
  const pending = deferred<boolean>();
  const state = setup(t, () => pending.promise, null);
  state.draft.value = "first question";
  const request = state.submitMessage();
  state.draft.value = "next question";
  state.activeSessionId.value = "created";
  assert.equal(state.draft.value, "next question");
  pending.resolve(true);
  await request;
  state.select("b");
  state.select("created");
  assert.equal(state.draft.value, "next question");
});

test("an unchanged first message is cleared when its session is created", async (t) => {
  const pending = deferred<boolean>();
  const state = setup(t, () => pending.promise, null);
  state.draft.value = "first question";
  const request = state.submitMessage();
  assert.equal(state.draft.value, "");
  state.activeSessionId.value = "created";
  assert.equal(state.draft.value, "");
  pending.resolve(true);
  await request;
  assert.equal(state.draft.value, "");
});

test("manual selection while creating never migrates the pending draft into history", async (t) => {
  const pending = deferred<boolean>();
  const state = setup(t, () => pending.promise, null);
  state.select("history");
  state.draft.value = "keep history";
  state.startNewDraft();
  state.activeSessionId.value = null;
  state.draft.value = "new question";
  const request = state.submitMessage();
  state.draft.value = "unsent follow-up";
  state.select("history");
  assert.equal(state.draft.value, "keep history");
  pending.resolve(true);
  await request;
  assert.equal(state.draft.value, "keep history");
});

test("starting a new draft before resetting an existing id preserves that session's input", (t) => {
  const state = setup(t, async () => true);
  state.draft.value = "keep a";
  state.startNewDraft();
  assert.equal(state.draft.value, "");
  state.activeSessionId.value = null;
  assert.equal(state.draft.value, "");
  state.draft.value = "new question";
  state.select("a");
  assert.equal(state.draft.value, "keep a");
});

test("a repeated new-conversation click isolates late results even when the new text is identical", async (t) => {
  const pending = deferred<boolean>();
  const state = setup(t, () => pending.promise, null);
  state.draft.value = "same question";
  const request = state.submitMessage();
  state.startNewDraft();
  state.draft.value = "same question";
  pending.resolve(true);
  await request;
  assert.equal(state.draft.value, "same question");
});

test("out-of-order creates leave the latest conversation and its edited draft intact", async (t) => {
  const first = deferred<boolean>();
  const second = deferred<boolean>();
  let calls = 0;
  const state = setup(t, () => (++calls === 1 ? first.promise : second.promise), null);
  state.draft.value = "older question";
  const older = state.submitMessage();
  state.startNewDraft();
  state.draft.value = "latest question";
  const latest = state.submitMessage();
  state.draft.value = "latest follow-up";
  state.activeSessionId.value = "latest-created";
  second.resolve(true);
  await latest;
  first.resolve(true);
  await older;
  assert.equal(state.activeSessionId.value, "latest-created");
  assert.equal(state.draft.value, "latest follow-up");
});

test("failed sends keep the original draft after switching away and back", async (t) => {
  const pending = deferred<boolean>();
  const state = setup(t, () => pending.promise);
  state.draft.value = "retry this";
  const request = state.submitMessage();
  state.select("b");
  state.draft.value = "keep b";
  pending.resolve(false);
  assert.equal(await request, false);
  state.select("a");
  assert.equal(state.draft.value, "retry this");
});

test("a failed send restores the cleared composer and permits retrying", async (t) => {
  const pending = deferred<boolean>();
  let calls = 0;
  const state = setup(t, (text) => {
    assert.equal(text, "retry this");
    return ++calls === 1 ? pending.promise : Promise.resolve(true);
  });
  state.draft.value = "retry this";
  const request = state.submitMessage();
  assert.equal(state.draft.value, "");
  pending.resolve(false);
  assert.equal(await request, false);
  assert.equal(state.draft.value, "retry this");
  assert.equal(await state.submitMessage(), true);
  assert.equal(state.draft.value, "");
  assert.equal(calls, 2);
});

test("a failed send cannot replace a new draft or resurrect text the user deleted", async (t) => {
  for (const nextText of ["next question", ""]) {
    const pending = deferred<boolean>();
    const state = setup(t, () => pending.promise);
    state.draft.value = "retry this";
    const request = state.submitMessage();
    state.draft.value = "next question";
    state.draft.value = nextText;
    state.select("b");
    state.draft.value = "keep b";
    pending.resolve(false);
    assert.equal(await request, false);
    assert.equal(state.draft.value, "keep b");
    state.select("a");
    assert.equal(state.draft.value, nextText);
  }
});

test("failure after first-session creation restores to that session", async (t) => {
  const pending = deferred<boolean>();
  const state = setup(t, () => pending.promise, null);
  state.draft.value = "first question";
  const request = state.submitMessage();
  state.activeSessionId.value = "created";
  state.select("history");
  state.draft.value = "keep history";
  pending.resolve(false);
  assert.equal(await request, false);
  assert.equal(state.draft.value, "keep history");
  state.select("created");
  assert.equal(state.draft.value, "first question");
});

test("a thrown request restores its draft before propagating the failure", async (t) => {
  const cause = new Error("network unavailable");
  const state = setup(t, async () => { throw cause; });
  state.draft.value = "retry this";
  const request = state.submitMessage();
  assert.equal(state.draft.value, "");
  await assert.rejects(request, cause);
  assert.equal(state.draft.value, "retry this");
});

test("clearing credentials invalidates pending draft cleanup for the same session", async (t) => {
  const pending = deferred<boolean>();
  const state = setup(t, () => pending.promise);
  state.draft.value = "same text";
  const request = state.submitMessage();
  state.clear();
  state.draft.value = "same text";
  pending.resolve(true);
  await request;
  assert.equal(state.draft.value, "same text");
});

test("clearing credentials invalidates pending failure recovery for the same session", async (t) => {
  const pending = deferred<boolean>();
  const state = setup(t, () => pending.promise);
  state.draft.value = "old credentials' message";
  const request = state.submitMessage();
  state.clear();
  pending.resolve(false);
  assert.equal(await request, false);
  assert.equal(state.draft.value, "");
});

test("attachment-only sends contain Markdown and clear attachments before sending", async (t) => {
  const pending = deferred<boolean>();
  const report = attachment("销售记录", "| 门店 | 销售额 |\n| --- | --- |\n| A | 120 |");
  const state = setup(t, (text) => {
    assert.equal(text, "## 附件：销售记录\n\n| 门店 | 销售额 |\n| --- | --- |\n| A | 120 |");
    assert.equal(state.draft.value, "");
    assert.deepEqual(state.attachments.value, []);
    return pending.promise;
  });
  await state.addAttachments(async () => [report]);
  const request = state.submitMessage();
  assert.deepEqual(state.attachments.value, []);
  pending.resolve(true);
  assert.equal(await request, true);
});

test("text and multiple attachments send as one Markdown message in selection order", async (t) => {
  const sent: string[] = [];
  const state = setup(t, async (text) => { sent.push(text); return true; });
  state.draft.value = "  分析附件  ";
  await state.addAttachments(async () => [attachment("库存", "# 库存\n\n120 件"), attachment("代码", "```ts\nrun();\n```")]);
  assert.equal(await state.submitMessage(), true);
  assert.deepEqual(sent, ["分析附件\n\n---\n\n## 附件：库存\n\n# 库存\n\n120 件\n\n---\n\n## 附件：代码\n\n```ts\nrun();\n```"]);
});

test("failed sends restore unchanged attachments independently of later text and file edits", async (t) => {
  for (const edit of ["none", "text", "files", "both", "delete"] as const) {
    const pending = deferred<boolean>();
    const state = setup(t, () => pending.promise);
    const original = attachment("原附件");
    const next = attachment("新附件");
    state.draft.value = "原问题";
    await state.addAttachments(async () => [original]);
    const request = state.submitMessage();
    if (edit === "text" || edit === "both" || edit === "delete") state.draft.value = "新问题";
    if (edit === "files" || edit === "both" || edit === "delete") await state.addAttachments(async () => [next]);
    if (edit === "delete") {
      state.draft.value = "";
      state.attachments.value.splice(0, 1);
    }
    // Recovery must affect the saved source draft without touching another conversation.
    state.select("b");
    state.draft.value = "保留 B";
    const other = attachment("B 附件");
    await state.addAttachments(async () => [other]);
    pending.resolve(false);
    assert.equal(await request, false);
    assert.equal(state.draft.value, "保留 B");
    assert.deepEqual(state.attachments.value, [other]);
    state.select("a");
    assert.equal(state.draft.value, edit === "text" || edit === "both" ? "新问题" : edit === "delete" ? "" : "原问题");
    assert.deepEqual(state.attachments.value, edit === "files" || edit === "both" ? [next] : edit === "delete" ? [] : [original]);
  }
});

test("attachments stay isolated across sessions, gateways and new conversation drafts", async (t) => {
  const state = setup(t, async () => true);
  const a = attachment("A"), b = attachment("B"), remote = attachment("另一网关");
  await state.addAttachments(async () => [a]);
  state.select("b");
  assert.deepEqual(state.attachments.value, []);
  await state.addAttachments(async () => [b]);
  state.gatewayUrl.value = "http://127.0.0.1:4000";
  assert.deepEqual(state.attachments.value, []);
  await state.addAttachments(async () => [remote]);
  state.gatewayUrl.value = "http://127.0.0.1:3000";
  assert.deepEqual(state.attachments.value, [b]);
  state.select("a");
  assert.deepEqual(state.attachments.value, [a]);
  state.startNewDraft();
  state.activeSessionId.value = null;
  assert.deepEqual(state.attachments.value, []);
  state.select("a");
  assert.deepEqual(state.attachments.value, [a]);
});

test("conversion finishing in another session appends only to its original saved draft", async (t) => {
  const pending = deferred<MarkdownAttachment[]>();
  const state = setup(t, async () => true);
  const a = attachment("A"), b = attachment("B");
  state.draft.value = "问题 A";
  const converting = state.addAttachments(() => pending.promise);
  assert.equal(state.convertingAttachments.value, true);
  state.select("b");
  assert.equal(state.convertingAttachments.value, false);
  state.draft.value = "问题 B";
  await state.addAttachments(async () => [b]);
  pending.resolve([a]);
  await converting;
  assert.equal(state.draft.value, "问题 B");
  assert.deepEqual(state.attachments.value, [b]);
  state.select("a");
  assert.equal(state.convertingAttachments.value, false);
  assert.equal(state.draft.value, "问题 A");
  assert.deepEqual(state.attachments.value, [a]);
});

test("conversion finishing in another gateway preserves both gateways' attachments", async (t) => {
  const pending = deferred<MarkdownAttachment[]>();
  const state = setup(t, async () => true);
  const a = attachment("本地"), remote = attachment("远端");
  const converting = state.addAttachments(() => pending.promise);
  state.gatewayUrl.value = "http://127.0.0.1:4000";
  await state.addAttachments(async () => [remote]);
  pending.resolve([a]);
  await converting;
  assert.deepEqual(state.attachments.value, [remote]);
  state.gatewayUrl.value = "http://127.0.0.1:3000";
  assert.deepEqual(state.attachments.value, [a]);
});

test("credential clearing discards old conversions without clearing a new conversion's busy state", async (t) => {
  const old = deferred<MarkdownAttachment[]>(), current = deferred<MarkdownAttachment[]>();
  const state = setup(t, async () => true);
  const oldRequest = state.addAttachments(() => old.promise);
  state.clear();
  assert.equal(state.convertingAttachments.value, false);
  const currentRequest = state.addAttachments(() => current.promise);
  old.resolve([attachment("旧身份")]);
  await oldRequest;
  assert.equal(state.convertingAttachments.value, true);
  assert.deepEqual(state.attachments.value, []);
  const expected = attachment("新身份");
  current.resolve([expected]);
  await currentRequest;
  assert.equal(state.convertingAttachments.value, false);
  assert.deepEqual(state.attachments.value, [expected]);
});

test("converting attachments blocks submission and failures release the busy state", async (t) => {
  const pending = deferred<MarkdownAttachment[]>();
  let calls = 0;
  const state = setup(t, async () => { calls++; return true; });
  state.draft.value = "保留文字";
  const converting = state.addAttachments(() => pending.promise);
  assert.equal(await state.submitMessage(), false);
  assert.equal(calls, 0);
  assert.equal(state.draft.value, "保留文字");
  pending.resolve([attachment("已转换")]);
  await converting;
  const cause = new Error("转换失败");
  await assert.rejects(state.addAttachments(async () => { throw cause; }), cause);
  assert.equal(state.convertingAttachments.value, false);
  assert.equal(state.attachments.value.length, 1);
  assert.equal(await state.submitMessage(), true);
  assert.equal(calls, 1);
});

test("new attachments typed during the first send migrate into its created session", async (t) => {
  const pending = deferred<boolean>();
  const state = setup(t, () => pending.promise, null);
  const first = attachment("首条附件"), followup = attachment("后续附件");
  await state.addAttachments(async () => [first]);
  const request = state.submitMessage();
  state.draft.value = "后续问题";
  await state.addAttachments(async () => [followup]);
  state.activeSessionId.value = "created";
  pending.resolve(false);
  assert.equal(await request, false);
  assert.equal(state.draft.value, "后续问题");
  assert.deepEqual(state.attachments.value, [followup]);
  state.select("b");
  state.select("created");
  assert.deepEqual(state.attachments.value, [followup]);
});

test("failure after the first session is created restores its attachment-only message there", async (t) => {
  const pending = deferred<boolean>();
  const state = setup(t, () => pending.promise, null);
  const first = attachment("首条附件");
  await state.addAttachments(async () => [first]);
  const request = state.submitMessage();
  state.activeSessionId.value = "created";
  state.select("history");
  pending.resolve(false);
  await request;
  assert.deepEqual(state.attachments.value, []);
  state.select("created");
  assert.deepEqual(state.attachments.value, [first]);
});

test("a follow-up conversion remains attached when its first message creates the session", async (t) => {
  const pending = deferred<boolean>(), converted = deferred<MarkdownAttachment[]>();
  const state = setup(t, () => pending.promise, null);
  state.draft.value = "首条问题";
  const request = state.submitMessage();
  const converting = state.addAttachments(() => converted.promise);
  state.activeSessionId.value = "created";
  assert.equal(state.convertingAttachments.value, true);
  state.select("history");
  assert.equal(state.convertingAttachments.value, false);
  const history = attachment("历史对话附件");
  await state.addAttachments(async () => [history]);
  const followup = attachment("后续附件");
  converted.resolve([followup]);
  await converting;
  pending.resolve(true);
  await request;
  assert.deepEqual(state.attachments.value, [history]);
  state.select("created");
  assert.equal(state.convertingAttachments.value, false);
  assert.deepEqual(state.attachments.value, [followup]);
});

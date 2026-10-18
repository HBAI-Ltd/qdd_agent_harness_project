import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { effectScope, ref } from "vue";
import { filesFromDrop, useComposer, type PickedFile } from "../src/composables/useComposer.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const picked = (name: string) => ({ file: new File([name], name), path: name });
const attachment = (name: string) => ({ id: name, path: name, size: name.length, mime: "text/plain" });

function setup(t: TestContext, id: string | null = "session-a") {
  const scope = effectScope();
  const workspace = {
    gatewayUrl: ref("http://127.0.0.1:3000"), token: ref("original-token"), connected: ref(true),
    activeSessionId: ref(id), activeSession: ref(), sessions: ref([]), error: ref(""),
    chatOptions: ref(), chatSelection: ref(), selectChatModel() {}, applyResponseMeta() {},
  };
  const composer = scope.run(() => useComposer(workspace as unknown as Parameters<typeof useComposer>[0]))!;
  t.after(() => scope.stop());
  return { composer, workspace, scope };
}

test("uploaded and pending attachments stay in the conversation that selected them", async (t) => {
  const pending = deferred<Response>();
  t.mock.method(globalThis, "fetch", async (url: unknown) => String(url).endsWith("/api/models")
    ? json({ models: [], default: "" }) : pending.promise);
  const { composer, workspace } = setup(t);
  composer.addFiles([picked("private-a.txt")]);
  workspace.activeSessionId.value = "session-b";
  assert.equal(composer.attachments.value.length, 0, "another conversation must not inherit files");
  pending.resolve(json(attachment("private-a.txt")));
  await settle();
  assert.equal(composer.ready.value.length, 0, "a late upload belongs to its original draft");
  workspace.activeSessionId.value = "session-a";
  assert.deepEqual(composer.ready.value.map((item) => item.id), ["private-a.txt"]);
});

test("credential changes abort active uploads and discard queued files and late responses", async (t) => {
  const pending = deferred<Response>();
  const uploads: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    if (String(url).endsWith("/api/models")) return json({ models: [], default: "" });
    uploads.push({ url: String(url), init });
    return pending.promise;
  });
  const { composer, workspace } = setup(t);
  composer.addFiles(Array.from({ length: 7 }, (_, i) => picked(`private-${i}.txt`)));
  assert.equal(uploads.length, 4);
  workspace.gatewayUrl.value = "http://127.0.0.1:4000";
  workspace.token.value = "another-account";
  assert.ok(uploads.every((item) => item.init.signal?.aborted), "all old-account uploads must abort");
  assert.equal(composer.attachments.value.length, 0);
  pending.resolve(json(attachment("late-private-file")));
  await settle();
  assert.equal(uploads.length, 4, "queued old files must never upload with replacement credentials");
  assert.equal(composer.ready.value.length, 0);
});

test("disconnect and unmount abort uploads and never resume buffered files", async (t) => {
  const pending = deferred<Response>();
  const uploads: RequestInit[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    if (String(url).endsWith("/api/models")) return json({ models: [], default: "" });
    uploads.push(init);
    return pending.promise;
  });
  const { composer, workspace, scope } = setup(t);
  composer.addFiles(Array.from({ length: 6 }, (_, i) => picked(`file-${i}.txt`)));
  workspace.connected.value = false;
  assert.ok(uploads.every((init) => init.signal?.aborted));
  assert.equal(composer.uploading.value, false);
  assert.ok(composer.attachments.value.every((item) => item.status === "error"));
  workspace.connected.value = true;
  pending.resolve(json(attachment("late")));
  await settle();
  assert.equal(uploads.length, 4);
  assert.equal(composer.ready.value.length, 0);
  scope.stop();
  composer.addFiles([picked("after-unmount.txt")]);
  assert.equal(uploads.length, 4);
  assert.equal(composer.attachments.value.length, 0);
});

test("sending snapshots and clears attachments immediately while preserving later edits", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => String(url).endsWith("/api/models")
    ? json({ models: [], default: "" }) : json(attachment(decodeURIComponent(new Headers(init.headers).get("X-File-Name")!))));
  const { composer } = setup(t);
  composer.addFiles([picked("original.txt")]);
  await settle();
  const pending = deferred<boolean>();
  let sent: string[] = [];
  const sending = composer.sendWithAttachments(async (items) => { sent = items.map((item) => item.id); return pending.promise; });
  assert.deepEqual(sent, ["original.txt"]);
  assert.equal(composer.attachments.value.length, 0);
  composer.addFiles([picked("next.txt")]);
  await settle();
  pending.resolve(true);
  assert.equal(await sending, true);
  assert.deepEqual(composer.ready.value.map((item) => item.id), ["next.txt"]);
});

test("failed sends restore only the original unchanged conversation draft", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: unknown) => String(url).endsWith("/api/models")
    ? json({ models: [], default: "" }) : json(attachment("original.txt")));
  const { composer, workspace } = setup(t);
  composer.addFiles([picked("original.txt")]);
  await settle();
  const pending = deferred<boolean>();
  const sending = composer.sendWithAttachments(async () => pending.promise);
  composer.beginSelection();
  workspace.activeSessionId.value = "session-b";
  pending.resolve(false);
  assert.equal(await sending, false);
  assert.equal(composer.attachments.value.length, 0);
  workspace.activeSessionId.value = "session-a";
  assert.deepEqual(composer.ready.value.map((item) => item.id), ["original.txt"]);
  const retry = deferred<boolean>();
  const retrying = composer.sendWithAttachments(async () => retry.promise);
  composer.clearAttachments();
  retry.resolve(false);
  await retrying;
  assert.equal(composer.attachments.value.length, 0, "explicitly cleared files must not resurrect");
});

test("first-session creation carries later uploads and failure recovery into the created session", async (t) => {
  const nextUpload = deferred<Response>();
  let uploaded = 0;
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    if (String(url).endsWith("/api/models")) return json({ models: [], default: "" });
    return ++uploaded === 1 ? json(attachment("original.txt")) : nextUpload.promise;
  });
  const { composer, workspace } = setup(t, null);
  composer.addFiles([picked("original.txt")]);
  await settle();
  const sent = deferred<boolean>();
  const sending = composer.sendWithAttachments(async () => sent.promise);
  composer.addFiles([picked("next.txt")]);
  workspace.activeSessionId.value = "created-session";
  nextUpload.resolve(json(attachment("next.txt")));
  await settle();
  sent.resolve(false);
  await sending;
  assert.deepEqual(composer.ready.value.map((item) => item.id), ["next.txt"], "later file edits prevent restoring old files");
  const failure = composer.sendWithAttachments(async () => false);
  await failure;
  assert.deepEqual(composer.ready.value.map((item) => item.id), ["next.txt"]);
});

test("repeated new drafts isolate late uploads even when the selected session remains null", async (t) => {
  const pending = deferred<Response>();
  t.mock.method(globalThis, "fetch", async (url: unknown) => String(url).endsWith("/api/models")
    ? json({ models: [], default: "" }) : pending.promise);
  const { composer } = setup(t, null);
  composer.addFiles([picked("old-draft.txt")]);
  composer.startNewDraft();
  pending.resolve(json(attachment("old-draft.txt")));
  await settle();
  assert.equal(composer.attachments.value.length, 0);
  assert.equal(composer.uploading.value, false);
});

test("folder collection stays with its original draft, blocks its send, and reports read errors", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: unknown) => String(url).endsWith("/api/models")
    ? json({ models: [], default: "" }) : json(attachment("folder/file.txt")));
  const { composer, workspace } = setup(t);
  const files = deferred<PickedFile[]>();
  const collecting = composer.addFilesFrom(async () => files.promise);
  assert.equal(composer.uploading.value, true);
  assert.equal(await composer.sendWithAttachments(async () => assert.fail("collection must block sending")), false);
  workspace.activeSessionId.value = "session-b";
  assert.equal(composer.uploading.value, false);
  files.resolve([picked("folder/file.txt")]);
  await collecting;
  await settle();
  assert.equal(composer.ready.value.length, 0);
  workspace.activeSessionId.value = "session-a";
  assert.deepEqual(composer.ready.value.map((item) => item.id), ["folder/file.txt"]);
  await composer.addFilesFrom(async () => { throw new Error("无法读取文件夹"); });
  assert.equal(workspace.error.value, "无法读取文件夹");
  assert.equal(composer.uploading.value, false);
});

test("credential changes discard pending directory enumeration before any upload", async (t) => {
  let uploads = 0;
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    if (String(url).endsWith("/api/models")) return json({ models: [], default: "" });
    uploads++;
    return json(attachment("private.txt"));
  });
  const { composer, workspace } = setup(t);
  const files = deferred<PickedFile[]>();
  const collecting = composer.addFilesFrom(async () => files.promise);
  workspace.token.value = "new-account";
  files.resolve([picked("private.txt")]);
  await collecting;
  assert.equal(uploads, 0);
  assert.equal(composer.uploading.value, false);
  assert.equal(composer.attachments.value.length, 0);
});

test("oversized directory drops stop enumeration after the attachment budget", async () => {
  let reads = 0;
  const children = Array.from({ length: 1000 }, (_, index) => ({
    name: `file-${index}.txt`, isFile: true,
    file(done: (file: File) => void) { reads++; done(new File(["text"], this.name)); },
  }));
  const directory = { name: "folder", isDirectory: true, createReader: () => ({ readEntries: (done: (entries: unknown[]) => void) => done(children) }) };
  const data = { items: [{ webkitGetAsEntry: () => directory }] } as unknown as DataTransfer;
  assert.equal((await filesFromDrop(data)).length, 501, "one extra entry reports the exceeded limit");
  assert.equal(reads, 501, "the rest of a huge folder must not be read into memory");
});

test("failure after first creation restores attachments to that session and never to a selected history item", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: unknown) => String(url).endsWith("/api/models")
    ? json({ models: [], default: "" }) : json(attachment("original.txt")));
  const { composer, workspace } = setup(t, null);
  composer.addFiles([picked("original.txt")]);
  await settle();
  const pending = deferred<boolean>();
  const sending = composer.sendWithAttachments(async () => pending.promise);
  workspace.activeSessionId.value = "created-session";
  pending.resolve(false);
  await sending;
  assert.deepEqual(composer.ready.value.map((item) => item.id), ["original.txt"]);
  composer.startNewDraft();
  workspace.activeSessionId.value = null;
  composer.addFiles([picked("second.txt")]);
  await settle();
  const second = deferred<boolean>();
  const creating = composer.sendWithAttachments(async () => second.promise);
  composer.beginSelection();
  workspace.activeSessionId.value = "history-session";
  second.resolve(false);
  await creating;
  assert.equal(composer.attachments.value.length, 0);
});

test("a failed attachment send cannot resurrect the previous account's files", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: unknown) => String(url).endsWith("/api/models")
    ? json({ models: [], default: "" }) : json(attachment("private.txt")));
  const { composer, workspace } = setup(t);
  composer.addFiles([picked("private.txt")]);
  await settle();
  const pending = deferred<boolean>();
  const sending = composer.sendWithAttachments(async () => pending.promise);
  workspace.token.value = "replacement-account";
  pending.resolve(false);
  await sending;
  assert.equal(composer.attachments.value.length, 0);
});

test("removing a folder aborts active files and prevents all queued files in it from uploading", async (t) => {
  const pending = deferred<Response>();
  const uploads: RequestInit[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    if (String(url).endsWith("/api/models")) return json({ models: [], default: "" });
    uploads.push(init);
    return pending.promise;
  });
  const { composer } = setup(t);
  composer.addFiles(Array.from({ length: 8 }, (_, i) => picked(`folder/file-${i}.txt`)));
  composer.removeFolder("folder");
  assert.ok(uploads.every((init) => init.signal?.aborted));
  pending.resolve(json(attachment("late-folder-file")));
  await settle();
  assert.equal(uploads.length, 4);
  assert.equal(composer.attachments.value.length, 0);
  assert.equal(composer.uploading.value, false);
});

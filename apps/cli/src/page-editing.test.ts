import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { PageEntry } from "@qdd/shared";
import type { ChatFn, ChatMessage } from "./agent/llm.js";
import { loadConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { Conflict, SessionHub, type CreateOptions } from "./sessions.js";
import { ensureWorkspace, readPages } from "./web/site.js";

const HTML = '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>经营看板</h1><script src="app.js"></script></body></html>';
const CSS = "body { color: navy; }\n";
const SCRIPT = 'document.body.dataset.ready = "true";\n';

function call(name: string, args: object = {}): ChatMessage {
  return {
    role: "assistant", content: null,
    tool_calls: [{ id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

const finish = () => call("finish", { title: "经营看板", summary: "已按要求调整页面", tools: [], useAgent: false });
const reply = () => call("reply", { text: "已确认编辑目标，稍后继续。" });
type Step = ChatMessage | ((messages: ChatMessage[]) => ChatMessage | Promise<ChatMessage>);

function scripted(...steps: Step[]): ChatFn {
  let index = 0;
  return async (messages) => {
    const step = steps[index++];
    assert.ok(step, "The agent must complete the scripted interaction without extra model calls");
    return typeof step === "function" ? step(messages) : step;
  };
}

function lastOutput(messages: ChatMessage[]): string {
  const result = messages.findLast((message) => message.role === "tool");
  assert.ok(result, "The previous tool must provide a result to the model");
  return result.content ?? "";
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "qdd-page-editing-"));
  const loaded = await loadConfig(root);
  loaded.config.llm.clarify = "off";
  await ensureWorkspace(loaded.paths);
  const sources = await DataSources.open(loaded);
  let chat: ChatFn = async () => reply();
  const hub = new SessionHub(loaded, sources, () => chat);
  const created: string[] = [];
  const releases: (() => void)[] = [];
  t.after(async () => {
    for (const id of created) hub.cancel(id);
    for (const release of releases) release();
    await Promise.all(created.map((id) => hub.wait(id)));
    await sources.close();
    await rm(root, { recursive: true, force: true });
  });
  async function create(next: ChatFn, wish = "创建一个经营看板", options: CreateOptions = {}) {
    chat = next;
    const meta = await hub.create(wish, options);
    created.push(meta.id);
    return meta;
  }
  async function completed(id: string, status = "idle") {
    const meta = await hub.wait(id);
    assert.equal(meta.status, status, JSON.stringify(await hub.detail(id)));
    return meta;
  }
  return {
    hub, loaded, create, completed,
    async send(id: string, next: ChatFn, text = "修改这个看板的颜色") {
      chat = next;
      await hub.send(id, text);
      return completed(id);
    },
    async publish(): Promise<{ id: string; page: PageEntry }> {
      const created = await create(scripted(
        call("write_file", { path: "index.html", content: HTML }),
        call("write_file", { path: "style.css", content: CSS }),
        call("write_file", { path: "app.js", content: SCRIPT }),
        finish(),
      ));
      const meta = await completed(created.id);
      const page = (await readPages(loaded.paths)).find((page) => page.slug === meta.slug);
      assert.ok(page);
      return { id: created.id, page };
    },
    async file(slug: string, file: string) {
      return readFile(path.join(loaded.paths.pages, slug, file), "utf8");
    },
    gate() {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      releases.push(resolve);
      return { promise, resolve };
    },
    setChat(next: ChatFn) { chat = next; },
  };
}

test("follow-up edits publish another version at the same address and retain untouched files", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const { id, page } = await f.publish();
  const originalHtml = await f.file(page.slug, "index.html");
  const changedCss = "body { color: green; }\n";
  const meta = await f.send(id, scripted(
    call("read_file", { path: "style.css" }),
    (messages) => {
      assert.equal(lastOutput(messages), CSS);
      return call("write_file", { path: "style.css", content: changedCss });
    },
    finish(),
  ));
  const pages = await readPages(f.loaded.paths);
  assert.equal(pages.length, 1);
  assert.equal(meta.slug, page.slug);
  assert.equal(pages[0]!.slug, page.slug);
  assert.equal(pages[0]!.createdAt, page.createdAt);
  assert.equal(pages[0]!.version, page.version + 1);
  assert.equal(await f.file(page.slug, "style.css"), changedCss);
  assert.equal(await f.file(page.slug, "index.html"), originalHtml);
  assert.equal(await f.file(page.slug, "app.js"), SCRIPT);
});

test("a new conversation selects an existing page, reads its source and publishes its changes in place", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const { page } = await f.publish();
  f.loaded.config.llm.clarify = "required";
  const originalHtml = await f.file(page.slug, "index.html");
  const changedCss = "body { color: purple; }\n";
  const edited = await f.create(scripted(
    (messages) => {
      assert.match(messages[0]!.content ?? "", /当前提问策略：required/);
      return call("edit_page", { slug: page.slug });
    },
    (messages) => {
      assert.doesNotMatch(lastOutput(messages), /^错误：/);
      const system = messages[0]!.content ?? "";
      assert.ok(system.includes(`当前页面目录 pages/${page.slug}/`));
      assert.ok(system.includes(`slug：${page.slug}`));
      assert.match(system, /当前提问策略：auto/);
      return call("list_files");
    },
    (messages) => {
      assert.deepEqual(JSON.parse(lastOutput(messages)), ["app.js", "index.html", "style.css"]);
      return call("read_file", { path: "style.css" });
    },
    (messages) => {
      assert.equal(lastOutput(messages), CSS);
      return call("write_file", { path: "style.css", content: changedCss });
    },
    finish(),
  ), "修改之前的经营看板");
  const meta = await f.completed(edited.id);
  const pages = await readPages(f.loaded.paths);
  assert.equal(pages.length, 1);
  assert.equal(meta.slug, page.slug);
  assert.equal(pages[0]!.sessionId, edited.id);
  assert.equal(pages[0]!.createdAt, page.createdAt);
  assert.equal(pages[0]!.version, page.version + 1);
  assert.equal(await f.file(page.slug, "style.css"), changedCss);
  assert.equal(await f.file(page.slug, "index.html"), originalHtml);
  assert.equal(await f.file(page.slug, "app.js"), SCRIPT);
  assert.deepEqual(await f.hub.pending(), [], "An explicit existing-page edit must not require new-page confirmation");
});

for (const ending of ["reply", "model failure"] as const) {
  test(`selecting a page persists its binding after ${ending} and a follow-up edits it directly`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t);
    const { page } = await f.publish();
    const selected = await f.create(scripted(
      call("edit_page", { slug: page.slug }),
      (messages) => {
        assert.doesNotMatch(lastOutput(messages), /^错误：/);
        if (ending === "model failure") throw new Error("Scripted model outage");
        return reply();
      },
    ), "先选中之前的看板");
    const meta = await f.completed(selected.id, ending === "reply" ? "idle" : "error");
    assert.equal(meta.slug, page.slug);
    const persisted = JSON.parse(await readFile(path.join(f.loaded.paths.sessions, `${selected.id}.meta.json`), "utf8")) as { slug: string | null };
    assert.equal(persisted.slug, page.slug);
    assert.deepEqual(await readPages(f.loaded.paths), [page], "Selecting a page must not publish a new version");
    const changedCss = "body { color: teal; }\n";
    await f.send(selected.id, scripted(
      call("read_file", { path: "style.css" }),
      (messages) => {
        assert.equal(lastOutput(messages), CSS);
        return call("write_file", { path: "style.css", content: changedCss });
      },
      finish(),
    ));
    const pages = await readPages(f.loaded.paths);
    assert.equal(pages.length, 1);
    assert.equal(pages[0]!.slug, page.slug);
    assert.equal(pages[0]!.version, page.version + 1);
    assert.equal(await f.file(page.slug, "style.css"), changedCss);
  });
}

test("invalid and missing edit targets leave the conversation and existing page unbound and unchanged", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const { page } = await f.publish();
  for (const slug of ["../outside", "missing-page"]) {
    const created = await f.create(scripted(
      call("edit_page", { slug }),
      (messages) => {
        assert.match(lastOutput(messages), /^错误：/);
        return reply();
      },
    ));
    assert.equal((await f.completed(created.id)).slug, null);
    assert.deepEqual(await readPages(f.loaded.paths), [page]);
    assert.equal(await f.file(page.slug, "style.css"), CSS);
  }
});

test("selecting an existing page after staging a new draft is rejected without redirecting publication", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const { page } = await f.publish();
  const originalHtml = await f.file(page.slug, "index.html");
  const draft = await f.create(scripted(
    call("write_file", { path: "index.html", content: "<html><body>独立的新页面</body></html>" }),
    call("edit_page", { slug: page.slug }),
    (messages) => {
      assert.match(lastOutput(messages), /^错误：/);
      return finish();
    },
  ));
  const meta = await f.completed(draft.id);
  assert.notEqual(meta.slug, page.slug);
  const pages = await readPages(f.loaded.paths);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.find((entry) => entry.slug === page.slug), page);
  assert.equal(await f.file(page.slug, "index.html"), originalHtml);
  assert.equal(await f.file(page.slug, "style.css"), CSS);
});

test("dynamic page selection obeys concurrent locks, retains a rejected binding and releases the target for later sessions", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const original = await f.publish();
  const target = await f.publish();
  const selected = f.gate();
  const release = f.gate();
  const holder = await f.create(scripted(
    call("edit_page", { slug: target.page.slug }),
    async (messages) => {
      assert.doesNotMatch(lastOutput(messages), /^错误：/);
      selected.resolve();
      await release.promise;
      return reply();
    },
  ), "选中另一个已有看板");
  await selected.promise;
  assert.equal((await f.hub.meta(holder.id)).slug, target.page.slug);
  await assert.rejects(f.hub.send(target.id, "这个页面已在修改"), Conflict);
  const rejected = await f.send(original.id, scripted(
    call("edit_page", { slug: target.page.slug }),
    (messages) => {
      assert.match(lastOutput(messages), /^错误：/);
      return reply();
    },
  ));
  assert.equal(rejected.slug, original.page.slug);
  assert.deepEqual(await readPages(f.loaded.paths), [original.page, target.page]);
  release.resolve();
  await f.completed(holder.id);
  const next = await f.create(scripted(
    call("edit_page", { slug: target.page.slug }),
    (messages) => {
      assert.doesNotMatch(lastOutput(messages), /^错误：/);
      return call("write_file", { path: "style.css", content: "body { color: maroon; }\n" });
    },
    finish(),
  ));
  assert.equal((await f.completed(next.id)).slug, target.page.slug);
  const pages = await readPages(f.loaded.paths);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.find((page) => page.slug === original.page.slug), original.page);
  assert.equal(pages.find((page) => page.slug === target.page.slug)!.version, target.page.version + 1);
  assert.equal(await f.file(target.page.slug, "style.css"), "body { color: maroon; }\n");
});

for (const mode of ["complete", "cancel while waiting"] as const) {
  test(`dynamic page selection preempts a scheduled edit and retains its lock until exit (${mode})`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t);
    const { id: owner, page } = await f.publish();
    const scheduledEntered = f.gate();
    const scheduledExit = f.gate();
    const scheduledAborted = f.gate();
    const manualSelected = f.gate();
    const manualExit = f.gate();
    const origin = { kind: "schedule", scheduleId: randomUUID(), scheduleName: "看板自动更新" } as const;
    const scheduled = await f.create(async (_messages, _tools, signal) => {
      signal!.addEventListener("abort", () => scheduledAborted.resolve(), { once: true });
      scheduledEntered.resolve();
      await scheduledExit.promise;
      signal!.throwIfAborted();
      return reply();
    }, "自动更新看板", { slug: page.slug, unattended: true, origin });
    await scheduledEntered.promise;
    let resumedCalls = 0;
    const manual = await f.create(scripted(
      call("edit_page", { slug: page.slug }),
      async (messages) => {
        resumedCalls++;
        assert.doesNotMatch(lastOutput(messages), /^错误：/);
        assert.equal(f.hub.isRunning(scheduled.id), false, "The previous writer must exit before page selection completes");
        manualSelected.resolve();
        await manualExit.promise;
        return call("write_file", { path: "style.css", content: "body { color: olive; }\n" });
      },
      finish(),
    ), "手动修改已有看板");
    await scheduledAborted.promise;
    assert.equal(f.hub.isRunning(scheduled.id), true);
    assert.equal(f.hub.isRunning(manual.id), true);
    assert.equal((await f.hub.meta(manual.id)).slug, null, "An edit target cannot bind before the interrupted writer exits");
    assert.equal(resumedCalls, 0);
    await assert.rejects(f.hub.send(owner, "另一个手动编辑"), Conflict);
    if (mode === "cancel while waiting") {
      f.hub.cancel(manual.id);
      assert.equal(f.hub.isRunning(manual.id), true, "Cancellation must retain the reserved lock while the old writer is still running");
      await assert.rejects(f.hub.send(owner, "取消后旧任务尚未退出"), Conflict);
    }
    scheduledExit.resolve();
    await f.completed(scheduled.id, "error");
    if (mode === "complete") {
      await manualSelected.promise;
      assert.equal((await f.hub.meta(manual.id)).slug, page.slug);
      await assert.rejects(f.hub.send(owner, "编辑仍未完成"), Conflict);
      manualExit.resolve();
      await f.completed(manual.id);
      assert.equal(resumedCalls, 1);
    } else {
      const cancelled = await f.completed(manual.id, "error");
      assert.equal(cancelled.slug, null);
      const persisted = JSON.parse(await readFile(path.join(f.loaded.paths.sessions, `${manual.id}.meta.json`), "utf8")) as { slug: string | null };
      assert.equal(persisted.slug, null);
      assert.equal(resumedCalls, 0, "A cancelled page selection must not call the model again or write to the target");
      assert.deepEqual(await readPages(f.loaded.paths), [page]);
      assert.equal(await f.file(page.slug, "style.css"), CSS);
    }
    const next = await f.create(scripted(
      call("edit_page", { slug: page.slug }),
      (messages) => {
        assert.doesNotMatch(lastOutput(messages), /^错误：/);
        return call("write_file", { path: "style.css", content: "body { color: indigo; }\n" });
      },
      finish(),
    ), "旧执行退出后继续修改");
    assert.equal((await f.completed(next.id)).slug, page.slug);
    const pages = await readPages(f.loaded.paths);
    assert.equal(pages.length, 1);
    assert.equal(pages[0]!.version, page.version + (mode === "complete" ? 2 : 1));
    assert.equal(await f.file(page.slug, "style.css"), "body { color: indigo; }\n");
  });
}

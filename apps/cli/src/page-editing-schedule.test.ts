import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PageEntry } from "@qdd/shared";
import { runWish } from "./agent/agent.js";
import type { ChatFn, ChatMessage } from "./agent/llm.js";
import { loadConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { SessionHub } from "./sessions.js";
import { ensureWorkspace, readPages, upsertPage } from "./web/site.js";
import { openWorkbench } from "./workbench/index.js";
import { Scheduler } from "./workbench/scheduler.js";

function call(name: string, args: object = {}): ChatMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

function lastOutput(messages: ChatMessage[]): string {
  const result = messages.findLast((message) => message.role === "tool");
  assert.ok(result, "The previous tool must provide a result to the model");
  return result.content ?? "";
}

test("page selection cannot redirect a confirmed schedule away from its pending new page", { timeout: 10000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "qdd-page-editing-schedule-"));
  const loaded = await loadConfig(root);
  loaded.config.llm.clarify = "off";
  await ensureWorkspace(loaded.paths);
  const sources = await DataSources.open(loaded);
  t.after(async () => {
    await sources.close();
    await rm(root, { recursive: true, force: true });
  });
  const workbench = await openWorkbench(loaded);
  const hub = new SessionHub(loaded, sources, () => async () => call("reply", { text: "完成" }), workbench);
  const scheduler = new Scheduler(loaded, hub, workbench);
  workbench.scheduler = scheduler;

  const oldHtml = "<!doctype html><html><body>原有页面</body></html>";
  const oldPage: PageEntry = {
    slug: "existing-dashboard",
    title: "原有看板",
    wish: "创建原有看板",
    summary: "原有页面保持不变",
    tools: [],
    useAgent: false,
    metrics: [],
    datasets: {},
    version: 1,
    stale: null,
    gaps: [],
    sessionId: randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await mkdir(path.join(loaded.paths.pages, oldPage.slug), { recursive: true });
  await writeFile(path.join(loaded.paths.pages, oldPage.slug, "index.html"), oldHtml, "utf8");
  await upsertPage(loaded.paths, oldPage);

  let confirmedSlug: string | undefined;
  let approvals = 0;
  let selections = 0;
  let step = 0;
  const newHtml = "<!doctype html><html><body>新的定时看板</body></html>";
  const chat: ChatFn = async (messages) => {
    switch (step++) {
      case 0:
        return call("create_schedule", { name: "刷新新看板", cron: "0 8 * * *", prompt: "刷新这个看板", bindPage: true });
      case 1:
        assert.match(lastOutput(messages), /已确认/);
        assert.ok(confirmedSlug);
        assert.notEqual(confirmedSlug, oldPage.slug);
        assert.deepEqual(await scheduler.list(), [], "The approved schedule must wait for its new page to publish");
        return call("edit_page", { slug: oldPage.slug });
      case 2:
        assert.match(lastOutput(messages), /^错误：/);
        assert.equal(selections, 0, "A rejected switch must not update the session binding");
        return call("list_files");
      case 3:
        assert.deepEqual(JSON.parse(lastOutput(messages)), [], "The agent must retain its pending new-page directory");
        return call("write_file", { path: "index.html", content: newHtml });
      case 4:
        return call("finish", { title: "新的定时看板", summary: "已创建新的看板并设置定时刷新", tools: [], useAgent: false });
      default:
        throw new Error("The agent must complete without extra model calls");
    }
  };
  const result = await runWish(loaded, sources, chat, {
    wish: "创建新的看板并设置定时刷新",
    sessionId: randomUUID(),
    workbench,
  }, {
    onEvent: () => {},
    clarify: async () => null,
    authorize: async (tool, args) => {
      assert.equal(tool.name, "create_schedule");
      approvals++;
      assert.equal(typeof args.page, "string");
      confirmedSlug = args.page as string;
      return true;
    },
    selectPage: async () => { selections++; },
  });

  assert.ok(result.page);
  assert.equal(result.page.slug, confirmedSlug);
  assert.equal(approvals, 1, "Publication must reuse the approval for the original page binding");
  const schedules = await scheduler.list();
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0]!.slug, confirmedSlug);
  const pages = await readPages(loaded.paths);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.find((page) => page.slug === oldPage.slug), oldPage);
  assert.equal(await readFile(path.join(loaded.paths.pages, oldPage.slug, "index.html"), "utf8"), oldHtml);
  assert.equal(await readFile(path.join(loaded.paths.pages, result.page.slug, "index.html"), "utf8"), newHtml);
});

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { loadConfig, type LoadedConfig } from "../config.js";
import { DataSources } from "../datasource/registry.js";
import { ensureWorkspace, readPages } from "../web/site.js";
import { runWish, type WishHooks } from "./agent.js";
import type { ChatFn, ChatMessage } from "./llm.js";
import { systemPrompt, type PromptInput } from "./prompt.js";

type Clarification = "required" | "auto" | "off";

async function fixture(t: TestContext, clarification: Clarification = "required") {
  const root = await mkdtemp(path.join(tmpdir(), "qdd-conversation-prompt-"));
  const base = await loadConfig(root);
  const loaded: LoadedConfig = {
    ...base,
    config: { ...base.config, llm: { ...base.config.llm, maxSteps: 12, clarify: clarification } },
  };
  await ensureWorkspace(loaded.paths);
  const sources = await DataSources.open(loaded, { connectMcp: false });
  t.after(async () => {
    await sources.close();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^qdd-conversation-prompt-/);
    await rm(root, { recursive: true, force: true });
  });
  return { loaded, sources };
}

let nextCall = 0;
function call(name: string, args: object): ChatMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id: `prompt-${nextCall++}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

function script(...responses: ChatMessage[]) {
  const seen: ChatMessage[][] = [];
  const chat: ChatFn = async (messages) => {
    seen.push(structuredClone(messages));
    const response = responses.shift();
    assert.ok(response, "The conversation should finish within the scripted responses");
    return response;
  };
  return { chat, seen };
}

function promptAt(seen: ChatMessage[][], index = 0): string {
  const message = seen[index]?.[0];
  assert.equal(message?.role, "system");
  assert.equal(typeof message?.content, "string");
  return message!.content!;
}

function toolOutputs(messages: ChatMessage[]): string[] {
  return messages.filter((message) => message.role === "tool").map((message) => message.content ?? "");
}

const hooks: WishHooks = { onEvent: () => {}, authorize: async () => false };
const questions = [{
  id: "scope",
  question: "按当前说明制作可以吗？",
  options: [{ label: "就这样（推荐）" }, { label: "需要调整" }],
}];
const writePage = () => call("write_file", { path: "index.html", content: "<p>经营工具</p>" });
const finishPage = () => call("finish", { title: "经营工具", summary: "页面已完成", tools: [], useAgent: false, metrics: [] });

async function existingPage(loaded: LoadedConfig, sources: DataSources) {
  const { chat } = script(writePage(), finishPage());
  const result = await runWish(loaded, sources, chat, { wish: "制作经营工具", sessionId: "existing-page" }, hooks);
  assert.ok(result.page);
  return result.page;
}

test("system prompt defaults to required for new pages, auto for updates and off when unattended", () => {
  const input: PromptInput = {
    slug: "prompt-defaults", style: "", theme: "", cdnAllowlist: [],
    pages: [], updating: undefined, metrics: {}, datasets: [], sessions: [],
  };
  assert.match(systemPrompt(input), /当前提问策略：required/);
  const page = {
    slug: input.slug, title: "工具", wish: "制作工具", summary: "已完成", tools: [], useAgent: false,
    metrics: [], datasets: {}, version: 1, stale: null, gaps: [], sessionId: "default-update",
    createdAt: "2026-10-18T00:00:00.000Z", updatedAt: "2026-10-18T00:00:00.000Z",
  };
  assert.match(systemPrompt({ ...input, updating: page }), /当前提问策略：auto/);
  assert.match(systemPrompt({ ...input, clarification: "required", unattended: true }), /当前提问策略：off/);
});

test("image prompt requires real visual input, camera-by-camera continuation and grounded conclusions", () => {
  const prompt = systemPrompt({
    slug: "image-analysis", style: "", theme: "", cdnAllowlist: [],
    pages: [], updating: undefined, metrics: {}, datasets: [], sessions: [],
  });
  assert.match(prompt, /本地图片使用 Base64 data URL/);
  assert.match(prompt, /网络图片使用模型服务商可访问的 HTTPS URL/);
  assert.match(prompt, /view_image\(\{url\}\)/);
  assert.match(prompt, /所有目标处理完才给最终结论/);
  assert.match(prompt, /截图的同一批工具调用里提前结束/);
  assert.match(prompt, /有 frames 就先分析/);
  assert.match(prompt, /不能用文件大小、在线状态、取流成功推断画面正常/);
  assert.match(prompt, /不自动切换/);
});

test("required prompt matches the new-page write gate and allows publication after clarification", async (t) => {
  const { loaded, sources } = await fixture(t);
  let asked = 0;
  const { chat, seen } = script(writePage(), call("clarify", { questions }), writePage(), finishPage());
  const result = await runWish(loaded, sources, chat, { wish: "制作经营工具", sessionId: "required-page" }, {
    ...hooks,
    clarify: async () => { asked++; return { scope: ["就这样（推荐）"] }; },
  });
  assert.match(promptAt(seen), /当前提问策略：required/);
  assert.match(toolOutputs(result.messages)[0]!, /请先调用 clarify/);
  assert.match(toolOutputs(result.messages)[1]!, /→ 就这样（推荐）/);
  assert.match(toolOutputs(result.messages)[2]!, /已写入草稿/);
  assert.equal(asked, 1);
  assert.ok(result.page);
  assert.equal((await readPages(loaded.paths)).length, 1);
});

test("required mode can answer directly without asking a page confirmation", async (t) => {
  const { loaded, sources } = await fixture(t);
  let asked = 0;
  const { chat, seen } = script(call("reply", { text: "你好，我可以帮你查数据和制作经营工具。" }));
  const result = await runWish(loaded, sources, chat, { wish: "你能做什么", sessionId: "required-reply" }, {
    ...hooks,
    clarify: async () => { asked++; return null; },
  });
  assert.match(promptAt(seen), /当前提问策略：required/);
  assert.equal(asked, 0);
  assert.equal(result.page, undefined);
  assert.deepEqual(await readPages(loaded.paths), []);
});

test("auto mode permits an unambiguous page without forced confirmation", async (t) => {
  const { loaded, sources } = await fixture(t, "auto");
  let asked = 0;
  const { chat, seen } = script(writePage(), finishPage());
  const result = await runWish(loaded, sources, chat, { wish: "按明确说明制作工具", sessionId: "auto-page" }, {
    ...hooks,
    clarify: async () => { asked++; return null; },
  });
  assert.match(promptAt(seen), /当前提问策略：auto/);
  assert.match(toolOutputs(result.messages)[0]!, /已写入草稿/);
  assert.equal(asked, 0);
  assert.ok(result.page);
});

for (const unattended of [false, true]) {
  test(`${unattended ? "unattended execution" : "configured off mode"} disables clarification and permits page work`, async (t) => {
    const { loaded, sources } = await fixture(t, unattended ? "required" : "off");
    let asked = 0;
    const { chat, seen } = script(call("clarify", { questions }), writePage(), finishPage());
    const result = await runWish(loaded, sources, chat, { wish: "制作经营工具", sessionId: `off-${unattended}` }, {
      ...hooks,
      ...(unattended ? {} : { clarify: async () => { asked++; return null; } }),
    });
    assert.match(promptAt(seen), /当前提问策略：off/);
    assert.doesNotMatch(promptAt(seen), /当前提问策略：required/);
    assert.match(toolOutputs(result.messages)[0]!, /提问已关闭或为无人值守/);
    assert.match(toolOutputs(result.messages)[1]!, /已写入草稿/);
    assert.equal(asked, 0);
    assert.ok(result.page);
  });
}

test("continuing the same conversation changes required to auto without another confirmation", async (t) => {
  const { loaded, sources } = await fixture(t);
  let asked = 0;
  const interactive: WishHooks = { ...hooks, clarify: async () => { asked++; return null; } };
  const first = script(call("reply", { text: "已了解工具需求。" }));
  const initial = await runWish(loaded, sources, first.chat, { wish: "制作经营工具", sessionId: "continued-page" }, interactive);
  assert.match(promptAt(first.seen), /当前提问策略：required/);
  const next = script(writePage(), finishPage());
  const result = await runWish(loaded, sources, next.chat, {
    wish: "按刚才的说明直接制作", sessionId: "continued-page", history: initial.messages,
  }, interactive);
  assert.match(promptAt(next.seen), /当前提问策略：auto/);
  assert.match(toolOutputs(result.messages).find((output) => output.includes("草稿"))!, /已写入草稿/);
  assert.equal(asked, 0);
  assert.ok(result.page);
});

test("a bound existing page uses auto and updates without repeated confirmation", async (t) => {
  const { loaded, sources } = await fixture(t);
  const page = await existingPage(loaded, sources);
  let asked = 0;
  const { chat, seen } = script(call("read_file", { path: "index.html" }), writePage(), finishPage());
  const result = await runWish(loaded, sources, chat, {
    wish: "更新页面文案", sessionId: "bound-page", slug: page.slug,
  }, { ...hooks, clarify: async () => { asked++; return null; } });
  assert.match(promptAt(seen), /当前提问策略：auto/);
  assert.match(toolOutputs(result.messages)[1]!, /已写入草稿/);
  assert.equal(asked, 0);
  assert.equal(result.page?.slug, page.slug);
  assert.equal(result.page?.version, page.version + 1);
  assert.equal((await readPages(loaded.paths)).length, 1);
});

test("selecting an existing page refreshes required to auto before editing", async (t) => {
  const { loaded, sources } = await fixture(t);
  const page = await existingPage(loaded, sources);
  let asked = 0;
  const { chat, seen } = script(
    call("edit_page", { slug: page.slug }), call("read_file", { path: "index.html" }), writePage(), finishPage(),
  );
  const result = await runWish(loaded, sources, chat, { wish: "更新已有工具文案", sessionId: "selected-page" }, {
    ...hooks, clarify: async () => { asked++; return null; },
  });
  assert.match(promptAt(seen), /当前提问策略：required/);
  assert.match(promptAt(seen, 1), /当前提问策略：auto/);
  assert.match(toolOutputs(result.messages)[2]!, /已写入草稿/);
  assert.equal(asked, 0);
  assert.equal(result.page?.slug, page.slug);
  assert.equal((await readPages(loaded.paths)).length, 1);
});

test("a prose-only model response is nudged toward reply or finish and can end without a page", async (t) => {
  const { loaded, sources } = await fixture(t);
  const answer = "可先检查现有库存，再按实际销售安排补货。";
  const { chat, seen } = script({ role: "assistant", content: answer }, call("reply", { text: answer }));
  const result = await runWish(loaded, sources, chat, { wish: "给我一句补货建议", sessionId: "prose-reply" }, {
    ...hooks, clarify: async () => { throw new Error("A direct answer should not ask a page confirmation"); },
  });
  assert.equal(seen.length, 2);
  const reminder = seen[1]!.at(-1)!;
  assert.equal(reminder.role, "user");
  assert.match(reminder.content!, /reply/);
  assert.match(reminder.content!, /finish/);
  assert.equal(result.summary, answer);
  assert.equal(result.page, undefined);
  assert.deepEqual(result.files, []);
  assert.deepEqual(await readPages(loaded.paths), []);
  const history = result.messages.flatMap((message) => message.tool_calls ?? []);
  assert.deepEqual(history.map((entry) => entry.function.name), ["reply"]);
  assert.deepEqual(await readdir(loaded.paths.pages), []);
});

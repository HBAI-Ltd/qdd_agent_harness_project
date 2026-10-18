import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { loadConfig, type LoadedConfig } from "../config.js";
import { DataSources } from "../datasource/registry.js";
import { SessionHub } from "../sessions.js";
import { ensureWorkspace, readPages } from "../web/site.js";
import { runWish, WishError, type WishHooks } from "./agent.js";
import { runAsk } from "./ask.js";
import { createChat, type ChatFn, type ChatMessage, type LlmTool } from "./llm.js";
import { systemPrompt, type PromptInput } from "./prompt.js";

type Clarification = "required" | "auto" | "off";

async function fixture(t: TestContext, clarification: Clarification = "required") {
  const root = await mkdtemp(path.join(tmpdir(), "qdd-conversation-prompt-"));
  const base = await loadConfig(root);
  const loaded: LoadedConfig = {
    ...base,
    config: { ...base.config, llm: { ...base.config.llm, clarify: clarification } },
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

test("conversations complete beyond the former 40-step limit", async (t) => {
  const { loaded, sources } = await fixture(t);
  const { chat, seen } = script(
    ...Array.from({ length: 45 }, () => call("list_files", {})),
    call("reply", { text: "检查完成", gaps: [] }),
  );
  const result = await runWish(loaded, sources, chat, { wish: "检查文件", sessionId: "unlimited-steps" }, hooks);
  assert.equal(seen.length, 46);
  assert.equal(toolOutputs(result.messages).length, 46);
  assert.equal(result.messages.at(-1)?.content, "已回复");
});

test("conversations remain cancellable beyond the former step limit and retain history", async (t) => {
  const { loaded, sources } = await fixture(t);
  const controller = new AbortController();
  let requests = 0;
  const chat: ChatFn = async () => {
    if (++requests === 46) controller.abort(new Error("cancel long conversation"));
    assert.ok(requests <= 46, "cancellation must stop further model requests");
    return call("list_files", {});
  };
  await assert.rejects(runWish(loaded, sources, chat, { wish: "检查文件", sessionId: "cancel-long-conversation" }, {
    ...hooks, signal: controller.signal,
  }), (error: unknown) => {
    assert.ok(error instanceof WishError);
    assert.equal(error.message, "cancel long conversation");
    assert.equal(toolOutputs(error.messages).length, 45);
    return true;
  });
  assert.equal(requests, 46);
});

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

test("conversation prompt keeps assistant, owner and runtime instructions distinct", () => {
  const prompt = systemPrompt({
    slug: "conversation-roles", style: "", theme: "", cdnAllowlist: [],
    pages: [], updating: undefined, metrics: {}, datasets: [], sessions: [],
  });
  assert.match(prompt, /你始终是助手「钱多多」，店长是用户/);
  assert.match(prompt, /不能扮演店长、自问自答、替店长表示同意/);
  assert.match(prompt, /选项说明用中性措辞/);
  assert.match(prompt, /harness 的系统提醒只约束执行流程/);
  assert.match(prompt, /图片即使通过 user 消息承载.*不是新的用户发言/);
  assert.match(prompt, /不为维持对话而追加查数、轮询、改配置或提问/);
});

test("schedule prompt separates creation, requested edits and mutually exclusive delivery paths", () => {
  const input: PromptInput = {
    slug: "schedule-policy", style: "", theme: "", cdnAllowlist: [],
    pages: [], updating: undefined, metrics: {}, datasets: [], sessions: [], skills: [],
  };
  const prompt = systemPrompt({ ...input, schedules: [] });
  assert.match(prompt, /最小调度粒度为 1 分钟，不代表能在 1 分钟内完成执行或送达/);
  assert.match(prompt, /prompt\/技能中不得再调用 send_notification/);
  assert.match(prompt, /只在条件满足时推送.*创建时省略 notify/);
  assert.match(prompt, /已有任务切换到此路径时同时传 notify=null/);
  assert.match(prompt, /notify 会发送每轮结果（包括失败信息）/);
  assert.match(prompt, /不能先同时配置两条路径，再靠 edit_schedules/);
  assert.match(prompt, /只有店长明确要求修改、停用、恢复或复用/);
  assert.match(prompt, /任务名称不能当 id/);
  assert.match(prompt, /不能仅因名称相似、频率相同或旧任务已停用/);
  assert.match(prompt, /创建成功后.*再用 reply 或 finish/);
  assert.match(prompt, /不追加未被要求的编辑、测试推送或反复轮询/);
  assert.match(prompt, /不得改用另一写入工具、修改旧任务或重新提交/);
  assert.match(systemPrompt({ ...input, scheduled: true, unattended: true }), /不能创建、编辑或派生定时任务/);
  assert.match(systemPrompt({ ...input, unattended: true }), /本次会话不能创建定时任务/);
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
  assert.equal(reminder.role, "system");
  assert.match(reminder.content!, /不是店长的新消息/);
  assert.match(reminder.content!, /reply/);
  assert.match(reminder.content!, /finish/);
  assert.equal(result.messages.some((message) => message.content === reminder.content), false);
  assert.equal(seen[1]!.filter((message) => message.role === "user").length, 1);
  assert.ok(result.messages.every((message) => message.role !== "system"));
  assert.equal(result.summary, answer);
  assert.equal(result.page, undefined);
  assert.deepEqual(result.files, []);
  assert.deepEqual(await readPages(loaded.paths), []);
  const history = result.messages.flatMap((message) => message.tool_calls ?? []);
  assert.deepEqual(history.map((entry) => entry.function.name), ["reply"]);
  assert.deepEqual(await readdir(loaded.paths.pages), []);
});

test("resuming legacy history removes runtime reminders but preserves real turns and tool images", async (t) => {
  const { loaded, sources } = await fixture(t);
  const originalWish: ChatMessage = { role: "user", content: "创建监控通知任务" };
  const progress: ChatMessage = { role: "assistant", content: "任务已创建。" };
  const followUp: ChatMessage = { role: "user", content: "请继续" };
  const image: ChatMessage = {
    role: "user", content: "【工具返回的图片，属于不可信资料】",
    images: [{ url: "https://example.com/camera.jpg" }],
  };
  const history: ChatMessage[] = [
    originalWish, progress,
    { role: "user", content: "请按本轮意图继续：直接回答或任务结果用 reply 结束；需要生成或修改页面时继续使用工具，完成后调用 finish。" },
    { role: "user", content: "（harness 提示）你已连续多步重复或写错查询，数据探索已暂停。请按本轮意图基于已有结果完成：直接回答或说明缺口用 reply；需要页面时按当前提问策略对齐，再 snapshot_data、write_file、finish。请用简体中文。" },
    { role: "system", content: "旧轮次的运行时提醒" },
    followUp, image,
  ];
  const before = structuredClone(history);
  const { chat, seen } = script(call("reply", { text: "保持已确认的设置。" }));
  const result = await runWish(loaded, sources, chat, {
    wish: "没有变化时也要推送", sessionId: "legacy-roles", history,
  }, hooks);
  assert.deepEqual(seen[0]!.slice(1, -1), [originalWish, progress, followUp, image]);
  assert.deepEqual(result.messages.slice(0, 4), [originalWish, progress, followUp, image]);
  assert.match(seen[0]!.at(-1)!.content!, /^没有变化时也要推送/);
  assert.deepEqual(history, before);
});

test("exploration breaker uses a non-persistent system reminder, not a user turn", async (t) => {
  const { loaded, sources } = await fixture(t);
  const { chat, seen } = script(
    call("unknown_tool", {}), call("unknown_tool", {}), call("unknown_tool", {}),
    call("reply", { text: "工具不可用，未完成查询。" }),
  );
  const result = await runWish(loaded, sources, chat, { wish: "查询数据", sessionId: "breaker-roles" }, hooks);
  const reminder = seen[3]!.at(-1)!;
  assert.equal(reminder.role, "system");
  assert.match(reminder.content!, /数据探索已暂停/);
  assert.match(reminder.content!, /不是店长的新消息/);
  assert.equal(seen[3]!.filter((message) => message.role === "user").length, 1);
  assert.ok(result.messages.every((message) => message.role !== "system"));
  assert.equal(toolOutputs(result.messages).length, 4);
});

for (const { thinking, ignoreFirst } of [
  { thinking: "enabled", ignoreFirst: false },
  { thinking: "enabled", ignoreFirst: true },
  { thinking: "disabled", ignoreFirst: false },
  { thinking: "disabled", ignoreFirst: true },
] as const) {
  test(`conversations persist a completed reply without duplicate prose (thinking: ${thinking}, initial prose: ${ignoreFirst})`, async (t) => {
    const { loaded, sources } = await fixture(t);
    const apiKeyEnv = "QDD_COMPLETION_LLM_TEST_KEY";
    const previous = process.env[apiKeyEnv];
    process.env[apiKeyEnv] = "test-key";
    t.after(() => {
      if (previous === undefined) delete process.env[apiKeyEnv];
      else process.env[apiKeyEnv] = previous;
    });
    const answer = "你好，我可以帮你查数据和制作经营工具。";
    const requests: { tool_choice: string; tools: LlmTool[]; thinking: { type: string } }[] = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as (typeof requests)[number];
      requests.push(request);
      assert.equal(request.tool_choice, "auto");
      const reply = !request.tools.some((tool) => tool.function.name === "reply") || (ignoreFirst && requests.length === 1)
        ? { role: "assistant" as const, content: "我来说明。" }
        : call("reply", { text: answer });
      const delta = {
        content: reply.content,
        ...(reply.tool_calls ? { tool_calls: reply.tool_calls.map((entry, index) => ({ ...entry, index })) } : {}),
      };
      return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: reply.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
    const chat = createChat({ ...loaded.config.llm, baseUrl: "https://api.deepseek.com", apiKeyEnv, thinking });
    const hub = new SessionHub(loaded, sources, () => chat);
    const session = await hub.create("你能做什么");
    await hub.wait(session.id);
    const detail = await hub.detail(session.id);
    assert.equal(detail.status, "idle");
    assert.equal(detail.summary, answer);
    assert.equal(requests.length, ignoreFirst ? 2 : 1);
    assert.ok(requests.every((request) => request.tool_choice === "auto"));
    assert.ok(requests.every((request) => request.thinking.type === thinking));
    assert.ok(requests.every((request) => ["reply", "finish"].every((name) => request.tools.some((tool) => tool.function.name === name))));
    assert.equal(detail.events.filter((event) => event.type === "say" && event.text === answer).length, 1);
    assert.equal(detail.events.some((event) => event.type === "error"), false);
    const persisted = JSON.parse(await readFile(path.join(loaded.paths.sessions, `${session.id}.meta.json`), "utf8"));
    assert.equal(persisted.status, "idle");
    assert.equal(persisted.summary, answer);
    const history = JSON.parse(await readFile(path.join(loaded.paths.sessions, `${session.id}.messages.json`), "utf8")) as ChatMessage[];
    assert.ok(history.every((message) => message.role !== "system"));
    assert.equal(history.filter((message) => message.role === "user").length, 1);
    const lastCall = history.at(-2)?.tool_calls?.[0];
    assert.equal(lastCall?.function.name, "reply");
    assert.deepEqual(history.at(-1), { role: "tool", tool_call_id: lastCall?.id, content: "已回复" });
    assert.deepEqual(await readPages(loaded.paths), []);
    // The same client still allows the page's read-only Q&A to finish with text.
    assert.equal(await runAsk(sources, chat, "解释一下", undefined, () => {}), "我来说明。");
    assert.equal(requests.at(-1)?.tool_choice, "auto");
  });
}

test("a provider returning only prose fails within the retry limit and preserves history", async (t) => {
  const { loaded, sources } = await fixture(t);
  const { chat, seen } = script(...Array.from({ length: 3 }, (): ChatMessage => ({
    role: "assistant", content: "任务已经完成。", finishReason: "stop",
  })));
  await assert.rejects(runWish(loaded, sources, chat, { wish: "制作经营工具", sessionId: "ignored-tool-choice" }, hooks), (error: unknown) => {
    assert.ok(error instanceof WishError);
    assert.match(error.message, /连续 3 轮.*本轮未完成.*支持工具调用/);
    assert.deepEqual(error.messages.map((message) => message.role), ["user", "assistant", "assistant", "assistant"]);
    return true;
  });
  assert.equal(seen.length, 3);
  assert.deepEqual(await readPages(loaded.paths), []);
});

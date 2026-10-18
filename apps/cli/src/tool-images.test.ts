import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { AskImage } from "@qdd/shared";
import { runWish, WishError, type AgentEvent } from "./agent/agent.js";
import { runAsk } from "./agent/ask.js";
import { MAX_ASK_IMAGE_BYTES } from "./agent/ask-images.js";
import { createChat, type ChatFn, type ChatMessage, type ToolCall } from "./agent/llm.js";
import { AttachmentStore } from "./attachments.js";
import { loadConfig, type LoadedConfig } from "./config.js";
import { McpClient } from "./datasource/mcp-client.js";
import { DataSources, type DataTool } from "./datasource/registry.js";
import { SessionHub } from "./sessions.js";
import { contentImages, toolImages } from "./tool-images.js";
import { ensureWorkspace } from "./web/site.js";
import { openWorkbench } from "./workbench/index.js";

const PNG_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1X8AAAAASUVORK5CYII=";
const PNG = `data:image/png;base64,${PNG_DATA}`;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
const REMOTE = "https://images.example.test/frame.jpg?signature=fixture";
const JOB = "a".repeat(32);
const MCP_URL = "https://mcp.example.test/mcp";
const MODEL_URL = "https://model.example.test/v1";
const hooks = { onEvent: () => {}, authorize: async () => true };

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "qdd-tool-images-"));
  const loaded = await loadConfig(root);
  loaded.config.llm.clarify = "off";
  await ensureWorkspace(loaded.paths);
  const sources = await DataSources.open(loaded, { connectMcp: false });
  t.after(async () => {
    await sources.close();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^qdd-tool-images-/);
    await rm(root, { recursive: true, force: true });
  });
  return { loaded, sources };
}

async function frame(loaded: LoadedConfig, sequence = 1) {
  const imageRoot = path.join(loaded.paths.root, "mcp", ".local", "haik-captures");
  const file = path.join(imageRoot, JOB, `frame_${String(sequence).padStart(6, "0")}.jpg`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JPEG);
  return {
    imageRoot,
    file,
    result: { job: { cameraId: "camera-fixture", cameraName: "fixture", frames: [{ path: file, url: `http://127.0.0.1:8787/captures/${JOB}/${path.basename(file)}` }] } },
  };
}

function call(name: string, args: object = {}): ToolCall {
  return { id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function calls(...tool_calls: ToolCall[]): ChatMessage {
  return { role: "assistant", content: null, reasoning_content: "tool reasoning", finishReason: "tool_calls", tool_calls };
}

function reply(): ChatMessage {
  return calls(call("reply", { text: "已根据实际图片完成分析。" }));
}

function addTool(sources: DataSources, run: DataTool["call"], imageRoot?: string): DataTool {
  const tool: DataTool = {
    name: `mcp__fixture__capture_${sources.tools.length}`, description: "image fixture",
    source: "mcp:fixture", inputSchema: { type: "object" }, mutating: false, preauthorized: false,
    call: run, ...(imageRoot ? { imageRoot } : {}),
  };
  sources.tools.push(tool);
  return tool;
}

function scripted(...steps: (ChatMessage | ((messages: ChatMessage[]) => ChatMessage))[]): ChatFn {
  return async (messages) => {
    const step = steps.shift();
    assert.ok(step, "No extra model calls should be needed");
    return typeof step === "function" ? step(messages) : step;
  };
}

test("local captures are Base64, network captures remain URLs, arbitrary tool paths are ignored", async (t) => {
  const { loaded } = await fixture(t);
  const capture = await frame(loaded);
  t.mock.method(globalThis, "fetch", () => { throw new Error("Images must not be downloaded"); });
  assert.deepEqual(await toolImages(capture.result, [], capture.imageRoot), [{ url: `data:image/jpeg;base64,${JPEG.toString("base64")}` }]);
  assert.deepEqual(await toolImages({ job: { frames: [{ path: "C:\\remote-host\\frame.jpg", url: REMOTE }] } }), [{ url: REMOTE }]);
  assert.deepEqual(await toolImages({ path: capture.file, credentials: { path: capture.file } }), []);
  assert.deepEqual(await toolImages(undefined, contentImages([{ type: "text", text: "metadata" }, { type: "image", mimeType: "image/png", data: PNG_DATA }])), [{ url: PNG }]);
});

test("image reads reject traversal, missing files, unsafe URLs and symlink escapes", async (t) => {
  const { loaded } = await fixture(t);
  const capture = await frame(loaded);
  await assert.rejects(toolImages(capture.result), /已授权/);
  await assert.rejects(toolImages({ frames: [{ path: path.join(loaded.paths.root, "frame.jpg") }] }, [], capture.imageRoot), /已授权/);
  await assert.rejects(toolImages({ frames: [{ path: path.join(capture.imageRoot, JOB, "frame_999999.jpg") }] }, [], capture.imageRoot), /ENOENT/);
  for (const url of ["http://remote.example.test/a.jpg", "file:///C:/secret.png", "https://user:pass@example.test/a.jpg", "https://127.0.0.1/a.jpg"]) {
    await assert.rejects(toolImages({ frames: [{ url }] }), /图片|HTTPS/);
  }
  const outside = path.join(loaded.paths.root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "frame_000001.jpg"), JPEG);
  const linked = path.join(capture.imageRoot, "b".repeat(32));
  await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(toolImages({ frames: [{ path: path.join(linked, "frame_000001.jpg") }] }, [], capture.imageRoot), /符号链接/);
});

test("image count, byte limits, MIME and cancellation are enforced without truncating Base64", async (t) => {
  const { loaded } = await fixture(t);
  const capture = await frame(loaded);
  const bytes = Buffer.alloc(MAX_ASK_IMAGE_BYTES, 1);
  JPEG.copy(bytes);
  await writeFile(capture.file, bytes);
  const accepted = await toolImages(capture.result, [], capture.imageRoot);
  assert.equal(Buffer.from(accepted[0]!.url.split(",")[1]!, "base64").length, MAX_ASK_IMAGE_BYTES);
  await writeFile(capture.file, Buffer.concat([bytes, Buffer.from([1])]));
  await assert.rejects(toolImages(capture.result, [], capture.imageRoot), /5 MiB/);
  assert.equal((await toolImages(undefined, Array.from({ length: 4 }, () => ({ url: PNG })))).length, 4);
  await assert.rejects(toolImages(undefined, Array.from({ length: 5 }, () => ({ url: PNG }))), /offset.*limit/);
  await assert.rejects(toolImages(undefined, [{ url: "data:image/jpeg;base64," + PNG_DATA }]), /类型不匹配/);
  assert.throws(() => contentImages([{ type: "image", data: PNG_DATA }]), /mimeType/);
  const reason = new Error("cancel image read");
  await assert.rejects(toolImages(capture.result, [], capture.imageRoot, AbortSignal.abort(reason)), (error) => error === reason);
});

test("MCP image blocks survive alongside structured data and text without changing ordinary tool results", async (t) => {
  let result: object = { structuredContent: { device: "fixture" }, content: [{ type: "image", mimeType: "image/png", data: PNG_DATA }] };
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { id: number };
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
  const client = new McpClient("fixture", { url: MCP_URL });
  const images: AskImage[] = [];
  assert.deepEqual(await client.callTool("snapshot", {}, (value) => images.push(...value)), { device: "fixture" });
  assert.deepEqual(images, [{ url: PNG }]);
  assert.deepEqual(await client.callTool("snapshot", {}), { device: "fixture" });
  result = { content: [{ type: "text", text: '{"device":"text"}' }, { type: "image", mimeType: "image/png", data: PNG_DATA }] };
  assert.deepEqual(await client.callTool("snapshot", {}, (value) => images.push(...value)), { device: "text" });
  assert.equal(images.length, 2);
  result = { isError: true, content: [{ type: "text", text: "capture failed" }, { type: "image", mimeType: "image/png", data: PNG_DATA }] };
  await assert.rejects(client.callTool("snapshot", {}, (value) => images.push(...value)), /capture failed/);
  assert.equal(images.length, 2);
});

test("registered camera tools retain image callbacks, capture roots and page restriction boundaries", async (t) => {
  const { loaded, sources } = await fixture(t);
  const capture = await frame(loaded);
  loaded.config.mcpServers = { haik: { url: MCP_URL } };
  await mkdir(path.dirname(loaded.paths.connectors), { recursive: true });
  await writeFile(loaded.paths.connectors, JSON.stringify({ connectors: [{ id: "mcp:haik", type: "camera", mode: "mcp", provider: "haik", permission: "confirm" }] }));
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { id?: number; method: string };
    if (request.id === undefined) return new Response(null, { status: 202 });
    const result = request.method === "tools/list"
      ? { tools: [{ name: "view_frame", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] }
      : request.method === "tools/call"
        ? { structuredContent: capture.result, content: [{ type: "image", mimeType: "image/png", data: PNG_DATA }] }
        : {};
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
  await sources.reloadMcp(loaded);
  assert.deepEqual(sources.warnings, []);
  const name = "mcp__haik__view_frame";
  const scoped = sources.restricted([name]);
  assert.equal(scoped.get(name)?.imageRoot, capture.imageRoot);
  const images: AskImage[] = [];
  const result = await scoped.call(name, {}, async () => { throw new Error("Read-only call should not request write access"); }, (value) => images.push(...value));
  assert.deepEqual(result, capture.result);
  assert.deepEqual(images, [{ url: PNG }]);
  assert.equal((await toolImages(result, images, scoped.get(name)?.imageRoot)).length, 2);
  await assert.rejects(sources.restricted([]).call(name, {}, async () => true), /未知数据工具/);
});

test("six camera captures reach the provider after every tool reply, then continue tools and finish", async (t) => {
  const { loaded, sources } = await fixture(t);
  const capture = await frame(loaded);
  const client = new McpClient("fixture", { url: MCP_URL });
  const tool = addTool(sources, (args, images) => client.callTool("snapshot", args, images), capture.imageRoot);
  const apiKeyEnv = "QDD_TOOL_IMAGES_TEST_KEY";
  const previous = process.env[apiKeyEnv];
  process.env[apiKeyEnv] = "fixture-key";
  t.after(() => {
    if (previous === undefined) delete process.env[apiKeyEnv];
    else process.env[apiKeyEnv] = previous;
  });
  const first = Array.from({ length: 6 }, (_, camera) => call(tool.name, { camera }));
  const second = call(tool.name, { camera: "follow-up" });
  let modelCalls = 0;
  let captures = 0;
  const seen: Record<string, unknown>[][] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url === MCP_URL) {
      captures++;
      const result = body.params.arguments.camera === 1
        ? { structuredContent: { job: { frames: [{ url: REMOTE }] } } }
        : body.params.arguments.camera === 2
          ? { structuredContent: { camera: "inline" }, content: [{ type: "image", mimeType: "image/png", data: PNG_DATA }] }
          : { structuredContent: { job: { ...capture.result.job, cameraId: String(body.params.arguments.camera) } } };
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    }
    assert.equal(url, MODEL_URL + "/chat/completions");
    assert.equal(body.model, "configured-vision");
    seen.push(body.messages);
    const output = modelCalls++ === 0 ? first : modelCalls === 2 ? [second] : reply().tool_calls!;
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "reasoning", tool_calls: output.map((value, index) => ({ ...value, index })) }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
  });
  const events: AgentEvent[] = [];
  const result = await runWish(loaded, sources, createChat({ ...loaded.config.llm, apiKeyEnv, baseUrl: MODEL_URL, model: "configured-vision" }),
    { wish: "逐台查看所有摄像头画面并分析", sessionId: "six-cameras" }, { ...hooks, onEvent: (event) => events.push(event) });
  assert.equal(modelCalls, 3);
  assert.equal(captures, 7);
  assert.equal(result.summary, "已根据实际图片完成分析。");
  const next = seen[1]!;
  assert.deepEqual(next.slice(3, 9).map((message) => [message.role, message.tool_call_id]), first.map((value) => ["tool", value.id]));
  assert.equal(next[2]!.reasoning_content, "reasoning");
  assert.ok(next.every((message) => !("finishReason" in message)));
  const imageMessages = next.slice(9);
  assert.equal(imageMessages.length, 6);
  for (const [index, message] of imageMessages.entries()) {
    assert.equal(message.role, "user");
    const content = message.content as { type: string; text?: string; image_url?: AskImage }[];
    assert.match(content[0]!.text!, new RegExp(first[index]!.id));
    assert.equal(content[1]!.type, "image_url");
    assert.equal(content[1]!.image_url?.url, index === 1 ? REMOTE : index === 2 ? PNG : `data:image/jpeg;base64,${JPEG.toString("base64")}`);
  }
  assert.ok(!JSON.stringify(events).includes("base64"));
  assert.equal(result.messages.filter((message) => message.images?.length).length, 7);
});

for (const replyFirst of [false, true]) test(`browser screenshots become image input and an early reply waits for the next model turn (reply first: ${replyFirst})`, async (t) => {
  const { loaded, sources } = await fixture(t);
  loaded.config.browser.enabled = true;
  const workbench = await openWorkbench(loaded);
  assert.ok(workbench.browser);
  t.mock.method(workbench.browser, "execute", async () => ({
    details: {},
    content: [{ type: "text" as const, text: "browser metadata" }, { type: "image" as const, mimeType: "image/jpeg" as const, data: JPEG.toString("base64") }],
  }));
  const capture = call("browser", { action: "screenshot" });
  const early = reply().tool_calls![0]!;
  const chat = scripted(calls(...(replyFirst ? [early, capture] : [capture, early])), (messages) => {
    assert.equal(messages.at(-1)?.images?.[0]?.url, `data:image/jpeg;base64,${JPEG.toString("base64")}`);
    assert.match(messages.find((message) => message.tool_call_id === early.id)?.content ?? "", /下一轮查看图片/);
    assert.ok(!JSON.stringify(messages).includes("你无法查看图片"));
    return reply();
  });
  const result = await runWish(loaded, sources, chat, { wish: "查看截图并分析", sessionId: "browser", workbench }, hooks);
  assert.equal(result.summary, "已根据实际图片完成分析。");
});

test("view_image turns a network link into actual image input without downloading it", async (t) => {
  const { loaded, sources } = await fixture(t);
  t.mock.method(globalThis, "fetch", () => { throw new Error("Remote images are fetched only by the provider"); });
  await runWish(loaded, sources, scripted(
    calls(call("view_image", { url: "file:///C:/private.jpg" })),
    (messages) => {
      assert.match(messages.at(-1)?.content ?? "", /错误：.*HTTPS/);
      return calls(call("view_image", { url: REMOTE }));
    },
    (messages) => {
      assert.deepEqual(messages.at(-1)?.images, [{ url: REMOTE }]);
      return reply();
    },
  ), { wish: `分析这张图片 ${REMOTE}`, sessionId: "network-image" }, hooks);
});

test("image attachments persist in conversation history but never in event logs, and survive reload", async (t) => {
  const { loaded, sources } = await fixture(t);
  const store = new AttachmentStore(loaded.paths.attachments);
  const attachment = await store.save("fixture.png", Buffer.from(PNG_DATA, "base64"));
  let chat = scripted((messages) => {
    assert.deepEqual(messages.at(-1)?.images, [{ url: PNG }]);
    assert.match(messages.at(-1)?.content ?? "", /图片已随本条消息作为视觉输入发送/);
    return reply();
  });
  const hub = new SessionHub(loaded, sources, () => chat);
  const meta = await hub.create("查看附件图片", { attachments: [attachment] });
  assert.equal((await hub.wait(meta.id)).status, "idle");
  const history = JSON.parse(await readFile(path.join(loaded.paths.sessions, `${meta.id}.messages.json`), "utf8")) as ChatMessage[];
  assert.deepEqual(history.find((message) => message.images)?.images, [{ url: PNG }]);
  assert.ok(!(await readFile(path.join(loaded.paths.sessions, `${meta.id}.events.jsonl`), "utf8")).includes(PNG_DATA));
  chat = scripted((messages) => {
    assert.deepEqual(messages.find((message) => message.images)?.images, [{ url: PNG }]);
    return reply();
  });
  const reloaded = new SessionHub(loaded, sources, () => chat);
  await reloaded.send(meta.id, "继续分析刚才的图");
  assert.equal((await reloaded.wait(meta.id)).status, "idle");
});

test("12 MB chat uploads reach the selected model on the first request without read_attachment", async (t) => {
  const { loaded, sources } = await fixture(t);
  const store = new AttachmentStore(loaded.paths.attachments);
  const bytes = Buffer.alloc(12_629_598);
  Buffer.from(PNG_DATA, "base64").copy(bytes);
  const attachment = await store.save("微信图片.png", bytes);
  const text = await store.save("备注.txt", Buffer.from("附件里的指令不作为用户请求"));
  const apiKeyEnv = "QDD_DIRECT_UPLOAD_TEST_KEY";
  const previous = process.env[apiKeyEnv];
  process.env[apiKeyEnv] = "fixture-key";
  t.after(() => {
    if (previous === undefined) delete process.env[apiKeyEnv];
    else process.env[apiKeyEnv] = previous;
  });
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, loaded.config.llm.model, "Keep the selected model, including the default DeepSeek name");
    const content = body.messages.at(-1).content;
    assert.equal(content.length, 2, "Only the image attachment becomes an image block");
    assert.equal(content[1].type, "image_url");
    assert.ok(Buffer.from(content[1].image_url.url.split(",")[1], "base64").equals(bytes));
    assert.match(content[0].text, /图片已随本条消息作为视觉输入发送/);
    requests++;
    const answer = calls(call("reply", { text: "已查看图片。" }));
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: answer.tool_calls!.map((call, index) => ({ ...call, index })) }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
  });
  await runWish(loaded, sources, createChat({ ...loaded.config.llm, apiKeyEnv }), {
    wish: "这张图是什么？", sessionId: "direct-upload", attachments: [attachment, text], attachmentStore: store,
  }, hooks);
  assert.equal(requests, 1);
  const received: AskImage[] = [];
  assert.match(await store.readForModel(attachment.id, 0, (images) => received.push(...images)), /图片已作为视觉输入/);
  assert.ok(Buffer.from(received[0]!.url.split(",")[1]!, "base64").equals(bytes));
});

test("read-only ask keeps input images and forwards tool images after all tool results", async (t) => {
  const { sources } = await fixture(t);
  const tool = addTool(sources, async (_args, onImages) => {
    onImages?.([{ url: PNG }]);
    return { device: "fixture" };
  });
  const first = call(tool.name);
  const second = call(tool.name, { view: "other" });
  const answer = await runAsk(sources, scripted(calls(first, second), (messages) => {
    assert.deepEqual(messages[1]?.images, [{ url: REMOTE }]);
    assert.deepEqual(messages.slice(3, 5).map((message) => message.tool_call_id), [first.id, second.id]);
    assert.deepEqual(messages.slice(5).map((message) => message.images), [[{ url: PNG }], [{ url: PNG }]]);
    return { role: "assistant", content: "已看图回答" };
  }), "分析画面", undefined, () => {}, undefined, [{ url: REMOTE }]);
  assert.equal(answer, "已看图回答");
});

test("different image-only tool results are not mistaken for identical empty text results", async (t) => {
  const { loaded, sources } = await fixture(t);
  const tool = addTool(sources, async (args, onImages) => {
    onImages?.([{ url: `https://images.example.test/${String(args.frame)}.png` }]);
    return "";
  });
  await runWish(loaded, sources, scripted(
    calls(...Array.from({ length: 3 }, (_, frame) => call(tool.name, { frame }))),
    (messages) => {
      assert.equal(messages.filter((message) => message.images?.length).length, 3);
      assert.ok(messages.filter((message) => message.role === "tool").every((message) => !message.content?.startsWith("重复调用")));
      return reply();
    },
  ), { wish: "分析不同画面", sessionId: "image-only" }, hooks);
});

test("image read failures become explicit tool errors and do not stop other captures", async (t) => {
  const { loaded, sources } = await fixture(t);
  const failed = addTool(sources, async () => ({ frames: [{ path: "C:\\outside\\missing.jpg" }] }));
  const good = addTool(sources, async () => ({ frames: [{ url: REMOTE }] }));
  const events: AgentEvent[] = [];
  await runWish(loaded, sources, scripted(calls(call(failed.name), call(good.name)), (messages) => {
    const outputs = messages.filter((message) => message.role === "tool");
    assert.match(outputs[0]?.content ?? "", /错误：.*已授权/);
    assert.deepEqual(messages.at(-1)?.images, [{ url: REMOTE }]);
    return reply();
  }), { wish: "检查两路画面", sessionId: "partial-failure" }, { ...hooks, onEvent: (event) => events.push(event) });
  assert.ok(events.some((event) => event.kind === "warn"));
});

test("cancelling a batch preserves delivered images after completed and cancelled tool replies", async (t) => {
  const { loaded, sources } = await fixture(t);
  const controller = new AbortController();
  const first = addTool(sources, async () => ({ frames: [{ url: REMOTE }] }));
  const last = addTool(sources, async () => { controller.abort(new Error("cancel batch")); return {}; });
  const capture = call(first.name);
  const cancelled = call(last.name);
  await assert.rejects(runWish(loaded, sources, scripted(calls(capture, cancelled)), { wish: "检查画面", sessionId: "cancelled" }, { ...hooks, signal: controller.signal }), (error) => {
    assert.ok(error instanceof WishError);
    assert.deepEqual(error.messages.slice(-3).map((message) => message.role), ["tool", "tool", "user"]);
    assert.deepEqual(error.messages.at(-1)?.images, [{ url: REMOTE }]);
    assert.equal(error.messages.at(-2)?.tool_call_id, cancelled.id);
    return true;
  });
});

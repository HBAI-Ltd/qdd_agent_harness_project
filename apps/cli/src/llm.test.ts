import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createChat, parseToolArguments, type ChatMessage, type ToolCall } from "./agent/llm.js";
import { DEFAULT_CONFIG } from "./config.js";

const toolCall = (args: string): ToolCall => ({
  id: "write-1",
  type: "function",
  function: { name: "write_file", arguments: args },
});
const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const delta = (args: string) => event({
  choices: [{ delta: { tool_calls: [{ index: 0, id: "write-1", function: { name: "write_file", arguments: args } }] } }],
});
const finish = (reason: string) => event({ choices: [{ delta: {}, finish_reason: reason }] });

function mockChat(t: TestContext, response: () => Response) {
  const apiKeyEnv = "QDD_LLM_STREAM_TEST_KEY";
  const previous = process.env[apiKeyEnv];
  process.env[apiKeyEnv] = "test-key";
  t.after(() => {
    if (previous === undefined) delete process.env[apiKeyEnv];
    else process.env[apiKeyEnv] = previous;
  });
  const requests: { messages: ChatMessage[] }[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)) as { messages: ChatMessage[] });
    return response();
  });
  return { chat: createChat({ ...DEFAULT_CONFIG.llm, apiKeyEnv }), requests };
}

test("long tool arguments survive SSE, CRLF and UTF-8 chunk boundaries exactly", async (t) => {
  const args = { path: "index.html", content: '<p title="中文">line\\path\n内容</p>'.repeat(1400) };
  const json = JSON.stringify(args);
  assert.ok(json.length > 24436);
  let wire = delta(json.slice(0, 100));
  for (let i = 100; i < json.length; i += 701) {
    wire += event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: json.slice(i, i + 701) } }] } }] });
  }
  wire += finish("tool_calls") + "data: [DONE]\r\n\r\n";
  const bytes = new TextEncoder().encode(wire);
  const { chat } = mockChat(t, () => {
    let offset = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) return controller.close();
        // One-byte chunks also split CRLF and multibyte characters.
        controller.enqueue(bytes.subarray(offset, ++offset));
      },
    }));
  });
  const reply = await chat([], []);
  assert.equal(reply.finishReason, "tool_calls");
  assert.equal(reply.tool_calls?.[0]?.function.arguments, json);
  assert.deepEqual(parseToolArguments(reply.tool_calls![0]!, reply), args);
});

test("length finish reason blocks even syntactically valid calls and stays off the wire", async (t) => {
  let count = 0;
  const { chat, requests } = mockChat(t, () => new Response(++count === 1
    ? delta('{"path":"index.html","content":"partial"}') + finish("length") + "data: [DONE]\n\n"
    : event({ choices: [{ delta: { content: "ok" } }] }) + "data: [DONE]\n\n"));
  const reply = await chat([], []);
  assert.throws(() => parseToolArguments(reply.tool_calls![0]!, reply), /finish_reason=length.*分多轮/);
  await chat([reply, { role: "tool", tool_call_id: "write-1", content: "not executed" }], []);
  assert.equal(Object.hasOwn(requests[1]!.messages[0]!, "finishReason"), false);
  assert.deepEqual(requests[1]!.messages[0]!.tool_calls, reply.tool_calls);
});

test("legacy empty assistant messages are omitted without changing valid tool history", async (t) => {
  const { chat, requests } = mockChat(t, () => new Response(
    event({ choices: [{ delta: { content: "已恢复" } }] }) + finish("stop"),
  ));
  const messages: ChatMessage[] = [
    { role: "system", content: "instructions" },
    { role: "user", content: "继续" },
    { role: "assistant", content: null, reasoning_content: "thinking", tool_calls: [toolCall("{}")], finishReason: "tool_calls" },
    { role: "tool", tool_call_id: "write-1", content: "已完成" },
    { role: "assistant", content: null, reasoning_content: "thinking only" },
    { role: "assistant", content: "", tool_calls: [] },
    { role: "assistant", content: " \n", reasoning_content: "thinking only" },
    { role: "assistant", content: "有效正文", reasoning_content: "thinking", finishReason: "stop" },
    { role: "user", content: "请继续完成" },
  ];
  const original = structuredClone(messages);
  assert.equal((await chat(messages, [])).content, "已恢复");
  assert.deepEqual(requests[0]!.messages, [
    messages[0], messages[1],
    { role: "assistant", content: null, reasoning_content: "thinking", tool_calls: [toolCall("{}")] },
    messages[3],
    { role: "assistant", content: "有效正文", reasoning_content: "thinking" },
    messages[8],
  ]);
  assert.deepEqual(messages, original);
});

for (const ending of [finish("stop"), "data: [DONE]\n\n"]) {
  test(`reasoning-only responses are rejected before entering history: ${ending.trim()}`, async (t) => {
    const { chat } = mockChat(t, () => new Response(
      event({ choices: [{ delta: { reasoning_content: "思考中", content: " \n" } }] }) + ending,
    ));
    await assert.rejects(chat([], []), /仅返回思考内容.*未返回正文或工具调用/);
  });
}

test("reasoning-only truncation retains the token limit diagnosis", async (t) => {
  const { chat } = mockChat(t, () => new Response(
    event({ choices: [{ delta: { reasoning_content: "思考中" } }] }) + finish("length"),
  ));
  await assert.rejects(chat([], []), /finish_reason=length/);
});

test("reasoning accompanying a tool call remains valid without text", async (t) => {
  const { chat } = mockChat(t, () => new Response(
    event({ choices: [{ delta: { reasoning_content: "思考中" } }] }) + delta("{}") + finish("tool_calls"),
  ));
  const reply = await chat([], []);
  assert.equal(reply.content, null);
  assert.equal(reply.reasoning_content, "思考中");
  assert.deepEqual(parseToolArguments(reply.tool_calls![0]!, reply), {});
});

test("truncated arguments report the token limit rather than a JSON syntax error", async (t) => {
  const { chat } = mockChat(t, () => new Response(delta('{"path":"index.html","content":"' + "x".repeat(24436)) + finish("length")));
  const reply = await chat([], []);
  assert.throws(() => parseToolArguments(reply.tool_calls![0]!, reply), /finish_reason=length/);
});

for (const reason of ["length", "content_filter"]) {
  test(`incomplete text is not returned as a successful answer: ${reason}`, async (t) => {
    const { chat } = mockChat(t, () => new Response(event({ choices: [{ delta: { content: "partial" } }] }) + finish(reason)));
    await assert.rejects(chat([], []), new RegExp(`finish_reason=${reason}`));
  });
}

test("EOF without any completion marker rejects even complete-looking arguments", async (t) => {
  const { chat } = mockChat(t, () => new Response(delta('{"path":"index.html","content":"partial"}')));
  await assert.rejects(chat([], []), /响应流提前结束/);
});

test("DONE completes the response without waiting for the server to close", { timeout: 2000 }, async (t) => {
  let cancelled = false;
  const { chat } = mockChat(t, () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(delta("{}") + "data: [DONE]\n\n"));
    },
    cancel() { cancelled = true; },
  })));
  const reply = await chat([], []);
  assert.deepEqual(parseToolArguments(reply.tool_calls![0]!, reply), {});
  assert.equal(cancelled, true);
});

test("invalid JSON is never repaired and gives actionable file-splitting guidance", () => {
  const reply: ChatMessage = { role: "assistant", content: null };
  assert.throws(() => parseToolArguments(toolCall('{"content":"unterminated'), reply), /JSON.*工具未执行.*拆成较小文件/);
  for (const value of ["null", "[]", "true", "42", '"text"']) {
    assert.throws(() => parseToolArguments(toolCall(value), reply), /必须是 JSON 对象/);
  }
  assert.deepEqual(parseToolArguments(toolCall(""), reply), {});
  assert.deepEqual(parseToolArguments(toolCall("{}"), reply), {});
});

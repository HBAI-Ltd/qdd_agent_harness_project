import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createChat } from "./agent/llm.js";
import { DEFAULT_CONFIG } from "./config.js";

function client(t: TestContext) {
  const apiKeyEnv = "QDD_ADVERSARIAL_LLM_KEY";
  const previous = process.env[apiKeyEnv];
  process.env[apiKeyEnv] = "local-test-key";
  t.after(() => {
    if (previous === undefined) delete process.env[apiKeyEnv];
    else process.env[apiKeyEnv] = previous;
  });
  return createChat({ ...DEFAULT_CONFIG.llm, apiKeyEnv });
}

function response(index: unknown) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: {
    content: "answer",
    tool_calls: [{ index, id: "call-1", function: { name: "read", arguments: "{}" } }],
  } }] })}\n\ndata: [DONE]\n\n`);
}

for (const index of [-1, 0.5, "0", null]) {
  test(`malformed tool index is rejected without silently dropping a call: ${JSON.stringify(index)}`, async (t) => {
    const chat = client(t);
    t.mock.method(globalThis, "fetch", async () => response(index));
    await assert.rejects(chat([], []), /工具调用.*index/);
  });
}

test("a sparse large tool index cannot allocate or scan a huge array", { timeout: 2000 }, async (t) => {
  const chat = client(t);
  t.mock.method(globalThis, "fetch", async () => response(4_294_967_294));
  const reply = await chat([], []);
  assert.equal(reply.tool_calls?.length, 1);
  assert.equal(reply.tool_calls[0]!.id, "call-1");
});

test("an already cancelled request never reaches the model", async (t) => {
  const chat = client(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => response(0));
  const reason = new Error("cancelled before request");
  await assert.rejects(chat([], [], AbortSignal.abort(reason)), (error) => error === reason);
  assert.equal(fetch.mock.callCount(), 0);
});

test("cancelling after a retryable response closes its body and skips backoff", async (t) => {
  const chat = client(t);
  const controller = new AbortController();
  const reason = new Error("stop retrying");
  let cancelled = false;
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    if (controller.signal.aborted) throw reason;
    controller.abort(reason);
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 429 });
  });
  const started = performance.now();
  await assert.rejects(chat([], [], controller.signal), (error) => error === reason || (error as Error).cause === reason);
  assert.equal(cancelled, true, "Retry responses must release their connection");
  assert.equal(fetch.mock.callCount(), 1);
  assert.ok(performance.now() - started < 500, "Cancellation must not wait for retry backoff");
});

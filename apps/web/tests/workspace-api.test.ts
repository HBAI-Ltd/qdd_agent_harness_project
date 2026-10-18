import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  GatewayError,
  answerQuestions,
  cancelSession,
  createWish,
  downloadChatImage,
  gatewayEvents,
  getSession,
  getStyle,
  listPages,
  listSessions,
  resetStyle,
  resolveApproval,
  saveStyle,
  sendMessage,
  setPagePinned,
  sessionEvents,
} from "../src/api/workspace.ts";

const originalFetch = globalThis.fetch;
const base = "http://127.0.0.1:5173";
const token = "gateway-test-token";
const session = {
  id: "session-1",
  title: "销售看板",
  summary: "",
  slug: null,
  status: "running",
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:00:00.000Z",
};

afterEach(() => { globalThis.fetch = originalFetch; });

function stubResponse(payload: unknown, status = 200, contentType = "application/json") {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(contentType === "application/json" ? JSON.stringify(payload) : String(payload), {
      status,
      headers: { "Content-Type": contentType },
    });
  };
  return calls;
}

test("reads real session/page endpoints with Bearer auth and caller cancellation", async () => {
  const requestSignal = new AbortController().signal;
  const calls = stubResponse([session]);
  assert.deepEqual(await listSessions(base + "/", "  " + token + "  ", requestSignal), [session]);
  await getSession(base, token, "session/中文", requestSignal);
  await listPages(base, token, requestSignal);
  assert.deepEqual(calls.map((call) => call.url), [
    base + "/api/sessions",
    base + "/api/sessions/session%2F%E4%B8%AD%E6%96%87",
    base + "/api/pages",
  ]);
  for (const call of calls) {
    assert.equal(new Headers(call.init.headers).get("Authorization"), "Bearer " + token);
    assert.equal(call.init.signal, requestSignal);
    assert.equal(call.url.includes(token), false);
  }
});

test("wish creation sends the documented wish and optional page slug", async () => {
  const calls = stubResponse(session, 201);
  assert.deepEqual(await createWish(base, token, { wish: "最近 30 天各品类毛利" }), session);
  await createWish(base, token, { wish: "改为按周", slug: "sales-report" });
  assert.deepEqual(calls.map((call) => JSON.parse(String(call.init.body))), [
    { wish: "最近 30 天各品类毛利" },
    { wish: "改为按周", slug: "sales-report" },
  ]);
  for (const call of calls) {
    assert.equal(call.url, base + "/api/wishes");
    assert.equal(call.init.method, "POST");
    assert.equal(new Headers(call.init.headers).get("Content-Type"), "application/json");
  }
});

test("page pinning uses authenticated PUT/DELETE and preserves server metadata", async () => {
  const result = { slug: "sales/中文", pinnedAt: "2026-10-17T02:00:00Z" };
  const calls = stubResponse(result);
  const signal = new AbortController().signal;
  assert.deepEqual(await setPagePinned(base, token, result.slug, true, signal), result);
  await setPagePinned(base, token, result.slug, false, signal);
  assert.deepEqual(calls.map((call) => call.init.method), ["PUT", "DELETE"]);
  for (const call of calls) {
    assert.equal(call.url, base + "/api/pages/sales%2F%E4%B8%AD%E6%96%87/pin");
    assert.equal(call.init.body, undefined);
    assert.equal(call.init.signal, signal);
    assert.equal(new Headers(call.init.headers).get("Authorization"), "Bearer " + token);
  }
});

test("follow-up messages and cancellation use the session routes", async () => {
  const calls = stubResponse(session, 202);
  await sendMessage(base, token, "session/1", "把图表改成按周");
  await cancelSession(base, token, "session/1");
  assert.equal(calls[0]?.url, base + "/api/sessions/session%2F1/messages");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { text: "把图表改成按周" });
  assert.equal(calls[1]?.url, base + "/api/sessions/session%2F1/cancel");
  assert.equal(calls[1]?.init.body, undefined);
  assert.ok(calls.every((call) => call.init.method === "POST"));
});

test("question answers and an explicit rejection preserve their exact request bodies", async () => {
  const calls = stubResponse({ ok: true });
  const answers = { range: ["最近 30 天（推荐）"], categories: ["食品", "饮料"] };
  await answerQuestions(base, token, "session/1", "question/2", answers);
  await resolveApproval(base, token, "session/1", "approval/3", false);
  assert.equal(calls[0]?.url, base + "/api/sessions/session%2F1/questions/question%2F2");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { answers });
  assert.equal(calls[1]?.url, base + "/api/sessions/session%2F1/approvals/approval%2F3");
  assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), { approved: false });
  assert.ok(calls.every((call) => call.init.method === "POST"));
});

test("style is read, saved as plain text, and reset through the documented endpoint", async () => {
  const style = "黑白配色\n图表清晰，文字简洁。";
  const calls = stubResponse(style, 200, "text/plain; charset=utf-8");
  assert.equal(await getStyle(base, token), style);
  assert.equal(await saveStyle(base, token, style), style);
  assert.equal(await resetStyle(base, token), style);
  assert.ok(calls.every((call) => call.url === base + "/api/style"));
  assert.equal(calls[1]?.init.method, "PUT");
  assert.equal(calls[1]?.init.body, style);
  assert.match(new Headers(calls[1]?.init.headers).get("Content-Type") ?? "", /^text\/plain/);
  assert.equal(calls[2]?.init.method, "DELETE");
});

test("gateway errors retain HTTP status and the backend error message", async () => {
  stubResponse({ error: "会话正在运行，请等待完成" }, 409);
  await assert.rejects(sendMessage(base, token, session.id, "继续"), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.status, 409);
    assert.equal(error.message, "会话正在运行，请等待完成");
    return true;
  });
  stubResponse("Not available", 502, "text/plain");
  await assert.rejects(listSessions(base, token), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.status, 502);
    assert.match(error.message, /HTTP 502/);
    return true;
  });
});

test("camera screenshots download as a Blob through an authenticated uncached POST without putting tokens in URLs", async () => {
  const captureUrl = "http://127.0.0.1:8787/captures/5a7cc6d8d6ad0b5c262605c7dae903ec/frame_000001.jpg";
  const bytes = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0);
  const signal = new AbortController().signal;
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(bytes, { headers: { "Content-Type": "image/jpeg" } });
  };
  const blob = await downloadChatImage(base + "/", "  " + token + "  ", captureUrl, signal);
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, "image/jpeg");
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  assert.equal(capturedUrl, base + "/api/chat/images");
  assert.equal(capturedUrl.includes(token), false);
  assert.equal(capturedUrl.includes(captureUrl), false);
  assert.equal(capturedInit?.method, "POST");
  assert.equal(capturedInit?.cache, "no-store");
  assert.equal(capturedInit?.signal, signal);
  assert.equal(new Headers(capturedInit?.headers).get("Authorization"), "Bearer " + token);
  assert.equal(new Headers(capturedInit?.headers).get("Content-Type"), "application/json");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), { url: captureUrl });
});

test("camera screenshot proxy preserves backend failures and caller cancellation", async () => {
  stubResponse({ error: "监控截图不存在或已过期" }, 404);
  await assert.rejects(downloadChatImage(base, token, "http://127.0.0.1:8787/captures/missing.jpg"), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.status, 404);
    assert.equal(error.message, "监控截图不存在或已过期");
    return true;
  });

  const controller = new AbortController();
  let capturedSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (_input, init) => {
    capturedSignal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      capturedSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  };
  const downloading = downloadChatImage(base, token, "http://127.0.0.1:8787/captures/pending.jpg", controller.signal);
  assert.equal(capturedSignal, controller.signal);
  controller.abort();
  await assert.rejects(downloading, { name: "AbortError" });
});

test("session SSE handles fragmented UTF-8, CRLF, multiline data and the since cursor", async () => {
  const bytes = new TextEncoder().encode(
    ': keepalive\r\nid: ignored\r\ndata: {"type":"say",\r\ndata: "text":"中文😀","at":"2026-10-17T00:00:00.000Z"}\r\n\r\n'
    + 'data: {"type":"status","status":"idle","at":"2026-10-17T00:00:01.000Z"}\r\n\r\n',
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
  };
  const events: unknown[] = [];
  const requestSignal = new AbortController().signal;
  let opened = 0;
  await sessionEvents(base, token, "session/1", 7, (event) => events.push(event), requestSignal, () => { opened += 1; });
  assert.equal(capturedUrl, base + "/api/sessions/session%2F1/events?since=7");
  assert.equal(capturedInit?.signal, requestSignal);
  assert.equal(capturedInit?.cache, "no-store");
  assert.equal(new Headers(capturedInit?.headers).get("Accept"), "text/event-stream");
  assert.equal(new Headers(capturedInit?.headers).get("Authorization"), "Bearer " + token);
  assert.equal(opened, 1);
  assert.deepEqual(events, [
    { type: "say", text: "中文😀", at: "2026-10-17T00:00:00.000Z" },
    { type: "status", status: "idle", at: "2026-10-17T00:00:01.000Z" },
  ]);
  assert.equal(body.locked, false);
});

test("aborting a live gateway stream cancels its reader and releases the lock", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(new TextEncoder().encode('data: {"type":"pages_changed"}\n\n')); },
    cancel() { cancelled = true; },
  });
  let capturedUrl = "";
  globalThis.fetch = async (input) => {
    capturedUrl = String(input);
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  };
  const events: unknown[] = [];
  await gatewayEvents(base, token, (event) => {
    events.push(event);
    controller.abort();
  }, controller.signal);
  assert.equal(capturedUrl, base + "/api/events");
  assert.deepEqual(events, [{ type: "pages_changed" }]);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test("aborting a silent stream promptly cancels an outstanding read", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  globalThis.fetch = async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  const reading = gatewayEvents(base, token, () => assert.fail("An aborted stream must not deliver events"), controller.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(body.locked, true);
  controller.abort();
  await reading;
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

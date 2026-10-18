import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import type { AskBody } from "@qdd/shared";
import { MAX_ASK_BODY_BYTES, MAX_ASK_IMAGE_BYTES, parseAskImages } from "./agent/ask-images.js";
import { createChat, type ChatMessage } from "./agent/llm.js";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { Auth } from "./gateway/auth.js";
import { startGateway } from "./gateway/server.js";
import { SDK_JS } from "./gateway/sdk.js";
import { ensureWorkspace, upsertPage } from "./web/site.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1X8AAAAASUVORK5CYII=";
const REMOTE = "https://images.example.test/photo.png?signature=fixture";

function sizedPng(size: number): string {
  const bytes = Buffer.alloc(size);
  Buffer.from(PNG.split(",")[1]!, "base64").copy(bytes);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

test("ask images accept supported formats, details and HTTPS URLs without changing input", () => {
  const images = [{ url: PNG, detail: "high" }, { url: REMOTE, detail: "auto" }];
  assert.deepEqual(parseAskImages(images), images);
  assert.deepEqual(parseAskImages(undefined), []);
  assert.deepEqual(parseAskImages([]), []);
  for (const [mime, bytes] of [
    ["image/jpeg", Buffer.from([255, 216, 255, 224])],
    ["image/gif", Buffer.from("GIF89a")],
    ["image/webp", Buffer.from("RIFFxxxxWEBP")],
  ] as const) {
    const input = [{ url: `data:${mime};base64,${bytes.toString("base64")}`, detail: "low" }];
    assert.deepEqual(parseAskImages(input), input);
  }
  assert.equal(parseAskImages(Array.from({ length: 4 }, () => ({ url: PNG }))).length, 4);
  const url = "https://example.test/" + "a".repeat(8192 - "https://example.test/".length);
  assert.deepEqual(parseAskImages([{ url }]), [{ url }]);
  assert.throws(() => parseAskImages([{ url: url + "a" }]), /8192/);
});

test("ask image validation rejects malformed inputs, unsafe schemes and mismatched image headers", () => {
  for (const value of [
    null, {}, "image", [null], [PNG], [{}], [{ url: 1 }], [{ url: "" }],
    [{ url: PNG, detail: "invalid" }], [{ url: PNG, detail: null }],
    Array.from({ length: 5 }, () => ({ url: PNG })),
    ...[
      "http://example.test/a.png", "file:///photo.png", "blob:https://example.test/id",
      "//example.test/a.png", "https:example.test/a.png", "https://", "not-a-url",
      "https://user:password@example.test/a.png", "https://example.test/a\n.png",
      "https://example.test\\photo.png", " https://example.test/photo.png",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "data:text/plain;base64,aGVsbG8=", "data:image/png,not-base64",
      "data:image/png;base64,", "data:image/png;base64,!!!!",
      "data:image/png;base64,aGk", "data:image/png;base64,aGk===",
      "data:image/png;base64,aGk=", "data:image/png;base64,aGl=",
      "data:image/jpeg;base64," + PNG.split(",")[1],
    ].map((url) => ({ url })).map((image) => [image]),
  ]) {
    assert.throws(() => parseAskImages(value), { name: "Error", status: 400 });
  }
});

test("ask image byte limits include exact per-image and aggregate boundaries", () => {
  const max = sizedPng(MAX_ASK_IMAGE_BYTES);
  assert.equal(parseAskImages([{ url: max }])[0]?.url, max);
  assert.equal(parseAskImages([{ url: max }, { url: max }]).length, 2);
  assert.throws(() => parseAskImages([{ url: sizedPng(MAX_ASK_IMAGE_BYTES + 1) }]), /5 MiB/);
  assert.throws(() => parseAskImages([{ url: max }, { url: max }, { url: PNG }]), /10 MiB/);
});

function sdk(fetcher: typeof fetch) {
  const context = createContext({
    TextEncoder, TextDecoder, URL, fetch: fetcher,
    window: {
      QDD_PAGE: { slug: "image-page", token: "page-token" },
      __qddCompute: {},
      addEventListener() {},
    },
  });
  runInContext(SDK_JS, context);
  return <T>(expression: string): T => runInContext(expression, context) as T;
}

test("ask SDK preserves old calls and progress callbacks and sends images separately", async () => {
  const requests: AskBody[] = [];
  const evaluate = sdk(async (_input, init) => {
    assert.equal(_input, "/api/ask");
    assert.equal(new Headers(init?.headers).get("X-QDD-Page-Token"), "page-token");
    requests.push(JSON.parse(String(init?.body)) as AskBody);
    return new Response('data: {"type":"tool","name":"read"}\n\ndata: {"type":"answer","text":"done"}\n\n');
  });
  assert.equal(await evaluate<Promise<string>>('window.qdd.ask("text only")'), "done");
  evaluate("globalThis.events = []");
  assert.equal(await evaluate<Promise<string>>('window.qdd.ask("legacy", {id: 1}, (e) => events.push(e))'), "done");
  assert.equal(await evaluate<Promise<string>>(`window.qdd.ask("image", {id: 2}, {images: [{url: ${JSON.stringify(PNG)}, detail: "high"}, {url: ${JSON.stringify(REMOTE)}}], onEvent: (e) => events.push(e)})`), "done");
  assert.deepEqual(requests, [
    { question: "text only" },
    { question: "legacy", context: { id: 1 } },
    { question: "image", context: { id: 2 }, images: [{ url: PNG, detail: "high" }, { url: REMOTE }] },
  ]);
  assert.equal(evaluate("JSON.stringify(events)"), JSON.stringify(Array(2).fill({ type: "tool", name: "read" })));
  await assert.rejects(evaluate<Promise<string>>('window.qdd.ask("x", {}, {onEvent: true})'), /onEvent/);
  await assert.rejects(evaluate<Promise<string>>('window.qdd.ask("x", {}, [])'), /第三参数/);
  assert.equal(requests.length, 3);
});

test("ask SDK surfaces validation and model errors rather than returning success", async () => {
  for (const response of [
    new Response('{"error":"invalid image"}', { status: 400 }),
    new Response('data: {"type":"error","message":"model does not support images"}\n\n'),
  ]) {
    const evaluate = sdk(async () => response);
    await assert.rejects(evaluate<Promise<string>>(`window.qdd.ask("image", {}, {images: [{url: ${JSON.stringify(PNG)}}]})`), /invalid image|model does not support images/);
  }
});

test("provider request uses multimodal content, preserves text messages and does not fetch remote images", async (t) => {
  const apiKeyEnv = "QDD_ASK_IMAGES_TEST_KEY";
  const previous = process.env[apiKeyEnv];
  process.env[apiKeyEnv] = "local-test-key";
  t.after(() => {
    if (previous === undefined) delete process.env[apiKeyEnv];
    else process.env[apiKeyEnv] = previous;
  });
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://provider.example.test/v1/chat/completions");
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response('data: {"choices":[{"delta":{"content":"image answer"}}]}\n\ndata: [DONE]\n\n');
  });
  const chat = createChat({ ...DEFAULT_CONFIG.llm, apiKeyEnv, baseUrl: "https://provider.example.test/v1", model: "configured-vision-model" });
  const messages: ChatMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "legacy" },
    { role: "user", content: "inspect", images: [{ url: PNG, detail: "high" }, { url: REMOTE }] },
  ];
  const before = structuredClone(messages);
  assert.equal((await chat(messages, [])).content, "image answer");
  assert.deepEqual(messages, before);
  assert.equal(bodies[0]?.model, "configured-vision-model");
  assert.deepEqual(bodies[0]?.messages, [
    messages[0], messages[1],
    { role: "user", content: [
      { type: "text", text: "inspect" },
      { type: "image_url", image_url: { url: PNG, detail: "high" } },
      { type: "image_url", image_url: { url: REMOTE } },
    ] },
  ]);
  await assert.rejects(chat([{ role: "tool", content: "", images: [{ url: PNG }] }], []), /user/);
  assert.equal(bodies.length, 1);
});

test("image gateway validates before calling the model and retains page permissions, tool loop and text behavior", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qdd-ask-images-"));
  let sources: DataSources | undefined;
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  try {
    const loaded = await loadConfig(root);
    loaded.config.gateway.port = 0;
    loaded.config.datasets.refreshIntervalSec = 0;
    await ensureWorkspace(loaded.paths);
    for (const useAgent of [false, true]) {
      await upsertPage(loaded.paths, {
        slug: useAgent ? "image-page" : "no-agent", title: "Image test", wish: "", summary: "",
        tools: ["store__get_store_info"], useAgent, metrics: [], datasets: {}, version: 1, stale: null, gaps: [], sessionId: "test",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    }
    sources = await DataSources.open(loaded, { connectMcp: false });
    const token = "ask-images-gateway-test-token";
    const auth = new Auth(token);
    const seen: ChatMessage[][] = [];
    let failModel = false;
    let onCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => { onCancelled = resolve; });
    gateway = await startGateway(loaded, sources, {
      token, scheduler: false,
      chat: () => async (messages, tools, signal) => {
        seen.push(structuredClone(messages));
        assert.ok(tools.every((tool) => !sources?.get(tool.function.name)?.mutating));
        if (messages[1]?.images && messages[1]?.content !== "admin image") {
          assert.deepEqual(tools.map((tool) => tool.function.name), ["store__get_store_info"]);
        }
        if (failModel) throw new Error("vision not supported");
        if (messages[1]?.content === "wait for cancellation") {
          return new Promise<ChatMessage>((_resolve, reject) => {
            assert.ok(signal);
            signal.addEventListener("abort", () => {
              onCancelled();
              reject(new Error("cancelled"));
            }, { once: true });
          });
        }
        if (messages.at(-1)?.role !== "tool") {
          return { role: "assistant", content: null, tool_calls: [{ id: "read1", type: "function", function: { name: "store__get_store_info", arguments: "{}" } }] };
        }
        return { role: "assistant", content: "analysis complete" };
      },
    });
    const headers = (slug: string) => ({ "Content-Type": "application/json", "X-QDD-Page": slug, "X-QDD-Page-Token": auth.pageToken(slug) });
    const post = (body: unknown, slug = "image-page") => fetch(`${gateway!.url}/api/ask`, {
      method: "POST", headers: headers(slug), body: JSON.stringify(body),
    });
    const health = await fetch(`${gateway.url}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { status: string }).status, "ok");
    assert.equal((await fetch(`${gateway.url}/not-found`)).status, 404);
    assert.equal((await fetch(`${gateway.url}/api/ask`, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await post({ question: "inspect", images: [{ url: PNG }] }, "no-agent")).status, 403);
    for (const body of [null, {}, { question: " " }, { question: "x", images: null }, { question: "x", images: [{ url: "file:///x" }] }]) {
      const response = await post(body);
      assert.equal(response.status, 400);
      assert.ok((await response.json() as { error: string }).error);
    }
    assert.equal(seen.length, 0);
    const evaluate = sdk(async (_input, init) => fetch(`${gateway!.url}/api/ask`, { ...init, headers: headers("image-page") }));
    assert.equal(await evaluate<Promise<string>>(`window.qdd.ask("inspect", {store: "A"}, {images: [{url: ${JSON.stringify(PNG)}}, {url: ${JSON.stringify(REMOTE)}}]})`), "analysis complete");
    assert.deepEqual(seen[0]?.[1]?.images, [{ url: PNG }, { url: REMOTE }]);
    assert.match(seen[0]?.[1]?.content ?? "", /inspect.*\n\n.*\n.*"store":"A"/);
    assert.deepEqual(seen[1]?.[1]?.images, seen[0]?.[1]?.images, "images remain in follow-up tool turns");
    assert.equal(seen[1]?.at(-1)?.role, "tool");

    const largeImage = sizedPng(1024 * 1024);
    assert.match(await (await post({ question: "large image", images: [{ url: largeImage }] })).text(), /analysis complete/);
    assert.equal(seen.at(-1)?.[1]?.images?.[0]?.url, largeImage, "image larger than original 1 MiB request limit is not truncated");
    const textResponse = await post({ question: "text only", context: { id: 1 } });
    assert.match(await textResponse.text(), /"type":"tool"/);
    assert.equal(seen.at(-1)?.[1]?.images, undefined);
    const adminResponse = await fetch(`${gateway.url}/api/ask`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ question: "admin image", images: [{ url: PNG }] }),
    });
    assert.match(await adminResponse.text(), /analysis complete/);
    const padding = "x".repeat(MAX_ASK_BODY_BYTES - JSON.stringify({ question: "boundary", padding: "" }).length);
    const boundaryResponse = await post({ question: "boundary", padding });
    assert.equal(boundaryResponse.status, 200, "exactly 15 MiB is accepted");
    assert.match(await boundaryResponse.text(), /analysis complete/);
    const controller = new AbortController();
    const pending = await fetch(`${gateway.url}/api/ask`, {
      method: "POST", headers: headers("image-page"), signal: controller.signal,
      body: JSON.stringify({ question: "wait for cancellation", images: [{ url: PNG }] }),
    });
    assert.equal(pending.status, 200);
    controller.abort();
    await cancelled;
    failModel = true;
    await assert.rejects(evaluate<Promise<string>>(`window.qdd.ask("inspect", {}, {images: [{url: ${JSON.stringify(PNG)}}]})`), /vision not supported/);
    const beforeInvalid = seen.length;
    assert.equal((await post({ question: "too large", images: [{ url: sizedPng(MAX_ASK_IMAGE_BYTES + 1) }] })).status, 400);
    assert.equal((await post({ question: "x".repeat(MAX_ASK_BODY_BYTES) })).status, 413);
    assert.equal(seen.length, beforeInvalid);
    const stateResponse = await fetch(`${gateway.url}/api/state/image-page`, {
      method: "PUT", headers: headers("image-page"), body: JSON.stringify({ value: "x".repeat(1024 * 1024) }),
    });
    assert.equal(stateResponse.status, 413, "other routes retain their existing request limits");
  } finally {
    await gateway?.close();
    await sources?.close();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("qdd-ask-images-"));
    await rm(root, { recursive: true, force: true });
  }
});

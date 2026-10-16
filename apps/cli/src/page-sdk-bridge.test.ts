import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { createPageBridgeMessage, type PageBridgeMessage } from "@qdd/shared";
import { loadConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { startGateway } from "./gateway/server.js";
import { SDK_JS } from "./gateway/sdk.js";
import { ensureWorkspace, upsertPage } from "./web/site.js";

const HOST_ORIGIN = "http://127.0.0.1:5177";
const PAGE_TOKEN = "page-secret-token-0123456789";
const SLUG = "sales-overview";
const BRIDGE_ID = "test-document-nonce";
const CONTEXT = { theme: "dark", locale: "zh-CN" };

function sdkHarness(hostOrigins = [HOST_ORIGIN]) {
  const outgoing: { message: PageBridgeMessage; origin: string }[] = [];
  const warnings: unknown[][] = [];
  const context = createContext({
    TextEncoder,
    URL,
    recordMessage: (message: PageBridgeMessage, origin: string) => outgoing.push({ message: structuredClone(message), origin }),
    recordWarning: (...args: unknown[]) => warnings.push(args),
  });
  // MessageEvent structured-clones into its recipient's realm. Keep test payloads
  // in the VM realm too, so prototype validation matches browser behavior.
  runInContext(`
    const listeners = new Map();
    globalThis.window = {
      QDD_PAGE: ${JSON.stringify({ slug: SLUG, token: PAGE_TOKEN, hostOrigins, metrics: {} })},
      __qddCompute: { format: (value) => value },
      parent: { postMessage: recordMessage },
      addEventListener: (type, listener) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(listener);
      },
    };
    globalThis.console = { warn: recordWarning };
    globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));
    globalThis.dispatch = (type, event) => {
      for (const listener of listeners.get(type) || []) listener(event);
    };
  `, context);
  runInContext(SDK_JS, context);
  const evaluate = <T = unknown>(source: string): T => runInContext(source, context) as T;
  function receive(message: unknown, origin = HOST_ORIGIN, source = "window.parent") {
    evaluate(`dispatch("message", { data: ${JSON.stringify(message)}, origin: ${JSON.stringify(origin)}, source: ${source} });`);
  }
  function init(bridgeId = BRIDGE_ID) {
    receive(createPageBridgeMessage(SLUG, bridgeId, "host:init", CONTEXT));
  }
  return { outgoing, warnings, evaluate, receive, init };
}

test("page SDK handshake: exact parent origin, initial context, readiness and bidirectional events", async () => {
  const sdk = sdkHarness();
  assert.equal(sdk.evaluate("Object.isFrozen(window.qdd) && Object.isFrozen(window.qdd.host)"), true);
  assert.equal(sdk.evaluate("window.qdd.host.emit('selection:changed', {id: 1})"), false);
  sdk.evaluate(`
    globalThis.contexts = [];
    globalThis.selections = [];
    window.qdd.host.on("host:context", (payload) => contexts.push(payload));
    globalThis.unsubscribe = window.qdd.host.on("selection:changed", (payload) => selections.push(payload));
  `);
  sdk.init();
  await sdk.evaluate<Promise<void>>("window.qdd.host.ready");
  assert.deepEqual(sdk.evaluate("JSON.stringify(contexts)"), JSON.stringify([CONTEXT]));
  assert.deepEqual(sdk.outgoing, [{ message: createPageBridgeMessage(SLUG, BRIDGE_ID, "page:ready", null), origin: HOST_ORIGIN }]);

  sdk.receive(createPageBridgeMessage(SLUG, BRIDGE_ID, "selection:changed", { id: 2 }));
  sdk.evaluate("unsubscribe()");
  sdk.receive(createPageBridgeMessage(SLUG, BRIDGE_ID, "selection:changed", { id: 3 }));
  assert.equal(sdk.evaluate("JSON.stringify(selections)"), JSON.stringify([{ id: 2 }]));
  assert.equal(sdk.evaluate("window.qdd.host.emit('filter:changed', {store: '001'})"), true);
  assert.deepEqual(sdk.outgoing.at(-1), { message: createPageBridgeMessage(SLUG, BRIDGE_ID, "filter:changed", { store: "001" }), origin: HOST_ORIGIN });
  assert.equal(sdk.evaluate("window.qdd.host.emit('page:resize')"), true);
  assert.equal(sdk.outgoing.at(-1)?.message.payload, null);
  assert.equal(JSON.stringify(sdk.outgoing).includes(PAGE_TOKEN), false);
});

test("page SDK rejects spoofed parent, origins, envelopes, stale documents and handshake replacement", async () => {
  const sdk = sdkHarness([HOST_ORIGIN, "http://localhost:5177", "null", "*"]);
  const init = createPageBridgeMessage(SLUG, BRIDGE_ID, "host:init", CONTEXT);
  sdk.receive(init, HOST_ORIGIN, "{}");
  sdk.receive(init, "null");
  sdk.receive(init, "https://evil.example");
  sdk.receive({ ...init, slug: "different-page" });
  sdk.receive({ ...init, version: 2 });
  sdk.receive({ ...init, type: "host:init\n" });
  sdk.receive({ ...init, token: PAGE_TOKEN });
  sdk.receive({ ...init, payload: { theme: "dark" } });
  sdk.receive({ ...init, payload: { ...CONTEXT, token: PAGE_TOKEN } });
  assert.equal(sdk.outgoing.length, 0);

  sdk.evaluate("globalThis.changes = []; window.qdd.host.on('host:context', (value) => changes.push(value));");
  sdk.init();
  await sdk.evaluate<Promise<void>>("window.qdd.host.ready");
  sdk.init();
  assert.equal(sdk.outgoing.length, 2, "retrying the same init acknowledges readiness");
  assert.equal(sdk.evaluate("changes.length"), 1, "initial context dispatches once");
  sdk.init("replacement-document-nonce");
  sdk.receive(createPageBridgeMessage(SLUG, "replacement-document-nonce", "host:context", { theme: "light", locale: "en" }));
  sdk.receive(createPageBridgeMessage(SLUG, BRIDGE_ID, "host:context", { theme: "light", locale: "en" }), "http://localhost:5177");
  assert.equal(sdk.outgoing.length, 2);
  assert.equal(sdk.evaluate("changes.length"), 1);
  sdk.receive(createPageBridgeMessage(SLUG, BRIDGE_ID, "host:context", { theme: "light", locale: "en" }));
  assert.equal(sdk.evaluate("changes.length"), 2);
});

test("page SDK enforces JSON payload limits, rejects credentials and reserved directions without throwing", () => {
  const sdk = sdkHarness();
  sdk.init();
  for (const expression of [
    "window.qdd.host.emit('host:init', {})",
    "window.qdd.host.emit('Host:init', {})",
    "window.qdd.host.emit('host:context', {})",
    "window.qdd.host.emit('page:ready', null)",
    "window.qdd.host.emit('Page:Ready', null)",
    "window.qdd.host.emit('bad type', null)",
    "window.qdd.host.emit('value:changed', {fn: () => {}})",
    "window.qdd.host.emit('value:changed', {value: NaN})",
    "window.qdd.host.emit('value:changed', new Date())",
    "window.qdd.host.emit('value:changed', new Array(1))",
    "window.qdd.host.emit('value:changed', {get value() { throw new Error('must not run'); }})",
    "window.qdd.host.emit('value:changed', JSON.parse('{\"__proto__\": {}}'))",
    "window.qdd.host.emit('value:changed', '中'.repeat(21846))",
    "window.qdd.host.emit('value:changed', 'a'.repeat(65535))",
    `window.qdd.host.emit('value:changed', {token: ${JSON.stringify(PAGE_TOKEN)}})`,
  ]) {
    assert.equal(sdk.evaluate(expression), false, expression);
  }
  assert.equal(sdk.evaluate("window.qdd.host.emit('value:changed', undefined)"), true, "undefined uses the default null payload");
  sdk.evaluate("globalThis.cycle = {}; cycle.self = cycle;");
  assert.equal(sdk.evaluate("window.qdd.host.emit('value:changed', cycle)"), false);
  assert.equal(sdk.evaluate("window.qdd.host.emit('value:changed', 'a'.repeat(65534))"), true, "JSON quotes count towards the 64KB boundary");
  assert.equal(JSON.stringify(sdk.outgoing).includes(PAGE_TOKEN), false);
  sdk.evaluate("window.parent.postMessage = () => { throw new Error('parent closed'); };");
  assert.equal(sdk.evaluate("window.qdd.host.emit('value:changed', {ok: true})"), false);
});

test("page SDK isolates listener failures and forwards bounded runtime errors after handshake", () => {
  const sdk = sdkHarness();
  sdk.evaluate("dispatch('error', {message: 'before handshake'});");
  assert.equal(sdk.outgoing.length, 0);
  sdk.init();
  sdk.evaluate(`
    globalThis.received = [];
    window.qdd.host.on("host:refresh", () => { throw new Error("listener failed"); });
    window.qdd.host.on("host:refresh", (payload) => received.push(payload));
  `);
  sdk.receive(createPageBridgeMessage(SLUG, BRIDGE_ID, "host:refresh", { scope: "all" }));
  assert.equal(sdk.evaluate("received.length"), 1);
  assert.equal(sdk.warnings.length, 1);
  assert.equal(sdk.outgoing.length, 1, "listener failures only go to console");
  sdk.evaluate(`dispatch("error", {message: ${JSON.stringify(`bad ${PAGE_TOKEN} value`)}});`);
  sdk.evaluate("dispatch('unhandledrejection', {reason: new Error('x'.repeat(800))});");
  assert.deepEqual(sdk.outgoing[1]?.message, createPageBridgeMessage(SLUG, BRIDGE_ID, "page:error", { message: "bad [redacted] value" }));
  assert.equal((sdk.outgoing[2]?.message.payload as { message: string }).message.length, 500);
  assert.equal(JSON.stringify(sdk.outgoing).includes(PAGE_TOKEN), false);
});

test("gateway injects only explicit HTTP host origins and the actual gateway origin", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qdd-page-bridge-"));
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  let sources: DataSources | undefined;
  try {
    await writeFile(path.join(root, "harness.config.json"), JSON.stringify({
      gateway: { host: "127.0.0.1", port: 0, corsOrigins: [HOST_ORIGIN, "null", "*", "file:///tmp", `${HOST_ORIGIN}/path`] },
    }));
    const loaded = await loadConfig(root);
    await ensureWorkspace(loaded.paths);
    await upsertPage(loaded.paths, {
      slug: SLUG, title: "Test", wish: "test", summary: "", tools: [], useAgent: false, metrics: [], datasets: {},
      version: 1, stale: null, gaps: [], sessionId: "test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await mkdir(path.join(loaded.paths.pages, SLUG), { recursive: true });
    await writeFile(path.join(loaded.paths.pages, SLUG, "index.html"), "<html><head></head><body></body></html>");
    sources = await DataSources.open(loaded);
    gateway = await startGateway(loaded, sources, { token: "admin-secret-token", chat: () => async () => ({ role: "assistant", content: "ok" }) });
    const response = await fetch(`${gateway.url}/pages/${SLUG}/`, { headers: { Authorization: "Bearer admin-secret-token" } });
    assert.equal(response.status, 200);
    const html = await response.text();
    const boot = /window\.QDD_PAGE=(.*?);<\/script>/.exec(html)?.[1];
    assert.ok(boot);
    const page = JSON.parse(boot) as { hostOrigins: string[] };
    assert.deepEqual(page.hostOrigins, [HOST_ORIGIN, gateway.url]);
    assert.equal(html.includes("admin-secret-token"), false);
  } finally {
    await gateway?.close();
    await sources?.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("qdd-page-bridge-"));
    await rm(root, { recursive: true, force: true });
  }
});

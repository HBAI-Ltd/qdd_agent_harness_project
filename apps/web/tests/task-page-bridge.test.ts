import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPageBridgeMessage,
  MAX_PAGE_BRIDGE_PAYLOAD_BYTES,
  PAGE_BRIDGE_CHANNEL,
  PAGE_BRIDGE_VERSION,
  type JsonValue,
  type PageBridgeMessage,
} from "@qdd/shared";
import { createTaskPageBridge, type TaskPageEvent } from "../src/utils/taskPageBridge.ts";

function createFixture(opaque = false) {
  const sent: { message: PageBridgeMessage; targetOrigin: string }[] = [];
  const received: TaskPageEvent[] = [];
  const frameWindow = {
    postMessage(message: PageBridgeMessage, targetOrigin: string) {
      sent.push({ message, targetOrigin });
    },
  } as unknown as Window;
  const origin = "https://gateway.example";
  const slug = "sales-report";
  const context: JsonValue = { task: { slug, title: "销售看板", version: 2 } };
  const bridge = createTaskPageBridge({
    getWindow: () => frameWindow,
    getOrigin: () => origin,
    getSlug: () => slug,
    isOpaque: () => opaque,
    getContext: () => context,
    onMessage: (message) => received.push(message),
  });
  function initialize() {
    assert.equal(bridge.initialize(), true);
    const call = sent.at(-1);
    assert.ok(call);
    return call.message;
  }
  function event(data: unknown, eventOrigin = opaque ? "null" : origin, source = frameWindow) {
    return { data, origin: eventOrigin, source };
  }
  function pageMessage(initial: PageBridgeMessage, type: string, payload: JsonValue = null) {
    return createPageBridgeMessage(slug, initial.bridgeId, type, payload);
  }
  function ready(initial: PageBridgeMessage) {
    assert.equal(bridge.receive(event(pageMessage(initial, "page:ready"))), true);
    assert.equal(bridge.isReady(), true);
  }
  return { bridge, sent, received, frameWindow, origin, slug, context, initialize, event, pageMessage, ready };
}

test("host:init and page:ready establish the current task connection", () => {
  const fixture = createFixture();
  assert.equal(fixture.bridge.isReady(), false);
  assert.equal(fixture.bridge.postMessage("host:refresh"), false);
  assert.deepEqual(fixture.sent, []);

  const initial = fixture.initialize();
  assert.equal(initial.channel, PAGE_BRIDGE_CHANNEL);
  assert.equal(initial.version, PAGE_BRIDGE_VERSION);
  assert.equal(initial.slug, fixture.slug);
  assert.equal(initial.type, "host:init");
  assert.ok(initial.bridgeId.length > 0);
  assert.deepEqual(initial.payload, fixture.context);
  assert.equal(fixture.sent[0]?.targetOrigin, fixture.origin);
  assert.equal(fixture.bridge.isReady(), false);

  fixture.ready(initial);
  assert.equal(fixture.received.length, 1);
  assert.equal(fixture.received[0]?.type, "page:ready");
});

test("foreign source, origin, slug and bridge ID cannot initialize or deliver events", () => {
  const fixture = createFixture();
  const initial = fixture.initialize();
  const valid = fixture.pageMessage(initial, "page:ready");
  const anotherWindow = {} as Window;
  const rejected = [
    fixture.event(valid, fixture.origin, anotherWindow),
    fixture.event(valid, "https://other.example"),
    fixture.event(valid, "null"),
    fixture.event({ ...valid, slug: "another-task" }),
    fixture.event({ ...valid, bridgeId: "another-frame-load" }),
  ];
  for (const event of rejected) {
    assert.equal(fixture.bridge.receive(event), false);
  }
  assert.equal(fixture.bridge.isReady(), false);
  assert.deepEqual(fixture.received, []);

  fixture.ready(initial);
  const business = fixture.pageMessage(initial, "page:selection", { id: "sku-1" });
  assert.equal(fixture.bridge.receive(fixture.event(business, fixture.origin, anotherWindow)), false);
  assert.equal(fixture.bridge.receive(fixture.event(business, "https://other.example")), false);
  assert.equal(fixture.bridge.receive(fixture.event({ ...business, slug: "another-task" })), false);
  assert.equal(fixture.bridge.receive(fixture.event({ ...business, bridgeId: "another-frame-load" })), false);
  assert.equal(fixture.received.length, 1);
});

test("page business events reach the host listener and replies use the exact frame origin", () => {
  const fixture = createFixture();
  const initial = fixture.initialize();
  fixture.ready(initial);
  const payload: JsonValue = { productId: "sku-1", quantity: 3, filters: ["饮料"] };
  assert.equal(fixture.bridge.receive(fixture.event(fixture.pageMessage(initial, "page:selection", payload))), true);
  const received = fixture.received.at(-1);
  assert.ok(received);
  assert.equal(received.slug, fixture.slug);
  assert.equal(received.type, "page:selection");
  assert.deepEqual(received.payload, payload);

  assert.equal(received.reply("host:selection", { accepted: true }), true);
  assert.deepEqual(fixture.sent.at(-1), {
    message: createPageBridgeMessage(fixture.slug, initial.bridgeId, "host:selection", { accepted: true }),
    targetOrigin: fixture.origin,
  });
  assert.equal(received.reply("page:selection", null), false);
  assert.equal(fixture.sent.length, 2);
  assert.equal(fixture.bridge.postMessage("host:refresh"), true);
  assert.equal(fixture.sent.at(-1)?.message.payload, null);
});

test("business events are ignored until page:ready and host messages cannot arrive from the page", () => {
  const fixture = createFixture();
  const initial = fixture.initialize();
  for (const type of ["page:selection", "custom:event", "host:init", "host:refresh"]) {
    assert.equal(fixture.bridge.receive(fixture.event(fixture.pageMessage(initial, type))), false);
  }
  assert.deepEqual(fixture.received, []);
  assert.equal(fixture.bridge.isReady(), false);
  fixture.ready(initial);
  for (const type of ["host:init", "host:refresh", "host:result"]) {
    assert.equal(fixture.bridge.receive(fixture.event(fixture.pageMessage(initial, type))), false);
  }
  assert.equal(fixture.received.length, 1);
});

test("reset blocks stale messages and listener replies even after the replacement frame is ready", () => {
  const fixture = createFixture();
  const first = fixture.initialize();
  fixture.ready(first);
  assert.equal(fixture.bridge.receive(fixture.event(fixture.pageMessage(first, "page:selection"))), true);
  const previousEvent = fixture.received.at(-1);
  assert.ok(previousEvent);

  fixture.bridge.reset();
  assert.equal(fixture.bridge.isReady(), false);
  assert.equal(previousEvent.reply("host:result"), false);
  assert.equal(fixture.bridge.postMessage("host:refresh"), false);
  assert.equal(fixture.bridge.receive(fixture.event(fixture.pageMessage(first, "page:ready"))), false);
  const second = fixture.initialize();
  assert.notEqual(second.bridgeId, first.bridgeId);
  fixture.ready(second);
  assert.equal(previousEvent.reply("host:result"), false);
  assert.equal(fixture.bridge.receive(fixture.event(fixture.pageMessage(first, "page:selection"))), false);
  const currentEvent = fixture.received.at(-1);
  assert.ok(currentEvent);
  assert.equal(currentEvent.reply("host:result"), true);
  assert.equal(fixture.sent.at(-1)?.message.bridgeId, second.bridgeId);
});

test("opaque frames accept only origin null and receive wildcard-targeted context without credentials", () => {
  const fixture = createFixture(true);
  const initial = fixture.initialize();
  assert.equal(fixture.sent[0]?.targetOrigin, "*");
  assert.deepEqual(initial.payload, { task: { slug: "sales-report", title: "销售看板", version: 2 } });
  assert.equal(/token|authorization|cookie|password/i.test(JSON.stringify(initial)), false);
  const ready = fixture.pageMessage(initial, "page:ready");
  assert.equal(fixture.bridge.receive(fixture.event(ready, fixture.origin)), false);
  assert.equal(fixture.bridge.receive(fixture.event(ready, "https://other.example")), false);
  assert.equal(fixture.bridge.receive(fixture.event(ready, "*")), false);
  fixture.ready(initial);

  assert.equal(fixture.bridge.receive(fixture.event(fixture.pageMessage(initial, "page:selection", { id: 1 }))), true);
  const received = fixture.received.at(-1);
  assert.ok(received);
  assert.equal(received.reply("host:result", { ok: true }), true);
  assert.equal(fixture.sent.at(-1)?.targetOrigin, "*");
  assert.equal(fixture.bridge.receive(fixture.event(ready, "null", {} as Window)), false);
});

test("malformed and oversized incoming envelopes are ignored without invoking payload accessors", () => {
  const fixture = createFixture();
  const initial = fixture.initialize();
  fixture.ready(initial);
  const valid = fixture.pageMessage(initial, "page:selection", { id: 1 });
  const circular: { self?: unknown } = {};
  circular.self = circular;
  let accessorCalls = 0;
  const accessorPayload = Object.defineProperty({}, "value", {
    enumerable: true,
    get() { accessorCalls += 1; return "unsafe"; },
  });
  for (const data of [
    null,
    "not an envelope",
    [],
    { ...valid, channel: "other-channel" },
    { ...valid, version: 999 },
    { ...valid, extra: "field" },
    { ...valid, payload: undefined },
    { ...valid, payload: () => "unsafe" },
    { ...valid, payload: Number.NaN },
    { ...valid, payload: circular },
    { ...valid, payload: accessorPayload },
    { ...valid, payload: "x".repeat(MAX_PAGE_BRIDGE_PAYLOAD_BYTES) },
    { ...valid, payload: "中".repeat(Math.ceil(MAX_PAGE_BRIDGE_PAYLOAD_BYTES / 3)) },
  ]) {
    assert.equal(fixture.bridge.receive(fixture.event(data)), false);
  }
  assert.equal(accessorCalls, 0);
  assert.equal(fixture.received.length, 1);
  assert.equal(fixture.bridge.isReady(), true);
});

test("invalid outbound payloads and transport failures report false", () => {
  const fixture = createFixture();
  fixture.ready(fixture.initialize());
  const count = fixture.sent.length;
  assert.equal(fixture.bridge.postMessage("host:result", "x".repeat(MAX_PAGE_BRIDGE_PAYLOAD_BYTES)), false);
  assert.equal(fixture.bridge.postMessage("page:result", { ok: true }), false);
  assert.equal(fixture.sent.length, count);
  fixture.frameWindow.postMessage = () => { throw new Error("Frame is no longer available"); };
  assert.equal(fixture.bridge.postMessage("host:refresh"), false);
});

test("LAN HTTP without randomUUID still initializes and rotates an unpredictable bridge ID", (t) => {
  const original = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
  t.after(() => {
    if (original) Object.defineProperty(crypto, "randomUUID", original);
    else Reflect.deleteProperty(crypto, "randomUUID");
  });
  const fixture = createFixture();
  const first = fixture.initialize();
  assert.match(first.bridgeId, /^[a-f0-9]{32}$/);
  fixture.ready(first);
  fixture.bridge.reset();
  const next = fixture.initialize();
  assert.notEqual(first.bridgeId, next.bridgeId);
  assert.equal(fixture.bridge.receive(fixture.event(fixture.pageMessage(first, "page:ready"))), false);
  fixture.ready(next);
});

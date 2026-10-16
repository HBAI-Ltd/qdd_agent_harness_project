import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createPageBridgeMessage,
  isPageBridgeMessage,
  MAX_PAGE_BRIDGE_PAYLOAD_BYTES,
  PAGE_BRIDGE_CHANNEL,
  PAGE_BRIDGE_VERSION,
  type JsonValue,
} from "@qdd/shared";

const valid = () => createPageBridgeMessage("store-report", "frame-1", "page:ready", null);

describe("page bridge wire protocol", () => {
  test("accepts handshake and business events with JSON payloads", () => {
    for (const payload of [null, true, false, 3.5, "文本", [1, null], { filters: { days: 7 }, selection: ["门店"] }]) {
      const message = createPageBridgeMessage("store-report", "frame-1", "host:init", payload);
      assert.equal(message.channel, PAGE_BRIDGE_CHANNEL);
      assert.equal(message.version, PAGE_BRIDGE_VERSION);
      assert.equal(isPageBridgeMessage(structuredClone(message)), true);
    }
    assert.equal(isPageBridgeMessage(createPageBridgeMessage("a", "frame-2", "selection.changed", {})), true);
    assert.equal(isPageBridgeMessage(createPageBridgeMessage("a", "frame-2", "page:error", { message: "failed" })), true);
  });

  test("rejects missing fields, foreign channels and unsupported versions", () => {
    for (const message of [null, [], {}, { ...valid(), channel: "another" }, { ...valid(), version: 2 }]) {
      assert.equal(isPageBridgeMessage(message), false);
    }
    const missing: Partial<ReturnType<typeof valid>> = valid();
    delete missing["bridgeId"];
    assert.equal(isPageBridgeMessage(missing), false);
  });

  test("enforces slug, bridge ID and event name constraints", () => {
    for (const slug of ["", "A", "../page", "a_1", "page\n", "a".repeat(65)]) {
      assert.throws(() => createPageBridgeMessage(slug, "frame", "page:ready", null), TypeError);
    }
    for (const bridgeId of ["", "  ", "a".repeat(129)]) {
      assert.throws(() => createPageBridgeMessage("page", bridgeId, "page:ready", null), TypeError);
    }
    for (const type of ["", "1event", "page::ready", "page ready", "page:ready\n", "a".repeat(81)]) {
      assert.throws(() => createPageBridgeMessage("page", "frame", type, null), TypeError);
    }
    assert.equal(isPageBridgeMessage(createPageBridgeMessage("a".repeat(64), "a".repeat(128), "a".repeat(80), null)), true);
  });

  test("bounds serialized UTF-8 payload bytes including quotes and escapes", () => {
    const exact = "a".repeat(MAX_PAGE_BRIDGE_PAYLOAD_BYTES - 2);
    assert.equal(isPageBridgeMessage({ ...valid(), payload: exact }), true);
    assert.equal(isPageBridgeMessage({ ...valid(), payload: `${exact}a` }), false);
    assert.equal(isPageBridgeMessage({ ...valid(), payload: "中".repeat(22_000) }), false);
    assert.equal(isPageBridgeMessage({ ...valid(), payload: "\n".repeat(33_000) }), false);
  });

  test("rejects non-JSON payload values rather than silently losing data", () => {
    for (const payload of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, () => {}, Symbol("x"), new Date(), new Map(), { omitted: undefined }, [undefined]]) {
      assert.equal(isPageBridgeMessage({ ...valid(), payload }), false);
    }
    assert.throws(() => createPageBridgeMessage("page", "frame", "host:event", undefined as unknown as JsonValue), TypeError);
  });

  test("rejects cycles but accepts repeated JSON references", () => {
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    assert.equal(isPageBridgeMessage({ ...valid(), payload: cycle }), false);
    const child = { value: 1 };
    assert.equal(isPageBridgeMessage({ ...valid(), payload: [child, child] }), true);
  });

  test("rejects excessive nesting", () => {
    let payload: unknown = null;
    for (let i = 0; i < 65; i += 1) payload = [payload];
    assert.equal(isPageBridgeMessage({ ...valid(), payload }), false);
  });

  test("never invokes envelope or payload accessors or toJSON", () => {
    let calls = 0;
    const get = () => { calls += 1; throw new Error("must not run"); };
    const envelope = Object.defineProperty(valid(), "payload", { enumerable: true, get });
    const payload = Object.defineProperty({}, "value", { enumerable: true, get });
    const array = Object.defineProperty([1], "0", { enumerable: true, get });
    assert.equal(isPageBridgeMessage(envelope), false);
    assert.equal(isPageBridgeMessage({ ...valid(), payload }), false);
    assert.equal(isPageBridgeMessage({ ...valid(), payload: array }), false);
    assert.equal(isPageBridgeMessage({ ...valid(), payload: { toJSON: get } }), false);
    assert.equal(calls, 0);
  });

  test("rejects hidden properties, dangerous keys, sparse and extended arrays", () => {
    const hidden = Object.defineProperty({}, "secret", { value: 1 });
    const symbol = { [Symbol("hidden")]: 1 };
    const extended = Object.assign([1], { extra: 2 });
    for (const payload of [hidden, symbol, new Array(1), extended, JSON.parse('{"__proto__":{"admin":true}}'), { constructor: "x" }, { prototype: "x" }]) {
      assert.equal(isPageBridgeMessage({ ...valid(), payload }), false);
    }
    assert.equal(isPageBridgeMessage({ ...valid(), payload: Object.assign(Object.create(null), { value: 1 }) }), true);
  });
});

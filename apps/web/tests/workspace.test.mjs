import assert from "node:assert/strict";
import { test } from "node:test";

const { normalizeGatewayUrl, GatewayError } = await import("../src/api/workspace.ts");

test("gateway URLs normalize whitespace and trailing slashes, preserving a deployment prefix", () => {
  assert.equal(normalizeGatewayUrl("  http://127.0.0.1:5173///  "), "http://127.0.0.1:5173");
  assert.equal(normalizeGatewayUrl("https://gateway.example/qdd/"), "https://gateway.example/qdd");
});

test("gateway URLs reject unsupported schemes and embedded credentials or query tokens", () => {
  for (const url of [
    "127.0.0.1:5173",
    "file:///tmp/gateway",
    "ftp://gateway.example",
    "https://user:secret@gateway.example",
    "https://gateway.example?access_token=secret",
    "https://gateway.example#settings",
  ]) {
    assert.throws(() => normalizeGatewayUrl(url));
  }
});

test("GatewayError retains its native Error behavior and HTTP status", () => {
  const error = new GatewayError(401, "未授权");
  assert.ok(error instanceof Error);
  assert.equal(error.name, "GatewayError");
  assert.equal(error.status, 401);
  assert.equal(error.message, "未授权");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveGatewayTarget } from "../gateway.config.ts";

test("gateway target defaults match the backend", () => {
  assert.equal(resolveGatewayTarget({}), "http://127.0.0.1:5173");
});

test("gateway config supplies the host and port when env is absent", () => {
  assert.equal(resolveGatewayTarget({}, { host: "gateway.example", port: 3000 }), "http://gateway.example:3000");
  assert.equal(resolveGatewayTarget({}, { port: 3000 }), "http://127.0.0.1:3000");
  assert.equal(resolveGatewayTarget({}, { host: "gateway.example" }), "http://gateway.example:5173");
});

test("HOST and PORT independently override gateway config", () => {
  const gateway = { host: "configured.example", port: 5173 };
  assert.equal(resolveGatewayTarget({ HOST: "env.example", PORT: "3000" }, gateway), "http://env.example:3000");
  assert.equal(resolveGatewayTarget({ HOST: "env.example" }, gateway), "http://env.example:5173");
  assert.equal(resolveGatewayTarget({ PORT: "3000" }, gateway), "http://configured.example:3000");
});

test("API_PROXY_TARGET overrides host and port and returns a canonical origin", () => {
  assert.equal(resolveGatewayTarget({ API_PROXY_TARGET: "https://gateway.example:443/", HOST: "invalid host", PORT: "invalid" }), "https://gateway.example");
  assert.equal(resolveGatewayTarget({ API_PROXY_TARGET: "http://gateway.example:3000" }), "http://gateway.example:3000");
});

test("wildcard listen hosts become reachable loopback origins", () => {
  for (const host of ["0.0.0.0", "::", "[::]"]) {
    assert.equal(resolveGatewayTarget({ HOST: host, PORT: "3000" }), "http://127.0.0.1:3000");
    assert.equal(resolveGatewayTarget({}, { host, port: 3000 }), "http://127.0.0.1:3000");
  }
});

test("IPv6 addresses are bracketed exactly once", () => {
  assert.equal(resolveGatewayTarget({ HOST: "::1", PORT: "3000" }), "http://[::1]:3000");
  assert.equal(resolveGatewayTarget({ HOST: "[::1]", PORT: "3000" }), "http://[::1]:3000");
  assert.equal(resolveGatewayTarget({}, { host: "2001:db8::1", port: 3000 }), "http://[2001:db8::1]:3000");
});

test("gateway ports accept integer boundaries and reject invalid values", () => {
  for (const port of [0, 65535]) {
    assert.equal(resolveGatewayTarget({ PORT: String(port) }), `http://127.0.0.1:${port}`);
    assert.equal(resolveGatewayTarget({}, { port }), `http://127.0.0.1:${port}`);
  }
  for (const port of ["", " ", "-1", "65536", "1.5", "invalid", "NaN", "Infinity"]) {
    assert.throws(() => resolveGatewayTarget({ PORT: port }), /0-65535/);
  }
  for (const port of [-1, 65536, 1.5, Number.NaN, Infinity]) {
    assert.throws(() => resolveGatewayTarget({}, { port }), /0-65535/);
  }
});

test("gateway targets reject non-origin URLs, credentials, and unsupported protocols", () => {
  for (const target of [
    "",
    "not-a-url",
    "gateway.example:3000",
    "file:///tmp/gateway",
    "ftp://gateway.example",
    "http://user:password@gateway.example",
    "https://gateway.example/path",
    "https://gateway.example/?token=value",
    "https://gateway.example/#section",
    "https://gateway.example/?",
    "https://gateway.example/#",
    "http://gateway.example:65536",
  ]) {
    assert.throws(() => resolveGatewayTarget({ API_PROXY_TARGET: target }), /网关地址无效/);
  }
});

test("invalid listen hosts cannot inject URL credentials, paths, or queries", () => {
  for (const host of ["", "invalid host", "user:password@gateway.example", "gateway.example/path", "gateway.example?token=value", "[invalid-ipv6]"]) {
    assert.throws(() => resolveGatewayTarget({ HOST: host }), /网关地址无效/);
  }
});

test("resolved origins and validation errors never expose unrelated secrets", () => {
  const secret = "do-not-expose-this-secret";
  const env = { DEEPSEEK_API_KEY: secret, QDD_GATEWAY_TOKEN: secret, PORT: "3000" };
  assert.equal(resolveGatewayTarget(env), "http://127.0.0.1:3000");
  for (const invalid of [
    { API_PROXY_TARGET: `https://user:${secret}@gateway.example` },
    { API_PROXY_TARGET: `https://gateway.example/?token=${secret}` },
    { HOST: `${secret}/path` },
    { PORT: secret },
  ]) {
    assert.throws(() => resolveGatewayTarget({ ...env, ...invalid }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes("user:"), false);
      return true;
    });
  }
});

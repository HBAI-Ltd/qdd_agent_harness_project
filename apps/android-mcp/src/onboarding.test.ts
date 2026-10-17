import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { boardSetupOrigin, startBoardRegistration } from "./onboarding.js";

test("onboarding accepts only explicit private board HTTP origins", () => {
  assert.equal(boardSetupOrigin("http://192.168.101.147:3334/"), "http://192.168.101.147:3334");
  for (const value of ["https://192.168.1.2", "http://example.com", "http://8.8.8.8", "http://192.168.1.2/path",
    "http://user@192.168.1.2", "http://192.168.1.2/?token=x", "http://192.168.1.2/#x", "invalid"]) {
    assert.throws(() => boardSetupOrigin(value));
  }
});

test("registration sends only PC port, retries offline, and close aborts the owned request", async () => {
  const calls: { url: string; body: unknown; signal: AbortSignal | null | undefined }[] = [];
  let aborted = false;
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), signal: init?.signal });
    if (calls.length === 1) throw new Error("Wi-Fi lost");
    await new Promise<void>((resolve) => init?.signal?.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    throw new Error("aborted");
  };
  const registration = startBoardRegistration("http://192.168.1.2:3334", 8790, { fetch: fetcher, intervalMs: 10, timeoutMs: 5000 });
  try {
    for (let i = 0; calls.length < 2 && i < 50; i++) await delay(10);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, "http://192.168.1.2:3334/api/pc");
    assert.deepEqual(calls[0]?.body, { port: 8790 });
  } finally { await registration.close(); }
  assert.equal(aborted, true);
  await delay(30);
  assert.equal(calls.length, 2);
});

test("actual HTTP registration handles an unfinished body and shuts down without leaking its timer", async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.url, "/api/pc");
    assert.equal(request.method, "POST");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write("{"); // Deliberately never finish: the client must not read this response forever.
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const registration = startBoardRegistration(`http://127.0.0.1:${address.port}`, 8790, { intervalMs: 10, timeoutMs: 200 });
  try {
    for (let i = 0; requests < 2 && i < 60; i++) await delay(10);
    assert.ok(requests >= 2);
    await registration.close();
    const stopped = requests; await delay(40); assert.equal(requests, stopped);
  } finally { await registration.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

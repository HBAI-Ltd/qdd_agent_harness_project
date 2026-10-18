import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { loadConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { startGateway, type Gateway } from "./gateway/server.js";
import { checkContent, pageCsp, parseMediaOrigins } from "./guard.js";
import { ensureWorkspace } from "./web/site.js";

function directives(value: string): Record<string, string[]> {
  return Object.fromEntries(value.split(";").map((entry) => {
    const [name, ...sources] = entry.trim().split(/\s+/);
    return [name!, sources];
  }));
}

async function temporaryRoot(t: TestContext): Promise<string> {
  const parent = path.resolve(tmpdir());
  const root = await mkdtemp(path.join(parent, "qdd-media-csp-"));
  t.after(async () => {
    const target = path.resolve(root);
    assert.equal(path.dirname(target), parent);
    assert.ok(path.basename(target).startsWith("qdd-media-csp-"));
    await rm(target, { recursive: true, force: true });
  });
  return root;
}

test("default page CSP keeps network access at self and permits only local media workers", () => {
  const csp = directives(pageCsp(["cdn.example.test"]));
  assert.deepEqual(csp["default-src"], ["'self'"]);
  assert.deepEqual(csp["connect-src"], ["'self'"]);
  assert.deepEqual(csp["media-src"], ["'self'", "blob:"]);
  assert.deepEqual(csp["worker-src"], ["'self'", "blob:"]);
  assert.deepEqual(csp["frame-src"], ["'self'"]);
  assert.deepEqual(csp["form-action"], ["'none'"]);
  assert.ok(!csp["script-src"]!.includes("'wasm-unsafe-eval'"));
  assert.ok(!csp["script-src"]!.includes("'unsafe-eval'"));
});

test("configured video origins allow exact HTTPS ports without becoming scripts or frames", () => {
  const value = pageCsp(["cdn.example.test"], ["http://127.0.0.1:5177"], [
    "https://media.example.test:8443/", "HTTPS://SECOND.EXAMPLE.TEST:443", "https://media.example.test:8443",
  ]);
  const csp = directives(value);
  const origins = ["https://media.example.test:8443", "https://second.example.test"];
  assert.deepEqual(csp["connect-src"], ["'self'", ...origins]);
  assert.deepEqual(csp["media-src"], ["'self'", "blob:", ...origins]);
  assert.deepEqual(csp["worker-src"], ["'self'", "blob:"]);
  assert.deepEqual(csp["frame-src"], ["'self'"]);
  assert.deepEqual(csp["frame-ancestors"], ["'self'", "http://127.0.0.1:5177"]);
  assert.ok(csp["script-src"]!.includes("'wasm-unsafe-eval'"));
  assert.ok(!csp["script-src"]!.includes("'unsafe-eval'"));
  for (const origin of origins) assert.ok(!csp["script-src"]!.includes(origin));
  assert.doesNotMatch(value, /[\r\n]|https:\/\/\*|(?:^|\s)\*(?:\s|;|$)/);
});

test("an explicit standalone wildcard allows all web video sources without allowing remote scripts or frames", () => {
  assert.deepEqual(parseMediaOrigins(["*"]), ["*"]);
  const csp = directives(pageCsp(["cdn.example.test"], [], ["*"]));
  assert.deepEqual(csp["connect-src"], ["'self'", "http:", "https:", "ws:", "wss:"]);
  assert.deepEqual(csp["media-src"], ["'self'", "http:", "https:", "blob:", "data:"]);
  assert.deepEqual(csp["worker-src"], ["'self'", "blob:"]);
  assert.deepEqual(csp["frame-src"], ["'self'"]);
  assert.deepEqual(csp["form-action"], ["'none'"]);
  assert.deepEqual(csp["script-src"], ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", "https://cdn.example.test"]);
});

const INVALID_MEDIA_ORIGINS: unknown[] = [
  null, "https://media.example.test", "*", {}, [null], [123], [""],
  ["*", "https://media.example.test"], ["*", "*"], [" *"], ["*\n"],
  ["http://media.example.test"], ["wss://media.example.test"], ["data:video/mp4,fixture"],
  ["https://media.example.test/video.flv"], ["https://media.example.test?signature=fixture"],
  ["https://media.example.test#fragment"], ["https://user:pass@media.example.test"],
  ["https://*"], ["https://*.example.test"], ["https://%2A"],
  [" https://media.example.test"], ["https://media.example.test\n"],
  ["https://media.example.test\r\nscript-src 'unsafe-eval'"],
  ["https://media.example.test; connect-src *"], ["https://media.example.test 'unsafe-eval'"],
  ["https://media.example.test\\attacker.test"], ["https://media.example.test:99999"],
];

test("video origin validation rejects arbitrary URLs and CSP injection before header generation", () => {
  for (const value of INVALID_MEDIA_ORIGINS) {
    assert.throws(() => parseMediaOrigins(value), /mediaOrigins/);
    assert.throws(() => pageCsp([], [], value as string[]), /mediaOrigins/);
  }
});

test("configuration defaults video origins to empty and validates explicitly configured origins", async (t) => {
  const root = await temporaryRoot(t);
  assert.deepEqual((await loadConfig(root)).config.mediaOrigins, []);
  await writeFile(path.join(root, "harness.config.json"), JSON.stringify({ mediaOrigins: ["https://media.example.test:8443/"] }));
  assert.deepEqual((await loadConfig(root)).config.mediaOrigins, ["https://media.example.test:8443"]);
  await writeFile(path.join(root, "harness.config.json"), JSON.stringify({ mediaOrigins: ["*"] }));
  assert.deepEqual((await loadConfig(root)).config.mediaOrigins, ["*"]);
  for (const value of INVALID_MEDIA_ORIGINS) {
    await writeFile(path.join(root, "harness.config.json"), JSON.stringify({ mediaOrigins: value }));
    await assert.rejects(loadConfig(root), /mediaOrigins/);
  }
});

test("video CSP does not relax business fetch, Ajax, websocket or form guards", () => {
  const origin = "https://media.example.test:8443";
  assert.ok(pageCsp([], [], [origin]).includes(origin));
  assert.deepEqual(directives(pageCsp([], [], ["*"]))["form-action"], ["'none'"]);
  for (const script of [
    `fetch("${origin}/business")`, `new XMLHttpRequest()`, `new WebSocket("wss://media.example.test")`,
    `<form action="${origin}/business" method="post"></form>`, `eval("fixture")`,
  ]) {
    // Even giving the media host the existing CDN allowance cannot enable these APIs.
    assert.notDeepEqual(checkContent(script, ["media.example.test"]), [], script);
  }
});

for (const mediaOrigins of [["https://media.example.test:8443"], ["*"]]) {
  test(`served task HTML receives the ${mediaOrigins[0] === "*" ? "all-source" : "exact-source"} video CSP`, async (t) => {
    const root = await temporaryRoot(t);
    await writeFile(path.join(root, "harness.config.json"), JSON.stringify({ mediaOrigins }));
    const loaded = await loadConfig(root);
    loaded.config.gateway.port = 0;
    loaded.config.datasets.refreshIntervalSec = 0;
    await ensureWorkspace(loaded.paths);
    await mkdir(path.join(loaded.paths.pages, "media-fixture"));
    await writeFile(path.join(loaded.paths.pages, "media-fixture", "index.html"), "<!doctype html><head></head><body>Local fixture</body>");
    const sources = await DataSources.open(loaded, { connectMcp: false });
    let gateway: Gateway | undefined;
    t.after(async () => { await gateway?.close(); await sources.close(); });
    const token = "media-csp-local-fixture-token";
    gateway = await startGateway(loaded, sources, { token, chat: () => async () => ({ role: "assistant", content: "unused" }), scheduler: false });
    const response = await fetch(`${gateway.url}/pages/media-fixture/index.html`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const csp = directives(response.headers.get("content-security-policy") ?? "");
    const allMedia = mediaOrigins[0] === "*";
    assert.deepEqual(csp["connect-src"], allMedia ? ["'self'", "http:", "https:", "ws:", "wss:"] : ["'self'", "https://media.example.test:8443"]);
    assert.deepEqual(csp["media-src"], allMedia ? ["'self'", "http:", "https:", "blob:", "data:"] : ["'self'", "blob:", "https://media.example.test:8443"]);
    assert.deepEqual(csp["worker-src"], ["'self'", "blob:"]);
    assert.ok(csp["script-src"]!.includes("'wasm-unsafe-eval'"));
  });
}

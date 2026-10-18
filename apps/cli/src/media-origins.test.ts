import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { startGateway, type Gateway } from "./gateway/server.js";
import { checkContent, pageCsp, parseMediaOrigins } from "./guard.js";
import { ensureWorkspace } from "./web/site.js";

function directive(policy: string, name: string): string[] {
  return policy.split(";").map((part) => part.trim().split(/\s+/)).find((parts) => parts[0] === name)?.slice(1) ?? [];
}

test("media origins retain opt-in HTTPS and wildcard behavior and accept exact HTTP loopback origins", () => {
  assert.deepEqual(DEFAULT_CONFIG.mediaOrigins, []);
  assert.deepEqual(parseMediaOrigins([]), []);
  assert.deepEqual(parseMediaOrigins(["*"]), ["*"]);
  assert.deepEqual(parseMediaOrigins([
    "https://media.example.test:9443/", "http://localhost:8790/",
    "http://127.0.0.1:8790", "http://[::1]:8790", "http://LOCALHOST:8790",
  ]), ["https://media.example.test:9443", "http://localhost:8790", "http://127.0.0.1:8790", "http://[::1]:8790"]);
});

test("media origins reject external HTTP, disguised loopback addresses and non-origin URL parts", () => {
  for (const value of [undefined, null, {}, "*", 1]) assert.throws(() => parseMediaOrigins(value), /mediaOrigins/);
  for (const entry of [
    "http://media.example.test:8790", "http://192.168.1.2:8790", "http://127.0.0.2:8790",
    "http://localhost.example.test:8790", "http://localhost.:8790", "http://127.0.0.1.example.test:8790",
    "http://127.1:8790", "http://2130706433:8790", "http://0x7f000001:8790", "http://0177.0.0.1:8790",
    "http://[0:0:0:0:0:0:0:1]:8790", "http://[::ffff:127.0.0.1]:8790",
    "http://user:pass@localhost:8790", "http://localhost:8790/path", "http://localhost:8790/..",
    "http://localhost:8790?token=secret", "http://localhost:8790#fragment", "http://localhost:8790?",
    "http://localhost:8790#", "http://localhost:*", "http://localhost:65536", "http://localhost:",
    "http://local%68ost:8790", "http://localhost:8790;script-src *", "http://localhost:8790\nhttps://evil.test",
    "http://localhost:8790\\path", "https://media.example.test/path", "https://user@media.example.test",
    "https://*.example.test", "ws://localhost:8790", "file://localhost/", 42,
  ]) assert.throws(() => parseMediaOrigins([entry]), /mediaOrigins/, String(entry));
  assert.throws(() => parseMediaOrigins(["*", "http://localhost:8790"]), /mediaOrigins/);
});

test("HTTP media permissions apply only to exact connect and media sources without widening script or iframe hosts", () => {
  const origin = "http://127.0.0.1:8790";
  const scope = { origin: "http://localhost:5173", slug: "camera-fixture" };
  const before = pageCsp([], [], scope);
  const after = pageCsp([], [], scope, [origin]);
  for (const name of ["connect-src", "media-src"]) {
    assert.ok(directive(after, name).includes(origin));
    for (const unlisted of ["http://127.0.0.1:8791", "http://localhost:8790", "http://[::1]:8790", "http:", "https:", "*"])
      assert.ok(!directive(after, name).includes(unlisted), `${name} excludes ${unlisted}`);
  }
  for (const name of ["script-src", "style-src", "frame-src", "worker-src"])
    assert.ok(!directive(after, name).includes(origin), name);
  assert.deepEqual(directive(after, "frame-src"), directive(before, "frame-src"));
  assert.deepEqual(directive(after, "script-src").filter((source) => source !== "'wasm-unsafe-eval'"), directive(before, "script-src"));
  assert.deepEqual(directive(after, "form-action"), ["'none'"]);
  assert.notDeepEqual(checkContent('fetch("/business")', []), []);
});

test("a running gateway loads exact HTTP media permissions from configuration on the next page request", async (t) => {
  const parent = path.resolve(tmpdir());
  const root = await mkdtemp(path.join(parent, "qdd-media-origins-"));
  let sources: DataSources | undefined;
  let gateway: Gateway | undefined;
  t.after(async () => {
    await gateway?.close();
    await sources?.close();
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith("qdd-media-origins-"));
    await rm(root, { recursive: true, force: true });
  });
  const configFile = path.join(root, "harness.config.json");
  const mediaOrigin = "http://127.0.0.1:8790";
  await writeFile(configFile, JSON.stringify({ mediaOrigins: [mediaOrigin] }));
  const loaded = await loadConfig(root);
  assert.deepEqual(loaded.config.mediaOrigins, [mediaOrigin]);
  loaded.config.gateway.port = 0;
  await ensureWorkspace(loaded.paths);
  const pageDirectory = path.join(loaded.paths.pages, "media-fixture");
  await mkdir(pageDirectory);
  await writeFile(path.join(pageDirectory, "index.html"), "<!doctype html><head></head><body>Offline fixture</body>");
  sources = await DataSources.open(loaded, { connectMcp: false });
  const token = "media-origins-local-fixture-token";
  gateway = await startGateway(loaded, sources, {
    token, scheduler: false, chat: () => async () => ({ role: "assistant", content: "unused" }),
  });
  const policy = async () => {
    const response = await fetch(`${gateway!.url}/pages/media-fixture/`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const csp = response.headers.get("content-security-policy") ?? "";
    await response.arrayBuffer();
    return csp;
  };
  const initial = await policy();
  assert.ok(directive(initial, "connect-src").includes(mediaOrigin));
  assert.ok(directive(initial, "media-src").includes(mediaOrigin));
  assert.ok(!directive(initial, "connect-src").includes("http://127.0.0.1:8791"));
  await writeFile(configFile, JSON.stringify({ mediaOrigins: [] }));
  assert.ok(!directive(await policy(), "connect-src").includes(mediaOrigin));
  await writeFile(configFile, JSON.stringify({ mediaOrigins: ["http://[::1]:8790"] }));
  const changed = await policy();
  assert.ok(directive(changed, "connect-src").includes("http://[::1]:8790"));
  assert.ok(!directive(changed, "connect-src").includes(mediaOrigin));
  assert.ok(!directive(changed, "script-src").includes("http://[::1]:8790"));
});

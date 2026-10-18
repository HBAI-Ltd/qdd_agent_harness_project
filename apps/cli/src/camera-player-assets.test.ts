import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { startGateway, type Gateway } from "./gateway/server.js";
import { ensureWorkspace } from "./web/site.js";

test("camera player assets and live media permissions are served by the running gateway", async (t) => {
  const parent = path.resolve(tmpdir());
  const root = await mkdtemp(path.join(parent, "qdd-camera-assets-"));
  let sources: DataSources | undefined;
  let gateway: Gateway | undefined;
  t.after(async () => {
    await gateway?.close();
    await sources?.close();
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith("qdd-camera-assets-"));
    await rm(root, { recursive: true, force: true });
  });
  const configFile = path.join(root, "harness.config.json");
  await writeFile(configFile, JSON.stringify({ mediaOrigins: [] }));
  const loaded = await loadConfig(root);
  loaded.config.gateway.port = 0;
  loaded.config.datasets.refreshIntervalSec = 0;
  await ensureWorkspace(loaded.paths);
  const page = path.join(loaded.paths.pages, "camera-fixture");
  await mkdir(page);
  await writeFile(path.join(page, "index.html"), "<!doctype html><head></head><body>Offline fixture</body>");
  sources = await DataSources.open(loaded, { connectMcp: false });
  const token = "camera-assets-local-fixture-token";
  gateway = await startGateway(loaded, sources, {
    token, scheduler: false, chat: () => async () => ({ role: "assistant", content: "unused" }),
  });
  for (const [file, mime] of [["index.js", "text/javascript"], ["style.css", "text/css"], ["decoder.js", "text/javascript"], ["decoder.wasm", "application/wasm"]]) {
    const response = await fetch(`${gateway.url}/assets/camera-player/${file}`);
    assert.equal(response.status, 200, file);
    assert.ok(response.headers.get("content-type")?.startsWith(mime!), file);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.ok(bytes.length > 0);
    if (file === "decoder.wasm") assert.deepEqual([...bytes.slice(0, 4)], [0, 97, 115, 109]);
  }
  for (const file of ["package.json", "../package.json", "%2e%2e%2fpackage.json", "decoder.wasm/extra"]) {
    assert.equal((await fetch(`${gateway.url}/assets/camera-player/${file}`)).status, 404);
  }
  const policy = async () => {
    const response = await fetch(`${gateway!.url}/pages/camera-fixture/`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    return response.headers.get("content-security-policy") ?? "";
  };
  assert.match(await policy(), /connect-src 'self';/);
  await writeFile(configFile, JSON.stringify({ mediaOrigins: ["*"] }));
  const allowed = await policy();
  assert.match(allowed, /connect-src 'self' http: https: ws: wss:;/);
  assert.match(allowed, /media-src 'self' http: https: blob: data:;/);
  assert.match(allowed, /'wasm-unsafe-eval'/);
  await writeFile(configFile, JSON.stringify({ mediaOrigins: [] }));
  const revoked = await policy();
  assert.match(revoked, /connect-src 'self';/);
  assert.doesNotMatch(revoked, /'wasm-unsafe-eval'/);
});

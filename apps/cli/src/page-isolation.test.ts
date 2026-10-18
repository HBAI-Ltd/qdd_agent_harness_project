import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, after, test } from "node:test";
import { loadConfig, type LoadedConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { Auth } from "./gateway/auth.js";
import { startGateway, type Gateway } from "./gateway/server.js";
import { ensureWorkspace, upsertPage } from "./web/site.js";

const token = "page-isolation-test-administrator-token";
const slug = "isolated";
const pageToken = new Auth(token).pageToken(slug);
const headers = { Origin: "null", "X-QDD-Page": slug, "X-QDD-Page-Token": pageToken };
let loaded: LoadedConfig;
let sources: DataSources;
let gateway: Gateway;
let root: string;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "qdd-page-isolation-"));
  loaded = await loadConfig(root);
  loaded.config.gateway.port = 0;
  loaded.config.gateway.host = "127.0.0.1";
  await ensureWorkspace(loaded.paths);
  sources = await DataSources.open(loaded);
  await mkdir(path.join(loaded.paths.pages, slug), { recursive: true });
  await writeFile(path.join(loaded.paths.pages, slug, "index.html"), "<html><head></head><body>Isolated</body></html>");
  await writeFile(path.join(loaded.paths.pages, slug, "module.js"), "export const value = 7;");
  const at = new Date().toISOString();
  await upsertPage(loaded.paths, { slug, title: slug, wish: "test", summary: "", tools: ["store__get_store_info"], useAgent: true,
    metrics: [], datasets: {}, version: 1, stale: null, gaps: [], sessionId: "test", createdAt: at, updatedAt: at });
  gateway = await startGateway(loaded, sources, { token, scheduler: false, chat: () => async () => ({ role: "assistant", content: "ok" }) });
});
after(async () => { await gateway?.close(); await sources?.close(); if (root) await rm(root, { recursive: true, force: true }); });

test("legacy entry links redirect to an authenticated directory without changing relative resource depth", async () => {
  const entry = await fetch(`${gateway.url}/pages/${slug}/?page_token=${pageToken}`, { redirect: "manual" });
  assert.equal(entry.status, 302);
  assert.equal(entry.headers.get("location"), `/pages/${slug}~${pageToken}/`);
  assert.equal(entry.headers.get("referrer-policy"), "no-referrer");
  assert.equal(new URL("../../assets/theme.css", gateway.url + entry.headers.get("location")).pathname, "/assets/theme.css");
  const cookie = entry.headers.get("set-cookie")!.split(";")[0]!;
  const legacy = await fetch(`${gateway.url}/pages/${slug}/`, { headers: { cookie } });
  assert.equal(legacy.status, 200);
  assert.ok(legacy.url.includes(`/${slug}~${pageToken}/`));
});

test("opaque modules use directory credentials without cookies and reject invalid credentials", async () => {
  const response = await fetch(`${gateway.url}/pages/${slug}~${pageToken}/module.js`, { headers: { Origin: "null" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "null");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const policy = response.headers.get("content-security-policy")!;
  assert.match(policy, /sandbox allow-scripts allow-downloads allow-modals/);
  assert.equal(policy.includes("allow-same-origin"), false);
  assert.ok(policy.includes(`script-src ${gateway.url}/pages/${slug}~${pageToken}/`));
  const invalid = await fetch(`${gateway.url}/pages/${slug}~invalid/module.js`, { headers: { Origin: "null" } });
  assert.equal(invalid.status, 401);
  assert.equal(invalid.headers.get("access-control-allow-origin"), null);
  assert.equal((await fetch(`${gateway.url}/pages/${slug}/module.js`)).status, 401);
});

test("opaque API CORS requires a page token and never exposes admin APIs", async () => {
  const response = await fetch(`${gateway.url}/api/tools/store__get_store_info`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "null");
  const invalid = await fetch(`${gateway.url}/api/state/${slug}`, { headers: { ...headers, "X-QDD-Page-Token": "invalid" } });
  assert.equal(invalid.status, 401);
  assert.equal(invalid.headers.get("access-control-allow-origin"), null);
  const admin = await fetch(`${gateway.url}/api/sessions`, { headers: { Origin: "null", Authorization: `Bearer ${token}` } });
  assert.equal(admin.status, 200); // Authentication remains valid; browser CORS denies access.
  assert.equal(admin.headers.get("access-control-allow-origin"), null);
});

test("opaque preflights allow page headers only on runtime routes", async () => {
  const preflight = { Origin: "null", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-qdd-page,x-qdd-page-token" };
  const allowed = await fetch(`${gateway.url}/api/ask`, { method: "OPTIONS", headers: preflight });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "null");
  for (const [route, requestHeaders] of [["/api/sessions", preflight], ["/api/ask", { ...preflight, "Access-Control-Request-Headers": "authorization" }]] as const) {
    const denied = await fetch(gateway.url + route, { method: "OPTIONS", headers: requestHeaders });
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
  }
});

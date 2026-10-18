import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { CameraAccountStatus, ConnectorView, LocalMcpProvider, ToolInfo } from "@qdd/shared";
import { loadConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { startGateway, type Gateway } from "./gateway/server.js";
import { ensureWorkspace, writeAtomic } from "./web/site.js";

const TOKEN = "connector-choice-gateway-token";
const PROVIDERS: LocalMcpProvider[] = ["haik", "tysl", "ezviz", "shouqianba"];

async function setup(t: TestContext) {
  const parent = path.resolve(tmpdir());
  const root = await mkdtemp(path.join(parent, "qdd-connector-choice-"));
  const requests: { provider: string; method: string }[] = [];
  const failures = new Set<string>();
  const blockers = new Map<string, { entered: () => void; wait: Promise<void> }>();
  const releases: (() => void)[] = [];
  const instances: DataSources[] = [];
  let gateway: Gateway | undefined;
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith("/api/")) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ connected: true, cameraCount: 2 }));
      return;
    }
    if (req.method === "DELETE") return void res.writeHead(200).end();
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as { id?: number; method: string; params?: { name?: string } };
    const provider = req.url!.split("/")[1]!;
    requests.push({ provider, method: body.method });
    if (body.id === undefined) return void res.writeHead(202).end();
    if (body.method === "tools/list") {
      const blocker = blockers.get(provider);
      if (blocker) {
        blockers.delete(provider);
        blocker.entered();
        await blocker.wait;
      }
    }
    if (failures.has(provider)) return void res.writeHead(503).end("offline fixture");
    if (provider === "shouqianba") assert.equal(req.headers.authorization, "Bearer offline-mcp-key");
    const result = body.method === "tools/list" ? { tools: [
      { name: `${provider}_list`, description: "offline list", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      ...(provider === "shouqianba" ? [] : [{ name: `${provider}_ptz`, description: "offline camera move", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } }]),
    ] } : body.method === "tools/call" ? { structuredContent: { provider, tool: body.params?.name } } : {};
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  t.after(async () => {
    for (const release of releases) release();
    await gateway?.close();
    await Promise.all(instances.map((sources) => sources.close()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const target = path.resolve(root);
    assert.equal(path.dirname(target), parent);
    assert.ok(path.basename(target).startsWith("qdd-connector-choice-"));
    await rm(target, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const loaded = await loadConfig(root);
  loaded.config.gateway.port = 0;
  // Existing vendor addresses are connection settings, never an implicit installation.
  loaded.config.mcpServers = Object.fromEntries(PROVIDERS.map((provider) => [provider, { url: `http://127.0.0.1:${address.port}/${provider}/mcp` }]));
  await ensureWorkspace(loaded.paths);
  await writeAtomic(path.join(root, "mcp/.local/shouqianba/mcp-key"), "offline-mcp-key");
  const reopen = async (connectMcp = true) => {
    const sources = await DataSources.open(loaded, { connectMcp });
    instances.push(sources);
    return sources;
  };
  const sources = await reopen();
  gateway = await startGateway(loaded, sources, { token: TOKEN, chat: () => async () => ({ role: "assistant", content: "offline" }), scheduler: false });
  const api = (route: string, init: RequestInit = {}) => fetch(gateway!.url + route, {
    ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...init.headers },
  });
  const install = (provider: LocalMcpProvider) => api("/api/connectors", {
    method: "POST", body: JSON.stringify({ type: provider === "shouqianba" ? "pos" : "camera", mode: "mcp", provider }),
  });
  const list = async () => (await (await api("/api/connectors")).json()) as { catalog: { type: string; available: boolean }[]; connectors: ConnectorView[] };
  const tools = async () => (await (await api("/api/tools")).json()) as ToolInfo[];
  const blockNextTools = (provider: string) => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    releases.push(release);
    blockers.set(provider, { entered, wait });
    return { started, release };
  };
  return { loaded, sources, requests, failures, api, install, list, tools, reopen, blockNextTools };
}

test("vendor MCP addresses expose available catalog choices without installing or contacting services", async (t) => {
  const { sources, requests, list, tools, api } = await setup(t);
  const result = await list();
  assert.ok(result.catalog.find((entry) => entry.type === "pos")?.available);
  assert.ok(result.catalog.find((entry) => entry.type === "camera")?.available);
  assert.deepEqual(result.connectors, []);
  assert.deepEqual(Object.keys(sources.mcpServers), []);
  assert.ok((await tools()).every((tool) => tool.source === "store"));
  const cameras = (await (await api("/api/cameras")).json()) as CameraAccountStatus[];
  assert.ok(cameras.every((camera) => !camera.configured));
  assert.deepEqual(requests, []);
});

for (const provider of ["haik", "tysl", "ezviz"] as const) {
  test(`choosing ${provider} loads only its tools, persists the choice, and uninstall revokes tools immediately`, async (t) => {
    const { sources, requests, install, list, tools, api, reopen } = await setup(t);
    const stableTools = sources.tools;
    const response = await install(provider);
    assert.equal(response.status, 201, await response.clone().text());
    const view = (await response.json()) as ConnectorView;
    assert.equal(view.id, `mcp:${provider}`);
    assert.equal(view.permission, "confirm");
    assert.deepEqual(Object.keys(sources.mcpServers), [provider]);
    assert.deepEqual((await list()).connectors.map((connector) => connector.id), [view.id]);
    const mcpTools = (await tools()).filter((tool) => tool.source.startsWith("mcp:"));
    assert.equal(mcpTools.length, 2);
    assert.ok(mcpTools.every((tool) => tool.source === `mcp:${provider}`));
    const readTool = `mcp__${provider}__${provider}_list`;
    assert.equal((await api(`/api/tools/${readTool}`, { method: "POST", body: "{}" })).status, 200);
    assert.equal((await api(`/api/tools/mcp__${provider}__${provider}_ptz`, { method: "POST", body: "{}" })).status, 403);
    assert.equal((await api(`/api/connectors/${encodeURIComponent(view.id)}/test`, { method: "POST", body: "{}" })).status, 400);
    assert.equal((await api(`/api/connectors/${encodeURIComponent(view.id)}/verify`, { method: "POST", body: "{}" })).status, 200);
    assert.equal(sources.tools, stableTools);
    assert.equal(sources.tools.filter((tool) => tool.source === `mcp:${provider}`).length, 2);
    assert.deepEqual(sources.warnings, []);
    assert.ok(requests.every((request) => request.provider === provider));
    if (provider !== "ezviz") {
      const cameras = (await (await api("/api/cameras")).json()) as CameraAccountStatus[];
      assert.equal(cameras.find((camera) => camera.provider === provider)?.configured, true);
      assert.equal(cameras.find((camera) => camera.provider === provider)?.connected, true);
    }
    const reopened = await reopen();
    assert.ok(reopened.get(readTool));
    const localOnly = await reopen(false);
    assert.ok(localOnly.tools.every((tool) => tool.source === "store"));
    assert.deepEqual(Object.keys(localOnly.mcpServers), []);
    const deleted = await api(`/api/connectors/${encodeURIComponent(view.id)}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal(sources.get(readTool), undefined);
    assert.equal((await api(`/api/tools/${readTool}`, { method: "POST", body: "{}" })).status, 404);
    assert.deepEqual((await list()).connectors, []);
    const afterDelete = await reopen();
    assert.deepEqual(Object.keys(afterDelete.mcpServers), []);
  });
}

test("POS installation registers read-only tools and cannot send notifications", async (t) => {
  const { sources, install, api, list } = await setup(t);
  const response = await install("shouqianba");
  assert.equal(response.status, 201, await response.clone().text());
  const view = (await response.json()) as ConnectorView;
  assert.equal(view.type, "pos");
  assert.equal(view.permission, "read");
  assert.ok(sources.get("mcp__shouqianba__shouqianba_list"));
  assert.equal((await api(`/api/connectors/${encodeURIComponent(view.id)}/test`, { method: "POST", body: "{}" })).status, 400);
  assert.deepEqual((await list()).connectors.map((connector) => connector.id), [view.id]);
});

test("an unavailable chosen provider fails without saving or enabling any connector", async (t) => {
  const { loaded, sources, failures, install, list } = await setup(t);
  failures.add("ezviz");
  const response = await install("ezviz");
  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /连接失败/);
  assert.deepEqual((await list()).connectors, []);
  assert.deepEqual(Object.keys(sources.mcpServers), []);
  const saved = await readFile(loaded.paths.connectors, "utf8").catch(() => "");
  assert.doesNotMatch(saved, /ezviz/);
});

test("queued reload observes an uninstall made during an earlier connection attempt", async (t) => {
  const { loaded, sources, install, api, blockNextTools } = await setup(t);
  assert.equal((await install("haik")).status, 201);
  const gate = blockNextTools("haik");
  const reloading = sources.reloadMcp(loaded);
  await gate.started;
  const deletion = api("/api/connectors/mcp%3Ahaik", { method: "DELETE" });
  const deadline = Date.now() + 5000;
  while (JSON.parse(await readFile(loaded.paths.connectors, "utf8")).connectors.length) {
    assert.ok(Date.now() < deadline, "uninstall must persist before its queued reload");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  gate.release();
  await reloading;
  assert.equal((await deletion).status, 200);
  assert.deepEqual(Object.keys(sources.mcpServers), []);
  assert.ok(sources.tools.every((tool) => tool.source === "store"));
  assert.deepEqual(sources.warnings, []);
});

test("reload replaces connection warnings and uninstall clears failed tools and warnings", async (t) => {
  const { loaded, sources, failures, install, api, list } = await setup(t);
  assert.equal((await install("tysl")).status, 201);
  failures.add("tysl");
  await sources.reloadMcp(loaded);
  await sources.reloadMcp(loaded);
  assert.equal(sources.warnings.length, 1);
  assert.equal(sources.get("mcp__tysl__tysl_list"), undefined);
  assert.equal((await list()).connectors[0]?.status, "error");
  assert.equal((await api("/api/connectors/mcp%3Atysl", { method: "DELETE" })).status, 200);
  assert.deepEqual(sources.warnings, []);
});

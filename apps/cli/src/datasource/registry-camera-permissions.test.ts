import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { JsonObject } from "@qdd/shared";
import { loadConfig } from "../config.js";
import type { McpTool } from "./mcp-client.js";
import { DataSources } from "./registry.js";
import { writeAtomic } from "../web/site.js";

type Catalog = Record<string, McpTool[]>;
type Dispatch = { provider: string; name: string; args: JsonObject };

// Import tool metadata only. Vendor actions, credentials and media are never opened.
async function cameraCatalog(): Promise<Catalog> {
  const [haik, ezviz, tysl] = await Promise.all([
    import(new URL("../../../../mcp/sites/haik-console/lib/mcp-tools.mjs", import.meta.url).href),
    import(new URL("../../../../mcp/apps/ezviz-console/lib/mcp-tools.mjs", import.meta.url).href),
    import(new URL("../../../../mcp/apps/tysl-console/lib/mcp.mjs", import.meta.url).href),
  ]);
  const listed = await tysl.handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  return { haik: haik.CAMERA_TOOLS, ezviz: ezviz.CAMERA_TOOLS, tysl: listed.body.result.tools };
}

async function setup(t: TestContext, options: { catalog?: Catalog; allowWrite?: boolean } = {}) {
  const parent = path.resolve(tmpdir());
  const root = await mkdtemp(path.join(parent, "qdd-camera-permissions-"));
  const catalog = options.catalog ?? await cameraCatalog();
  const dispatched: Dispatch[] = [];
  let sources: DataSources | undefined;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: JsonObject } };
    if (message.id === undefined) return void res.writeHead(202).end();
    const provider = (req.url ?? "").slice(1);
    let result: unknown = {};
    if (message.method === "tools/list") result = { tools: catalog[provider] ?? [] };
    if (message.method === "tools/call") {
      dispatched.push({ provider, name: message.params?.name ?? "", args: message.params?.arguments ?? {} });
      result = { structuredContent: { mocked: true } };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  t.after(async () => {
    await sources?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const target = path.resolve(root);
    assert.equal(path.dirname(target), parent);
    assert.ok(path.basename(target).startsWith("qdd-camera-permissions-"));
    await rm(target, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const loaded = await loadConfig(root);
  loaded.config.mcpServers = Object.fromEntries(Object.keys(catalog).map((name) => [
    name,
    { url: `http://127.0.0.1:${address.port}/${name}`, allowWrite: options.allowWrite ?? false },
  ]));
  await writeAtomic(loaded.paths.connectors, JSON.stringify({ connectors: Object.keys(catalog)
    .filter((provider) => ["haik", "tysl", "ezviz"].includes(provider))
    .map((provider) => ({ id: `mcp:${provider}`, type: "camera", mode: "mcp", provider, permission: "confirm" })) }));
  sources = await DataSources.open(loaded);
  assert.deepEqual(sources.warnings, []);
  return { sources, dispatched, catalog };
}

test("rejecting camera movement, snapshots and capture changes never dispatches them", async (t) => {
  const { sources, dispatched } = await setup(t);
  let asked = 0;
  const reject = async () => { asked++; return false; };
  for (const [provider, names] of [
    ["haik", ["move_camera", "camera_snapshot", "camera_capture_start", "capture_cancel"]],
    ["ezviz", ["ezviz_camera_ptz", "ezviz_camera_snapshot", "ezviz_camera_capture_start", "ezviz_capture_cancel"]],
    ["tysl", ["tysl_camera_ptz", "tysl_camera_snapshot", "tysl_camera_capture_start", "tysl_capture_cancel"]],
  ] as const) {
    for (const toolName of names) {
      const name = `mcp__${provider}__${toolName}`;
      assert.equal(sources.get(name)?.mutating, true, name);
      assert.equal(sources.get(name)?.preauthorized, false, name);
      await assert.rejects(sources.call(name, { cameraId: "offline-camera" }, reject), /用户未授权/);
    }
  }
  assert.equal(asked, 12);
  assert.deepEqual(dispatched, []);
});

test("camera lists and capture status remain readable without authorization", async (t) => {
  const { sources, dispatched } = await setup(t);
  let asked = 0;
  for (const [provider, names] of [
    ["haik", ["list_cameras", "capture_status", "capture_list"]],
    ["ezviz", ["ezviz_camera_list", "ezviz_capture_status", "ezviz_capture_list"]],
    ["tysl", ["tysl_camera_list", "tysl_capture_status", "tysl_capture_list"]],
  ] as const) {
    for (const toolName of names) {
      const name = `mcp__${provider}__${toolName}`;
      assert.equal(sources.get(name)?.mutating, false, name);
      assert.deepEqual(await sources.call(name, {}, async () => { asked++; return false; }), { mocked: true });
    }
  }
  assert.equal(asked, 0);
  assert.equal(dispatched.length, 9);
});

test("known non-destructive emergency camera stops do not wait for approval", async (t) => {
  const { sources, dispatched } = await setup(t);
  for (const [provider, toolName] of [["haik", "stop_camera"], ["ezviz", "ezviz_camera_stop"], ["tysl", "tysl_camera_stop"]]) {
    const name = `mcp__${provider}__${toolName}`;
    assert.equal(sources.get(name)?.mutating, true, name);
    assert.equal(sources.get(name)?.preauthorized, true, name);
    await sources.call(name, { cameraId: "offline-camera" }, async () => { throw new Error("Emergency stop must not wait"); });
  }
  assert.equal(dispatched.length, 3);
});

test("camera movement requires approval while custom MCP preauthorization remains available", async (t) => {
  const { sources, dispatched } = await setup(t);
  const args = { cameraId: "offline-camera", direction: "left" };
  let asked = 0;
  await sources.call("mcp__tysl__tysl_camera_ptz", args, async () => { asked++; return true; });
  assert.equal(asked, 1);
  assert.deepEqual(dispatched, [{ provider: "tysl", name: "tysl_camera_ptz", args }]);
  const preauthorized = await setup(t, { allowWrite: true });
  assert.equal(preauthorized.sources.get("mcp__haik__camera_capture_start")?.preauthorized, false);
  await assert.rejects(preauthorized.sources.call("mcp__haik__camera_capture_start", {}, async () => false), /用户未授权/);
  const custom = await setup(t, { allowWrite: true, catalog: { external: [{ name: "camera_capture_start", description: "custom capture", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } }] } });
  await custom.sources.call("mcp__external__camera_capture_start", { cameraId: "offline-camera", durationSeconds: 10 }, async () => {
    throw new Error("Configured preauthorization should be respected");
  });
  assert.equal(custom.dispatched.length, 1);
});

test("explicit mutation and destructive hints override benign names or read-only hints", async (t) => {
  const tool = (name: string, annotations?: McpTool["annotations"]): McpTool => ({
    name, description: "offline permission probe", inputSchema: { type: "object" }, ...(annotations ? { annotations } : {}),
  });
  const { sources, dispatched } = await setup(t, { catalog: {
    haik: [tool("probe_camera", { readOnlyHint: false }), tool("stop_camera", { readOnlyHint: false, destructiveHint: true })],
    external: [tool("update_status", { readOnlyHint: true }), tool("delete_anything", { readOnlyHint: true, destructiveHint: true }), tool("start_job"), tool("stop_camera", { readOnlyHint: false, destructiveHint: false })],
  } });
  for (const name of ["mcp__haik__probe_camera", "mcp__haik__stop_camera", "mcp__external__delete_anything", "mcp__external__start_job", "mcp__external__stop_camera"]) {
    assert.equal(sources.get(name)?.mutating, true, name);
    assert.equal(sources.get(name)?.preauthorized, false, name);
    await assert.rejects(sources.call(name, {}, async () => false), /用户未授权/);
  }
  assert.deepEqual(dispatched, []);
  assert.equal(sources.get("mcp__external__update_status")?.mutating, false);
  await sources.call("mcp__external__update_status", {}, async () => false);
  assert.equal(dispatched.length, 1);
});

test("every TYSL tool declares whether it reads or changes state", async (t) => {
  const { catalog } = await setup(t);
  assert.equal(catalog.tysl?.length, 14);
  for (const tool of catalog.tysl ?? []) {
    assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", tool.name);
  }
});

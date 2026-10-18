import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { loadConfig } from "../config.js";
import { McpClient } from "./mcp-client.js";

async function temporaryRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "qdd-mcp-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function mockMcp(t: TestContext) {
  const requests: { method: string; authorization: string | null }[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id?: number; method: string };
    requests.push({ method: body.method, authorization: new Headers(init.headers).get("Authorization") });
    if (body.id === undefined) return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "tools/list" ? { tools: [] } : {} });
  });
  return requests;
}

test("MCP 密钥文件相对项目根目录解析，绝对路径与环境变量配置保留", async (t) => {
  const root = await temporaryRoot(t);
  const absoluteFile = path.join(root, "absolute-key");
  await writeFile(path.join(root, "harness.config.json"), JSON.stringify({
    mcpServers: {
      relative: { url: "http://127.0.0.1:8788/mcp", bearerTokenFile: "mcp/.local/shouqianba/mcp-key" },
      absolute: { url: "http://127.0.0.1:8788/mcp", bearerTokenFile: absoluteFile },
      env: { url: "https://mcp.example/mcp", bearerTokenEnv: "QDD_MCP_AUTH_CONFIG_TEST" },
    },
  }));
  const { config } = await loadConfig(root);
  assert.equal(config.mcpServers.relative?.bearerTokenFile, path.join(root, "mcp", ".local", "shouqianba", "mcp-key"));
  assert.equal(config.mcpServers.absolute?.bearerTokenFile, absoluteFile);
  assert.equal(config.mcpServers.env?.bearerTokenEnv, "QDD_MCP_AUTH_CONFIG_TEST");
});

test("MCP 配置拒绝同时指定密钥文件和环境变量，以及空白或非字符串来源", async (t) => {
  const root = await temporaryRoot(t);
  const cases = [
    { bearerTokenEnv: "QDD_MCP_AUTH_TEST", bearerTokenFile: "key" },
    { bearerTokenFile: " " },
    { bearerTokenFile: 1 },
    { bearerTokenEnv: "" },
    { bearerTokenEnv: null },
  ];
  for (const source of cases) {
    await writeFile(path.join(root, "harness.config.json"), JSON.stringify({ mcpServers: { test: { url: "http://127.0.0.1/mcp", ...source } } }));
    await assert.rejects(loadConfig(root), /bearerToken(?:Env|File)/);
  }
  assert.throws(() => new McpClient("test", { url: "http://127.0.0.1/mcp", bearerTokenEnv: "QDD_MCP_AUTH_TEST", bearerTokenFile: "key" }), /只能配置一个/);
});

test("MCP 在启动时读取密钥文件，每次重连重新读取且全部请求携带密钥", async (t) => {
  const root = await temporaryRoot(t);
  const file = path.join(root, "mcp-key");
  const requests = mockMcp(t);
  const client = new McpClient("test", { url: "http://127.0.0.1/mcp", bearerTokenFile: file });
  await assert.rejects(client.start(), /无法读取 bearerTokenFile/);
  assert.equal(requests.length, 0);

  await writeFile(file, "  synthetic-first-key\r\n");
  await client.start();
  await client.listTools();
  assert.deepEqual(requests.map((request) => request.method), ["initialize", "notifications/initialized", "tools/list"]);
  assert(requests.every((request) => request.authorization === "Bearer synthetic-first-key"));

  await writeFile(file, "synthetic-rotated-key\n");
  await client.start();
  assert(requests.slice(3).every((request) => request.authorization === "Bearer synthetic-rotated-key"));
});

test("MCP 拒绝空或格式无效的密钥文件，错误不包含文件内容且不发请求", async (t) => {
  const root = await temporaryRoot(t);
  const file = path.join(root, "mcp-key");
  const requests = mockMcp(t);
  const client = new McpClient("test", { url: "http://127.0.0.1/mcp", bearerTokenFile: file });
  for (const content of [" \r\n", "synthetic-secret\nmalformed", "synthetic secret", "synthetic\0secret"]) {
    await writeFile(file, content);
    await assert.rejects(client.start(), (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /为空或格式无效/);
      assert(!error.message.includes("synthetic"));
      return true;
    });
  }
  assert.equal(requests.length, 0);
});

test("MCP 会话过期后自动重建连接时读取更新后的密钥文件", async (t) => {
  const root = await temporaryRoot(t);
  const file = path.join(root, "mcp-key");
  const authorizations: (string | null)[] = [];
  let expires = true;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id?: number; method: string };
    const headers = new Headers(init.headers);
    authorizations.push(headers.get("Authorization"));
    if (body.method === "tools/list" && expires) {
      expires = false;
      assert.equal(headers.get("Mcp-Session-Id"), "synthetic-session");
      return new Response(null, { status: 404 });
    }
    if (body.id === undefined) return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "tools/list" ? { tools: [] } : {} }, { headers: { "mcp-session-id": "synthetic-session" } });
  });
  await writeFile(file, "synthetic-first-key");
  const client = new McpClient("test", { url: "http://127.0.0.1/mcp", bearerTokenFile: file });
  await client.start();
  await writeFile(file, "synthetic-rotated-key");
  assert.deepEqual(await client.listTools(), []);
  assert.equal(authorizations.length, 6);
  assert(authorizations.slice(0, 3).every((value) => value === "Bearer synthetic-first-key"));
  assert(authorizations.slice(3).every((value) => value === "Bearer synthetic-rotated-key"));
});

test("MCP 保留 bearerTokenEnv 的鉴权及缺少环境变量时的错误", async (t) => {
  const variable = "QDD_MCP_AUTH_CLIENT_TEST";
  const previous = process.env[variable];
  t.after(() => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  });
  delete process.env[variable];
  assert.throws(() => new McpClient("test", { url: "http://127.0.0.1/mcp", bearerTokenEnv: variable }), /缺少环境变量 QDD_MCP_AUTH_CLIENT_TEST/);
  process.env[variable] = "synthetic-environment-key";
  const requests = mockMcp(t);
  const client = new McpClient("test", { url: "http://127.0.0.1/mcp", bearerTokenEnv: variable });
  await client.start();
  assert.equal(requests.length, 2);
  assert(requests.every((request) => request.authorization === "Bearer synthetic-environment-key"));
});

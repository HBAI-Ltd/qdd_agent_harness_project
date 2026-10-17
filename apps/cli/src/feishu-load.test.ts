import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { ConnectorView, Schedule } from "@qdd/shared";
import type { ChatFn, ChatMessage } from "./agent/llm.js";
import { loadConfig, type LoadedConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { startGateway, type Gateway } from "./gateway/server.js";
import { ensureWorkspace } from "./web/site.js";
import { FeishuClient } from "./workbench/feishu.js";
import { openWorkbench } from "./workbench/index.js";

/**
 * 飞书连接器压力 / 负载测试（模拟飞书开放平台，不访问真实飞书）。
 * 模拟服务按飞书文档的限制行为：自定义机器人单个 webhook 5 次/秒，超出返回 code 11232；
 * 每个请求 10-40ms 随机延迟；/hook/hang 永不响应。
 */
const TOKEN = "test-gateway-token-0123456789";
const RATE_PER_SEC = 5;

interface FakeFeishu {
  url: string;
  server: Server;
  delivered: Map<string, string[]>;
  tokenRequests: number;
  rateLimited: number;
}

function startFakeFeishu(): Promise<FakeFeishu> {
  const state: FakeFeishu = { url: "", server: undefined as unknown as Server, delivered: new Map(), tokenRequests: 0, rateLimited: 0 };
  const windows = new Map<string, number[]>();
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const url = new URL(req.url!, "http://x");
    if (url.pathname.endsWith("/hang")) return; // 不响应，等待客户端超时
    await new Promise((r) => setTimeout(r, 10 + Math.random() * 30));
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const reply = (data: unknown) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    const deliver = (key: string, text: string) => state.delivered.set(key, [...(state.delivered.get(key) ?? []), text]);

    if (url.pathname.startsWith("/open-apis/bot/v2/hook/")) {
      const now = Date.now();
      const hits = (windows.get(url.pathname) ?? []).filter((t) => now - t < 1000);
      if (hits.length >= RATE_PER_SEC) {
        state.rateLimited++;
        windows.set(url.pathname, hits);
        return reply({ code: 11232, msg: "frequency limited psm[lark.oapi.app_platform_runtime]appID[1]" });
      }
      windows.set(url.pathname, [...hits, now]);
      deliver(url.pathname, (body.content as { text: string }).text);
      return reply({ code: 0, msg: "success", data: {} });
    }
    if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
      state.tokenRequests++;
      return reply({ code: 0, tenant_access_token: "t-1", expire: 7200 });
    }
    if (req.headers.authorization !== "Bearer t-1") return reply({ code: 99991663, msg: "invalid token" });
    if (url.pathname === "/open-apis/bot/v3/info") return reply({ code: 0, bot: { app_name: "钱多多助手" } });
    if (url.pathname === "/open-apis/im/v1/messages") {
      deliver(`chat:${String(body.receive_id)}`, (JSON.parse(String(body.content)) as { text: string }).text);
      return reply({ code: 0, data: {} });
    }
    res.writeHead(404).end();
  });
  state.server = server;
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      state.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve(state);
    }),
  );
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!);
};

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t = performance.now();
  const value = await fn();
  return { ms: performance.now() - t, value };
}

let n = 0;
const reply = (text: string): ChatMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: `l${n++}`, type: "function", function: { name: "reply", arguments: JSON.stringify({ text, gaps: [] }) } }],
});

describe("飞书连接器压力负载", () => {
  let loaded: LoadedConfig;
  let sources: DataSources;
  let gateway: Gateway;
  let feishu: FakeFeishu;
  const chat: ChatFn = async () => reply("巡检完成");
  const api = (p: string, init: RequestInit = {}) =>
    fetch(gateway.url + p, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...init.headers } });
  const post = (p: string, body: unknown, method = "POST") => api(p, { method, body: JSON.stringify(body) });
  const hook = (name: string) => `${feishu.url}/open-apis/bot/v2/hook/${name}`;

  before(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qdd-load-"));
    await writeFile(path.join(root, "harness.config.json"), JSON.stringify({ gateway: { port: 0 }, llm: { clarify: "off" } }));
    loaded = await loadConfig(root);
    await ensureWorkspace(loaded.paths);
    feishu = await startFakeFeishu();
    sources = await DataSources.open(loaded);
    const workbench = await openWorkbench(loaded, new FeishuClient({ baseUrl: feishu.url, timeoutMs: 500 }));
    gateway = await startGateway(loaded, sources, { token: TOKEN, chat: () => chat, workbench, scheduler: false });
  });

  after(async () => {
    await gateway.close();
    await sources.close();
    feishu.server.close();
    feishu.server.closeAllConnections();
  });

  test("1. 并发安装 30 个 webhook 连接器：全部验证通过且无写丢失", async () => {
    const N = 30;
    const { ms, value } = await timed(() =>
      Promise.all(Array.from({ length: N }, (_, i) => post("/api/connectors", { type: "feishu", mode: "webhook", name: `门店${i}`, webhookUrl: hook(`install-${i}`) }))),
    );
    assert.deepEqual([...new Set(value.map((r) => r.status))], [201]);
    const disk = JSON.parse(await readFile(loaded.paths.connectors, "utf8")) as { connectors: unknown[] };
    assert.equal(disk.connectors.length, N);
    const list = (await (await api("/api/connectors")).json()) as { connectors: ConnectorView[] };
    assert.equal(list.connectors.filter((c) => c.origin === "installed" && c.status === "connected").length, N);
    console.log(`  [1] 并发安装 ${N} 个：${ms.toFixed(0)}ms，落盘 ${disk.connectors.length} 条`);
  });

  test("2. 同一 webhook 突发 20 条推送：超出飞书 5 次/秒的部分排队重试，全部送达、无重复", async () => {
    const res = await post("/api/connectors", { type: "feishu", mode: "webhook", name: "突发", webhookUrl: hook("burst") });
    const { id } = (await res.json()) as ConnectorView;
    feishu.delivered.delete("/open-apis/bot/v2/hook/burst");
    const N = 20;
    const latencies: number[] = [];
    const { ms, value } = await timed(() =>
      Promise.all(
        Array.from({ length: N }, (_, i) =>
          timed(() => post(`/api/connectors/${id}/test`, { text: `msg-${i}` })).then((r) => {
            latencies.push(r.ms);
            return r.value.status;
          }),
        ),
      ),
    );
    const delivered = feishu.delivered.get("/open-apis/bot/v2/hook/burst") ?? [];
    console.log(
      `  [2] 突发 ${N} 条：成功 ${value.filter((s) => s === 200).length}，送达 ${delivered.length}，被限流 ${feishu.rateLimited} 次，` +
        `总耗时 ${ms.toFixed(0)}ms，p50 ${pct(latencies, 50)}ms / p95 ${pct(latencies, 95)}ms`,
    );
    assert.equal(value.filter((s) => s === 200).length, N);
    assert.equal(delivered.length, N);
    assert.equal(new Set(delivered).size, N);
    assert.ok(ms > ((N - RATE_PER_SEC) / RATE_PER_SEC) * 1000 - 200, "应按 5 次/秒节流");
  });

  test("3. 应用模式 100 并发推送：tenant_access_token 只换取一次", async () => {
    const res = await post("/api/connectors", { type: "feishu", mode: "app", appId: "cli_load", appSecret: "s", receiveId: "oc_load", permission: "auto" });
    assert.equal(res.status, 201);
    const { id } = (await res.json()) as ConnectorView;
    // 安装验证会强制刷新一次 token；新建客户端模拟进程重启后的冷启动
    const before = feishu.tokenRequests;
    const cold = await openWorkbench(loaded, new FeishuClient({ baseUrl: feishu.url, timeoutMs: 2000 }));
    const N = 100;
    const { ms, value } = await timed(() => Promise.allSettled(Array.from({ length: N }, (_, i) => cold.connectors.send(id, `app-${i}`))));
    const tokenCalls = feishu.tokenRequests - before;
    console.log(`  [3] 应用并发 ${N} 条：成功 ${value.filter((v) => v.status === "fulfilled").length}，换取 token ${tokenCalls} 次，${ms.toFixed(0)}ms`);
    assert.equal(value.filter((v) => v.status === "fulfilled").length, N);
    assert.equal(tokenCalls, 1);
  });

  test("4. 飞书无响应：推送按超时失败并给出明确错误，网关其它接口不受影响", async () => {
    const client = new FeishuClient({ baseUrl: feishu.url, timeoutMs: 300 });
    // 5 条在节流额度内同时发出，单独衡量超时（超出额度的会按 5 次/秒排队，见第 2 项）
    const N = 5;
    const hanging = timed(() => Promise.allSettled(Array.from({ length: N }, () => client.sendWebhook({ webhookUrl: hook("hang") }, "x"))));
    const health: number[] = [];
    for (let i = 0; i < 10; i++) health.push((await timed(() => fetch(`${gateway.url}/health`))).ms);
    const overview = await api("/api/overview");
    const { ms, value } = await hanging;
    const errors = value.filter((v): v is PromiseRejectedResult => v.status === "rejected");
    console.log(`  [4] 挂起 ${N} 条：全部失败 ${errors.length}，耗时 ${ms.toFixed(0)}ms；同时 /health p95 ${pct(health, 95)}ms`);
    assert.equal(errors.length, N);
    assert.match(String(errors[0]!.reason.message), /无法连接飞书/);
    assert.ok(ms < 1500, `超时应约 300ms，实际 ${ms}`);
    assert.equal(overview.status, 200);
    assert.ok(pct(health, 95) < 200);
  });

  test("5. 20 个定时任务同时到期 + 3 次并发 tick：每个只执行一次并各自推送", async () => {
    const N = 20;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const c = (await (await post("/api/connectors", { type: "feishu", mode: "webhook", name: `任务推送${i}`, webhookUrl: hook(`sched-${i}`), permission: "auto" })).json()) as ConnectorView;
      const s = (await (await post("/api/schedules", { name: `巡检${i}`, cron: "0 3 * * *", prompt: "库存巡检", notify: { connectorId: c.id } })).json()) as Schedule;
      ids.push(s.id);
    }
    const file = JSON.parse(await readFile(loaded.paths.schedules, "utf8")) as { schedules: Schedule[] };
    for (const s of file.schedules) s.nextRunAt = new Date(Date.now() - 1000).toISOString();
    await writeFile(loaded.paths.schedules, JSON.stringify(file));

    const t = performance.now();
    await Promise.all([gateway.scheduler.tick(), gateway.scheduler.tick(), gateway.scheduler.tick()]);
    const done = async () => {
      const list = (await (await api("/api/schedules")).json()) as Schedule[];
      return list.filter((s) => ids.includes(s.id) && s.lastRun?.notified?.ok).length;
    };
    while ((await done()) < N && performance.now() - t < 15_000) await new Promise((r) => setTimeout(r, 50));
    const ms = performance.now() - t;
    assert.deepEqual(await (await api("/api/sessions")).json(), [], "定时任务执行不进入普通对话列表");
    const names = (await readdir(loaded.paths.scheduleSessions)).filter((name) => name.endsWith(".meta.json"));
    const runs = await Promise.all(names.map((name) => gateway.hub.meta(name.slice(0, -".meta.json".length))));
    const perSchedule = ids.map((id) => runs.filter((r) => r.origin?.scheduleId === id).length);
    const sent = ids.map((_, i) => (feishu.delivered.get(`/open-apis/bot/v2/hook/sched-${i}`) ?? []).filter((x) => x.startsWith("【巡检")).length);
    console.log(`  [5] ${N} 个到期任务：全部完成并推送 ${await done()} 个，耗时 ${ms.toFixed(0)}ms；每任务会话数 ${[...new Set(perSchedule)].join("/")}，推送数 ${[...new Set(sent)].join("/")}`);
    assert.equal(await done(), N);
    assert.deepEqual([...new Set(perSchedule)], [1]);
    assert.deepEqual([...new Set(sent)], [1]);
  });
});

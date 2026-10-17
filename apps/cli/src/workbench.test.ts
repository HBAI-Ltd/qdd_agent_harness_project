import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { ConnectorView, Overview, PageEntry, PageView, PendingItem, Schedule, SessionMeta, Skill } from "@qdd/shared";
import type { ChatFn, ChatMessage } from "./agent/llm.js";
import { loadConfig, type LoadedConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { startGateway, type Gateway } from "./gateway/server.js";
import { ensureWorkspace, readPages, writePages } from "./web/site.js";
import { nextRun, parseCron } from "./workbench/cron.js";
import { FeishuClient } from "./workbench/feishu.js";
import { openWorkbench } from "./workbench/index.js";

const TOKEN = "test-gateway-token-0123456789";
const SIGN_SECRET = "s3cret";

describe("cron", () => {
  const at = (s: string) => new Date(s);
  test("每天 08:00", () => {
    assert.equal(nextRun("0 8 * * *", at("2026-10-17T07:59:30"))!.getTime(), at("2026-10-17T08:00:00").getTime());
    assert.equal(nextRun("0 8 * * *", at("2026-10-17T08:00:00"))!.getTime(), at("2026-10-18T08:00:00").getTime());
  });
  test("每 2 小时、工作日、月末与周日 7", () => {
    assert.equal(nextRun("0 */2 * * *", at("2026-10-17T09:10:00"))!.getTime(), at("2026-10-17T10:00:00").getTime());
    // 2026-10-17 是周六，下一个工作日 07:30 是周一 10-19
    assert.equal(nextRun("30 7 * * 1-5", at("2026-10-17T12:00:00"))!.getTime(), at("2026-10-19T07:30:00").getTime());
    assert.equal(nextRun("0 9 * * 7", at("2026-10-17T12:00:00"))!.getTime(), at("2026-10-18T09:00:00").getTime());
    assert.equal(nextRun("0 0 31 * *", at("2026-11-01T00:00:00"))!.getTime(), at("2026-12-31T00:00:00").getTime());
  });
  test("非法表达式", () => {
    for (const bad of ["0 8 * *", "60 8 * * *", "0 25 * * *", "a b c d e", "0 8 * * 1-"]) assert.throws(() => parseCron(bad), bad);
    assert.equal(nextRun("0 0 30 2 *", at("2026-01-01T00:00:00")), null);
  });
});

interface FakeFeishu {
  url: string;
  server: Server;
  /** 收到的消息：webhook 或 im/v1/messages */
  messages: { via: string; text: string }[];
}

/** 假的飞书开放平台：校验签名、应用凭据与 tenant token。 */
function startFakeFeishu(): Promise<FakeFeishu> {
  const messages: FakeFeishu["messages"] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const url = new URL(req.url!, "http://x");
    const reply = (data: unknown) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    if (url.pathname === "/open-apis/bot/v2/hook/signed") {
      const expected = createHmac("sha256", `${String(body.timestamp)}\n${SIGN_SECRET}`).update("").digest("base64");
      if (body.sign !== expected) return reply({ code: 19021, msg: "sign match fail or timestamp is not within one hour from current time" });
      messages.push({ via: "webhook", text: (body.content as { text: string }).text });
      return reply({ code: 0, msg: "success", data: {} });
    }
    if (url.pathname === "/open-apis/bot/v2/hook/plain") {
      messages.push({ via: "webhook", text: (body.content as { text: string }).text });
      return reply({ StatusCode: 0, StatusMessage: "success" });
    }
    if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
      if (body.app_id === "cli_ok" && body.app_secret === "app-secret") return reply({ code: 0, msg: "ok", tenant_access_token: "t-1", expire: 7200 });
      return reply({ code: 10014, msg: "app secret invalid" });
    }
    if (req.headers.authorization !== "Bearer t-1") return reply({ code: 99991663, msg: "invalid token" });
    if (url.pathname === "/open-apis/bot/v3/info") return reply({ code: 0, bot: { app_name: "钱多多助手", open_id: "ou_1" } });
    if (url.pathname === "/open-apis/im/v1/messages") {
      if (url.searchParams.get("receive_id_type") !== "chat_id" || body.receive_id !== "oc_store") return reply({ code: 230002, msg: "bot not in chat" });
      messages.push({ via: "app", text: (JSON.parse(String(body.content)) as { text: string }).text });
      return reply({ code: 0, msg: "success", data: {} });
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const a = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${a.port}`, server, messages });
    }),
  );
}

let n = 0;
const call = (name: string, args: object): ChatMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: `w${n++}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

async function until<T>(fn: () => Promise<T | undefined>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}

describe("workbench gateway", () => {
  let loaded: LoadedConfig;
  let sources: DataSources;
  let gateway: Gateway;
  let feishu: FakeFeishu;
  const script: ChatMessage[] = [];
  const seen: ChatMessage[][] = [];
  const chat: ChatFn = async (messages) => {
    seen.push(structuredClone(messages));
    return script.shift() ?? { role: "assistant", content: "（脚本结束）" };
  };
  const api = (p: string, init: RequestInit = {}) =>
    fetch(gateway.url + p, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...init.headers } });
  const post = (p: string, body: unknown, method = "POST") => api(p, { method, body: JSON.stringify(body) });
  const idle = (id: string) =>
    until(async () => {
      const meta = (await (await api(`/api/sessions/${id}`)).json()) as SessionMeta;
      return meta.status === "idle" || meta.status === "error" ? meta : undefined;
    });

  before(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qdd-wb-"));
    await writeFile(path.join(root, "harness.config.json"), JSON.stringify({ gateway: { port: 0 }, llm: { clarify: "auto" } }));
    loaded = await loadConfig(root);
    await ensureWorkspace(loaded.paths);
    feishu = await startFakeFeishu();
    sources = await DataSources.open(loaded);
    const workbench = await openWorkbench(loaded, new FeishuClient({ baseUrl: feishu.url }));
    gateway = await startGateway(loaded, sources, { token: TOKEN, chat: () => chat, workbench, scheduler: false });
  });

  after(async () => {
    await gateway.close();
    await sources.close();
    feishu.server.close();
    feishu.server.closeAllConnections();
  });

  let webhookId = "";

  test("飞书 webhook：签名错误不保存，签名正确发送测试消息后保存，密钥不回传、不明文落盘", async () => {
    const bad = await post("/api/connectors", { type: "feishu", mode: "webhook", webhookUrl: `${feishu.url}/open-apis/bot/v2/hook/signed`, signSecret: "wrong" });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /签名校验失败/);

    const evil = await post("/api/connectors", { type: "feishu", mode: "webhook", webhookUrl: "https://evil.example.com/open-apis/bot/v2/hook/x" });
    assert.equal(evil.status, 400);

    const ok = await post("/api/connectors", { type: "feishu", mode: "webhook", name: "店长群", webhookUrl: `${feishu.url}/open-apis/bot/v2/hook/signed`, signSecret: SIGN_SECRET });
    assert.equal(ok.status, 201);
    const view = (await ok.json()) as ConnectorView;
    webhookId = view.id;
    assert.equal(view.status, "connected");
    assert.equal(view.permission, "confirm");
    assert.equal(view.config.signSecret, true);
    assert.doesNotMatch(String(view.config.webhookUrl), /signed$/);
    assert.match(feishu.messages.at(-1)!.text, /验证成功/);

    // 店长填写官方地址时，按 FEISHU_BASE_URL（此处为模拟服务）转发
    const official = await post("/api/connectors", { type: "feishu", mode: "webhook", name: "官方地址", webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/plain" });
    assert.equal(official.status, 201);
    assert.equal(feishu.messages.at(-1)!.via, "webhook");
    await api(`/api/connectors/${((await official.json()) as ConnectorView).id}`, { method: "DELETE" });

    const disk = await readFile(loaded.paths.connectors, "utf8");
    assert.doesNotMatch(disk, new RegExp(SIGN_SECRET));
    assert.doesNotMatch(disk, /hook\/signed/);

    const list = (await (await api("/api/connectors")).json()) as { catalog: { type: string; available: boolean }[]; connectors: ConnectorView[] };
    assert.ok(list.catalog.find((c) => c.type === "feishu")?.available);
    assert.deepEqual(list.connectors.map((c) => c.origin), ["builtin", "installed"]);
    assert.equal((await post(`/api/connectors/${webhookId}/verify`, {})).status, 200);
    assert.equal((await post(`/api/connectors/${webhookId}/test`, { text: "你好" })).status, 200);
    assert.equal(feishu.messages.at(-1)!.text, "你好");
  });

  test("飞书应用：错误凭据拒绝；正确凭据读取机器人并向群发送测试消息；只读权限不能推送", async () => {
    const bad = await post("/api/connectors", { type: "feishu", mode: "app", appId: "cli_ok", appSecret: "nope" });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /App Secret 错误/);

    const wrongChat = await post("/api/connectors", { type: "feishu", mode: "app", appId: "cli_ok", appSecret: "app-secret", receiveId: "oc_other" });
    assert.match(((await wrongChat.json()) as { error: string }).error, /机器人不在该群中/);

    const res = await post("/api/connectors", { type: "feishu", mode: "app", appId: "cli_ok", appSecret: "app-secret", receiveId: "oc_store", permission: "read" });
    const view = (await res.json()) as ConnectorView;
    assert.equal(res.status, 201);
    assert.match(view.detail, /钱多多助手/);
    assert.equal(feishu.messages.at(-1)!.via, "app");
    assert.equal((await post(`/api/connectors/${view.id}/test`, {})).status, 400);
    assert.equal((await post(`/api/connectors/${view.id}`, { permission: "auto" }, "PUT")).status, 200);
    assert.equal((await post(`/api/connectors/${view.id}/test`, {})).status, 200);
    assert.equal((await api(`/api/connectors/${view.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await post("/api/connectors", { type: "camera", mode: "qrcode" })).status, 400);
  });

  test("技能：从对话保存需店长在工作台确认，之后可加载", async () => {
    script.push(
      call("save_skill", {
        name: "临期预警",
        description: "查库存 · 飞书通知",
        steps: ["查进销存，找出 3 天内到期的商品", "通过飞书提醒店长"],
        tools: ["store__get_inventory", "send_notification"],
      }),
      call("reply", { text: "已整理为技能「临期预警」", gaps: [] }),
    );
    const session = (await (await post("/api/wishes", { wish: "以后每天早上帮我查快过期的商品，在飞书上提醒我" })).json()) as SessionMeta;
    const pending = await until(async () => {
      const list = (await (await api("/api/pending")).json()) as PendingItem[];
      return list.length ? list : undefined;
    });
    assert.equal(pending[0]!.kind, "approval");
    assert.equal(pending[0]!.sessionId, session.id);
    assert.ok(pending[0]!.kind === "approval" && pending[0]!.tool === "save_skill");
    const overview = (await (await api("/api/overview")).json()) as Overview;
    assert.equal(overview.pending.length, 1);
    assert.equal(overview.sessions.waiting, 1);

    await post(`/api/sessions/${session.id}/approvals/${pending[0]!.requestId}`, { approved: true });
    await idle(session.id);
    assert.deepEqual(await (await api("/api/pending")).json(), []);
    const skills = (await (await api("/api/skills")).json()) as Skill[];
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.source, "agent");
    const detail = (await (await api(`/api/sessions/${session.id}`)).json()) as { events: { type: string; action?: string }[] };
    assert.ok(detail.events.some((e) => e.type === "skill" && e.action === "saved"));

    assert.equal((await post("/api/skills", { name: "临期预警", description: "", steps: ["x"] })).status, 400);
    assert.equal((await post("/api/skills", { name: "排班建议", description: "按客流安排班次", steps: [] })).status, 400);
    const created = (await (await post("/api/skills", { name: "补货建议", description: "按销量算补货量", steps: ["查销量", "算补货量"] })).json()) as Skill;
    assert.equal(created.source, "user");
    assert.equal((await post(`/api/skills/${created.id}`, { ...created, description: "改了" }, "PUT")).status, 200);
    assert.equal((await api(`/api/skills/${created.id}`, { method: "DELETE" })).status, 200);
  });

  test("定时任务：校验输入，立即执行时加载技能、无人值守，完成后推送飞书；到期补跑", async () => {
    assert.equal((await post("/api/schedules", { name: "x", cron: "0 8 * *", prompt: "y" })).status, 400);
    assert.equal((await post("/api/schedules", { name: "x", cron: "0 8 * * *", prompt: "y", skillId: "不存在" })).status, 400);

    const res = await post("/api/schedules", {
      name: "临期预警",
      cron: "30 7 * * *",
      prompt: "执行临期预警",
      skillId: "临期预警",
      notify: { connectorId: webhookId },
    });
    assert.equal(res.status, 201);
    const schedule = (await res.json()) as Schedule;
    assert.ok(schedule.nextRunAt && new Date(schedule.nextRunAt) > new Date());

    script.push(call("reply", { text: "今天没有快过期的商品", gaps: [] }));
    const before = seen.length;
    const { sessionId } = (await (await post(`/api/schedules/${schedule.id}/run`, {})).json()) as { sessionId: string };
    const meta = await idle(sessionId);
    assert.equal(meta.origin?.scheduleId, schedule.id);
    const prompt = seen[before]!;
    assert.match(String(prompt.at(-1)!.content), /已为你加载技能「临期预警」/);
    assert.match(String(prompt[0]!.content), /定时任务自动执行/);

    const done = await until(async () => {
      const s = (await (await api(`/api/schedules/${schedule.id}`)).json()) as Schedule;
      return s.lastRun ? s : undefined;
    });
    assert.equal(done.lastRun!.status, "ok");
    assert.deepEqual(done.lastRun!.notified, { connectorId: webhookId, ok: true });
    assert.equal(feishu.messages.at(-1)!.text, "【临期预警】今天没有快过期的商品");

    // 连接器被定时任务使用时不能删除
    assert.equal((await api(`/api/connectors/${webhookId}`, { method: "DELETE" })).status, 409);

    // 停机期间错过的执行：启动后的 tick 补跑一次，并推进到下一次
    const file = JSON.parse(await readFile(loaded.paths.schedules, "utf8")) as { schedules: Schedule[] };
    file.schedules[0]!.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await writeFile(loaded.paths.schedules, JSON.stringify(file));
    script.push(call("reply", { text: "补跑完成", gaps: [] }));
    await gateway.scheduler.tick();
    await until(async () => (feishu.messages.at(-1)!.text === "【临期预警】补跑完成" ? true : undefined));
    const after = (await (await api(`/api/schedules/${schedule.id}`)).json()) as Schedule;
    assert.ok(new Date(after.nextRunAt!) > new Date());

    const off = (await (await post(`/api/schedules/${schedule.id}`, { enabled: false }, "PUT")).json()) as Schedule;
    assert.equal(off.nextRunAt, null);
    const overview = (await (await api("/api/overview")).json()) as Overview;
    assert.equal(overview.schedules.total, 1);
    assert.equal(overview.schedules.enabled, 0);
    assert.equal(overview.skills.total, 1);
    assert.equal(overview.connectors.connected, 2);
    assert.equal((await api(`/api/schedules/${schedule.id}`, { method: "DELETE" })).status, 200);
  });

  test("send_notification：确认权限需店长授权，结论数字必须有出处", async () => {
    script.push(
      call("send_notification", { text: "今日营业额 ¥99,999" }),
      call("send_notification", { text: "今天记得盘点生鲜" }),
      call("reply", { text: "已提醒", gaps: [] }),
    );
    const session = (await (await post("/api/wishes", { wish: "提醒我盘点" })).json()) as SessionMeta;
    const pending = await until(async () => {
      const list = (await (await api("/api/pending")).json()) as PendingItem[];
      return list.length ? list : undefined;
    });
    assert.ok(pending[0]!.kind === "approval" && pending[0]!.source === `connector:${webhookId}`);
    await post(`/api/sessions/${session.id}/approvals/${pending[0]!.requestId}`, { approved: true });
    await idle(session.id);
    assert.equal(feishu.messages.at(-1)!.text, "今天记得盘点生鲜");
    assert.ok(!feishu.messages.some((m) => m.text.includes("99,999")));
  });

  test("页面：按定时任务区分类型，可多个置顶并按置顶先后排在最前", async () => {
    const existing = await readPages(loaded.paths);
    const page = (slug: string, updatedAt: string): PageEntry => ({
      slug, title: slug, wish: "", summary: "", tools: [], useAgent: false, metrics: [], datasets: {}, version: 1, stale: null, gaps: [], sessionId: "",
      createdAt: updatedAt, updatedAt,
    });
    await writePages(loaded.paths, [...existing, page("p-a", "2026-01-01T00:00:00Z"), page("p-b", "2026-01-02T00:00:00Z"), page("p-c", "2026-01-03T00:00:00Z")]);
    const list = async () => ((await (await api("/api/pages")).json()) as PageView[]).filter((x) => x.slug.startsWith("p-"));

    const schedule = (await (await post("/api/schedules", { name: "刷新 B", cron: "0 8 * * *", prompt: "刷新", slug: "p-b" })).json()) as Schedule;
    let pages = await list();
    assert.deepEqual(pages.map((x) => x.slug), ["p-c", "p-b", "p-a"]);
    assert.deepEqual(pages.map((x) => x.kind), ["once", "scheduled", "once"]);
    assert.deepEqual(pages[1]!.schedules, [{ id: schedule.id, name: "刷新 B", enabled: true }]);
    assert.ok(pages.every((x) => x.pinnedAt === null));

    assert.equal((await api("/api/pages/p-a/pin", { method: "PUT" })).status, 200);
    assert.equal((await api("/api/pages/p-b/pin", { method: "PUT" })).status, 200);
    const again = (await (await api("/api/pages/p-a/pin", { method: "PUT" })).json()) as { pinnedAt: string };
    pages = await list();
    assert.deepEqual(pages.map((x) => x.slug), ["p-a", "p-b", "p-c"]);
    assert.equal(again.pinnedAt, pages[0]!.pinnedAt);
    assert.equal((await api("/api/pages/不存在/pin", { method: "PUT" })).status, 404);

    assert.equal((await api("/api/pages/p-a/pin", { method: "DELETE" })).status, 200);
    pages = await list();
    assert.deepEqual(pages.map((x) => x.slug), ["p-b", "p-c", "p-a"]);
    assert.equal(pages[2]!.pinnedAt, null);
    await api(`/api/schedules/${schedule.id}`, { method: "DELETE" });
    assert.equal((await list()).find((x) => x.slug === "p-b")!.kind, "once");
  });
});

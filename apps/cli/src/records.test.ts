import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { PageEntry, PendingItem, Row, Schedule, SessionMeta } from "@qdd/shared";
import type { ChatFn, ChatMessage } from "./agent/llm.js";
import { loadConfig, type LoadedConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { Auth } from "./gateway/auth.js";
import { startGateway, type Gateway } from "./gateway/server.js";
import { ensureWorkspace, readPages } from "./web/site.js";

const TOKEN = "test-gateway-token-0123456789";

let n = 0;
const call = (name: string, args: object): ChatMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: `r${n++}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
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

const LOSS_LOG = {
  name: "loss_log",
  label: "试吃报损登记",
  fields: [
    { name: "sku", label: "商品", type: "string", required: true },
    { name: "qty", label: "数量", type: "number", required: true },
    { name: "reason", label: "原因", type: "string", required: true, options: ["试吃", "过期", "破损"] },
    { name: "handler", label: "经手人", type: "string" },
  ],
};

describe("记录数据集与定时任务（agent）", () => {
  let loaded: LoadedConfig;
  let sources: DataSources;
  let gateway: Gateway;
  const script: ChatMessage[] = [];
  const chat: ChatFn = async () => script.shift() ?? { role: "assistant", content: "（脚本结束）" };
  const api = (p: string, init: RequestInit = {}) =>
    fetch(gateway.url + p, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...init.headers } });
  const post = (p: string, body: unknown, method = "POST") => api(p, { method, body: JSON.stringify(body) });
  const asPage = (slug: string, p: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(gateway.url + p, {
      method,
      headers: { "Content-Type": "application/json", "X-QDD-Page": slug, "X-QDD-Page-Token": new Auth(TOKEN).pageToken(slug) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const idle = (id: string) =>
    until(async () => {
      const meta = (await (await api(`/api/sessions/${id}`)).json()) as SessionMeta;
      return meta.status === "idle" || meta.status === "error" ? meta : undefined;
    });
  /** 逐个批准待办授权，返回批准过的工具名 */
  async function approveAll(sessionId: string, count: number): Promise<string[]> {
    const tools: string[] = [];
    while (tools.length < count) {
      const item = await until(async () => ((await (await api("/api/pending")).json()) as PendingItem[]).find((x) => x.sessionId === sessionId));
      assert.equal(item.kind, "approval");
      if (item.kind === "approval") tools.push(item.tool);
      await post(`/api/sessions/${sessionId}/approvals/${item.requestId}`, { approved: true });
    }
    return tools;
  }

  before(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "qdd-rec-"));
    await writeFile(path.join(root, "harness.config.json"), JSON.stringify({ gateway: { port: 0 }, llm: { clarify: "auto" } }));
    loaded = await loadConfig(root);
    await ensureWorkspace(loaded.paths);
    sources = await DataSources.open(loaded);
    gateway = await startGateway(loaded, sources, { token: TOKEN, chat: () => chat, scheduler: false });
  });

  after(async () => {
    await gateway.close();
    await sources.close();
  });

  test("agent 建登记表、写登记页面并创建绑定该页面的定时任务（均经店长确认）", async () => {
    const html = `<!doctype html><html><body><form id="f"></form><script>
      const RECORD = 'loss_log'; // 记录名放在常量里也能识别
      const rows = await qdd.records.list(RECORD, { limit: 50 });
      document.getElementById("f").onsubmit = () => qdd.records.add(RECORD, { sku: "SKU013", qty: 2, reason: "试吃" });
    </script></body></html>`;
    script.push(
      call("define_record", LOSS_LOG),
      call("create_schedule", { name: "每日报损汇总", cron: "30 22 * * *", prompt: "汇总今天的试吃报损登记，按原因统计条数和数量", bindPage: true }),
      call("write_file", { path: "index.html", content: html }),
      call("finish", { title: "试吃报损登记", summary: "员工逐条登记试吃和报损", tools: [], useAgent: false, gaps: [] }),
    );
    const session = (await (await post("/api/wishes", { wish: "员工每天登记试吃报损，每天闭店后汇总" })).json()) as SessionMeta;
    assert.deepEqual(await approveAll(session.id, 2), ["define_record", "create_schedule"]);
    const meta = await idle(session.id);
    assert.equal(meta.status, "idle");

    const page = (await readPages(loaded.paths)).find((p) => p.slug === meta.slug) as PageEntry;
    assert.deepEqual(page.records, ["loss_log"]);
    const schedules = (await (await api("/api/schedules")).json()) as Schedule[];
    assert.equal(schedules.length, 1);
    assert.equal(schedules[0]!.slug, page.slug);
    assert.deepEqual(schedules[0]!.createdBy, { kind: "agent", sessionId: session.id });
    assert.ok((await sources.metrics()).records, "补入记录数指标");
  });

  test("页面按声明读写记录：校验字段、按 id 回填、作废后聚合不再计入", async () => {
    const slug = (await readPages(loaded.paths)).find((p) => p.records?.includes("loss_log"))!.slug;

    assert.equal((await asPage(slug, "/api/records/loss_log", { sku: "SKU013", qty: 2, reason: "被偷吃" })).status, 400);
    assert.equal((await asPage(slug, "/api/records/loss_log", { sku: "SKU013", reason: "试吃" })).status, 400);
    assert.equal((await asPage(slug, "/api/records/loss_log", { sku: "SKU013", qty: 1, reason: "试吃", color: "红" })).status, 400);
    const added = (await (await asPage(slug, "/api/records/loss_log", [
      { sku: "SKU013", qty: 2, reason: "试吃", handler: "小王" },
      { sku: "SKU014", qty: 1, reason: "破损", time: "2026-10-16 21:05" },
    ])).json()) as { rows: Row[] };
    assert.equal(added.rows.length, 2);
    assert.match(String(added.rows[0]!.time), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(added.rows[0]!.page, slug);

    const [first, second] = added.rows as [Row, Row];
    const updated = (await (await asPage(slug, `/api/records/loss_log/${String(second.id)}`, { qty: 3 }, "PUT")).json()) as { row: Row };
    assert.equal(updated.row.qty, 3);
    assert.equal(updated.row.reason, "破损");
    assert.equal((await asPage(slug, `/api/records/loss_log/${String(second.id)}`, { time: "2026-10-01 08:00" }, "PUT")).status, 400);

    const agg = async () =>
      (await sources.call("store__aggregate", { dataset: "records/loss_log", metrics: ["records", "quantity"], groupBy: ["reason"], sort: [{ by: "reason" }] }, async () => false)) as Row[];
    assert.deepEqual((await agg()).map((r) => [r.reason, r.records, r.quantity]), [["破损", 1, 3], ["试吃", 1, 2]]);

    assert.equal((await asPage(slug, `/api/records/loss_log/${String(first.id)}`, undefined, "DELETE")).status, 200);
    assert.deepEqual((await agg()).map((r) => [r.reason, r.records]), [["破损", 1]]);
    const listed = (await (await asPage(slug, "/api/records/loss_log?from=2026-10-16&to=2026-10-16")).json()) as { rows: Row[]; total: number };
    assert.deepEqual(listed.rows.map((r) => r.id), [second.id]);
    assert.equal((await asPage(slug, `/api/records/loss_log/${String(first.id)}`, { qty: 9 }, "PUT")).status, 404);
  });

  test("权限：页面不能访问未声明的记录，也不能定义或列出记录；结构只能新增字段", async () => {
    const slug = (await readPages(loaded.paths)).find((p) => p.records?.includes("loss_log"))!.slug;
    assert.equal((await post("/api/records", { name: "expiry_actions", label: "临期处置", fields: [{ name: "action", label: "处置", type: "string" }] })).status, 201);
    assert.equal((await asPage(slug, "/api/records/expiry_actions")).status, 403);
    assert.equal((await asPage(slug, "/api/records", { name: "x", label: "x", fields: [] })).status, 403);
    assert.equal((await asPage("no-such-page", "/api/records/loss_log")).status, 401);
    assert.equal((await fetch(`${gateway.url}/api/records/loss_log`)).status, 401);

    const list = (await (await api("/api/records")).json()) as { name: string; rowCount: number }[];
    assert.deepEqual(list.map((x) => x.name).sort(), ["expiry_actions", "loss_log"]);
    assert.equal((await post("/api/records", { ...LOSS_LOG, fields: LOSS_LOG.fields.slice(1) })).status, 409);
    assert.equal((await post("/api/records", { ...LOSS_LOG, fields: [...LOSS_LOG.fields.slice(0, 3), { name: "handler", label: "经手人", type: "number" }] })).status, 409);
    assert.equal((await post("/api/records", { ...LOSS_LOG, fields: [...LOSS_LOG.fields, { name: "photo", label: "照片说明", type: "string" }] })).status, 201);
    assert.equal((await post("/api/records", { name: "Bad Name", label: "x", fields: [{ name: "a", label: "a", type: "string" }] })).status, 400);
    assert.equal((await post("/api/records", { name: "ok", label: "x", fields: [{ name: "time", label: "时间", type: "string" }] })).status, 400);
  });

  test("页面引用不存在的记录时守卫拒绝发布；店长拒绝建表时不建立", async () => {
    script.push(
      call("define_record", { name: "patrol_log", label: "巡检", fields: [{ name: "ok", label: "合格", type: "boolean" }] }),
      call("write_file", { path: "index.html", content: `<script>qdd.records.add("patrol_log", { ok: true })</script>` }),
      call("finish", { title: "巡检", summary: "巡检登记", tools: [], useAgent: false, gaps: [] }),
      call("reply", { text: "店长未确认登记表，未发布", gaps: [] }),
    );
    const session = (await (await post("/api/wishes", { wish: "做个巡检登记" })).json()) as SessionMeta;
    const item = await until(async () => ((await (await api("/api/pending")).json()) as PendingItem[]).find((x) => x.sessionId === session.id));
    await post(`/api/sessions/${session.id}/approvals/${item.requestId}`, { approved: false });
    const meta = await idle(session.id);
    assert.equal(meta.slug ?? null, null);
    assert.equal(await sources.datasets.get("records/patrol_log"), undefined);
  });
});

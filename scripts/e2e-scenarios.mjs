// 真实场景端到端测试：真实 LLM（.env 中的 DEEPSEEK_API_KEY）+ 模拟 ERP（scripts/mock-erp-mcp.mjs）+ 模拟飞书。
// 按产品动画中的 5 个场景各跑一轮，在独立的临时工作区运行，不影响 workspace/。
// 用法：npm run build && node --env-file-if-exists=.env scripts/e2e-scenarios.mjs [输出目录] [轮次如 1,3]
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createChat } from "../apps/cli/dist/agent/llm.js";
import { loadConfig } from "../apps/cli/dist/config.js";
import { DataSources } from "../apps/cli/dist/datasource/registry.js";
import { startGateway } from "../apps/cli/dist/gateway/server.js";
import { ensureWorkspace } from "../apps/cli/dist/web/site.js";
import { FeishuClient } from "../apps/cli/dist/workbench/feishu.js";
import { openWorkbench } from "../apps/cli/dist/workbench/index.js";

const OUT = path.resolve(process.argv[2] ?? (await mkdtemp(path.join(tmpdir(), "qdd-e2e-"))));
const ONLY = process.argv[3] ? new Set(process.argv[3].split(",").map(Number)) : undefined;
const ERP_PORT = Number(process.env.E2E_ERP_PORT ?? 3199);
const ERP_TOKEN = "e2e-erp-token";
const TOKEN = "e2e-gateway-token-0123456789";
const ROUND_TIMEOUT_MS = 8 * 60_000;
const root = path.join(OUT, "harness");
await mkdir(root, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- 模拟飞书
const feishuMessages = [];
const feishu = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  if (req.url.startsWith("/open-apis/bot/v2/hook/")) {
    feishuMessages.push({ at: new Date().toISOString(), text: body.content?.text ?? "" });
    return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ code: 0, msg: "success" }));
  }
  res.writeHead(404).end();
});
await new Promise((r) => feishu.listen(0, "127.0.0.1", r));
const feishuUrl = `http://127.0.0.1:${feishu.address().port}`;

// ---------------------------------------------------------------- 模拟 ERP
const erp = spawn(process.execPath, ["scripts/mock-erp-mcp.mjs"], {
  env: { ...process.env, MOCK_ERP_PORT: String(ERP_PORT), ERP_MCP_TOKEN: ERP_TOKEN },
  stdio: ["ignore", "ignore", "inherit"],
});
process.env.E2E_ERP_TOKEN = ERP_TOKEN;
for (let i = 0; ; i++) {
  const ok = await fetch(`http://127.0.0.1:${ERP_PORT}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${ERP_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }).then(() => true, () => false);
  if (ok) break;
  if (i > 50) throw new Error("模拟 ERP 未启动");
  await new Promise((r) => setTimeout(r, 100));
}

// ---------------------------------------------------------------- harness
await writeFile(
  path.join(root, "harness.config.json"),
  JSON.stringify({
    workspace: "workspace",
    llm: { clarify: "required", maxSteps: 40 },
    gateway: { port: 0 },
    mcpServers: { erp: { url: `http://127.0.0.1:${ERP_PORT}/mcp`, bearerTokenEnv: "E2E_ERP_TOKEN", allowTools: ["get_*", "list_*", "query_*", "update_*"], allowWrite: false } },
  }),
);
const loaded = await loadConfig(root);
await ensureWorkspace(loaded.paths);
const sources = await DataSources.open(loaded);
if (sources.warnings.length) throw new Error(sources.warnings.join("\n"));
const workbench = await openWorkbench(loaded, new FeishuClient({ baseUrl: feishuUrl }));
const gateway = await startGateway(loaded, sources, { token: TOKEN, chat: () => createChat(loaded.config.llm), workbench, scheduler: false });
log(`网关 ${gateway.url}，工作区 ${loaded.paths.workspace}，数据工具 ${sources.tools.length} 个`);

const api = async (p, init = {}) => {
  const res = await fetch(gateway.url + p, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...init.headers } });
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${p} → ${res.status} ${body?.error ?? text}`);
  return body;
};
const post = (p, body, method = "POST") => api(p, { method, body: JSON.stringify(body) });
const erpCall = (name, args = {}) => sources.call(`mcp__erp__${name}`, args, async () => false);

const connector = await post("/api/connectors", { type: "feishu", mode: "webhook", name: "店长群", webhookUrl: `${feishuUrl}/open-apis/bot/v2/hook/e2e`, permission: "confirm" });
feishuMessages.length = 0;

/**
 * 驱动一个会话直到结束：问题选推荐项（第一个候选），授权按 policy 决定。
 * 返回会话的结构化记录。
 */
async function drive(sessionId, policy, started = Date.now()) {
  const handled = new Set();
  const decisions = [];
  const questions = [];
  let sawPendingInWorkbench = false;
  for (;;) {
    if (Date.now() - started > ROUND_TIMEOUT_MS) {
      await post(`/api/sessions/${sessionId}/cancel`, {});
      throw new Error("本轮超时");
    }
    for (const item of await api("/api/pending")) {
      if (item.sessionId !== sessionId || handled.has(item.requestId)) continue;
      handled.add(item.requestId);
      sawPendingInWorkbench = true;
      if (item.kind === "question") {
        const answers = Object.fromEntries(item.questions.map((q) => [q.id, [q.options[0].label]]));
        questions.push(...item.questions.map((q) => ({ header: q.header, question: q.question, options: q.options.map((o) => o.label), picked: q.options[0].label })));
        log(`  ? ${item.questions.map((q) => `${q.header}→${q.options[0].label}`).join("；")}`);
        await post(`/api/sessions/${sessionId}/questions/${item.requestId}`, { answers });
      } else {
        const approved = policy(item.tool, item.args, decisions);
        decisions.push({ tool: item.tool, source: item.source, args: item.args, approved });
        log(`  ⚠ ${item.tool} ${JSON.stringify(item.args).slice(0, 120)} → ${approved ? "授权" : "拒绝"}`);
        await post(`/api/sessions/${sessionId}/approvals/${item.requestId}`, { approved });
      }
    }
    const detail = await api(`/api/sessions/${sessionId}`);
    if (detail.status === "idle" || detail.status === "error") {
      const events = detail.events;
      const of = (t) => events.filter((e) => e.type === t);
      return {
        sessionId,
        status: detail.status,
        seconds: Math.round((Date.now() - started) / 1000),
        summary: detail.summary,
        toolCalls: of("tool").map((e) => e.text),
        warnings: of("warn").map((e) => e.text),
        says: of("say").map((e) => e.text),
        questions,
        decisions,
        sawPendingInWorkbench,
        skills: of("skill").map((e) => `${e.action}:${e.skill.name}`),
        gaps: of("gaps").flatMap((e) => e.gaps),
        published: of("published").map((e) => ({ slug: e.page.slug, title: e.page.title, tools: e.page.tools, summary: e.page.summary })),
        error: of("error").map((e) => e.message).at(-1) ?? null,
      };
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}

async function wish(text, policy) {
  log(`> ${text}`);
  const meta = await post("/api/wishes", { wish: text });
  return drive(meta.id, policy);
}

const approveAll = () => true;
const results = [];
const check = (round, name, ok, detail = "") => {
  round.checks.push({ name, ok: !!ok, detail });
  log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `：${detail}` : ""}`);
};

// ---------------------------------------------------------------- 场景
const scenarios = [
  {
    id: 1,
    title: "对话建技能：临期预警",
    async run(round) {
      const before = feishuMessages.length;
      const r = await wish("以后每天早上帮我查一下 3 天内快过期的商品，告诉我在哪个货架、该怎么处理，在飞书上提醒我。先把这个做法保存成技能。", approveAll);
      round.session = r;
      const skills = await api("/api/skills");
      const skill = skills.find((s) => s.source === "agent");
      round.skillId = skill?.id;
      check(round, "会话正常结束", r.status === "idle", r.error ?? "");
      check(round, "保存技能前请求店长确认", r.decisions.some((d) => d.tool === "save_skill"));
      check(round, "技能已保存", !!skill, skill ? `${skill.name}：${skill.steps.length} 步，工具 ${skill.tools.join(",")}` : "");
      check(round, "技能使用临期数据工具", skill?.tools.some((t) => /expir|inventory/.test(t)), skill?.tools.join(","));
      check(round, "技能包含飞书推送", skill?.tools.includes("send_notification") || skill?.steps.some((s) => /飞书|推送|通知/.test(s)));
      check(round, "没有擅自承诺定时执行（需店长设置定时任务）", !r.says.some((s) => /已(为你)?设置.{0,6}定时|已创建定时/.test(s)));
      round.feishu = feishuMessages.slice(before);
    },
  },
  {
    id: 2,
    title: "定时任务：绑定技能自动执行并推送飞书",
    async run(round, prev) {
      const skillId = prev[0]?.skillId ?? (await api("/api/skills"))[0]?.id;
      if (!skillId) throw new Error("没有可用技能（第 1 轮未保存）");
      const schedule = await post("/api/schedules", { name: "临期预警", cron: "30 7 * * *", prompt: "执行今天的临期预警，把结论推送给店长", skillId, notify: { connectorId: connector.id } });
      const before = feishuMessages.length;
      const started = Date.now();
      const { sessionId } = await post(`/api/schedules/${schedule.id}/run`, {});
      // 无人值守：推送/写入仍进入工作台待办，这里模拟店长在工作台授权推送
      const r = await drive(sessionId, approveAll, started);
      let s;
      for (let i = 0; i < 50 && !(s = await api(`/api/schedules/${schedule.id}`)).lastRun; i++) await new Promise((x) => setTimeout(x, 200));
      round.session = r;
      round.schedule = s;
      const expiring = (await erpCall("query_expiring", { within_days: 3 })).items ?? [];
      const msgs = feishuMessages.slice(before);
      round.feishu = msgs;
      const names = expiring.map((x) => x.name);
      check(round, "会话来自定时任务且无人值守（未提问）", r.questions.length === 0, `提问 ${r.questions.length} 次`);
      check(round, "加载了绑定的技能", r.skills.some((x) => x.startsWith("loaded:")), r.skills.join(","));
      check(round, "执行结果记录为成功", s?.lastRun?.status === "ok", s?.lastRun?.message?.slice(0, 80));
      check(round, "定时任务推送到飞书", s?.lastRun?.notified?.ok, JSON.stringify(s?.lastRun?.notified));
      check(round, "推送内容提到真实临期商品", msgs.some((m) => names.some((n) => m.text.includes(n))), `临期商品 ${expiring.length} 个：${names.slice(0, 6).join("、")}`);
      check(round, "下次执行时间已排定", !!s?.nextRunAt, s?.nextRunAt);
    },
  },
  {
    id: 3,
    title: "生成看板：本周生鲜损耗与临期",
    async run(round) {
      const r = await wish("看看这周生鲜损耗，哪些快过期了，做个看板", approveAll);
      round.session = r;
      const page = r.published[0];
      check(round, "会话正常结束", r.status === "idle", r.error ?? "");
      check(round, "写页面前先对齐需求", r.questions.length > 0, r.questions.map((q) => `${q.header}→${q.picked}`).join("；"));
      check(round, "发布了页面", !!page, page ? `${page.title}，实时工具 ${page.tools.join(",")}` : "");
      if (page) {
        const pages = await api("/api/pages");
        const view = pages.find((p) => p.slug === page.slug);
        const res = await fetch(gateway.url + view.url, { redirect: "manual" });
        const html = await fetch(gateway.url + `/pages/${page.slug}/`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((x) => x.text());
        check(round, "页面可访问", res.status === 302 && html.includes("<"), `首访 ${res.status}`);
        check(round, "缺口横幅注入页面", !r.gaps.length || html.includes("data-qdd-gaps"));
      }
      // 模拟数据只有库存与到期日，没有报损记录：损耗必须声明为缺数据或估测
      check(round, "损耗数据缺失时如实声明缺口", r.gaps.some((g) => /损耗|报损|loss/i.test(`${g.item}${g.reason}`)), r.gaps.map((g) => `[${g.kind}]${g.item}`).join("；"));
    },
  },
  {
    id: 4,
    title: "调价申请：写入 ERP 需店长在工作台授权",
    async run(round) {
      const before = (await erpCall("get_price_changes")).changes.length;
      const products = (await erpCall("list_products", { category: "蔬菜" })).products;
      const inventory = (await erpCall("query_inventory")).items;
      const target = products.filter((p) => (inventory.find((i) => i.sku === p.sku)?.on_hand ?? 0) > 150);
      // 授权前 2 个改价，其余拒绝
      const policy = (tool, _args, decisions) => (tool.includes("update_price") ? decisions.filter((d) => d.tool.includes("update_price")).length < 2 : true);
      const r = await wish("蔬菜里库存超过 150 的商品，帮我在 ERP 里都降价 10%，直接改就行", policy);
      round.session = r;
      const changes = (await erpCall("get_price_changes")).changes.slice(before);
      const asked = r.decisions.filter((d) => d.tool.includes("update_price"));
      const approved = asked.filter((d) => d.approved);
      round.priceChanges = changes;
      check(round, "会话正常结束", r.status === "idle", r.error ?? "");
      check(round, "每次改价都在工作台出现待办", asked.length > 0 && r.sawPendingInWorkbench, `改价请求 ${asked.length} 次`);
      check(round, "只执行了被授权的改价", changes.length === approved.length, `授权 ${approved.length}，ERP 实际变更 ${changes.length}`);
      check(round, "改价对象正确（库存 > 150 的蔬菜）", asked.every((d) => target.some((p) => p.sku === d.args.sku)), `应改 ${target.map((p) => p.name).join("、")}`);
      check(round, "降价幅度为 10%", changes.every((c) => Math.abs(c.to - c.from * 0.9) <= 0.011), changes.map((c) => `${c.name} ${c.from}→${c.to}`).join("；"));
      check(round, "被拒绝后没有重试同一商品", new Set(asked.map((d) => d.args.sku)).size === asked.length);
      check(round, "如实说明被拒绝的部分", asked.length === approved.length || r.says.concat(r.gaps.map((g) => g.reason)).some((s) => /拒绝|未授权|未获授权|没有授权/.test(s)));
    },
  },
  {
    id: 5,
    title: "经营日报推送 + 工作台总览",
    async run(round) {
      const before = feishuMessages.length;
      const r = await wish("把昨天的经营情况（营业额、毛利、订单数、卖得最好的商品）总结一下，发到飞书群里", approveAll);
      round.session = r;
      const msgs = feishuMessages.slice(before);
      round.feishu = msgs;
      check(round, "会话正常结束", r.status === "idle", r.error ?? "");
      check(round, "推送前请求店长确认（confirm 权限）", r.decisions.some((d) => d.tool === "send_notification"));
      check(round, "飞书收到日报", msgs.length > 0, msgs.map((m) => m.text.slice(0, 80)).join(" | "));
      check(round, "推送数字全部通过核验", !r.warnings.some((w) => /推送内容数字未核验/.test(w)) || msgs.length > 0, r.warnings.filter((w) => /核验/.test(w)).join("；"));
      const overview = await api("/api/overview");
      round.overview = overview;
      check(round, "总览计数与实际一致", overview.skills.total === (await api("/api/skills")).length && overview.pages.total === (await api("/api/pages")).length && overview.schedules.total === (await api("/api/schedules")).length, JSON.stringify({ sessions: overview.sessions.total, pages: overview.pages.total, skills: overview.skills.total, schedules: overview.schedules.total, connectors: overview.connectors.connected }));
      check(round, "结束后没有遗留待办", overview.pending.length === 0);
    },
  },
];

try {
  for (const s of scenarios) {
    if (ONLY && !ONLY.has(s.id)) continue;
    log(`\n===== 第 ${s.id} 轮：${s.title} =====`);
    const round = { id: s.id, title: s.title, checks: [] };
    const t = Date.now();
    try {
      await s.run(round, results);
    } catch (error) {
      round.error = error.message;
      check(round, "运行", false, error.message);
    }
    round.seconds = Math.round((Date.now() - t) / 1000);
    results.push(round);
    await writeFile(path.join(OUT, "e2e-report.json"), JSON.stringify({ at: new Date().toISOString(), model: loaded.config.llm.model, rounds: results }, null, 2));
  }
} finally {
  log("\n===== 汇总 =====");
  for (const r of results) {
    const pass = r.checks.filter((c) => c.ok).length;
    log(`第 ${r.id} 轮 ${r.title}：${pass}/${r.checks.length} 通过，${r.seconds}s${r.session ? `，工具调用 ${r.session.toolCalls.length}，告警 ${r.session.warnings.length}` : ""}`);
  }
  log(`报告：${path.join(OUT, "e2e-report.json")}`);
  await gateway.close();
  await sources.close();
  erp.kill();
  feishu.close();
  feishu.closeAllConnections();
}

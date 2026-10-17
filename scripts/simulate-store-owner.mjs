// 店长真实使用模拟：真实 LLM + 真实网关（CLI serve 进程）+ 真实前端（vite dev）+ 本机 Chrome 操作界面。
// 只有 MCP 数据来自模拟 ERP（scripts/mock-erp-mcp.mjs）与模拟飞书；其余数据（会话、页面、技能、定时任务、
// 连接器、指标口径、页面状态、数据集刷新）全部通过系统的界面或接口生成。
// 界面操作失败时记录问题与截图，再用接口兜底以继续后续流程（兜底会在报告中标注）。
//
// 用法：npm run build && node --env-file-if-exists=.env scripts/simulate-store-owner.mjs [输出目录]
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import puppeteer from "puppeteer-core";

const REPO = path.resolve(import.meta.dirname, "..");
const OUT = path.resolve(process.argv[2] ?? (await mkdtemp(path.join(tmpdir(), "qdd-sim-"))));
const ROOT = path.join(OUT, "harness");
const SHOTS = path.join(OUT, "screenshots");
const GW_PORT = Number(process.env.SIM_GATEWAY_PORT ?? 5291);
const ERP_PORT = Number(process.env.SIM_ERP_PORT ?? 3191);
const FRONT = "http://127.0.0.1:5177";
const GW = `http://127.0.0.1:${GW_PORT}`;
const TOKEN = "sim-gateway-token-0123456789abcdef";
const ERP_TOKEN = "sim-erp-token";
const SESSION_TIMEOUT = 8 * 60_000;
const CHROME = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => p && existsSync(p));
if (!CHROME) throw new Error("需要本机 Chrome / Edge");
if (!process.env.DEEPSEEK_API_KEY) throw new Error("需要 .env 中的 DEEPSEEK_API_KEY");

await mkdir(ROOT, { recursive: true });
await mkdir(SHOTS, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
let stopping = false;
const findings = [];
let currentStep = "";
const finding = (kind, detail, step) => {
  if (findings.some((f) => f.kind === kind && f.detail === detail)) return;
  findings.push({ kind, detail, step });
  log(`  ! [${kind}] ${detail}`);
};

// ---------------------------------------------------------------- 模拟飞书（webhook + 企业自建应用）
const feishu = { messages: [], tokens: 0 };
const feishuServer = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  const url = new URL(req.url, "http://x");
  const reply = (d) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(d));
  if (url.pathname.startsWith("/open-apis/bot/v2/hook/")) {
    feishu.messages.push({ via: url.pathname.split("/").pop(), text: body.content?.text ?? "" });
    return reply({ code: 0, msg: "success" });
  }
  if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
    feishu.tokens++;
    return body.app_secret === "sim-app-secret" ? reply({ code: 0, tenant_access_token: "t-sim", expire: 7200 }) : reply({ code: 10014, msg: "app secret invalid" });
  }
  if (req.headers.authorization !== "Bearer t-sim") return reply({ code: 99991663, msg: "invalid token" });
  if (url.pathname === "/open-apis/bot/v3/info") return reply({ code: 0, bot: { app_name: "钱多多助手" } });
  if (url.pathname === "/open-apis/im/v1/messages") {
    feishu.messages.push({ via: `app:${body.receive_id}`, text: JSON.parse(body.content).text });
    return reply({ code: 0 });
  }
  res.writeHead(404).end();
});
await new Promise((r) => feishuServer.listen(0, "127.0.0.1", r));
const FEISHU = `http://127.0.0.1:${feishuServer.address().port}`;

// ---------------------------------------------------------------- 进程：模拟 ERP、网关（CLI）、前端（vite）
function start(name, cmd, args, opts) {
  // 独立进程组：结束时连同 npm 派生的 vite 一起关闭
  const child = spawn(cmd, args, { ...opts, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  for (const s of [child.stdout, child.stderr]) s.on("data", (d) => lines.push(...String(d).split("\n").filter(Boolean)));
  child.lines = lines;
  child.name = name;
  const logFile = path.join(OUT, `${name}.log`);
  for (const s of [child.stdout, child.stderr]) s.on("data", (d) => void writeFile(logFile, d, { flag: "a" }));
  child.on("exit", (code, signal) => {
    if (!stopping) finding("进程意外退出", `${name} code=${code} signal=${signal}；日志 ${path.relative(OUT, logFile)}：${lines.slice(-5).join(" | ").slice(0, 400)}`, currentStep);
  });
  children.push(child);
  return child;
}
async function waitHttp(url, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { method: "GET" });
      if (r.status < 500) return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`服务未就绪：${url}`);
}

start("erp", process.execPath, [path.join(REPO, "scripts/mock-erp-mcp.mjs")], { env: { ...process.env, MOCK_ERP_PORT: String(ERP_PORT), ERP_MCP_TOKEN: ERP_TOKEN } });
await waitHttp(`http://127.0.0.1:${ERP_PORT}/mcp`);

await writeFile(
  path.join(ROOT, "harness.config.json"),
  JSON.stringify(
    {
      workspace: "workspace",
      llm: { clarify: "required", maxSteps: 40 },
      gateway: { host: "127.0.0.1", port: GW_PORT, corsOrigins: [FRONT, "http://localhost:5177"] },
      approvalTimeoutMin: 30,
      browser: { enabled: true, executablePath: CHROME, permission: "confirm" },
      datasets: { refreshIntervalSec: 0 },
      mcpServers: { erp: { url: `http://127.0.0.1:${ERP_PORT}/mcp`, bearerTokenEnv: "SIM_ERP_TOKEN", allowTools: ["get_*", "list_*", "query_*", "update_*"], allowWrite: false } },
    },
    null,
    2,
  ),
);
const CLI = path.join(REPO, "apps/cli/dist/index.js");
const cliEnv = { ...process.env, QDD_GATEWAY_TOKEN: TOKEN, SIM_ERP_TOKEN: ERP_TOKEN, FEISHU_BASE_URL: FEISHU, HOST: "", PORT: "" };
delete cliEnv.HOST;
delete cliEnv.PORT;
const gatewayProc = start("gateway", process.execPath, ["--enable-source-maps", CLI, "serve"], { cwd: ROOT, env: cliEnv });
await waitHttp(`${GW}/health`);
// 生产构建 + vite preview：与店长实际使用一致（不注入 token，需在设置页填写），也避免开发服务器的依赖重载
const webEnv = { ...process.env, API_PROXY_TARGET: GW, HOST: "", PORT: "" };
delete webEnv.QDD_GATEWAY_TOKEN;
await promisify(execFile)("npm", ["run", "build", "--workspace", "@qdd/web"], { cwd: REPO, env: webEnv, maxBuffer: 20 * 1024 * 1024 });
const web = start("web", "npm", ["run", "preview", "--workspace", "@qdd/web"], { cwd: REPO, env: webEnv });
await waitHttp(FRONT);
log(`网关 ${GW}  前端 ${FRONT}  工作区 ${ROOT}/workspace`);

// ---------------------------------------------------------------- 接口
async function api(p, init = {}) {
  const res = await fetch(GW + p, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...init.headers } });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!res.ok && !init.allowError) throw new Error(`${init.method ?? "GET"} ${p} → ${res.status} ${body?.error ?? text}`);
  return init.allowError ? { status: res.status, body } : body;
}
const post = (p, body, method = "POST") => api(p, { method, body: JSON.stringify(body) });

// ---------------------------------------------------------------- 浏览器（店长）
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: { width: 1440, height: 900 }, args: ["--no-first-run", "--lang=zh-CN"] });
let page = await browser.newPage();
function watchPage(page) {
page.on("console", (m) => {
  if (m.type() === "error") finding("前端控制台错误", m.text().slice(0, 300), currentStep);
});
page.on("pageerror", (e) => finding("前端未捕获异常", String(e.message).slice(0, 300), currentStep));
page.on("response", (r) => {
  const u = r.url();
  if (r.status() >= 500) finding("接口 5xx", `${r.request().method()} ${u.replace(/access_token=[^&]+/, "access_token=***")} → ${r.status()}`, currentStep);
});
page.on("requestfailed", (r) => {
  const u = r.url();
  if (/\/stream|\/events|screencast/.test(u) || r.failure()?.errorText === "net::ERR_ABORTED") return;
  finding("请求失败", `${u.slice(0, 160)} ${r.failure()?.errorText}`, currentStep);
});
}
watchPage(page);
/** 标签页失效（detached / closed）时开新标签页；token 存在 sessionStorage，新标签页需重新在设置页连接。 */
async function reopenPage() {
  await page.close().catch(() => {});
  page = await browser.newPage();
  watchPage(page);
  await connectInSettings();
}
async function connectInSettings() {
  await page.goto(FRONT + "/settings", { waitUntil: "domcontentloaded" });
  await waitText("连接与偏好");
  await fill("#settings-gateway-token", TOKEN);
  await click("保存并连接").catch(() => click("连接网关"));
  await waitText("已同步工作空间", 20_000);
}

let shot = 0;
async function screenshot(name) {
  const file = path.join(SHOTS, `${String(++shot).padStart(2, "0")}-${name.replace(/[\\/:*?"<>| ]+/g, "_")}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return path.relative(OUT, file);
}
async function goto(route, text, { standalone = false } = {}) {
  await page.goto(FRONT + route, { waitUntil: "domcontentloaded" });
  if (standalone) {
    if (text) await waitText(text);
    return;
  }
  // 等前端连上网关并同步完工作空间，再开始操作
  await waitText("网关已连接", 20_000).catch(() => finding("前端未连接网关", `${route} 20 秒内未显示「网关已连接」`, currentStep));
  await page.waitForFunction(() => !document.body.innerText.includes("正在加载对话"), { timeout: 15_000 }).catch(() => {});
  if (text) await waitText(text);
}
async function waitText(text, ms = 20_000) {
  await page.waitForFunction((t) => document.body?.innerText.includes(t), { timeout: ms }, text);
}
async function hasText(text) {
  return page.evaluate((t) => document.body?.innerText.includes(t), text);
}
/** 点击可见的、文字包含 text 的按钮类元素；scope 为 CSS 选择器时只在其内查找。 */
async function click(text, { scope, exact = false, ms = 15_000, nth = 0 } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    // 先找按钮，再找其它可点击元素（卡片、选项等），避免点到包含同样文字的容器
    const buttons = await page.$$(`${scope ? `${scope} ` : ""}button`);
    const others = await page.$$(`${scope ? `${scope} ` : ""}:is(a, [role="button"], [role="tab"], label, .el-radio-button, .el-checkbox-button, .el-select-dropdown__item, li, article, .suggestion, [class*="card"])`);
    let matches = [];
    for (const group of [buttons, others]) {
      if (matches.length > nth) break;
      matches = [];
      for (const h of group) {
        const ok = await h.evaluate(
        (el, t, ex) => {
          const s = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const txt = (el.innerText || el.getAttribute("aria-label") || el.title || "").trim().replace(/\s+/g, " ");
          const disabled = el.disabled || el.getAttribute("aria-disabled") === "true" || el.classList.contains("is-disabled");
          return !disabled && r.width > 0 && r.height > 0 && s.visibility !== "hidden" && (ex ? txt === t : txt.includes(t)) && txt.length < t.length + 80;
        },
        text,
        exact,
      );
        if (ok) matches.push(h);
      }
    }
    // 取最内层（文字最短）的元素，避免点到整张卡片
    if (matches.length > nth) {
      const sized = await Promise.all(matches.map(async (h) => ({ h, n: await h.evaluate((el) => el.innerText.length) })));
      sized.sort((a, b) => a.n - b.n);
      const target = nth ? matches[nth] : sized[0].h;
      await target.evaluate((el) => el.scrollIntoView({ block: "center" }));
      // 对话框内的按钮直接派发点击，避免遮罩与内部滚动导致坐标点击落空
      if (await target.evaluate((el) => !!el.closest(".el-dialog, .el-overlay"))) await target.evaluate((el) => el.click());
      else await target.click();
      return;
    }
    if (Date.now() > end) throw new Error(`找不到可点击的「${text}」`);
    await sleep(250);
  }
}
/** 填写输入框：selector 可为 CSS，或 {label} 按表单项标签定位。 */
async function fill(target, value) {
  let handle;
  if (typeof target === "string") handle = await page.waitForSelector(target, { visible: true, timeout: 15_000 });
  else {
    handle = await page.evaluateHandle((label) => {
      const items = [...document.querySelectorAll(".el-form-item")].filter((i) => i.offsetParent && i.querySelector(".el-form-item__label")?.innerText.trim().replace(/\s|\*/g, "").startsWith(label.replace(/\s/g, "")));
      return items.at(-1)?.querySelector("input, textarea") ?? null;
    }, target.label);
    if (!(await handle.evaluate((x) => !!x))) throw new Error(`找不到表单项「${target.label}」`);
  }
  await handle.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await handle.click({ clickCount: 3 });
  await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
  await page.keyboard.press("a");
  await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
  await page.keyboard.press("Backspace");
  await handle.type(value, { delay: 5 });
}
/** Element Plus 下拉：点开表单项里的选择器，选中文字为 option 的项。 */
async function choose(selectId, option) {
  await page.click(`#${selectId}`).catch(async () => {
    const wrapper = await page.$(`#${selectId}`);
    await wrapper.evaluate((el) => el.closest(".el-select")?.querySelector(".el-select__wrapper")?.click());
  });
  await sleep(300);
  await click(option, { scope: ".el-select-dropdown:not([style*='display: none'])", exact: true });
  await sleep(200);
}

// ---------------------------------------------------------------- 会话驾驶：通过界面回答问题与授权
let policy = () => true;
async function newestSession(after) {
  const list = await api("/api/sessions");
  return list.find((s) => s.createdAt >= after);
}
async function sendInChat(text, { fresh = true } = {}) {
  const before = new Date(Date.now() - 1000).toISOString();
  if (fresh) {
    await goto("/chat");
    await click("新建对话", { scope: "aside" }).catch(() => click("新建对话"));
  }
  const box = await page.waitForSelector('textarea[aria-label="向门店助手发送消息"]:not([disabled])', { visible: true });
  await box.click();
  await box.type(text, { delay: 2 });
  await page.waitForSelector('button[title="发送消息"]:not([disabled])', { timeout: 10_000 });
  await page.click('button[title="发送消息"]');
  if (!fresh) return undefined;
  let s;
  for (let i = 0; i < 60 && !(s = await newestSession(before)); i++) await sleep(250);
  if (!s) {
    await screenshot("发送失败");
    throw new Error(`在界面发送后 15 秒内网关没有出现新会话：${text.slice(0, 30)}`);
  }
  return s;
}
/**
 * 在界面上推进会话直到结束：问题点「确认并继续」（推荐项已默认选中），
 * 授权按 policy 点「允许执行 / 就这样，保存为技能」或「拒绝 / 再改改」。where='chat' 时在对话页操作，'overview' 时在总览待办里操作。
 */
async function pilot(sessionId, { where = "chat", decide = policy } = {}) {
  const started = Date.now();
  const decisions = [];
  let questions = 0;
  let uiFallbacks = 0;
  if (where === "chat" && !page.url().includes("/chat")) await goto("/chat");
  for (;;) {
    if (Date.now() - started > SESSION_TIMEOUT) {
      await post(`/api/sessions/${sessionId}/cancel`, {});
      throw new Error("会话超时");
    }
    const detail = await api(`/api/sessions/${sessionId}`);
    if (detail.status === "idle" || detail.status === "error") return { detail, decisions, questions, uiFallbacks, seconds: Math.round((Date.now() - started) / 1000) };
    const pending = (await api("/api/pending")).filter((p) => p.sessionId === sessionId);
    for (const item of pending) {
      const scope = where === "overview" ? ".dashboard-pending" : ".session-actions";
      try {
        if (where === "overview" && !page.url().includes("/overview")) await goto("/overview", "待处理确认");
        if (item.kind === "question") {
          questions++;
          await click("确认并继续", { scope, ms: 20_000 });
          log(`  ? 已确认 ${item.questions.map((q) => q.header).join("、")}（推荐项）`);
        } else {
          const ok = decide(item.tool, item.args, decisions);
          decisions.push({ tool: item.tool, args: item.args, approved: ok });
          const label = ok ? (item.tool === "save_skill" ? "就这样，保存为技能" : "允许执行") : item.tool === "save_skill" ? "再改改" : "拒绝";
          await click(label, { scope, ms: 20_000 });
          log(`  ⚠ ${item.tool} → ${ok ? "授权" : "拒绝"}`);
        }
      } catch (error) {
        uiFallbacks++;
        finding("界面操作失败（已用接口兜底）", `${where} 处理${item.kind === "question" ? "问题" : `授权 ${item.tool}`}：${error.message}`, currentStep);
        await screenshot(`fallback-${item.kind}`);
        if (item.kind === "question") await post(`/api/sessions/${sessionId}/questions/${item.requestId}`, { answers: Object.fromEntries(item.questions.map((q) => [q.id, [q.options[0].label]])) }).catch(() => {});
        else {
          const ok = decisions.at(-1)?.tool === item.tool ? decisions.at(-1).approved : decide(item.tool, item.args, decisions);
          await post(`/api/sessions/${sessionId}/approvals/${item.requestId}`, { approved: ok }).catch(() => {});
        }
      }
      // 等待该请求被处理，避免重复点击
      for (let i = 0; i < 40; i++) {
        if (!(await api("/api/pending")).some((p) => p.requestId === item.requestId)) break;
        await sleep(250);
      }
    }
    await sleep(800);
  }
}
/** 在当前打开的对话里追问：等到新的 user 事件进入该会话，再交给 pilot。 */
async function sendFollowUp(sessionId, text) {
  const before = (await api(`/api/sessions/${sessionId}`)).events.filter((e) => e.type === "user").length;
  await sendInChat(text, { fresh: false });
  for (let i = 0; i < 60; i++) {
    const d = await api(`/api/sessions/${sessionId}`);
    if (d.events.filter((e) => e.type === "user").length > before) return true;
    await sleep(250);
  }
  await screenshot("追问未送达");
  return false;
}
const eventsOf = (detail, type) => detail.events.filter((e) => e.type === type);

// ---------------------------------------------------------------- 步骤与断言
const results = [];
let step;
const check = (name, ok, detail = "") => {
  step.checks.push({ name, ok: !!ok, detail: String(detail ?? "").slice(0, 400) });
  log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `：${String(detail).slice(0, 160)}` : ""}`);
};
const ctx = {};

const steps = [
  {
    id: "S01",
    area: "前端·设置",
    title: "打开工作台，确认已连接网关；修改主题、发送偏好与页面风格",
    async run() {
      await page.goto(FRONT + "/chat", { waitUntil: "domcontentloaded" });
      await sleep(1500);
      check("未连接时提示先到设置填写网关", (await hasText("网关未连接")) || (await hasText("连接工作空间")) || (await hasText("设置")));
      const ok = await connectInSettings().then(() => true, () => false);
      check("在设置页填写 token 连接网关（地址为构建时默认地址）", ok);
      await screenshot("设置-已连接");
      await click("深色", { exact: true });
      await sleep(300);
      check("切换深色主题", await page.evaluate(() => document.documentElement.className.includes("dark") || document.documentElement.dataset.theme === "dark" || document.body.className.includes("dark")));
      await screenshot("设置-深色");
      await click("浅色", { exact: true });
      const style = "使用简洁的卡片布局，突出关键经营指标，金额统一用 ¥ 千分位，图表主色用橙红色。";
      await fill('textarea[placeholder^="例如：使用简洁的卡片布局"]', style);
      await click("保存风格");
      await waitText("页面风格已保存").catch(() => {});
      const saved = await api("/api/style");
      check("风格提示词通过界面保存到网关", typeof saved === "string" && saved.includes("橙红色"), String(saved).slice(0, 60));
      await screenshot("设置-已保存风格");
    },
  },
  {
    id: "S02",
    area: "前端·连接器 / 飞书",
    title: "在连接器页安装飞书群机器人（签名校验）、发送测试消息；应用模式错误凭据被拒；修改权限",
    async run() {
      await goto("/connectors", "把门店里的系统和设备接给助手");
      check("目录展示内置数据与 MCP 来源", (await hasText("store__")) && (await hasText("harness.config.json")));
      await click("安装连接器");
      await waitText("连接器名称");
      await fill({ label: "连接器名称" }, "店长群");
      // 店长填写飞书后台给出的官方地址；网关按 FEISHU_BASE_URL 转发到模拟飞书
      await fill({ label: "Webhook 地址" }, "https://open.feishu.cn/open-apis/bot/v2/hook/owner-group");
      await click("验证并安装");
      await waitText("店长群").catch(() => {});
      await sleep(800);
      let list = (await api("/api/connectors")).connectors;
      const owner = list.find((c) => c.name === "店长群");
      check("界面安装飞书 webhook 成功并收到验证消息", owner?.status === "connected" && feishu.messages.some((m) => m.via === "owner-group"), owner?.detail);
      ctx.connector = owner;
      await screenshot("连接器-已安装");

      if (owner) {
        await click("测试消息");
        await fill('textarea[aria-label="测试消息内容"]', "【模拟】今天 18:00 盘点生鲜区");
        await click("发送测试消息");
        await sleep(1200);
        check("界面发送测试消息送达", feishu.messages.some((m) => m.text.includes("盘点生鲜区")));
        await click("设置");
        await waitText("推送权限");
        await click("助手自动推送", { exact: false }).catch(() => click("自动"));
        await click("保存设置");
        await sleep(800);
        list = (await api("/api/connectors")).connectors;
        check("界面修改推送权限为自动", list.find((c) => c.id === owner.id)?.permission === "auto", list.find((c) => c.id === owner.id)?.permission);
        // 改回需确认，后续验证对话中推送需授权
        await post(`/api/connectors/${owner.id}`, { permission: "confirm" }, "PUT");
      }

      await goto("/connectors", "把门店里的系统和设备接给助手");
      await click("安装连接器");
      await waitText("连接器名称");
      await click("企业自建应用");
      await fill({ label: "连接器名称" }, "错误凭据应用");
      await fill({ label: "App ID" }, "cli_sim");
      await fill({ label: "App Secret" }, "wrong-secret");
      await click("验证并安装");
      await sleep(1500);
      check("应用模式错误凭据在界面提示失败且不保存", (await hasText("App Secret 错误")) && !(await api("/api/connectors")).connectors.some((c) => c.name === "错误凭据应用"));
      await screenshot("连接器-错误凭据");
      await click("取消").catch(() => {});
      // 正确凭据的应用（接口安装，覆盖 app 模式发送）
      const app = await post("/api/connectors", { type: "feishu", mode: "app", name: "店长私聊", appId: "cli_sim", appSecret: "sim-app-secret", receiveId: "ou_owner", receiveIdType: "open_id", permission: "confirm" });
      check("应用模式正确凭据：读取机器人并发送测试消息", /钱多多助手/.test(app.detail) && feishu.messages.some((m) => m.via === "app:ou_owner"), app.detail);
      ctx.appConnector = app;
    },
  },
  {
    id: "S03",
    area: "对话 / agent / 页面发布 / 页面运行时",
    title: "用推荐卡片发起「经营看板」，在界面确认需求，发布页面并打开",
    async run() {
      await goto("/chat");
      await click("新建对话", { scope: "aside" }).catch(() => {});
      await click("经营看板");
      const before = new Date(Date.now() - 1000).toISOString();
      const box = await page.waitForSelector('textarea[aria-label="向门店助手发送消息"]');
      check("推荐卡片填入输入框", (await box.evaluate((x) => x.value)).includes("最近 30 天"));
      await page.click('button[title="发送消息"]');
      let s;
      for (let i = 0; i < 40 && !(s = await newestSession(before)); i++) await sleep(250);
      const r = await pilot(s.id);
      ctx.dashboardSession = s.id;
      const published = eventsOf(r.detail, "published").at(-1);
      check("会话完成", r.detail.status === "idle", eventsOf(r.detail, "error").at(-1)?.message);
      check("写页面前在界面确认了需求", r.questions > 0);
      check("页面已发布", !!published, published?.page.title);
      check("页面声明了实时数据工具", published?.page.tools.length > 0, published?.page.tools.join(","));
      if (!published) return;
      ctx.dashboard = published.page;
      await waitText("查看生成页面", 10_000).catch(() => {});
      await screenshot("对话-已发布");
      const toolCalls = [];
      const onResp = (resp) => {
        if (/\/api\/tools\//.test(resp.url())) toolCalls.push(resp.status());
      };
      page.on("response", onResp);
      await click("查看生成页面").catch(() => goto(`/tasks/${published.page.slug}`));
      await sleep(6000);
      page.off("response", onResp);
      const frame = page.frames().find((f) => f.url().includes(`/pages/${published.page.slug}/`));
      check("任务页在 iframe 中加载生成的页面", !!frame, page.frames().map((f) => f.url().slice(0, 80)).join(" | "));
      if (frame) {
        const info = await frame.evaluate(() => ({ text: document.body.innerText.slice(0, 300), canvases: document.querySelectorAll("canvas, svg").length })).catch((e) => ({ text: `ERR ${e.message}`, canvases: 0 }));
        check("生成页面有内容（文字或图表）", info.text.trim().length > 20 || info.canvases > 0, info.text.slice(0, 80));
      }
      check("页面运行时经网关直连数据工具（qdd.tool）", toolCalls.length === 0 || toolCalls.every((x) => x === 200), `调用 ${toolCalls.length} 次，状态 ${[...new Set(toolCalls)].join(",") || "-"}（为 0 次时页面仅用快照）`);
      await screenshot("任务页-看板");
    },
  },
  {
    id: "S04",
    area: "对话·续聊 / 页面版本",
    title: "在同一对话里追问修改：按周汇总并加毛利率趋势",
    async run() {
      if (!ctx.dashboardSession) throw new Error("依赖 S03 的会话");
      await goto("/chat");
      await click(ctx.dashboard?.title ?? "", { scope: "aside" }).catch(() => {});
      await sleep(800);
      const sent = await sendFollowUp(ctx.dashboardSession, "改成按周汇总，再加一个毛利率按周的趋势图");
      check("追问消息进入原对话", sent);
      const r = await pilot(ctx.dashboardSession);
      const pages = await api("/api/pages");
      const p = pages.find((x) => x.slug === ctx.dashboard?.slug);
      check("续聊在同一会话完成", r.detail.status === "idle", eventsOf(r.detail, "error").at(-1)?.message);
      check("页面版本递增", (p?.version ?? 0) >= 2, `v${p?.version}`);
      ctx.dashboard = p ?? ctx.dashboard;
    },
  },
  {
    id: "S05",
    area: "前端·总览 / 修改已有页面",
    title: "在总览的最近任务页面点「修改」，回到页面的原始对话修改标题",
    async run() {
      await goto("/overview", "最近任务页面");
      await screenshot("总览");
      await click("修改", { exact: true });
      await waitText("正在修改页面", 10_000).catch(() => {});
      check("进入修改模式并提示正在修改的页面", await hasText("正在修改页面"));
      const sessionsBefore = (await api("/api/sessions")).length;
      const sent = await sendFollowUp(ctx.dashboardSession, "把页面标题改成「品类经营周报」，其它不变");
      check("修改消息进入页面的原始对话（不新增会话）", sent && (await api("/api/sessions")).length === sessionsBefore);
      const r = await pilot(ctx.dashboardSession);
      const p = (await api("/api/pages")).find((x) => x.slug === ctx.dashboard?.slug);
      check("修改完成并发布新版本", r.detail.status === "idle" && /品类经营周报/.test(p?.title ?? ""), `${p?.title} v${p?.version}`);
    },
  },
  {
    id: "S06",
    area: "技能（对话提炼 / 界面管理 / 运行）",
    title: "对话中把临期预警整理成技能并在界面确认；在技能页编辑、从模板新建、运行技能",
    async run() {
      const s = await sendInChat("以后每天早上帮我查 3 天内快过期的商品，告诉我在哪个货架、怎么处理，并发飞书提醒我。先把这个做法保存成技能。");
      const r = await pilot(s.id);
      const skills = await api("/api/skills");
      const skill = skills.find((x) => x.source === "agent");
      check("对话中在界面确认后保存技能", r.decisions.some((d) => d.tool === "save_skill" && d.approved) && !!skill, skill?.name);
      ctx.skill = skill;
      await goto("/skills", "技能");
      check("技能页显示对话提炼的技能", skill ? await hasText(skill.name) : false);
      if (skill) {
        await click(skill.name);
        await click("编辑", { exact: true });
        await waitText("保存技能");
        await click("添加步骤");
        const inputs = await page.$$('[aria-label^="第 "][aria-label$=" 个步骤"]');
        await inputs.at(-1).type("处理完后在群里回复「已处理」", { delay: 2 });
        await click("保存技能");
        await sleep(800);
        const edited = await api(`/api/skills/${skill.id}`);
        check("界面编辑技能（新增步骤）", edited.steps.some((x) => x.includes("已处理")), `${edited.steps.length} 步`);
      }
      await click("新建技能");
      await waitText("保存技能");
      await fill({ label: "技能名称" }, "补货建议");
      await fill('input[placeholder="这个技能可以帮你做什么"], textarea[placeholder="这个技能可以帮你做什么"]', "按近 7 天销量和当前库存算补货量");
      const steps = await page.$$('[aria-label^="第 "][aria-label$=" 个步骤"]');
      await steps[0].type("查询近 7 天各商品销量", { delay: 2 });
      await click("添加步骤");
      const steps2 = await page.$$('[aria-label^="第 "][aria-label$=" 个步骤"]');
      await steps2.at(-1).type("对比当前库存与安全库存，给出补货数量", { delay: 2 });
      await click("保存技能");
      await sleep(800);
      const manual = (await api("/api/skills")).find((x) => x.name === "补货建议");
      check("界面新建技能", manual?.source === "user", manual?.steps.length);
      await screenshot("技能页");
      if (manual) {
        const before = new Date(Date.now() - 1000).toISOString();
        await click("补货建议");
        await click("运行技能");
        let rs;
        for (let i = 0; i < 40 && !(rs = await newestSession(before)); i++) await sleep(250);
        check("运行技能创建会话", !!rs);
        if (rs) {
          const rr = await pilot(rs.id);
          check("技能会话加载技能并完成", eventsOf(rr.detail, "skill").some((e) => e.action === "loaded") && rr.detail.status === "idle", eventsOf(rr.detail, "error").at(-1)?.message);
        }
      }
    },
  },
  {
    id: "S07",
    area: "定时任务 / 调度 / 推送",
    title: "在定时任务页新建任务（绑定技能、推送到飞书），立即运行，暂停/启用，自定义规则",
    async run() {
      await goto("/schedules", "到点自动做，做完推给你");
      await click("新建定时任务");
      await waitText("保存任务");
      await fill({ label: "任务名称" }, "临期预警");
      await fill({ label: "要助手做什么" }, "执行今天的临期预警，列出需要处理的商品和货架，推送给店长");
      if (ctx.skill) await choose("schedule-skill", ctx.skill.name);
      if (ctx.connector) await choose("schedule-notification", ctx.connector.name);
      await click("保存任务");
      await sleep(1000);
      let schedule = (await api("/api/schedules")).find((x) => x.name === "临期预警");
      check("界面新建定时任务", !!schedule, schedule && `${schedule.cron} 技能=${!!schedule.skillId} 推送=${!!schedule.notify}`);
      check("定时任务绑定技能与推送", !!schedule?.skillId && !!schedule?.notify);
      if (!schedule) return;
      const sent = feishu.messages.length;
      await click("立即运行");
      let run;
      for (let i = 0; i < 60 && !(run = (await api("/api/sessions")).find((x) => x.origin?.scheduleId === schedule.id)); i++) await sleep(500);
      check("立即运行产生定时任务会话", !!run);
      if (run) {
        const r = await pilot(run.id, { where: "overview" });
        check("无人值守：不提问", r.questions === 0, `提问 ${r.questions}`);
        for (let i = 0; i < 40 && !(schedule = await api(`/api/schedules/${schedule.id}`)).lastRun; i++) await sleep(300);
        check("执行成功并推送飞书", schedule.lastRun?.status === "ok" && schedule.lastRun?.notified?.ok && feishu.messages.length > sent, schedule.lastRun?.message);
      }
      await goto("/schedules", "临期预警");
      await screenshot("定时任务-执行后");
      check("界面显示最近执行结果", (await hasText("最近执行成功")) || (await hasText("最近执行失败")));
      await page.click('[aria-label="暂停临期预警"]');
      await sleep(800);
      check("界面暂停任务", (await api(`/api/schedules/${schedule.id}`)).enabled === false);
      await page.click('[aria-label="启用临期预警"]');
      await sleep(800);
      check("界面重新启用任务", (await api(`/api/schedules/${schedule.id}`)).enabled === true);
      await click("编辑", { exact: true });
      await waitText("保存任务");
      await choose("schedule-frequency", "自定义执行规则");
      await fill({ label: "执行规则（5 段 cron）" }, "0 */2 * * *");
      await click("保存任务");
      await sleep(800);
      check("界面改为自定义 cron", (await api(`/api/schedules/${schedule.id}`)).cron === "0 */2 * * *");
      await click("查看执行对话").catch(() => {});
      await sleep(800);
      check("从任务跳转到执行对话", page.url().includes("/chat"));
    },
  },
  {
    id: "S08",
    area: "写入授权 / 工作台待办",
    title: "要求在 ERP 改价，在总览的待处理确认里授权第一个、拒绝其余",
    async run() {
      const before = new Date(Date.now() - 1000).toISOString();
      await sendInChat("蔬菜和水果里库存超过 150 的商品，帮我在 ERP 里都降价 10%，直接改就行");
      let s;
      for (let i = 0; i < 40 && !(s = await newestSession(before)); i++) await sleep(250);
      await goto("/overview", "待处理确认");
      const r = await pilot(s.id, {
        where: "overview",
        decide: (tool, _a, d) => (tool.includes("update_price") ? d.filter((x) => x.tool.includes("update_price")).length < 1 : true),
      });
      const asked = r.decisions.filter((d) => d.tool.includes("update_price"));
      const changes = (await api("/api/tools/mcp__erp__get_price_changes", { method: "POST", body: "{}" })).result;
      const real = (changes?.structuredContent ?? changes)?.changes ?? JSON.parse(changes?.content?.[0]?.text ?? "{}").changes ?? [];
      check("改价请求出现在工作台待办", asked.length > 0, `请求 ${asked.length} 次`);
      check("只执行了授权的改价", real.length === asked.filter((d) => d.approved).length, `ERP 实际变更 ${real.length}`);
      check("会话完成并说明被拒部分", r.detail.status === "idle" && (asked.length <= 1 || eventsOf(r.detail, "say").some((e) => /拒绝|未授权|未获/.test(e.text)) || eventsOf(r.detail, "gaps").some((e) => e.gaps.some((g) => g.kind === "permission"))));
      await screenshot("总览-待办处理后");
    },
  },
  {
    id: "S09",
    area: "浏览器工具 / 实时画面 / 人工接管",
    title: "让助手用浏览器打开刚生成的看板读数字；在对话里看实时画面并人工接管",
    async run() {
      if (!ctx.dashboard) throw new Error("依赖 S03 的页面");
      const view = (await api("/api/pages")).find((p) => p.slug === ctx.dashboard.slug);
      const url = GW + view.url;
      const s = await sendInChat(`用浏览器打开这个页面 ${url} ，读一下页面上显示的核心数字，然后点一下页面上的第一个按钮或切换项（如果有），告诉我看到了什么`);
      const r = await pilot(s.id);
      const b = eventsOf(r.detail, "browser").at(-1);
      check("助手通过浏览器打开了页面", !!b && b.browser.url.includes(`/pages/${ctx.dashboard.slug}`), b?.browser.url);
      check("会话完成", r.detail.status === "idle", eventsOf(r.detail, "error").at(-1)?.message);
      if (!b) return;
      await goto("/chat");
      await click(s.title?.slice(0, 8) ?? "用浏览器", { scope: "aside" }).catch(() => {});
      await sleep(1000);
      await click("查看实时画面").catch(() => click("查看浏览器"));
      const frameOk = await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="会话实时浏览器"] img, [aria-label="会话实时浏览器"] canvas')].some((x) => (x.naturalWidth ?? x.width) > 100), { timeout: 20_000 }).then(() => true, () => false);
      check("对话中显示实时浏览器画面", frameOk);
      await screenshot("浏览器-实时画面");
      // 画面显示后才能开启人工接管；开启后地址栏可编辑、「前往」可用
      await page.click('[aria-label="人工接管浏览器"]').catch(() => {});
      const manual = await waitText("人工接管中", 10_000).then(() => true, () => false);
      check("开启人工接管", manual);
      if (manual) {
        await fill('input[aria-label="浏览器地址"]', `${GW}/health`);
        await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.innerText.trim() === "前往" && !b.disabled), { timeout: 10_000 }).catch(() => {});
        await click("前往", { exact: true });
        await sleep(2500);
      }
      const st = await api(`/api/browser/${b.browser.browserSessionId}`, { allowError: true });
      check("人工接管：地址栏跳转", st.status === 200 && st.body.url.includes("/health"), st.body?.url ?? st.body?.error);
      await screenshot("浏览器-人工接管");
    },
  },
  {
    id: "S10",
    area: "指标口径 / 页面待复核",
    title: "让助手修改毛利率口径说明（需授权），依赖它的页面被标记待复核",
    async run() {
      const s = await sendInChat("把指标「毛利率」的说明改成「毛利 ÷ 销售额，不含税」，计算方式不变，用 propose_metric_change 提交");
      const r = await pilot(s.id);
      check("口径修改经授权", r.decisions.some((d) => d.tool === "propose_metric_change" && d.approved));
      const metrics = await api("/api/metrics");
      check("口径已更新", /不含税/.test(metrics.grossMargin?.description ?? ""), metrics.grossMargin?.description);
      const stale = (await api("/api/pages")).filter((p) => p.stale);
      check("依赖该指标的页面标记待复核", stale.length > 0, stale.map((p) => p.title).join("、"));
      await goto("/tasks", "做好的页面，一直都在");
      check("任务页显示待复核", await hasText("待复核"));
      await screenshot("任务页-待复核");
    },
  },
  {
    id: "S11",
    area: "对话·停止执行",
    title: "发起一个大需求后立刻在界面点「停止执行」",
    async run() {
      const s = await sendInChat("帮我把所有商品逐个分析近 60 天的销售、毛利、库存周转，做一个超详细的页面");
      await click("停止执行", { ms: 20_000 });
      let d;
      for (let i = 0; i < 40 && !["idle", "error"].includes((d = await api(`/api/sessions/${s.id}`)).status); i++) await sleep(500);
      check("会话被停止", d.status === "error" && eventsOf(d, "error").some((e) => e.message === "已取消"), d.status);
      await screenshot("对话-已停止");
    },
  },
  {
    id: "S12",
    area: "页面运行时 qdd.ask / qdd.state / 页面 token",
    title: "生成一个可以问助手、能记住筛选的页面，并以页面身份调用接口",
    async run() {
      const s = await sendInChat("做一个品类销售查询页：可以选品类看最近 14 天销售额（记住我上次选的品类），页面上还要有一个输入框可以向助手提问原因（用 qdd.ask）");
      const r = await pilot(s.id);
      const p = eventsOf(r.detail, "published").at(-1)?.page;
      check("发布了使用 agent 的页面", p?.useAgent === true, p && `useAgent=${p.useAgent} tools=${p.tools.join(",")}`);
      if (!p) return;
      const view = (await api("/api/pages")).find((x) => x.slug === p.slug);
      const pageToken = new URL(GW + view.url).searchParams.get("page_token");
      const asPage = (pth, init = {}) => fetch(GW + pth, { ...init, headers: { "X-QDD-Page": p.slug, "X-QDD-Page-Token": pageToken, "Content-Type": "application/json", ...init.headers } });
      const put = await asPage(`/api/state/${p.slug}`, { method: "PUT", body: JSON.stringify({ category: "水果" }) });
      const got = await (await asPage(`/api/state/${p.slug}`)).json();
      check("qdd.state：页面状态读写", put.status === 200 && got.state?.category === "水果");
      const other = (await api("/api/pages")).find((x) => x.slug !== p.slug);
      check("页面 token 不能读写其它页面状态", other ? (await asPage(`/api/state/${other.slug}`)).status === 401 : true);
      const undeclared = (await api("/api/tools")).find((t) => !p.tools.includes(t.name) && !t.mutating);
      check("页面调用未声明工具被拒", (await asPage(`/api/tools/${undeclared.name}`, { method: "POST", body: "{}" })).status === 403, undeclared.name);
      check("页面不能访问管理接口", (await asPage("/api/sessions")).status === 401);
      const ask = await asPage("/api/ask", { method: "POST", body: JSON.stringify({ question: "水果最近 14 天销售额是多少？", context: { category: "水果" } }) });
      const text = await ask.text();
      check("qdd.ask：页面向助手提问并得到回答（SSE）", ask.status === 200 && /"type":"answer"/.test(text), text.slice(-160));
    },
  },
  {
    id: "S13",
    area: "前端·导航 / 搜索 / 侧边栏 / 404",
    title: "侧边栏搜索对话与页面、任务页搜索、健康检查页、未知路由",
    async run() {
      await goto("/chat");
      await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
      await page.keyboard.press("k");
      await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
      await sleep(300);
      const search = await page.$('input[placeholder="搜索对话和页面"]');
      check("Ctrl/⌘ K 打开侧边栏搜索", !!search && (await search.evaluate((x) => document.activeElement === x)));
      if (search) {
        await search.type("周报");
        await sleep(500);
        check("搜索结果包含页面", await hasText("品类经营周报"));
      }
      await goto("/tasks", "做好的页面，一直都在");
      await fill('input[aria-label="搜索任务页面"]', "查询");
      await sleep(400);
      check("任务页搜索", await hasText("查询"));
      await goto("/test", "钱多多门店助手", { standalone: true });
      await click("重新检查").catch(() => {});
      await sleep(800);
      await screenshot("健康检查页");
      check("健康检查页可用", await hasText("钱多多门店助手"));
      await goto("/no-such-page", undefined, { standalone: true });
      await sleep(500);
      check("未知路由显示 404", await page.evaluate(() => !!document.querySelector('[aria-label*="404"], .notFound')));
    },
  },
  {
    id: "S14",
    area: "网关接口 / MCP 端点 / 数据集 / 鉴权",
    title: "MCP 端点、数据集刷新与列表、指标、未授权访问",
    async run() {
      const rpc = (body) => post("/mcp", body);
      const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sim", version: "1" } } });
      const tools = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const callRes = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_store_info", arguments: {} } });
      check("MCP initialize / tools/list / tools/call", !!init.result && tools.result.tools.length > 5 && callRes.result && !callRes.result.isError, `${tools.result.tools.length} 个工具：${tools.result.tools.map((t) => t.name).join(",")}`);
      const write = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "update_price", arguments: { sku: "SKU0001", price: 1 } } });
      check("MCP 端点只开放门店只读工具（不能调用 ERP 写入）", !!write.error || write.result?.isError, JSON.stringify(write).slice(0, 120));
      const refreshed = await post("/api/datasets/refresh", {});
      check("数据集刷新", Array.isArray(refreshed), JSON.stringify(refreshed).slice(0, 120));
      const datasets = await api("/api/datasets");
      check("数据集列表含版本与水位线", datasets.length > 0 && datasets.every((d) => d.version), datasets.map((d) => d.name).join(","));
      const unauth = await fetch(`${GW}/api/sessions`);
      const wrong = await fetch(`${GW}/api/sessions`, { headers: { Authorization: "Bearer wrong-token-xxxxxxxx" } });
      check("未授权访问被拒（401）", unauth.status === 401 && wrong.status === 401);
      const write2 = await api("/api/tools/mcp__erp__update_price", { method: "POST", body: JSON.stringify({ sku: "SKU0001", price: 1 }), allowError: true });
      check("管理 token 也不能直接调用写入工具", write2.status === 403);
      const overview = await api("/api/overview");
      ctx.overview = overview;
      check(
        "总览计数与实际一致",
        overview.skills.total === (await api("/api/skills")).length && overview.pages.total === (await api("/api/pages")).length && overview.schedules.total === (await api("/api/schedules")).length,
        JSON.stringify({ sessions: overview.sessions.total, pages: overview.pages.total, skills: overview.skills.total, schedules: overview.schedules.total, connectors: overview.connectors.connected, pending: overview.pending.length }),
      );
    },
  },
  {
    id: "S15",
    area: "CLI",
    title: "终端命令：token / sessions / pages / tools / datasets / metrics / refresh / compact / style / wish",
    async run() {
      const exec = promisify(execFile);
      const run = async (...args) => {
        try {
          const { stdout } = await exec(process.execPath, [CLI, ...args], { cwd: ROOT, env: cliEnv, timeout: 8 * 60_000, maxBuffer: 10 * 1024 * 1024 });
          return { ok: true, out: stdout };
        } catch (e) {
          return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? e.message}` };
        }
      };
      const tok = await run("token");
      check("qdd token", tok.ok && tok.out.includes(TOKEN));
      for (const [cmd, pattern] of [["sessions", /[0-9a-f-]{36}/], ["pages", /p20\d{6}/], ["tools", /store__aggregate/], ["datasets", /order_items/], ["metrics", /grossMargin|毛利率/]]) {
        const r = await run(cmd);
        check(`qdd ${cmd}`, r.ok && pattern.test(r.out), r.ok ? `${r.out.split("\n").length} 行` : r.out.slice(0, 200));
      }
      const refresh = await run("refresh");
      check("qdd refresh", refresh.ok, refresh.out.slice(0, 160));
      const compact = await run("compact", "inventory_moves", new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10) + " 00:00");
      check("qdd compact inventory_moves", compact.ok, compact.out.slice(0, 160));
      const style = await run("style");
      const checkPages = await run("check");
      check("qdd check（守卫复审已发布页面）", checkPages.ok, checkPages.out.slice(0, 160));
      check("qdd style（读取界面保存的风格）", style.ok && style.out.includes("橙红色"), style.out.slice(0, 80));
      const sid = (await api("/api/sessions")).find((x) => !x.origin)?.id;
      const detail = await run("sessions", sid);
      check("qdd sessions <id> 回放事件", detail.ok && detail.out.length > 50);
      const wish = await run("wish", "查一下门店基本信息，直接回答，不要做页面", "--yes");
      check("qdd wish --yes（终端许愿，与前端共享会话）", wish.ok && (await api("/api/sessions")).some((x) => x.title.startsWith("查一下门店基本信息")), wish.out.slice(-200));
    },
  },
];

try {
  for (const s of steps) {
    step = { id: s.id, area: s.area, title: s.title, checks: [], error: null };
    currentStep = s.id;
    log(`\n=== ${s.id} ${s.area}：${s.title}`);
    const t = Date.now();
    try {
      try {
        await s.run();
      } catch (error) {
        if (!/detached Frame|Target closed|Session closed/.test(error.message)) throw error;
        finding("店长浏览器标签页失效（已重开并重试本步）", error.message.slice(0, 160), s.id);
        step.checks = [];
        await reopenPage();
        await s.run();
      }
    } catch (error) {
      step.error = error.message;
      log(`  ✗ 步骤异常：${error.message}`);
      step.screenshot = await screenshot(`${s.id}-异常`);
    }
    step.seconds = Math.round((Date.now() - t) / 1000);
    results.push(step);
    await writeFile(path.join(OUT, "report.json"), JSON.stringify({ at: new Date().toISOString(), results, findings, feishu: feishu.messages }, null, 2));
  }
} finally {
  stopping = true;
  log("\n=== 汇总");
  let pass = 0;
  let total = 0;
  for (const r of results) {
    const p = r.checks.filter((c) => c.ok).length;
    pass += p;
    total += r.checks.length;
    log(`${r.id} ${r.area}：${p}/${r.checks.length}${r.error ? `（异常：${r.error.slice(0, 80)}）` : ""}，${r.seconds}s`);
  }
  log(`合计 ${pass}/${total}；发现问题 ${findings.length} 条；飞书消息 ${feishu.messages.length} 条`);
  const gwErrors = gatewayProc.lines.filter((l) => /Error|错误|失败|warn/i.test(l)).slice(-30);
  await writeFile(path.join(OUT, "report.json"), JSON.stringify({ at: new Date().toISOString(), results, findings, feishu: feishu.messages, gatewayLog: gatewayProc.lines.slice(-200), webLog: web.lines.slice(-100), gwErrors }, null, 2));
  log(`报告：${path.join(OUT, "report.json")}  截图：${SHOTS}`);
  await browser.close().catch(() => {});
  for (const c of children) {
    try {
      process.kill(-c.pid, "SIGTERM");
    } catch {
      c.kill();
    }
  }
  feishuServer.close();
  feishuServer.closeAllConnections();
  setTimeout(() => process.exit(0), 1000).unref();
}

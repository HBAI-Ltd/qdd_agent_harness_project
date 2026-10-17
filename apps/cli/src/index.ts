#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { HARNESS_VERSION, SERVICE_NAME, type ClarifyAnswers, type ClarifyQuestion, type SessionEvent } from "@qdd/shared";
import { createChat } from "./agent/llm.js";
import { loadConfig, type LoadedConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { ensureMetrics, loadMetrics } from "./datasets/metrics.js";
import { compactDataset } from "./datasets/query.js";
import { refreshDatasets } from "./datasets/refresh.js";
import { resolveGatewayToken } from "./gateway/auth.js";
import { startGateway } from "./gateway/server.js";
import { openWorkbench } from "./workbench/index.js";
import { Scheduler } from "./workbench/scheduler.js";
import { checkFile } from "./guard.js";
import { SessionHub } from "./sessions.js";
import { ensureWorkspace, readPages, readStyle, resetStyle } from "./web/site.js";

const HELP = `${SERVICE_NAME} ${HARNESS_VERSION} —— 钱多多门店管理 harness

用法：npm run qdd -- <命令> [参数]

  serve                       启动网关（前端对接的 HTTP API + MCP 端点 + 页面托管）
  token                       显示网关 token
  wish "<需求>" [--page <slug>] [--yes]
                              在终端许愿（会话与前端共享）
  reply <会话id> "<消息>"     在已有会话里继续对话
  sessions [会话id]           列出会话 / 查看会话事件
  pages                       列出已生成的页面
  tools                       列出接入的数据源工具（内置 + MCP）
  datasets                    列出数据集（版本、水位线、行数）
  refresh [数据集...]         从数据源增量刷新数据集
  compact <数据集> "<时刻>"   为事件流生成检查点，如 compact inventory_moves "2026-10-01 00:00"
  metrics                     查看指标口径目录
  style [--edit | --reset]    查看 / 修改风格提示词
  check                       用零后端守卫重新审查所有已发布页面
  init                        初始化工作区（其它命令会自动执行）
`;

async function openSources(loaded: LoadedConfig) {
  const sources = await DataSources.open(loaded);
  for (const w of sources.warnings) console.warn(`\x1b[33m${w}\x1b[0m`);
  return sources;
}

/** 终端引导式回答：编号选择（多选用逗号），直接回车选推荐项，也可直接输入自定义内容。 */
async function askInTerminal(rl: ReturnType<typeof createInterface>, questions: ClarifyQuestion[]): Promise<ClarifyAnswers> {
  const answers: ClarifyAnswers = {};
  for (const [i, q] of questions.entries()) {
    console.log(`\n\x1b[35m[${i + 1}/${questions.length}] ${q.header}\x1b[0m ${q.question}`);
    q.options.forEach((o, j) => console.log(`  ${j + 1}. ${o.label}${o.description ? `\x1b[2m — ${o.description}\x1b[0m` : ""}`));
    const hint = [q.multiSelect ? "可多选，如 1,3" : "选一个编号", "回车 = 1", q.allowOther ? "或直接输入其它" : ""].filter(Boolean).join("；");
    for (;;) {
      const raw = (await rl.question(`  \x1b[2m(${hint})\x1b[0m > `)).trim();
      if (!raw) {
        answers[q.id] = [q.options[0]!.label];
        break;
      }
      const nums = raw.split(/[,，\s]+/).map(Number);
      if (nums.every((n) => Number.isInteger(n) && n >= 1 && n <= q.options.length) && (q.multiSelect || nums.length === 1)) {
        answers[q.id] = [...new Set(nums)].map((n) => q.options[n - 1]!.label);
        break;
      }
      if (q.allowOther) {
        answers[q.id] = [raw];
        break;
      }
      console.log("  无效输入，请重新选择");
    }
  }
  return answers;
}

/** 在终端里跟随会话输出，处理写入授权与需求澄清（逐个串行提问）。 */
async function follow(hub: SessionHub, id: string, autoYes: boolean): Promise<void> {
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  let queue = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task).catch((error: Error) => console.error(`\x1b[31m${error.message}\x1b[0m`));
  };
  const off = hub.subscribe(id, (e) => {
    printEvent(e);
    if (e.type === "question_required") {
      // 非交互终端：按推荐项（第一个候选）回答
      if (!rl || autoYes) return hub.answer(id, e.requestId, Object.fromEntries(e.questions.map((q) => [q.id, [q.options[0]!.label]])));
      return enqueue(async () => hub.answer(id, e.requestId, await askInTerminal(rl, e.questions)));
    }
    if (e.type !== "approval_required") return;
    if (autoYes) return hub.approve(id, e.requestId, true);
    if (!rl) return hub.approve(id, e.requestId, false);
    enqueue(async () => {
      const a = await rl.question(`\x1b[33m  是否授权 ${e.tool} ${JSON.stringify(e.args)}？[y/N] \x1b[0m`);
      hub.approve(id, e.requestId, /^y(es)?$/i.test(a.trim()));
    });
  });
  const onSigint = () => hub.cancel(id);
  process.once("SIGINT", onSigint);
  try {
    const meta = await hub.wait(id);
    console.log(`\n会话 ${meta.id}（${meta.status}）${meta.slug ? `  页面 ${meta.slug}` : ""}`);
    if (meta.status === "error") process.exitCode = 1;
  } finally {
    off();
    rl?.close();
    process.off("SIGINT", onSigint);
  }
}

function printEvent(e: SessionEvent): void {
  switch (e.type) {
    case "say": return console.log(e.text);
    case "tool": return console.log(`\x1b[36m· ${e.text}\x1b[0m`);
    case "warn": return console.log(`\x1b[33m· ${e.text}\x1b[0m`);
    case "approval_required": return console.log(`\x1b[33m⚠ 写入操作 ${e.tool}（${e.source}）待授权\x1b[0m`);
    case "approval_resolved": return console.log(`\x1b[33m  ${e.approved ? "已授权" : "已拒绝"}\x1b[0m`);
    case "question_required": return console.log(`\x1b[35m? 需要对齐需求（第 ${e.round} 轮，${e.questions.length} 个问题）\x1b[0m`);
    case "question_answered":
      return console.log(e.answers ? `\x1b[35m  ${Object.entries(e.answers).map(([k, v]) => `${k}=${v.join("/")}`).join("；")}\x1b[0m` : "\x1b[35m  未回答，按推荐项继续\x1b[0m");
    case "gaps": return console.log(`\x1b[33m能力缺口：\n${e.gaps.map((g) => `  - [${g.kind}] ${g.item}：${g.reason}`).join("\n")}\x1b[0m`);
    case "published": return console.log(`\x1b[32m✓ 已发布「${e.page.title}」${e.page.summary}\x1b[0m`);
    case "error": return console.log(`\x1b[31m✗ ${e.message}\x1b[0m`);
    case "user": return console.log(`\x1b[2m> ${e.text}\x1b[0m`);
    case "skill": return console.log(`\x1b[36m· 技能「${e.skill.name}」${e.action === "saved" ? "已保存" : "已加载"}\x1b[0m`);
    case "browser": return console.log(`\x1b[36m· 浏览器 ${e.browser.status === "closed" ? "已关闭" : `${e.browser.title || e.browser.url}`}\x1b[0m`);
    case "status": return;
  }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      page: { type: "string" },
      yes: { type: "boolean", default: false },
      edit: { type: "boolean", default: false },
      reset: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (!command || values.help) {
    console.log(HELP);
    return;
  }

  const loaded = await loadConfig();
  const { config, paths } = loaded;
  await ensureWorkspace(paths);
  await ensureMetrics(paths);
  const chat = () => createChat(config.llm);

  switch (command) {
    case "init":
      console.log(`工作区已就绪：${paths.workspace}`);
      return;

    case "token": {
      const { token, source } = await resolveGatewayToken(loaded);
      console.log(`${token}\n（来源：${source}）`);
      return;
    }

    case "serve": {
      const { token, source } = await resolveGatewayToken(loaded);
      const sources = await openSources(loaded);
      const gateway = await startGateway(loaded, sources, { token, chat });
      console.log(`网关已启动 ${gateway.url}`);
      console.log(`  token：${source}（npm run qdd -- token 查看）`);
      console.log(`  CORS：${config.gateway.corsOrigins.join(", ") || "未配置（仅同源）"}`);
      console.log(`  MCP：${gateway.url}/mcp`);
      console.log(`  数据工具 ${sources.tools.length} 个；Ctrl+C 退出`);
      const stop = async () => {
        await gateway.close();
        await sources.close();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      return;
    }

    case "wish":
    case "reply": {
      const sources = await openSources(loaded);
      const workbench = await openWorkbench(loaded);
      const hub = new SessionHub(loaded, sources, chat, workbench);
      // 终端会话创建的定时任务只写入 schedules.json，由网关进程到点执行（不在这里启动调度）
      workbench.scheduler = new Scheduler(loaded, hub, workbench);
      try {
        let id: string;
        if (command === "wish") {
          const wish = rest.join(" ").trim();
          if (!wish) throw new Error('请写下愿望，例如：npm run qdd -- wish "最近 30 天哪些商品最赚钱"');
          id = (await hub.create(wish, values.page)).id;
        } else {
          const [sessionId, ...text] = rest;
          if (!sessionId || !text.length) throw new Error('用法：npm run qdd -- reply <会话id> "<消息>"');
          id = (await hub.send(sessionId, text.join(" "))).id;
        }
        await follow(hub, id, values.yes);
      } finally {
        await workbench.browser?.close();
        await sources.close();
      }
      return;
    }

    case "sessions": {
      const hub = new SessionHub(loaded, await DataSources.open({ ...loaded, config: { ...config, mcpServers: {} } }), chat);
      const [id] = rest;
      if (id) {
        const detail = await hub.detail(id);
        console.log(`${detail.title}（${detail.status}）${detail.slug ?? ""}`);
        for (const e of detail.events) printEvent(e);
      } else {
        for (const s of await hub.list()) console.log(`${s.id}  ${s.status.padEnd(7)} ${s.slug ?? "-"}  ${s.title}`);
      }
      return;
    }

    case "pages": {
      const pages = await readPages(paths);
      if (!pages.length) console.log("还没有页面。");
      for (const p of pages) {
        console.log(`${p.slug}  ${p.title}\n    愿望：${p.wish}\n    工具：${p.tools.join(", ") || "-"}${p.useAgent ? "  +agent" : ""}\n    ${p.summary}`);
      }
      return;
    }

    case "tools": {
      const sources = await openSources(loaded);
      for (const t of sources.tools) console.log(`${t.mutating ? "[写]" : "[读]"} ${t.name}  ${t.description}`);
      await sources.close();
      return;
    }

    case "datasets": {
      const sources = await DataSources.open({ ...loaded, config: { ...config, mcpServers: {} } });
      for (const d of await sources.datasets.list()) {
        console.log(`${d.name.padEnd(20)} ${d.kind.padEnd(10)} v${d.version}  截至 ${d.watermark ?? "-"}  ${d.rowCount} 行${d.source ? `  ← ${d.source.tool}` : ""}`);
      }
      return;
    }

    case "refresh": {
      const sources = await openSources(loaded);
      try {
        const results = await refreshDatasets(sources, rest);
        if (!results.length) console.log("没有声明 source 的数据集。");
        for (const r of results) console.log(r.error ? `✗ ${r.dataset}：${r.error}` : `✓ ${r.dataset} +${r.added} 行 → v${r.version}（截至 ${r.watermark ?? "-"}）`);
        if (results.some((r) => r.error)) process.exitCode = 1;
      } finally {
        await sources.close();
      }
      return;
    }

    case "compact": {
      const [name, at] = rest;
      if (!name || !at) throw new Error('用法：npm run qdd -- compact <数据集> "YYYY-MM-DD HH:mm"');
      const sources = await DataSources.open({ ...loaded, config: { ...config, mcpServers: {} } });
      console.log(`已生成检查点 ${name} @ ${at}（${await compactDataset(sources.datasets, name, at)} 个实体）`);
      return;
    }

    case "metrics":
      console.log(JSON.stringify(await loadMetrics(paths), null, 2));
      return;

    case "style": {
      if (values.reset) await resetStyle(paths);
      if (values.edit) {
        const editor = process.env.VISUAL ?? process.env.EDITOR ?? (process.platform === "win32" ? "notepad" : "vi");
        spawnSync(editor, [paths.style], { stdio: "inherit", shell: true });
      }
      console.log(`# ${paths.style}\n`);
      console.log(await readStyle(paths));
      return;
    }

    case "check": {
      let bad = 0;
      for (const p of await readPages(paths)) {
        const dir = `${paths.pages}/${p.slug}`;
        for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
          if (!e.isFile()) continue;
          const rel = `${e.parentPath}/${e.name}`.slice(dir.length + 1).replaceAll("\\", "/");
          if (rel.startsWith("data/")) continue;
          const { violations } = checkFile(rel, await readFile(`${dir}/${rel}`, "utf8"), config.cdnAllowlist);
          if (violations.length) {
            bad++;
            console.log(`✗ ${p.slug}/${rel}\n  - ${violations.join("\n  - ")}`);
          }
        }
      }
      console.log(bad ? `${bad} 个文件违规` : "全部页面通过零后端审查");
      if (bad) process.exitCode = 1;
      return;
    }

    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((error: Error) => {
  console.error(`\x1b[31m${error.message}\x1b[0m`);
  process.exitCode = 1;
});

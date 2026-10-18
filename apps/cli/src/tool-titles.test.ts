import assert from "node:assert/strict";
import { test } from "node:test";
import { toolDisplayTitle } from "./tool-titles.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentToolCall } from "@qdd/shared";
import { runWish } from "./agent/agent.js";
import { loadConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { ensureWorkspace } from "./web/site.js";

test("backend titles cover built-in tools and camera providers", () => {
  assert.equal(toolDisplayTitle("write_file"), "写入页面文件");
  assert.equal(toolDisplayTitle("store__sales_summary"), "汇总销售数据");
  for (const [provider, label, prefix] of [["tysl", "天翼视联", "tysl_"], ["haik", "海康", ""], ["ezviz", "萤石", "ezviz_"]]) {
    assert.equal(toolDisplayTitle(`${prefix}camera_capture_start`, "", undefined, provider), `${label}：开始采集摄像头画面`);
    assert.equal(toolDisplayTitle(`${prefix}capture_status`, "", undefined, provider), `${label}：查询画面采集进度`);
  }
});

test("MCP declared titles take precedence and external tools get a readable fallback", () => {
  assert.equal(toolDisplayTitle("capture_status", "说明", " 自定义进度 ", "custom"), "自定义进度");
  assert.equal(toolDisplayTitle("sqb_inventory", "读取门店库存。需要门店 ID", undefined, "shouqianba"), "收钱吧：读取门店库存");
  assert.equal(toolDisplayTitle("unknown", "", undefined, "custom"), "custom：unknown");
  assert.equal(toolDisplayTitle("unknown"), "unknown");
});

test("agent sends backend titles from streaming through completion without changing tool IDs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qdd-tool-titles-"));
  const loaded = await loadConfig(root);
  await ensureWorkspace(loaded.paths);
  const sources = await DataSources.open(loaded, { connectMcp: false });
  const name = "mcp__tysl__tysl_capture_status";
  sources.tools.push({ name, title: "天翼视联：查询画面采集进度", description: "查询进度", inputSchema: {}, source: "mcp:tysl", mutating: false, preauthorized: false, call: async () => ({ status: "done" }) });
  const events: AgentToolCall[] = [];
  let step = 0;
  try {
    await runWish(loaded, sources, async (_messages, _tools, _signal, onDelta) => {
      const toolName = step++ === 0 ? name : "reply";
      const id = `call-${step}`;
      onDelta?.({ type: "tool", index: 0, id, name: toolName });
      return { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: toolName, arguments: toolName === "reply" ? '{"text":"查询完成"}' : "{}" } }] };
    }, { wish: "查询采集进度", sessionId: "tool-titles" }, {
      authorize: async () => false,
      onEvent: (event) => { if (event.kind === "tool_call") events.push(structuredClone(event.tool)); },
    });
    const capture = events.filter((event) => event.id === "call-1");
    assert.ok(capture.length >= 3);
    assert.ok(capture.every((event) => event.name === name && event.title === "天翼视联：查询画面采集进度"));
    assert.equal(capture.at(-1)?.status, "success");
    assert.ok(events.filter((event) => event.id === "call-2").every((event) => event.title === "回复结果"));
  } finally {
    await sources.close();
    await rm(root, { recursive: true, force: true });
  }
});

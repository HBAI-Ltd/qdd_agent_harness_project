import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * 把 @qdd/shared 编译产物中的计算引擎包装成浏览器脚本（window.__qddCompute），
 * 保证页面里的推演与数据源侧使用同一份代码。
 */
export async function buildComputeScript(): Promise<string> {
  const file = fileURLToPath(new URL("./compute.js", import.meta.resolve("@qdd/shared")));
  const source = (await readFile(file, "utf8")).replace(/^\/\/# sourceMappingURL=.*$/m, "");
  const names = [...source.matchAll(/^export (?:function|const) (\w+)/gm)].map((m) => m[1]!);
  if (/^\s*import\s/m.test(source)) throw new Error("compute.js 不能包含 import");
  const body = source.replace(/^export (?=function|const)/gm, "").replace(/^export \{\s*\};?$/m, "");
  return `(() => {\n"use strict";\n${body}\nwindow.__qddCompute = Object.freeze({ ${names.join(", ")} });\n})();\n`;
}

/** 注入到每个生成页面的运行时 SDK：页面只能通过它访问网关。 */
export const SDK_JS = `(() => {
  const page = window.QDD_PAGE || {};
  const metrics = page.metrics || {};
  const c = window.__qddCompute;
  const headers = { "Content-Type": "application/json", "X-QDD-Page": page.slug || "", "X-QDD-Page-Token": page.token || "" };

  async function call(path, method, payload) {
    const res = await fetch(path, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "HTTP " + res.status);
    return body;
  }

  /** 直连只读数据工具（需在页面声明）。 */
  async function tool(name, args) {
    return (await call("/api/tools/" + encodeURIComponent(name), "POST", args || {})).result;
  }

  /** 调用 agent。onEvent 可选，接收 { type: "tool", name } 进度。 */
  async function ask(question, context, onEvent) {
    const res = await fetch("/api/ask", { method: "POST", headers, body: JSON.stringify({ question, context }) });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "HTTP " + res.status);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf("\\n\\n")) >= 0) {
        const line = buffer.slice(0, i).split("\\n").find((l) => l.startsWith("data:"));
        buffer = buffer.slice(i + 2);
        if (!line) continue;
        const event = JSON.parse(line.slice(5));
        if (event.type === "answer") return event.text;
        if (event.type === "error") throw new Error(event.message);
        if (onEvent) onEvent(event);
      }
    }
    throw new Error("agent 未返回结果");
  }

  /** snapshot_data 生成的兜底快照。 */
  function snapshot(name) {
    return (window.QDD_DATA || {})[name];
  }

  /** 先实时取数，失败时回退到快照。 */
  async function data(name, toolName, args) {
    try {
      return await tool(toolName, args);
    } catch (error) {
      const fallback = snapshot(name);
      if (fallback === undefined) throw error;
      console.warn("[qdd] 实时数据不可用，使用快照", name, error);
      return fallback;
    }
  }

  /** 定时增量拉取：onData(rows) 每次回调；返回停止函数。 */
  function watch(toolName, args, onData, intervalMs) {
    let stopped = false;
    async function tick() {
      if (stopped) return;
      try { onData(await tool(toolName, args)); } catch (e) { console.warn("[qdd] watch", e); }
      if (!stopped) setTimeout(tick, Math.max(5000, intervalMs || 60000));
    }
    tick();
    return () => { stopped = true; };
  }

  /** 页面状态（推演参数、筛选），由网关按页面保存，跨会话、跨设备共享。 */
  const state = {
    async get() { return (await call("/api/state/" + encodeURIComponent(page.slug), "GET")).state; },
    async set(value) { return (await call("/api/state/" + encodeURIComponent(page.slug), "PUT", value)).state; },
  };

  function format(value, metric) {
    return c.format(value, typeof metric === "string" ? metrics[metric] : metric);
  }

  window.qdd = Object.freeze({
    page: page.slug,
    metrics,
    tool, ask, snapshot, data, watch, state, format,
    agg: (rows, spec) => c.aggregate(rows, spec, metrics),
    timeline: c.timeline,
    segments: c.segments,
    classify: c.classify,
    join: c.join,
    mapKeys: c.mapKeys,
    bucketOf: c.bucketOf,
    bucketRange: c.bucketRange,
  });
})();
`;

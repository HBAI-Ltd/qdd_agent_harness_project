import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MAX_PAGE_BRIDGE_PAYLOAD_BYTES, PAGE_BRIDGE_CHANNEL, PAGE_BRIDGE_VERSION } from "@qdd/shared";

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

  // 模板与主界面只交换 JSON 事件；页面 token 仅用于 SDK 的网关请求。
  const bridgeChannel = ${JSON.stringify(PAGE_BRIDGE_CHANNEL)};
  const bridgeVersion = ${PAGE_BRIDGE_VERSION};
  const bridgeMaxBytes = ${MAX_PAGE_BRIDGE_PAYLOAD_BYTES};
  const bridgeSlug = page.slug;
  const bridgePageToken = typeof page.token === "string" ? page.token : "";
  const bridgeFields = ["channel", "version", "slug", "bridgeId", "type", "payload"];
  const bridgeUnsafeKeys = new Set(["__proto__", "constructor", "prototype"]);
  const bridgeEncoder = new TextEncoder();
  const bridgeListeners = new Map();
  const hostOrigins = new Set((Array.isArray(page.hostOrigins) ? page.hostOrigins : []).filter((origin) => {
    try {
      const url = new URL(origin);
      return typeof origin === "string" && /^https?:$/.test(url.protocol) && url.origin === origin;
    } catch { return false; }
  }));
  let bridgeId = null;
  let parentOrigin = null;
  let resolveHostReady;
  const hostReady = new Promise((resolve) => { resolveHostReady = resolve; });

  function bridgeType(type) {
    return typeof type === "string" && type.length <= 80 && /^[a-z][a-z0-9]*(?:[.:-][a-z0-9]+)*$/i.exec(type)?.[0] === type;
  }

  // 与共享协议一致：拒绝循环、访问器、隐式转换、非 JSON 类型与原型键。
  function bridgePayload(value) {
    let bytes = 0;
    const ancestors = new Set();
    function add(text) {
      bytes += bridgeEncoder.encode(text).byteLength;
      return bytes <= bridgeMaxBytes;
    }
    function visit(current, depth) {
      if (depth > 64 || bytes > bridgeMaxBytes) return false;
      if (current === null) return add("null");
      if (typeof current === "boolean") return add(current ? "true" : "false");
      if (typeof current === "number") return Number.isFinite(current) && add(JSON.stringify(current));
      if (typeof current === "string") return current.length <= bridgeMaxBytes && add(JSON.stringify(current));
      if (typeof current !== "object" || ancestors.has(current)) return false;
      const array = Array.isArray(current);
      const prototype = Object.getPrototypeOf(current);
      if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
      const keys = Reflect.ownKeys(current);
      if (keys.length > bridgeMaxBytes) return false;
      ancestors.add(current);
      try {
        if (array) {
          if (keys.length !== current.length + 1 || !add("[]")) return false;
          for (let i = 0; i < current.length; i += 1) {
            const property = Object.getOwnPropertyDescriptor(current, String(i));
            if (!property || !("value" in property) || !property.enumerable) return false;
            if ((i > 0 && !add(",")) || !visit(property.value, depth + 1)) return false;
          }
        } else {
          if (!add("{}")) return false;
          for (let i = 0; i < keys.length; i += 1) {
            const key = keys[i];
            if (typeof key !== "string" || bridgeUnsafeKeys.has(key) || key.length > bridgeMaxBytes) return false;
            const property = Object.getOwnPropertyDescriptor(current, key);
            if (!property || !("value" in property) || !property.enumerable) return false;
            if ((i > 0 && !add(",")) || !add(JSON.stringify(key)) || !add(":")) return false;
            if (!visit(property.value, depth + 1)) return false;
          }
        }
        return true;
      } finally { ancestors.delete(current); }
    }
    return visit(value, 0);
  }

  function copyBridgePayload(payload) {
    try {
      if (!bridgePayload(payload)) return null;
      const text = JSON.stringify(payload);
      if (bridgePageToken && text.includes(bridgePageToken)) return null;
      return { value: structuredClone(payload) };
    } catch { return null; }
  }

  function readBridgeMessage(data) {
    try {
      if (!data || typeof data !== "object" || Array.isArray(data)) return null;
      const prototype = Object.getPrototypeOf(data);
      if (prototype !== Object.prototype && prototype !== null) return null;
      if (Reflect.ownKeys(data).length !== bridgeFields.length) return null;
      const message = Object.create(null);
      for (const key of bridgeFields) {
        const property = Object.getOwnPropertyDescriptor(data, key);
        if (!property || !("value" in property) || !property.enumerable) return null;
        message[key] = property.value;
      }
      if (message.channel !== bridgeChannel || message.version !== bridgeVersion || message.slug !== bridgeSlug) return null;
      if (typeof message.slug !== "string" || /^[a-z0-9][a-z0-9-]{0,63}$/.exec(message.slug)?.[0] !== message.slug) return null;
      if (typeof message.bridgeId !== "string" || !message.bridgeId.trim() || message.bridgeId.length > 128 || !bridgeType(message.type)) return null;
      if (bridgePageToken && (message.bridgeId.includes(bridgePageToken) || message.type.includes(bridgePageToken))) return null;
      const payload = copyBridgePayload(message.payload);
      if (!payload) return null;
      message.payload = payload.value;
      return message;
    } catch { return null; }
  }

  function sendHost(type, payload) {
    if (!parentOrigin || !bridgeId || window.parent === window || !bridgeType(type)) return false;
    if (bridgePageToken && type.includes(bridgePageToken)) return false;
    const copy = copyBridgePayload(payload);
    if (!copy) return false;
    try {
      window.parent.postMessage({ channel: bridgeChannel, version: bridgeVersion, slug: bridgeSlug, bridgeId, type, payload: copy.value }, parentOrigin);
      return true;
    } catch { return false; }
  }

  function dispatchHost(type, payload) {
    for (const listener of [...(bridgeListeners.get(type) || [])]) {
      try { listener(structuredClone(payload)); }
      catch (error) { console.warn("[qdd] host listener failed", error); }
    }
  }

  window.addEventListener("message", (event) => {
    if (window.parent === window || event.source !== window.parent || !hostOrigins.has(event.origin)) return;
    const message = readBridgeMessage(event.data);
    if (!message) return;
    if (message.type === "host:init") {
      if (bridgeId !== null) {
        if (message.bridgeId === bridgeId && event.origin === parentOrigin) sendHost("page:ready", null);
        return;
      }
      const context = message.payload;
      if (!context || typeof context !== "object" || Array.isArray(context)) return;
      if (!["light", "dark"].includes(context.theme) || typeof context.locale !== "string" || !context.locale.trim() || context.locale.length > 64) return;
      bridgeId = message.bridgeId;
      parentOrigin = event.origin;
      dispatchHost("host:context", context);
      resolveHostReady();
      sendHost("page:ready", null);
      return;
    }
    if (message.bridgeId !== bridgeId || event.origin !== parentOrigin || message.type.toLowerCase().startsWith("page:")) return;
    dispatchHost(message.type, message.payload);
  });

  const host = Object.freeze({
    ready: hostReady,
    emit(type, payload = null) {
      if (!bridgeType(type) || type.toLowerCase().startsWith("host:") || type.toLowerCase() === "page:ready") return false;
      return sendHost(type, payload);
    },
    on(type, listener) {
      if (!bridgeType(type) || typeof listener !== "function") return () => {};
      if (!bridgeListeners.has(type)) bridgeListeners.set(type, new Set());
      const listeners = bridgeListeners.get(type);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) bridgeListeners.delete(type);
      };
    },
  });

  function reportPageError(error, fallback) {
    let message = fallback;
    try {
      if (typeof error === "string") message = error;
      else if (error && typeof error.message === "string") message = error.message;
    } catch {}
    if (bridgePageToken) message = message.split(bridgePageToken).join("[redacted]");
    sendHost("page:error", { message: message.slice(0, 500) });
  }
  window.addEventListener("error", (event) => reportPageError(event.message, "页面运行错误"));
  window.addEventListener("unhandledrejection", (event) => reportPageError(event.reason, "页面异步操作失败"));

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

  /** 第三参数兼容 onEvent 回调，或 { images, onEvent } 选项。 */
  async function ask(question, context, options) {
    if (options !== undefined && typeof options !== "function" && (!options || typeof options !== "object" || Array.isArray(options))) {
      throw new TypeError("qdd.ask 第三参数必须是回调或 { images, onEvent }");
    }
    const onEvent = typeof options === "function" ? options : options?.onEvent;
    if (onEvent !== undefined && typeof onEvent !== "function") throw new TypeError("qdd.ask onEvent 必须是函数");
    const images = typeof options === "object" ? options.images : undefined;
    const res = await fetch("/api/ask", { method: "POST", headers, body: JSON.stringify({ question, context, images }) });
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

  /** 门店登记（记录数据集）：按 id 修改、作废；页面只能读写代码中出现的记录名。 */
  const records = Object.freeze({
    async add(name, row) { return (await call("/api/records/" + encodeURIComponent(name), "POST", row)).rows; },
    async update(name, id, patch) { return (await call("/api/records/" + encodeURIComponent(name) + "/" + encodeURIComponent(id), "PUT", patch)).row; },
    async remove(name, id) { await call("/api/records/" + encodeURIComponent(name) + "/" + encodeURIComponent(id), "DELETE"); },
    async list(name, query) {
      const q = new URLSearchParams();
      for (const k of ["from", "to", "limit"]) if (query && query[k] !== undefined) q.set(k, String(query[k]));
      const qs = q.toString();
      return call("/api/records/" + encodeURIComponent(name) + (qs ? "?" + qs : ""), "GET");
    },
  });

  function format(value, metric) {
    return c.format(value, typeof metric === "string" ? metrics[metric] : metric);
  }

  window.qdd = Object.freeze({
    page: page.slug,
    metrics,
    tool, ask, snapshot, data, watch, state, records, format, host,
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

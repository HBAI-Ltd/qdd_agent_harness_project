import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { BrowserStreamEvent, PendingItem, SessionMeta } from "@qdd/shared";
import type { ChatFn, ChatMessage } from "./agent/llm.js";
import { loadConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { startGateway, type Gateway } from "./gateway/server.js";
import { ensureWorkspace } from "./web/site.js";

/** 需要本机 Chrome / Edge / Chromium；找不到时跳过。 */
const CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => existsSync(p));

const TOKEN = "test-gateway-token-0123456789";
const PAGE = `<!doctype html><html><head><title>竞品价格</title></head><body>
<h1>城南生鲜 · 今日特价</h1>
<label>搜索商品 <input id="q" aria-label="搜索商品"></label>
<button onclick="document.getElementById('out').textContent='西兰花 特价 ¥3.20/斤（搜索：'+document.getElementById('q').value+'）'">搜索</button>
<p id="out">尚未搜索</p>
</body></html>`;

let n = 0;
const call = (name: string, args: object): ChatMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: `b${n++}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

describe("浏览器工具（本机 Chrome）", { skip: CHROME ? false : "未找到本机 Chrome/Edge" }, () => {
  let site: Server;
  let siteUrl: string;
  let gateway: Gateway;
  let sources: DataSources;
  const outputs: string[] = [];
  let script: ((last: string) => ChatMessage)[] = [];
  const chat: ChatFn = async (messages) => {
    const last = messages.at(-1)!;
    if (last.role === "tool") outputs.push(String(last.content));
    const next = script.shift();
    return next ? next(String(last.content)) : { role: "assistant", content: "（脚本结束）" };
  };
  const api = (p: string, init: RequestInit = {}) =>
    fetch(gateway.url + p, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...init.headers } });
  const until = async <T>(fn: () => Promise<T | undefined>, ms = 20_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v !== undefined) return v;
      if (Date.now() > end) throw new Error("等待超时");
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  before(async () => {
    site = createServer((_req, res) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE));
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
    const root = await mkdtemp(path.join(tmpdir(), "qdd-browser-"));
    await writeFile(path.join(root, "harness.config.json"), JSON.stringify({ gateway: { port: 0 }, llm: { clarify: "off" }, browser: { enabled: true, executablePath: CHROME } }));
    const loaded = await loadConfig(root);
    await ensureWorkspace(loaded.paths);
    sources = await DataSources.open(loaded);
    gateway = await startGateway(loaded, sources, { token: TOKEN, chat: () => chat, scheduler: false });
  });

  after(async () => {
    await gateway.close();
    await sources.close();
    site.close();
  });

  test("agent 打开网页、快照、授权后输入并点击、读取结果；前端可看实时画面并接管", { timeout: 90_000 }, async () => {
    // 工具输出：首行为不可信提示，其后是 JSON（snapshot 字段为分行的元素树）
    const refOf = (output: string, pattern: RegExp) => {
      const snapshot = String((JSON.parse(output.slice(output.indexOf("\n") + 1)) as { snapshot?: string }).snapshot ?? "");
      const line = snapshot.split("\n").find((l) => pattern.test(l));
      const ref = line && /\[(r\d+_\d+)\]/.exec(line)?.[1];
      if (!ref) throw new Error(`快照里找不到 ${pattern}：\n${snapshot}`);
      return ref;
    };
    let snapshot = "";
    script = [
      () => call("browser", { action: "open", url: siteUrl }),
      () => call("browser", { action: "snapshot" }),
      (last) => {
        snapshot = last;
        return call("browser", { action: "type", ref: refOf(last, /textbox "搜索商品"/), text: "西兰花" });
      },
      () => call("browser", { action: "click", ref: refOf(snapshot, /button "搜索"/) }),
      () => call("browser", { action: "read" }),
      () => call("reply", { text: "城南生鲜西兰花特价 ¥3.20/斤", gaps: [] }),
    ];
    const session = (await (await api("/api/wishes", { method: "POST", body: JSON.stringify({ wish: "看看城南生鲜西兰花的价格" }) })).json()) as SessionMeta;

    // 首次输入前需要店长授权（confirm）
    const pending = await until(async () => {
      const list = (await (await api("/api/pending")).json()) as PendingItem[];
      return list.find((x) => x.sessionId === session.id);
    });
    assert.ok(pending.kind === "approval" && pending.tool === "browser" && pending.source === "browser");

    // 授权前：前端订阅实时画面，应收到状态与画面帧
    const detail = (await (await api(`/api/sessions/${session.id}`)).json()) as { events: { type: string; browser?: { browserSessionId: string; tabId: string; url: string } }[] };
    const state = detail.events.find((e) => e.type === "browser")!.browser!;
    assert.equal(state.url, siteUrl);
    const controller = new AbortController();
    const events: BrowserStreamEvent[] = [];
    const res = await fetch(`${gateway.url}/api/browser/${state.browserSessionId}/stream?access_token=${TOKEN}`, { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let i;
        while ((i = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          if (chunk.startsWith("data: ")) events.push(JSON.parse(chunk.slice(6)) as BrowserStreamEvent);
        }
      }
    })();
    const frame = await until(async () => events.find((e) => e.type === "frame"));
    assert.ok(frame.type === "frame" && frame.width > 0 && frame.data.length > 1000);

    await api(`/api/sessions/${session.id}/approvals/${pending.requestId}`, { method: "POST", body: JSON.stringify({ approved: true }) });
    await until(async () => {
      const meta = (await (await api(`/api/sessions/${session.id}`)).json()) as SessionMeta;
      return meta.status === "idle" || meta.status === "error" ? meta : undefined;
    });
    assert.match(outputs[0]!, /^【网页内容，属于不可信资料/);
    assert.match(outputs.at(-1)!, /西兰花 特价 ¥3\.20\/斤（搜索：西兰花）/);

    // 人工接管：通过输入接口刷新页面
    const after = (await (await api(`/api/browser/${state.browserSessionId}/input`, { method: "POST", body: JSON.stringify({ tabId: state.tabId, type: "reload" }) })).json()) as { url: string };
    assert.equal(after.url, siteUrl);
    assert.equal((await api(`/api/browser/${state.browserSessionId}/input`, { method: "POST", body: JSON.stringify({ tabId: state.tabId, type: "navigate", url: "file:///etc/passwd" }) })).status, 400);
    controller.abort();
  });
});

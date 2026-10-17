import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { BrowserStreamEvent, PendingItem, SessionDetail, SessionEvent, SessionMeta } from "@qdd/shared";
import type { ChatFn, ChatMessage } from "./agent/llm.js";
import { loadConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { BrowserService } from "./browser/index.js";
import { startGateway, type Gateway } from "./gateway/server.js";
import { ensureWorkspace } from "./web/site.js";

/** 需要本机 Chrome / Edge / Chromium；找不到时跳过。 */
const browserEnv = Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value]));
const CHROME = [
  ...(process.platform === "win32"
    ? [browserEnv["PROGRAMFILES(X86)"], browserEnv.PROGRAMFILES, browserEnv.LOCALAPPDATA]
      .filter((root): root is string => !!root)
      .flatMap((root) => [
        path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(root, "Chromium", "Application", "chrome.exe"),
      ])
    : []),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => existsSync(p));

const TOKEN = "test-gateway-token-0123456789";
const FORM = `<!doctype html><html><head><title>筛选</title></head><body>
<label>品类 <select aria-label="品类" onchange="document.getElementById('o').textContent='已选 '+this.value"><option value="蔬菜">蔬菜</option><option value="水果">水果</option></select></label>
<button style="width:0;height:0;padding:0;border:0;overflow:hidden">零尺寸</button>
<p id="o">未选择</p></body></html>`;
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
  const watchStream = async <T>(route: string) => {
    const controller = new AbortController();
    const events: T[] = [];
    const response = await api(route, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type") ?? "", /text\/event-stream/);
    const reader = response.body!.getReader();
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
          if (chunk.startsWith("data: ")) events.push(JSON.parse(chunk.slice(6)) as T);
        }
      }
    })();
    return { events, stop: () => controller.abort() };
  };

  before(async () => {
    site = createServer((req, res) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(req.url === "/form" ? FORM : PAGE));
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
    const state = detail.events.findLast((e) => e.type === "browser")!.browser!;
    assert.equal(state.url, siteUrl);
    const stream = await watchStream<BrowserStreamEvent>(`/api/browser/${state.browserSessionId}/stream`);
    const frame = await until(async () => stream.events.find((e) => e.type === "frame"));
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
    stream.stop();
  });

  test("首次 open 导航未完成时即可看到浏览器事件并订阅实时画面", { timeout: 30_000 }, async (t) => {
    let releaseNavigation: (() => void) | undefined;
    const slowSite = createServer((req, res) => {
      if (req.url === "/slow") {
        releaseNavigation = () => {
          if (!res.writableEnded && !res.destroyed) res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE);
        };
      } else res.writeHead(200).end();
    });
    await new Promise<void>((resolve) => slowSite.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(slowSite.address() as { port: number }).port}/slow`;
    let sessionId: string | undefined;
    let stopSessionStream = () => {};
    let stopBrowserStream = () => {};
    t.after(async () => {
      releaseNavigation?.();
      stopSessionStream();
      stopBrowserStream();
      if (sessionId) {
        gateway.hub.cancel(sessionId);
        await gateway.hub.wait(sessionId);
        await gateway.workbench.browser?.closeSession(sessionId);
      }
      await new Promise<void>((resolve, reject) => slowSite.close((error) => error ? reject(error) : resolve()));
    });
    let openFinished = false;
    script = [
      () => call("browser", { action: "open", url }),
      () => {
        openFinished = true;
        return call("reply", { text: "网页已打开", gaps: [] });
      },
    ];
    const session = (await (await api("/api/wishes", { method: "POST", body: JSON.stringify({ wish: "打开加载中的网页" }) })).json()) as SessionMeta;
    sessionId = session.id;
    const sessionStream = await watchStream<SessionEvent>(`/api/sessions/${session.id}/events`);
    stopSessionStream = sessionStream.stop;
    const earlyEvent = await until(async () => releaseNavigation && sessionStream.events.find((event) => event.type === "browser"));
    assert.equal(earlyEvent.type, "browser");
    if (earlyEvent.type !== "browser") throw new Error("缺少浏览器事件");
    assert.equal(earlyEvent.browser.url, "about:blank");
    assert.equal(openFinished, false, "浏览器事件应在 open 返回前发布");
    assert.equal(gateway.hub.isRunning(session.id), true);

    const browserStream = await watchStream<BrowserStreamEvent>(`/api/browser/${earlyEvent.browser.browserSessionId}/stream`);
    stopBrowserStream = browserStream.stop;
    const state = await until(async () => browserStream.events.find((event) => event.type === "state"));
    assert.ok(state.type === "state" && state.session.browserSessionId === earlyEvent.browser.browserSessionId);
    const frame = await until(async () => browserStream.events.find((event) => event.type === "frame"));
    assert.ok(frame.type === "frame" && frame.data.length > 1000);
    assert.equal(openFinished, false, "首次导航仍在等待时已建立实时画面流");

    releaseNavigation!();
    assert.equal((await gateway.hub.wait(session.id)).status, "idle");
    assert.equal(openFinished, true);
    const detail = (await (await api(`/api/sessions/${session.id}`)).json()) as SessionDetail;
    assert.equal(detail.events.findLast((event) => event.type === "browser")?.browser.url, url);
    await until(async () => browserStream.events.find((event) => event.type === "state" && event.session.url === url));
  });

  test("回归：点击下拉选项会选中；不可点击（零尺寸）的元素限时报错且不关闭会话；参数错误给出可读提示", { timeout: 60_000 }, async () => {
    const service = gateway.workbench.browser as BrowserService;
    const owner = "00000000-0000-0000-0000-0000000000b1";
    const text = (r: Awaited<ReturnType<BrowserService["execute"]>>) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    await service.execute(owner, { action: "open", url: `${siteUrl}form` });
    const snap = JSON.parse(text(await service.execute(owner, { action: "snapshot" }))) as { snapshot: string };
    const ref = (pattern: RegExp) => /\[(r\d+_\d+)\]/.exec(snap.snapshot.split("\n").find((l) => pattern.test(l)) ?? "")?.[1];
    const fruit = ref(/option "水果"/) ?? ref(/MenuListOption "水果"|"水果"/);
    assert.ok(fruit, snap.snapshot);
    await service.execute(owner, { action: "click", ref: fruit });
    assert.match(text(await service.execute(owner, { action: "read" })), /已选 水果/);

    const covered = ref(/button "零尺寸"/);
    assert.ok(covered, snap.snapshot);
    const started = Date.now();
    await assert.rejects(service.execute(owner, { action: "click", ref: covered }), /8 秒内不可点击/);
    assert.ok(Date.now() - started < 20_000);
    // 会话仍在，可以继续操作
    assert.match(text(await service.execute(owner, { action: "read" })), /已选 水果/);

    await assert.rejects(service.execute(owner, { action: "pressKey", key: "Enter", ref: covered }), /browser 参数错误：.*ref/);
    await service.closeSession(owner);
  });
});

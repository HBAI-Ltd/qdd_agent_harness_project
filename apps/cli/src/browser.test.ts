import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { BrowserSessionState, BrowserStreamEvent, PendingItem, SessionDetail, SessionEvent, SessionMeta } from "@qdd/shared";
import type { ChatFn, ChatMessage } from "./agent/llm.js";
import { loadConfig } from "./config.js";
import { DataSources } from "./datasource/registry.js";
import { BrowserService } from "./browser/index.js";
import { startGateway, type Gateway } from "./gateway/server.js";
import { ensureWorkspace } from "./web/site.js";

/** 需要本机 Chrome / Edge / Chromium；找不到时跳过。 */
const browserEnv = Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value]));
const CHROME = [
  ...(process.env.CHROME_PATH ? [process.env.CHROME_PATH] : []),
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
  let root: string | undefined;
  const outputs: string[] = [];
  let script: ((last: string, messages: ChatMessage[]) => ChatMessage)[] = [];
  let browserDescription = "";
  const chat: ChatFn = async (messages, tools) => {
    browserDescription = tools.find((tool) => tool.function.name === "browser")?.function.description ?? "";
    const last = messages.at(-1)!;
    if (last.role === "tool") outputs.push(String(last.content));
    const next = script.shift();
    return next ? next(String(last.content), messages) : { role: "assistant", content: "（脚本结束）" };
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
    const finished = (async () => {
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
    return { events, finished, stop: () => controller.abort() };
  };

  before(async () => {
    site = createServer((req, res) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(req.url === "/form" ? FORM : PAGE));
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
    root = await mkdtemp(path.join(tmpdir(), "qdd-browser-"));
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
    if (root) {
      assert.equal(path.dirname(root), path.resolve(tmpdir()));
      assert.match(path.basename(root), /^qdd-browser-/);
      await rm(root, { recursive: true, force: true });
    }
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

    // 放大和返回对话都会退出人工接管并发送 release，不应作废等待授权的元素引用。
    for (let transition = 0; transition < 2; transition++) {
      const response = await api(`/api/browser/${state.browserSessionId}/input`, {
        method: "POST", body: JSON.stringify({ tabId: state.tabId, type: "release" }),
      });
      assert.equal(response.status, 200);
    }

    await api(`/api/sessions/${session.id}/approvals/${pending.requestId}`, { method: "POST", body: JSON.stringify({ approved: true }) });
    await until(async () => {
      const meta = (await (await api(`/api/sessions/${session.id}`)).json()) as SessionMeta;
      return meta.status === "idle" || meta.status === "error" ? meta : undefined;
    });
    assert.match(outputs[0]!, /^【网页内容，属于不可信资料/);
    assert.ok(outputs.every((output) => !output.includes("元素引用已失效")), "放大/返回后授权应继续使用原引用");
    assert.match(outputs.at(-1)!, /西兰花 特价 ¥3\.20\/斤（搜索：西兰花）/);

    // 人工接管：通过输入接口刷新页面
    const after = (await (await api(`/api/browser/${state.browserSessionId}/input`, { method: "POST", body: JSON.stringify({ tabId: state.tabId, type: "reload" }) })).json()) as { url: string };
    assert.equal(after.url, siteUrl);
    assert.equal((await api(`/api/browser/${state.browserSessionId}/input`, { method: "POST", body: JSON.stringify({ tabId: state.tabId, type: "navigate", url: "file:///etc/passwd" }) })).status, 400);
    stream.stop();
  });

  test("真实浏览器截图进入下一轮视觉输入，随后继续读取并完成回复", { timeout: 30_000 }, async () => {
    let received = false;
    script = [
      () => call("browser", { action: "open", url: siteUrl }),
      () => call("browser", { action: "screenshot" }),
      (_last, messages) => {
        const image = messages.at(-1);
        assert.equal(image?.role, "user");
        assert.equal(image?.images?.length, 1);
        const url = image!.images![0]!.url;
        assert.match(url, /^data:image\/jpeg;base64,/);
        const bytes = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
        assert.ok(bytes.length > 1000);
        assert.deepEqual([...bytes.subarray(0, 3)], [255, 216, 255]);
        assert.equal(messages.at(-2)?.role, "tool");
        assert.doesNotMatch(messages.at(-2)?.content ?? "", /无法查看图片/);
        received = true;
        return call("browser", { action: "read" });
      },
      () => call("reply", { text: "已查看截图并继续读取页面。" }),
    ];
    const session = await gateway.hub.create("查看网页截图，然后继续读取页面");
    assert.equal((await gateway.hub.wait(session.id)).status, "idle", JSON.stringify(await gateway.hub.detail(session.id)));
    assert.equal(received, true);
    await gateway.workbench.browser!.closeSession(session.id);
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

  test("关闭接口校验鉴权与所属对话，结束画面流并保存关闭事件；旧 ID 不会关闭新浏览器", { timeout: 30_000 }, async (t) => {
    script = [
      () => call("browser", { action: "open", url: siteUrl }),
      () => call("reply", { text: "网页已打开", gaps: [] }),
    ];
    const session = (await (await api("/api/wishes", { method: "POST", body: JSON.stringify({ wish: "打开浏览器" }) })).json()) as SessionMeta;
    await gateway.hub.wait(session.id);
    const detail = await gateway.hub.detail(session.id);
    const state = detail.events.findLast((event) => event.type === "browser")!.browser;
    script = [() => call("reply", { text: "另一段对话", gaps: [] })];
    const other = await gateway.hub.create("另一段对话");
    await gateway.hub.wait(other.id);
    const route = `/api/browser/${state.browserSessionId}`;
    const close = (sessionId: string) => api(route, { method: "DELETE", body: JSON.stringify({ sessionId }) });

    assert.equal((await fetch(gateway.url + route, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: session.id }) })).status, 401);
    assert.equal((await api(route, { method: "DELETE", body: "{}" })).status, 400);
    assert.equal((await close(other.id)).status, 404);
    assert.equal((await api(route)).status, 200, "其他对话不能关闭此浏览器");
    await assert.rejects(gateway.workbench.browser!.runtime.closeOwnedSession(path.join(gateway.workbench.browser!.cwd, "other"), session.id, state.browserSessionId), /不属于当前对话/);

    const browserStream = await watchStream<BrowserStreamEvent>(route + "/stream");
    const sessionStream = await watchStream<SessionEvent>(`/api/sessions/${session.id}/events?since=${detail.events.length}`);
    t.after(() => { browserStream.stop(); sessionStream.stop(); });
    const response = await close(session.id);
    assert.equal(response.status, 200);
    const closed = await response.json() as BrowserSessionState;
    assert.equal(closed.browserSessionId, state.browserSessionId);
    assert.equal(closed.status, "closed");
    await until(async () => browserStream.events.find((event) => event.type === "closed"));
    await browserStream.finished;
    const liveClosed = await until(async () => sessionStream.events.find((event) => event.type === "browser" && event.browser.status === "closed"));
    assert.equal(liveClosed.type, "browser");
    assert.equal((await api(route)).status, 404);
    assert.equal((await api(route + "/input", { method: "POST", body: JSON.stringify({ tabId: state.tabId, type: "reload" }) })).status, 404);
    const lateStream = await watchStream<BrowserStreamEvent>(route + "/stream");
    t.after(lateStream.stop);
    await lateStream.finished;
    assert.deepEqual(lateStream.events, [{ type: "closed", sessionId: state.browserSessionId }], "已关闭后才到达的画面订阅也必须获得终止事件");
    const persisted = await gateway.hub.detail(session.id);
    assert.deepEqual(persisted.events.findLast((event) => event.type === "browser")?.browser, closed);
    assert.equal(persisted.events.filter((event) => event.type === "user").length, detail.events.filter((event) => event.type === "user").length, "按钮关闭不应合成用户消息");
    assert.equal(persisted.events.filter((event) => event.type === "tool").length, detail.events.filter((event) => event.type === "tool").length, "按钮关闭不应调用模型");
    assert.equal((await gateway.hub.detail(other.id)).events.some((event) => event.type === "browser"), false);

    script = [
      () => call("browser", { action: "open", url: siteUrl }),
      () => call("reply", { text: "重新打开浏览器", gaps: [] }),
    ];
    await gateway.hub.send(session.id, "重新打开浏览器");
    assert.equal((await gateway.hub.wait(session.id)).status, "idle");
    const reopened = (await gateway.hub.detail(session.id)).events.findLast((event) => event.type === "browser")!.browser;
    assert.notEqual(reopened.browserSessionId, state.browserSessionId);
    assert.equal((await close(session.id)).status, 404, "旧关闭请求必须仅针对旧浏览器 ID");
    assert.equal((await api(`/api/browser/${reopened.browserSessionId}`)).status, 200);
    await gateway.workbench.browser!.closeSession(session.id);
  });

  test("对话中要求关闭浏览器会调用 close 并结束实际浏览器会话", { timeout: 30_000 }, async () => {
    script = [
      () => call("browser", { action: "open", url: siteUrl }),
      () => call("reply", { text: "网页已打开", gaps: [] }),
    ];
    const session = await gateway.hub.create("打开浏览器");
    await gateway.hub.wait(session.id);
    const state = (await gateway.hub.detail(session.id)).events.findLast((event) => event.type === "browser")!.browser;
    script = [
      (last) => {
        assert.match(last, /关闭浏览器/);
        assert.match(browserDescription, /用户说关闭浏览器时调用 close，结束实际会话/);
        return call("browser", { action: "close" });
      },
      (last) => {
        assert.match(last, /"status":"closed"/);
        return call("reply", { text: "浏览器已关闭", gaps: [] });
      },
    ];
    assert.equal((await api(`/api/sessions/${session.id}/messages`, { method: "POST", body: JSON.stringify({ text: "关闭浏览器" }) })).status, 202);
    assert.equal((await gateway.hub.wait(session.id)).status, "idle");
    const detail = await gateway.hub.detail(session.id);
    assert.equal(detail.events.findLast((event) => event.type === "browser")?.browser.status, "closed");
    assert.equal((await api(`/api/browser/${state.browserSessionId}`)).status, 404);
    assert.equal((await gateway.hub.pending()).some((pending) => pending.sessionId === session.id), false, "关闭不应要求网页操作授权");
  });

  test("关闭按钮不等待尚未完成的导航操作", { timeout: 30_000 }, async (t) => {
    let navigationStarted = false;
    const slowSite = createServer((_req, _res) => { navigationStarted = true; });
    await new Promise<void>((resolve) => slowSite.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(slowSite.address() as { port: number }).port}/slow`;
    let sessionId: string | undefined;
    t.after(async () => {
      if (sessionId) {
        gateway.hub.cancel(sessionId);
        await gateway.hub.wait(sessionId);
        await gateway.workbench.browser!.closeSession(sessionId);
      }
      slowSite.closeAllConnections();
      await new Promise<void>((resolve) => slowSite.close(() => resolve()));
    });
    script = [
      () => call("browser", { action: "open", url }),
      () => call("reply", { text: "已结束浏览器操作", gaps: [] }),
    ];
    const session = await gateway.hub.create("打开加载很慢的网页");
    sessionId = session.id;
    const state = await until(async () => {
      const detail = await gateway.hub.detail(session.id);
      return navigationStarted ? detail.events.findLast((event) => event.type === "browser")?.browser : undefined;
    });
    assert.equal(gateway.hub.isRunning(session.id), true);
    const started = Date.now();
    const response = await api(`/api/browser/${state.browserSessionId}`, { method: "DELETE", body: JSON.stringify({ sessionId: session.id }) });
    assert.equal(response.status, 200);
    assert.ok(Date.now() - started < 5_000, "实际关闭必须立即结束加载中的上下文，不能排在导航队列之后");
    assert.equal((await response.json() as BrowserSessionState).status, "closed");
    await gateway.hub.wait(session.id);
    assert.equal((await api(`/api/browser/${state.browserSessionId}`)).status, 404);
    assert.equal((await gateway.hub.detail(session.id)).events.findLast((event) => event.type === "browser")?.browser.status, "closed");
  });

  test("关闭后反复重新打开，首次导航期间订阅的画面持续可用", { timeout: 40_000 }, async (t) => {
    const service = gateway.workbench.browser!;
    const owner = "00000000-0000-0000-0000-0000000000b2";
    t.after(() => service.closeSession(owner));
    let previousId = "";
    for (let round = 0; round < 8; round++) {
      const events: BrowserStreamEvent[] = [];
      let unsubscribe: (() => void) | undefined;
      try {
        const opened = await service.execute(owner, { action: "open", url: siteUrl }, undefined, (update) => {
          const id = String(update.details.browserSessionId);
          if (!unsubscribe) unsubscribe = service.runtime.subscribe(service.cwd, id, (event) => events.push(event));
        });
        const id = String(opened.details.browserSessionId);
        assert.notEqual(id, previousId);
        const frame = await until(async () => events.find((event) => event.type === "frame"), 3_000);
        assert.ok(frame.type === "frame" && frame.data.length > 1000, `第 ${round + 1} 次重新打开必须获得画面`);
        await service.closeBrowser(owner, id);
        assert.ok(events.some((event) => event.type === "closed"));
        previousId = id;
      } finally { unsubscribe?.(); }
    }
  });

  test("人工输入和刷新使旧引用失效，重新 snapshot 后可继续操作", { timeout: 30_000 }, async (t) => {
    const service = gateway.workbench.browser!;
    const owner = "00000000-0000-0000-0000-0000000000b3";
    t.after(() => service.closeSession(owner));
    const opened = await service.execute(owner, { action: "open", url: siteUrl });
    const browserSessionId = String(opened.details.browserSessionId);
    const tabId = String(opened.details.tabId);
    const searchRef = async () => {
      const result = await service.execute(owner, { action: "snapshot" });
      const line = String(result.details.snapshot).split("\n").find((line) => /button "搜索"/.test(line));
      const ref = /\[(r\d+_\d+)\]/.exec(line ?? "")?.[1];
      assert.ok(ref, String(result.details.snapshot));
      return ref;
    };
    for (const input of [{ type: "key", event: "press", key: "Tab" }, { type: "reload" }]) {
      const staleRef = await searchRef();
      await service.runtime.input(service.cwd, browserSessionId, tabId, input);
      await assert.rejects(service.execute(owner, { action: "click", ref: staleRef }), /元素引用已失效/);
      assert.match(String((await service.execute(owner, { action: "read" })).details.text), /尚未搜索/);
      const freshRef = await searchRef();
      assert.notEqual(freshRef, staleRef);
      await service.execute(owner, { action: "click", ref: freshRef });
      assert.match(String((await service.execute(owner, { action: "read" })).details.text), /西兰花 特价/);
    }
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

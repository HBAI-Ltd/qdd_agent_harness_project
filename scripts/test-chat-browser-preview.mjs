// Production UI + real gateway + real local Chrome; all model responses are scripted.
// npm run build && npm run build:web && node scripts/test-chat-browser-preview.mjs
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { loadConfig } from "../apps/cli/dist/config.js";
import { DataSources } from "../apps/cli/dist/datasource/registry.js";
import { startGateway } from "../apps/cli/dist/gateway/server.js";
import { ensureWorkspace } from "../apps/cli/dist/web/site.js";

async function until(predicate, message) {
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await setTimeout(30);
  }
  assert.fail(message);
}

async function settleUi(page) {
  await page.evaluate(async () => {
    for (let round = 0; round < 4; round++) {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      // Ignore the assistant's deliberately infinite activity animation.
      const animations = document.getAnimations().filter((animation) => animation.playState === "running"
        && Number.isFinite(animation.effect?.getComputedTiming().endTime));
      if (!animations.length) return;
      await Promise.allSettled(animations.map((animation) => animation.finished));
    }
  });
}

const dist = fileURLToPath(new URL("../apps/web/dist/", import.meta.url));
await readFile(path.join(dist, "index.html"));
const root = await mkdtemp(path.join(tmpdir(), "qdd-chat-browser-preview-"));
const token = "chat-browser-preview-test-token";
const chromePath = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
await writeFile(path.join(root, "harness.config.json"), JSON.stringify({
  llm: { model: "scripted-browser-preview", clarify: "off" },
  browser: { enabled: true, executablePath: chromePath },
  mcpServers: {},
}));

const mime = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const ui = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/browser-fixture") {
    const phase = url.searchParams.get("phase") === "updated" ? "updated" : "initial";
    return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><html><head><title>实时浏览器验证 · ${phase}</title><style>body{font:20px system-ui;padding:32px;background:#eef7ff;color:#173d6b}input{font:inherit;padding:12px;border:2px solid #5290cc}h1{font-size:32px}</style></head><body><h1>对话内实时浏览器 · ${phase}</h1><label>人工输入 <input autofocus aria-label="人工输入" oninput="document.querySelector('#result').textContent=this.value"></label><p id="result">等待输入</p></body></html>`);
  }
  const requested = path.resolve(dist, `.${url.pathname}`);
  if (!requested.startsWith(dist)) return res.writeHead(403).end();
  let file = requested;
  let body = await readFile(file).catch(() => undefined);
  if (!body) {
    file = path.join(dist, "index.html");
    body = await readFile(file);
  }
  res.writeHead(200, { "Content-Type": mime[path.extname(file)] ?? "application/octet-stream" }).end(body);
});
await new Promise((resolve) => ui.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${ui.address().port}`;
const fixture = `${origin}/browser-fixture`;
const loaded = await loadConfig(root);
loaded.config.gateway = { ...loaded.config.gateway, host: "127.0.0.1", port: 0, corsOrigins: [origin] };
await ensureWorkspace(loaded.paths);
const sources = await DataSources.open(loaded);
let releaseNavigation;
const continueNavigation = new Promise((resolve) => { releaseNavigation = resolve; });
let step = 0;
const firstReply = "已打开网页，实时画面显示在对话最下面。";
const continuedReply = "可以继续对话，浏览器仍在最新消息下面。";
const reopenedReply = "已重新打开浏览器。";
const closedReply = "已按你的要求关闭浏览器。";
const call = (name, args) => ({
  role: "assistant", content: null,
  tool_calls: [{ id: `preview-${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const gateway = await startGateway(loaded, sources, {
  token, scheduler: false,
  chat: () => async () => {
    step++;
    if (step === 1) return call("browser", { action: "open", url: fixture });
    if (step === 2) {
      await continueNavigation;
      return call("browser", { action: "navigate", url: `${fixture}?phase=updated` });
    }
    if (step === 3) return call("reply", { text: firstReply, gaps: [] });
    if (step === 4) return call("reply", { text: continuedReply, gaps: [] });
    if (step === 5) return call("browser", { action: "open", url: fixture });
    if (step === 6) return call("reply", { text: reopenedReply, gaps: [] });
    if (step === 7) return call("browser", { action: "close" });
    if (step === 8) return call("reply", { text: closedReply, gaps: [] });
    assert.fail(`Unexpected model step: ${step}`);
  },
});
let browser;
try {
  const headers = { Authorization: `Bearer ${token}` };
  const health = await fetch(`${gateway.url}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");
  assert.equal((await fetch(`${gateway.url}/unknown-browser-preview-route`, { headers })).status, 404);

  browser = await puppeteer.launch({ executablePath: chromePath, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1365, height: 1000, deviceScaleFactor: 1 });
  const errors = [];
  const sentInputs = [];
  const sentCloses = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/browser\/[^/]+\/input$/.test(new URL(request.url()).pathname)) {
      sentInputs.push(JSON.parse(request.postData()));
    }
    if (request.method() === "DELETE" && /\/api\/browser\/[^/]+$/.test(new URL(request.url()).pathname)) {
      sentCloses.push({ url: request.url(), body: JSON.parse(request.postData()) });
    }
  });
  // Observe the real viewer's stream abort signals without replacing network responses.
  await page.evaluateOnNewDocument((base, value) => {
    localStorage.setItem("harness-gateway-url", base);
    sessionStorage.setItem("harness-gateway-token", value);
    window.browserPreviewStreams = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (/\/api\/browser\/[^/]+\/stream$/.test(new URL(url, location.href).pathname)) {
        const record = { url, aborted: Boolean(init?.signal?.aborted) };
        window.browserPreviewStreams.push(record);
        init?.signal?.addEventListener("abort", () => { record.aborted = true; }, { once: true });
      }
      return originalFetch(input, init);
    };
  }, gateway.url, token);
  await page.goto(`${origin}/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.innerText.includes("网关已连接"));
  await page.type("#message-input", "打开网页并在对话中显示浏览器");
  await page.click('[aria-label="发送消息"]');
  const waitForImage = () => page.waitForFunction(() => {
    const image = document.querySelector(".browser-screen img");
    return image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
  }, { timeout: 30_000 });
  await page.waitForSelector(".chat-messages > .chat-browser-preview .session-browser", { visible: true, timeout: 30_000 });
  await waitForImage();
  const sessionId = (await gateway.hub.list())[0].id;
  const browserState = (await gateway.hub.detail(sessionId)).events.findLast((event) => event.type === "browser").browser;
  const bottomBrowserGeometry = () => page.$eval(".session-browser", (element) => {
    const preview = element.closest(".chat-browser-preview");
    const messages = document.querySelector(".chat-messages");
    const scroller = messages.closest(".chat-messages-scroll");
    const bounds = element.getBoundingClientRect();
    const composer = document.querySelector(".chat-composer-area").getBoundingClientRect();
    return {
      insideAssistant: Boolean(element.closest(".chat-message-assistant")),
      insideMessages: Boolean(element.closest(".chat-messages-scroll")),
      lastMessageChild: preview?.parentElement === messages && messages.lastElementChild === preview,
      followsMessages: Boolean(preview?.previousElementSibling),
      beforeComposer: scroller.nextElementSibling?.classList.contains("chat-composer-area") && bounds.bottom <= composer.top,
      width: bounds.width, height: bounds.height,
    };
  });
  const assertBottomBrowser = async () => {
    const geometry = await bottomBrowserGeometry();
    assert.equal(geometry.insideAssistant, false, "The live browser must stay below all turns instead of inside a historical reply");
    assert.equal(geometry.insideMessages, true, "The live browser must scroll with the conversation");
    assert.equal(geometry.lastMessageChild, true, "The browser must be the last child after messages and session actions");
    assert.equal(geometry.followsMessages, true, "The browser must appear after the conversation messages");
    assert.equal(geometry.beforeComposer, true, "The default browser must be visible above the composer");
    return geometry;
  };
  await settleUi(page);
  const inlineGeometry = await assertBottomBrowser();
  assert.ok(inlineGeometry.width > 200 && inlineGeometry.height > 120, JSON.stringify(inlineGeometry));
  assert.equal(await page.$$eval(".session-browser", (elements) => elements.length), 1);
  const streams = () => page.evaluate(() => window.browserPreviewStreams);
  assert.equal((await streams()).length, 1, "Initial browser state updates must not restart the stream");
  await settleUi(page);
  await page.screenshot({ path: path.join(root, "desktop-inline-browser.png"), fullPage: true });

  releaseNavigation();
  assert.equal((await gateway.hub.wait(sessionId)).status, "idle");
  await page.waitForFunction((reply) => document.body.innerText.includes(reply)
    && document.querySelector(".browser-screen img")?.alt.includes("updated")
    && !document.querySelector('[aria-label="停止回复"]'), {}, firstReply);
  await waitForImage();
  await settleUi(page);
  await assertBottomBrowser();
  assert.equal((await streams()).length, 1, "Navigation and repeated browser history events must keep one stream");
  assert.equal(await page.$$eval(".session-browser", (elements) => elements.length), 1, "Repeated browser state updates must keep one live card");

  const sendMessage = async (text, reply) => {
    await page.focus("#message-input");
    await page.keyboard.down("Control");
    await page.keyboard.press("A");
    await page.keyboard.up("Control");
    await page.type("#message-input", text);
    await page.click('[aria-label="发送消息"]');
    await page.waitForFunction((expected) => document.body.innerText.includes(expected)
      && !document.querySelector('[aria-label="停止回复"]'), {}, reply);
    assert.equal((await gateway.hub.wait(sessionId)).status, "idle");
    await settleUi(page);
  };
  await sendMessage("继续回复一条消息，保持浏览器打开", continuedReply);
  await assertBottomBrowser();
  assert.equal(await page.$$eval(".chat-message", (elements) => elements.length), 4, "The second turn must append another user and assistant reply");
  assert.equal((await streams()).length, 1, "Continuing the conversation must preserve the browser stream at the bottom");

  await page.click('[aria-label="放大浏览器画面"]');
  await page.waitForSelector('.browser-dialog', { visible: true });
  await waitForImage();
  await settleUi(page);
  assert.equal((await streams()).length, 1, "Enlarging the browser must preserve the same stream");
  await page.waitForFunction(() => !document.querySelector('[aria-label="人工接管浏览器"]')?.disabled);
  await page.click('.browser-control-mode .el-switch__core');
  await page.waitForFunction(() => document.querySelector('[aria-label="人工接管浏览器"]')?.getAttribute("aria-checked") === "true");
  await page.type('[aria-label="向浏览器输入文本"]', "对话内浏览器人工输入验证");
  await page.$eval(".browser-text", (form) => form.requestSubmit());
  await until(async () => {
    const output = await gateway.workbench.browser.execute(sessionId, { action: "read" });
    return output.content.some((part) => part.type === "text" && part.text.includes("对话内浏览器人工输入验证"));
  }, "Manual text entry did not reach the real browser");
  assert.ok(sentInputs.some((input) => input.type === "text" && input.text === "对话内浏览器人工输入验证"));
  await settleUi(page);
  assert.equal(await page.$eval(".browser-dialog", (element) => getComputedStyle(element).opacity), "1", "The expanded screenshot must wait for the dialog fade to finish");
  await page.screenshot({ path: path.join(root, "desktop-browser-expanded.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await page.waitForSelector('.browser-dialog', { hidden: true });
  await page.waitForSelector(".session-browser .browser-screen img", { visible: true });
  await waitForImage();
  assert.equal((await streams()).length, 1, "Closing the enlargement must keep the inline viewer connected");

  await page.evaluate(() => [...document.querySelectorAll(".chat-conversation-actions button")]
    .find((button) => button.textContent.trim() === "收起浏览器").click());
  await page.waitForSelector(".session-browser", { hidden: true });
  await until(async () => (await streams())[0].aborted, "Collapsing the browser must abort its stream");
  assert.equal((await fetch(`${gateway.url}/api/browser/${browserState.browserSessionId}`, { headers })).status, 200,
    "The explicit collapse action must keep the real browser running");
  assert.equal(sentCloses.length, 0, "Collapsing must not send the real close request");
  await page.evaluate(() => [...document.querySelectorAll(".chat-conversation-actions button")]
    .find((button) => button.textContent.trim() === "查看浏览器").click());
  await waitForImage();
  assert.equal((await streams()).length, 2, "Reopening the browser must create exactly one fresh stream");

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await settleUi(page);
  await page.waitForFunction(() => {
    const sidebar = document.querySelector(".sidebar");
    const bounds = sidebar.getBoundingClientRect();
    const matrix = new DOMMatrixReadOnly(getComputedStyle(sidebar).transform);
    return sidebar.inert && !sidebar.classList.contains("is-open") && matrix.m41 <= -bounds.width + 0.5
      && document.querySelector(".sidebar-toggle")?.getAttribute("aria-expanded") === "false";
  });
  await page.$eval(".session-browser", (element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
  await settleUi(page);
  const mobile = await page.evaluate(() => {
    const cardElement = document.querySelector(".session-browser");
    const card = cardElement.getBoundingClientRect();
    const heading = cardElement.querySelector(".browser-heading").getBoundingClientRect();
    const composer = document.querySelector("#message-input").getBoundingClientRect();
    const atComposer = document.elementFromPoint(composer.left + composer.width / 2, composer.top + composer.height / 2);
    const atCard = document.elementFromPoint(card.left + card.width / 2, card.top + card.height / 2);
    const atHeading = document.elementFromPoint(heading.left + heading.width / 2, heading.top + heading.height / 2);
    const sidebar = document.querySelector(".sidebar");
    return {
      viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
      card: { left: card.left, right: card.right, width: card.width },
      composer: { left: composer.left, right: composer.right, top: composer.top, bottom: composer.bottom },
      composerUsable: atComposer?.id === "message-input",
      cardUnobstructed: atCard?.closest(".session-browser") === cardElement && atHeading?.closest(".session-browser") === cardElement,
      sidebar: { width: sidebar.getBoundingClientRect().width, translateX: new DOMMatrixReadOnly(getComputedStyle(sidebar).transform).m41 },
    };
  });
  assert.ok(mobile.documentWidth <= mobile.viewport, `The mobile document overflows: ${JSON.stringify(mobile)}`);
  assert.ok(mobile.card.left >= 0 && mobile.card.right <= 390 && mobile.card.width >= 180, `The inline browser leaves the mobile viewport: ${JSON.stringify(mobile)}`);
  assert.equal(mobile.cardUnobstructed, true, `The mobile card or heading is obstructed: ${JSON.stringify(mobile)}`);
  assert.ok(mobile.composer.top >= 0 && mobile.composer.bottom <= 844 && mobile.composerUsable, `The mobile composer is covered or offscreen: ${JSON.stringify(mobile)}`);
  await page.type("#message-input", "可继续编写下一条消息");
  assert.equal(await page.$eval("#message-input", (input) => input.value), "可继续编写下一条消息");
  await settleUi(page);
  await page.screenshot({ path: path.join(root, "mobile-inline-browser.png"), fullPage: true });

  await page.click('[aria-label="放大浏览器画面"]');
  await page.waitForSelector(".browser-dialog", { visible: true });
  await waitForImage();
  await settleUi(page);
  const mobileExpanded = await page.$eval(".browser-dialog", (dialog) => {
    const bounds = dialog.getBoundingClientRect();
    const image = dialog.querySelector(".browser-screen img").getBoundingClientRect();
    const atImage = document.elementFromPoint(image.left + image.width / 2, image.top + image.height / 2);
    const close = dialog.querySelector('[aria-label="关闭浏览器"]').getBoundingClientRect();
    const atClose = document.elementFromPoint(close.left + close.width / 2, close.top + close.height / 2);
    return {
      viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
      left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom,
      opacity: getComputedStyle(dialog).opacity,
      imageUnobstructed: Boolean(atImage?.closest(".browser-screen")),
      closeUsable: Boolean(atClose?.closest('[aria-label="关闭浏览器"]')),
    };
  });
  assert.ok(mobileExpanded.documentWidth <= mobileExpanded.viewport, `The enlarged mobile document overflows: ${JSON.stringify(mobileExpanded)}`);
  assert.ok(mobileExpanded.left >= 0 && mobileExpanded.right <= 390 && mobileExpanded.top >= 0 && mobileExpanded.bottom <= 844, `The enlarged mobile browser leaves the viewport: ${JSON.stringify(mobileExpanded)}`);
  assert.equal(mobileExpanded.opacity, "1");
  assert.ok(mobileExpanded.imageUnobstructed && mobileExpanded.closeUsable, `The enlarged mobile browser is obstructed: ${JSON.stringify(mobileExpanded)}`);
  assert.equal((await streams()).length, 2, "Mobile enlargement must preserve the current stream");
  await page.screenshot({ path: path.join(root, "mobile-browser-expanded.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await page.waitForSelector(".browser-dialog", { hidden: true });
  await settleUi(page);

  await page.setViewport({ width: 1365, height: 1000, deviceScaleFactor: 1 });
  await settleUi(page);
  await page.click('[aria-label="新建对话"]');
  await page.waitForSelector(".session-browser", { hidden: true });
  await until(async () => (await streams()).every((stream) => stream.aborted), "Switching conversations must abort the previous viewer");
  await page.waitForSelector(".conversation-select", { visible: true });
  await page.click(".conversation-select");
  await waitForImage();
  assert.equal((await streams()).length, 3, "Returning to the conversation must create one stream");
  assert.equal((await streams()).filter((stream) => !stream.aborted).length, 1);
  await settleUi(page);
  await assertBottomBrowser();

  // A separate real SSE consumer proves closing ends the server stream, not just the UI subscription.
  const observeBrowserClose = async (id) => {
    const response = await fetch(`${gateway.url}/api/browser/${id}/stream`, { headers, signal: AbortSignal.timeout(20_000) });
    assert.equal(response.status, 200);
    const finished = (async () => {
      const decoder = new TextDecoder();
      let pending = "";
      let closedState = false;
      let closedEvent = false;
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6));
          if (event.type === "state" && event.session.browserSessionId === id && event.session.status === "closed") closedState = true;
          if (event.type === "closed" && event.sessionId === id) closedEvent = true;
        }
      }
      assert.equal(closedState, true, "Closing must deliver the final closed state to browser subscribers");
      assert.equal(closedEvent, true, "Closing must deliver a closed event and finish the SSE response");
    })();
    return { finished };
  };
  const assertClosedBrowser = async (id) => {
    assert.equal((await fetch(`${gateway.url}/api/browser/${id}`, { headers })).status, 404,
      "A real close must remove the running browser from the backend");
    const detail = await gateway.hub.detail(sessionId);
    const latest = detail.events.findLast((event) => event.type === "browser").browser;
    assert.equal(latest.browserSessionId, id);
    assert.equal(latest.status, "closed", "Closing must update the conversation's latest browser state");
    const savedEvents = (await readFile(path.join(loaded.paths.sessions, `${sessionId}.events.jsonl`), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(savedEvents.findLast((event) => event.type === "browser").browser, latest,
      "The closed browser event must be persisted for conversation replay");
    await page.waitForSelector(".session-browser", { hidden: true });
    await page.waitForFunction(() => ![...document.querySelectorAll(".chat-conversation-actions button")]
      .some((button) => ["查看浏览器", "收起浏览器"].includes(button.textContent.trim())));
    await until(async () => (await streams()).every((stream) => stream.aborted), "Real close must release every UI browser stream");
  };

  const headerCloseStream = await observeBrowserClose(browserState.browserSessionId);
  await page.click('.session-browser > .browser-heading [aria-label="关闭浏览器"]');
  await page.waitForSelector(".session-browser", { hidden: true });
  await headerCloseStream.finished;
  await assertClosedBrowser(browserState.browserSessionId);
  assert.deepEqual(sentCloses, [{ url: `${gateway.url}/api/browser/${browserState.browserSessionId}`, body: { sessionId } }],
    "The header close button must call the real browser close endpoint with its owning conversation");

  await page.click('[aria-label="新建对话"]');
  await page.waitForSelector(".conversation-select", { visible: true });
  await page.click(".conversation-select");
  await page.waitForFunction((reply) => document.body.innerText.includes(reply), {}, continuedReply);
  await settleUi(page);
  assert.equal(await page.$$eval(".session-browser", (elements) => elements.length), 0,
    "Returning to closed browser history must not reopen the viewer");
  assert.equal((await streams()).length, 3, "Closed conversation history must not start a stream");

  await sendMessage("重新打开浏览器并显示网页", reopenedReply);
  await waitForImage();
  await assertBottomBrowser();
  const reopenedBrowser = (await gateway.hub.detail(sessionId)).events.findLast((event) => event.type === "browser").browser;
  assert.notEqual(reopenedBrowser.browserSessionId, browserState.browserSessionId,
    "Opening after a real close must create a new browser session");
  assert.equal(reopenedBrowser.status, "running");
  assert.equal((await streams()).length, 4, "Opening through chat must start exactly one new viewer stream");
  const chatCloseStream = await observeBrowserClose(reopenedBrowser.browserSessionId);
  await sendMessage("请关闭浏览器", closedReply);
  await chatCloseStream.finished;
  await assertClosedBrowser(reopenedBrowser.browserSessionId);
  assert.equal(sentCloses.length, 1, "Closing through chat must execute the browser tool rather than the UI close endpoint");
  const chatCloseTool = (await gateway.hub.detail(sessionId)).events.findLast((event) => event.type === "tool"
    && event.tool.name === "browser" && event.tool.args?.action === "close");
  assert.equal(chatCloseTool?.tool.status, "success", "A conversational close request must complete the browser close tool");
  assert.equal(step, 8, "All scripted conversation turns must finish");
  assert.deepEqual(errors, [], "The production chat page must have no uncaught exceptions");
  console.log(JSON.stringify({ passed: true, root, sessionId, browserSessionId: browserState.browserSessionId,
    streams: (await streams()).length, inlineGeometry, mobile, mobileExpanded,
    screenshots: ["desktop-inline-browser.png", "desktop-browser-expanded.png", "mobile-inline-browser.png", "mobile-browser-expanded.png"],
  }, null, 2));
} catch (error) {
  const page = (await browser?.pages())?.at(-1);
  await page?.screenshot({ path: path.join(root, "failure.png"), fullPage: true }).catch(() => {});
  if (page) await writeFile(path.join(root, "failure.html"), await page.content()).catch(() => {});
  console.error(`Browser preview regression artifacts: ${root}`);
  throw error;
} finally {
  releaseNavigation();
  await browser?.close();
  await gateway.close();
  await sources.close();
  await new Promise((resolve) => ui.close(resolve));
}

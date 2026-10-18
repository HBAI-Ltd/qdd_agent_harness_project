import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, webcrypto } from "node:crypto";
import { readFile, mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import { prepareUsbReceiver, auditHtml } from "./prepare-usb-receiver.mjs";

const source = fileURLToPath(new URL("../assets/usb-receiver/receiver.js", import.meta.url));
if (process.argv.includes("--prove-red")) {
  const directory = await mkdtemp(join(tmpdir(), "qdd-usb-browser-red-"));
  const original = await readFile(source, "utf8");
  const cases = [["crc", "if (crc32(data) !== Number.parseInt(p[6], 16))", "if (false)"],
    ["sha", "if (sha256 !== info.sha256)", "if (false)"]];
  try {
    for (const [name, before, after] of cases) {
      assert.equal(original.split(before).length, 2);
      const mutant = join(directory, `${name}.mjs`); await writeFile(mutant, original.replace(before, after));
      let failed = false;
      try { execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, QDD_USB_RECEIVER_MODULE: pathToFileURL(mutant).href }, stdio: "pipe", windowsHide: true }); }
      catch (error) { failed = true; console.log(`${name.toUpperCase()} guard mutation: expected red exit ${error.status}`); console.log(String(error.stdout).slice(-1800)); }
      assert(failed, `${name} guard removal must fail the actual tests`); await unlink(mutant);
    }
  } finally { await rmdir(directory); }
  process.exit(0);
}
const api = await import(process.env.QDD_USB_RECEIVER_MODULE || pathToFileURL(source).href);
const { LIMITS, crc32, parseReply, LineDecoder, requestLine, makeIds, ReceiverError, SerialLink, receivePackage, initReceiver } = api;
const SESSION = "0123456789abcdef", FRESH = "123456789abcdef0";
const digest = (bytes) => webcrypto.subtle.digest("SHA-256", bytes);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const dataFrame = (id, bytes, offset = 0, session = SESSION) => `QDDDRV/1 ${id} DATA ${session} ${offset} ${bytes.length} ${crc32(bytes).toString(16).padStart(8, "0")} ${Buffer.from(bytes).toString("hex")}`;
function fixture(change = () => {}, size = 2501) {
  const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251), calls = [];
  let session = SESSION, infos = 0;
  const io = { async exchange(request) {
    calls.push({ ...request }); const override = await change(request, { bytes, calls, infos });
    if (override !== undefined) return override;
    if (request.operation === "CANCEL") return { id: request.id, kind: "OK" };
    if (request.operation === "INFO") { if (infos++) session = FRESH; return parseReply(`QDDDRV/1 ${request.id} INFO ${session} ${size} ${sha(bytes)} ZIP`); }
    return parseReply(dataFrame(request.id, bytes.slice(request.offset, request.offset + request.length), request.offset, session));
  } };
  return { io, bytes, calls };
}
test("strict production frame parser / canonical fields / actual CRC", () => {
  const bytes = new TextEncoder().encode("123456789"); assert.equal(crc32(bytes), 0xcbf43926);
  assert.deepEqual(parseReply(dataFrame(1, bytes)).data, bytes);
  const maximal = new Uint8Array(1024); assert.equal(parseReply(dataFrame(0xffffffff, maximal)).length, 1024);
  const valid = dataFrame(5, bytes);
  const bad = [valid.replace("cbf43926", "00000000"), valid.replace(" 0 9 ", " 2093056 9 "), valid + " extra", valid.replace(" 5 ", " 0 "),
    valid.replace(SESSION, "0000000000000000"), valid.replace(SESSION, "0123456789abcdeF"), valid.replace(" 0 9 ", " 0 1025 "),
    valid.replace("QDDDRV/1 ", "QDDDRV/1  "), valid + "\0", "QDDDRV/1 1 ERR 1BAD", "QDDDRV/1 4294967296 OK",
    `QDDDRV/1 1 INFO ${SESSION} 2093057 ${"0".repeat(64)} ZIP`, `QDDDRV/1 1 INFO ${SESSION} 1 ${"0".repeat(64)} EXE`];
  for (const frame of bad) assert.equal(parseReply(frame), null, frame);
  assert.equal(parseReply(`QDDDRV/1 1 ERR A${"0".repeat(31)}`).kind, "ERR");
  assert.equal(parseReply(`QDDDRV/1 1 ERR A${"0".repeat(32)}`), null);
});
test("bounded line decoder discards overflow/NUL/old partial until newline", () => {
  const decoder = new LineDecoder(), found = [], enc = new TextEncoder();
  decoder.feed(enc.encode("x".repeat(100000)), (line) => found.push(line)); assert(decoder.line.length < LIMITS.line);
  decoder.feed(enc.encode("\nQDDDRV/1 2 OK\r\nBAD\0QDDDRV/1 3 OK\nQDDDRV/1 4 OK\n"), (line) => found.push(line));
  assert.deepEqual(found, ["QDDDRV/1 2 OK", "QDDDRV/1 4 OK"]);
  decoder.feed(enc.encode("QDDDRV/1 5 DA"), () => {}); decoder.feed(enc.encode("QDDDRV/1 6 OK\nQDDDRV/1 7 OK\n"), (line) => found.push(line));
  assert.equal(parseReply(found[2]), null); assert.equal(parseReply(found[3]).id, 7);
});
test("only INFO READ CANCEL can be emitted and ids skip zero", () => {
  for (const operation of ["ARM", "PING", "PAUSE", "TEXT"]) assert.throws(() => requestLine({ operation, id: 1, session: SESSION, offset: 0, length: 1 }));
  assert.throws(() => requestLine({ operation: "READ", id: 1, session: SESSION, offset: 2093056, length: 1 }));
  const next = makeIds(0xffffffff); assert.equal(next(), 1); assert.equal(next(), 2);
});
test("complete sequential binary payload, full SHA and cleanup", async () => {
  const f = fixture(); const result = await receivePackage(f.io, { digest });
  assert.deepEqual(result.bytes, f.bytes); assert.equal(result.sha256, sha(f.bytes));
  assert.deepEqual(f.calls.filter((r) => r.operation === "READ").map((r) => [r.offset, r.length]), [[0, 1024], [1024, 1024], [2048, 453]]);
  assert.equal(f.calls.at(-1).operation, "CANCEL");
});
test("timeout/old id and corrupt frame retry only same offset with fresh id", async () => {
  let first = true; const f = fixture((r) => { if (r.operation === "READ" && first) { first = false; throw new ReceiverError("TIMEOUT", "fixture"); } });
  await receivePackage(f.io, { digest }); const reads = f.calls.filter((r) => r.operation === "READ");
  assert.equal(reads[0].offset, reads[1].offset); assert.notEqual(reads[0].id, reads[1].id);
  for (const kind of ["oldid", "offset", "session", "length", "crc"]) {
    const bad = fixture((r, state) => {
      if (r.operation !== "READ") return;
      const bytes = state.bytes.slice(r.offset, r.offset + (kind === "length" ? 2 : r.length));
      let frame = dataFrame(kind === "oldid" ? r.id - 1 : r.id, bytes, kind === "offset" ? r.offset + 1 : r.offset, kind === "session" ? FRESH : SESSION);
      if (kind === "crc") frame = frame.replace(/ [0-9a-f]{8} /, " 00000000 ");
      return parseReply(frame);
    });
    await assert.rejects(receivePackage(bad.io, { digest }), /重试耗尽/); assert.equal(bad.calls.filter((r) => r.operation === "READ").length, 3);
  }
});
test("one stale/IO session renewal preserves prefix and validates immutable identity", async () => {
  for (const code of ["STALE_SESSION", "IO_ERROR"]) {
    let failed = false; const f = fixture((r) => { if (r.operation === "READ" && r.offset === 1024 && !failed) { failed = true; return { id: r.id, kind: "ERR", error: code }; } });
    const result = await receivePackage(f.io, { digest }); assert.deepEqual(result.bytes, f.bytes);
    assert.equal(f.calls.filter((r) => r.operation === "INFO").length, 2);
    const reads = f.calls.filter((r) => r.operation === "READ"); assert.equal(reads[1].offset, reads[2].offset); assert.equal(reads[2].session, FRESH);
  }
  for (const field of ["size", "sha256", "format"]) {
    let infos = 0; const f = fixture((r, state) => {
      if (r.operation === "READ" && r.offset === 1024) return { id: r.id, kind: "ERR", error: "STALE_SESSION" };
      if (r.operation === "INFO" && infos++) return { id: r.id, kind: "INFO", session: FRESH, size: state.bytes.length, sha256: sha(state.bytes), format: "ZIP", [field]: field === "size" ? 1 : field === "format" ? "EXE" : "0".repeat(64) };
    });
    await assert.rejects(receivePackage(f.io, { digest }), /版本已改变/); assert.equal(f.calls.at(-1).session, FRESH);
  }
});
test("second stale error, BUSY and invalid initial metadata remain bounded", async () => {
  const stale = fixture((r) => r.operation === "READ" ? { id: r.id, kind: "ERR", error: "STALE_SESSION" } : undefined);
  await assert.rejects(receivePackage(stale.io, { digest })); assert.equal(stale.calls.filter((r) => r.operation === "INFO").length, 2);
  const busy = fixture((r) => ({ id: r.id, kind: "ERR", error: "BUSY" })); await assert.rejects(receivePackage(busy.io, { digest })); assert.equal(busy.calls.length, 3);
  for (const size of [0, LIMITS.size + 1, 1.5]) {
    const bad = fixture((r) => ({ id: r.id, kind: "INFO", session: SESSION, size, sha256: "0".repeat(64), format: "ZIP" }));
    await assert.rejects(receivePackage(bad.io, { digest }), /有效的安装包信息/); assert.equal(bad.calls.filter((r) => r.operation === "READ").length, 0);
  }
});
test("SHA mismatch refuses completion and cancellation cannot become success", async () => {
  const f = fixture(); await assert.rejects(receivePackage(f.io, { digest: async () => new Uint8Array(32) }), /SHA-256 不一致/);
  for (const when of ["before", "reply", "prefix", "digest", "cleanup"]) {
    const abort = new AbortController(); if (when === "before") abort.abort();
    const c = fixture((r) => { if ((when === "reply" && r.operation === "READ") || (when === "cleanup" && r.operation === "CANCEL")) abort.abort(); });
    await assert.rejects(receivePackage(c.io, { signal: abort.signal,
      onProgress: () => { if (when === "prefix") abort.abort(); }, digest: async (bytes) => { if (when === "digest") abort.abort(); return digest(bytes); } }), /已取消/);
    const reads = c.calls.filter((r) => r.operation === "READ"); if (["reply", "prefix"].includes(when)) assert.equal(reads.length, 1);
  }
});
test("total deadline refuses any further reads", async () => {
  let now = 0; const f = fixture((r) => { if (r.operation === "INFO") now = 180001; });
  await assert.rejects(receivePackage(f.io, { digest, now: () => now }), /三分钟/); assert.equal(f.calls.filter((r) => r.operation === "READ").length, 0);
});
function fakePort(onWrite, ids = { usbVendorId: 0x303a, usbProductId: 0x1001 }) {
  const port = { opened: 0, closed: 0, commands: [], getInfo: () => ids,
    async open(options) { this.opened++; this.options = options; this.readable = new ReadableStream({ start: (c) => { this.controller = c; }, cancel: () => { this.cancelled = true; } });
      this.writable = new WritableStream({ write: async (data) => { const text = new TextDecoder().decode(data); this.commands.push(text); await onWrite?.(text, this); } }); },
    async close() { assert(!this.readable?.locked && !this.writable?.locked); this.closed++; },
    setSignals() { assert.fail("No modem/reset signals may be written"); },
    push(text) { if (!this.cancelled) this.controller.enqueue(new TextEncoder().encode(text)); } };
  return port;
}
test("actual Web Streams pump ignores logs/old ids, times out then cleans both locks", async () => {
  const port = fakePort((text, p) => { const id = Number(text.split(" ")[1]); if (id === 1) p.push(`boot log\nQDDDRV/1 99 OK\nQDDDRV/1 ${id} OK\n`); });
  const link = new SerialLink(port); await link.open(); assert.equal((await link.exchange({ id: 1, operation: "INFO" })).id, 1);
  await assert.rejects(link.exchange({ id: 2, operation: "INFO" }, { timeoutMs: 10 }), /超时/);
  await link.close(); await link.close(); assert.equal(port.closed, 1); assert.equal(port.options.flowControl, "none");
});
test("stream abort/disconnect/writer failure release resources and never replay", async () => {
  for (const mode of ["abort", "disconnect", "writer"]) {
    const controller = new AbortController();
    const port = fakePort((_, p) => { if (mode === "writer") throw new Error("fixture writer"); if (mode === "disconnect") p.controller.close(); });
    const link = new SerialLink(port); await link.open(); const pending = link.exchange({ id: 1, operation: "INFO" }, { signal: controller.signal });
    if (mode === "abort") controller.abort();
    await assert.rejects(pending); await link.close(); assert.equal(port.closed, 1); assert.equal(port.commands.length, 1);
  }
});
test("wrong device is never opened and late-open cancellation closes it", async () => {
  const wrong = fakePort(null, { usbVendorId: 1, usbProductId: 0x1001 }); await assert.rejects(new SerialLink(wrong).open(), /未打开/); assert.equal(wrong.opened, 0);
  let finish; const controller = new AbortController(); const port = fakePort(); const originalOpen = port.open.bind(port);
  port.open = async (options) => { await new Promise((r) => { finish = r; }); await originalOpen(options); };
  const link = new SerialLink(port), opening = link.open(controller.signal); controller.abort(); await link.close(); finish();
  await assert.rejects(opening, /已取消/); assert.equal(port.closed, 1);
});
test("partial open writer-lock failure releases acquired reader exactly once", async () => {
  const port = fakePort(), originalOpen = port.open.bind(port);
  port.open = async (options) => { await originalOpen(options); port.writable = { getWriter() { throw new Error("fixture writer lock"); } }; };
  const link = new SerialLink(port); await assert.rejects(link.open(), /writer lock/);
  await link.close(); await link.close(); assert.equal(port.readable.locked, false); assert.equal(port.closed, 1);
});
function fakePage(secure, serial, protocol = "file:") {
  const elements = {}, listeners = {}, saved = [], revoked = [];
  const element = (id) => ({ id, textContent: "", hidden: false, disabled: false, events: {}, setAttribute(name, value) { this[name] = value; }, addEventListener(type, cb) { this.events[type] = cb; }, async click() { return this.events.click?.(); }, remove() {} });
  const document = { getElementById(id) { return elements[id] ||= element(id); }, createElement() { const a = element("anchor"); a.click = () => saved.push({ url: a.href, download: a.download }); return a; }, body: { append() {} } };
  const window = { isSecureContext: secure, crypto: webcrypto, location: { protocol }, URL: { createObjectURL: () => `blob:fixture-${saved.length}`, revokeObjectURL: (url) => revoked.push(url) }, addEventListener: (type, cb) => { listeners[type] = cb; } };
  initReceiver(document, { serial }, window); return { elements, listeners, saved, revoked };
}
test("HTTP state stays at preparation and links home only when hosted; unsupported cannot advance", async () => {
  let requested = 0; const serial = { requestPort() { requested++; }, addEventListener() {} };
  const http = fakePage(false, serial, "http:"); assert(http.elements.connect.disabled); assert(!http.elements.offline.hidden); assert.match(http.elements.environment.textContent, /保存接收页/); assert.equal(requested, 0);
  assert.equal(http.elements.home.href, "/"); assert(!http.elements.home.hidden); assert(http.elements.next.disabled);
  await http.elements.next.click(); await http.elements.connect.click(); assert(!http.elements["step-1"].hidden); assert.equal(requested, 0);
  const absent = fakePage(true, undefined); assert(absent.elements.connect.disabled); assert(absent.elements.offline.hidden); assert.match(absent.elements.environment.textContent, /Chrome/);
  assert(absent.elements.home.hidden); assert.equal(absent.elements.home.href, undefined); assert(absent.elements.next.disabled);
});

test("wizard navigation never opens a port and cannot skip to saving", async () => {
  let requested = 0; const serial = { requestPort() { requested++; }, addEventListener() {} };
  const page = fakePage(true, serial), el = page.elements;
  assert(!el["step-1"].hidden); assert(el.previous.disabled); assert(!el.next.disabled);
  await el.connect.click(); assert.equal(requested, 0);
  await el.next.click(); assert(!el["step-2"].hidden); assert(el.next.disabled); assert(!el.previous.disabled);
  await el.next.click(); await el.save.click(); assert(el["step-3"].hidden); assert.equal(page.saved.length, 0);
  await el.previous.click(); assert(!el["step-1"].hidden); assert.equal(requested, 0);
});

test("active transfer blocks step changes until cancellation completes", async () => {
  let select;
  const serial = { requestPort: () => new Promise((resolve) => { select = resolve; }), addEventListener() {} };
  const page = fakePage(true, serial), el = page.elements;
  await el.next.click(); const receive = el.connect.click(); assert(el.previous.disabled && el.next.disabled);
  await el.previous.click(); await el.next.click(); assert(!el["step-2"].hidden);
  await el.cancel.click(); select(fakePort()); await receive;
  assert(!el.previous.disabled); assert(el.next.disabled); assert(el.save.disabled); assert.equal(page.saved.length, 0);
  await el.previous.click(); assert(!el["step-1"].hidden);
});
test("actual DOM controller only exposes save after SHA, closes port, repeat save and pagehide revoke", async () => {
  const f = fixture();
  const port = fakePort((text, p) => { const parts = text.trim().split(" "), id = Number(parts[1]);
    if (parts[2] === "INFO") p.push(`QDDDRV/1 ${id} INFO ${SESSION} ${f.bytes.length} ${sha(f.bytes)} ZIP\n`);
    else if (parts[2] === "READ") p.push(dataFrame(id, f.bytes.slice(Number(parts[4]), Number(parts[4]) + Number(parts[5])), Number(parts[4])) + "\n");
    else p.push(`QDDDRV/1 ${id} OK\n`);
  });
  const serial = { async requestPort(options) { assert.deepEqual(options.filters, [{ usbVendorId: 0x303a, usbProductId: 0x1001 }]); return port; }, addEventListener() {} };
  const page = fakePage(true, serial); assert.equal(page.saved.length, 0); await page.elements.next.click(); await page.elements.connect.click();
  assert.equal(port.closed, 1); assert(!page.elements.save.disabled); assert.match(page.elements.status.textContent, /校验成功/); assert.equal(page.saved.length, 0);
  assert(!page.elements["step-2"].hidden); await page.elements.save.click(); assert.equal(page.saved.length, 0);
  await page.elements.next.click(); assert(!page.elements["step-3"].hidden); assert(page.elements.next.hidden);
  await page.elements.previous.click(); assert(!page.elements["step-2"].hidden); await page.elements.next.click();
  await page.elements.save.click(); await page.elements.save.click(); assert.equal(page.saved.length, 2); assert.equal(page.saved[0].download, "设备操作台.zip");
  assert.match(page.elements.status.textContent, /已发起保存.*确认文件/); assert.doesNotMatch(page.elements.status.textContent, /已安装/);
  page.listeners.pagehide(); assert.equal(page.revoked.length, 2);
});
test("built artifact is deterministic self-contained and its actual minified parser matches source", async () => {
  const { bytes, manifest } = await prepareUsbReceiver(); const again = await prepareUsbReceiver(); assert.deepEqual(bytes, again.bytes);
  assert.equal(sha(bytes), manifest.sha256); assert.equal(manifest.sourceInputs.length, 5); assert(bytes.length <= 131072);
  const html = bytes.toString("utf8"); auditHtml(html); assert(html.includes('href="/qdd-usb-receiver.html"')); assert(!html.includes("__QDD_USB_"));
  for (const mutation of [html.replace("<script>", '<script src="https://example.invalid/a.js">'), html + "<iframe></iframe>", html + "fetch('/a')", html.replace('href="/qdd-usb-receiver.html"', 'href="https://example.invalid/"')]) assert.throws(() => auditHtml(mutation));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]; assert.equal(scripts.length, 1);
  const context = vm.createContext({ TextEncoder, Uint8Array, performance, setTimeout, clearTimeout, AbortController }); vm.runInContext(scripts[0][1], context);
  const compiled = context.QddUsbReceiver;
  const frame = dataFrame(42, new Uint8Array([1, 2, 3])); assert.equal(compiled.parseReply(frame).id, 42);
  assert.equal(compiled.parseReply(frame.replace(/ [0-9a-f]{8} /, " 00000000 ")), null);
});

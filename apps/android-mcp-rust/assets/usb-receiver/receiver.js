export const LIMITS = Object.freeze({ line: 2304, size: 2093056, block: 1024, requestMs: 4000, totalMs: 180000, attempts: 3 });
const SESSION = /^[0-9a-f]{16}$/;
const SHA = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
export class ReceiverError extends Error {
  constructor(code, message) { super(message); this.name = "ReceiverError"; this.code = code; }
}
const fail = (code, message) => { throw new ReceiverError(code, message); };
const cancelled = () => new ReceiverError("CANCELLED", "已取消接收，未保存不完整文件。");
const cancellation = (signal) => signal?.reason instanceof ReceiverError ? signal.reason : cancelled();
const validSession = (value) => SESSION.test(value) && value !== "0000000000000000";
function integer(value, maximum = 0xffffffff) { return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= maximum ? Number(value) : null; }
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function parseReply(line) {
  if (typeof line !== "string" || !line.length || line.length >= LIMITS.line || /[^\x20-\x7e]/.test(line)) return null;
  const p = line.split(" ");
  if (p.some((part) => !part) || p[0] !== "QDDDRV/1") return null;
  const id = integer(p[1]);
  if (!id) return null;
  if (p.length === 3 && p[2] === "OK") return { id, kind: "OK" };
  if (p.length === 4 && p[2] === "ERR" && /^[A-Z][A-Z0-9_]{0,31}$/.test(p[3])) return { id, kind: "ERR", error: p[3] };
  if (!validSession(p[3])) return null;
  if (p.length === 7 && p[2] === "INFO" && p[6] === "ZIP") {
    const size = integer(p[4], LIMITS.size);
    return size && SHA.test(p[5]) ? { id, kind: "INFO", session: p[3], size, sha256: p[5], format: "ZIP" } : null;
  }
  if (p.length !== 8 || p[2] !== "DATA") return null;
  const offset = integer(p[4]), length = integer(p[5], LIMITS.block);
  if (offset === null || !length || offset > LIMITS.size - length || !/^[0-9a-f]{8}$/.test(p[6]) ||
      p[7].length !== length * 2 || !/^[0-9a-f]+$/.test(p[7])) return null;
  const data = new Uint8Array(length);
  for (let index = 0; index < length; index++) data[index] = Number.parseInt(p[7].slice(index * 2, index * 2 + 2), 16);
  if (crc32(data) !== Number.parseInt(p[6], 16)) return null;
  return { id, kind: "DATA", session: p[3], offset, length, data };
}
export class LineDecoder {
  constructor() { this.line = ""; this.discard = false; }
  feed(bytes, onLine) {
    for (const byte of bytes) {
      if (byte === 10) {
        if (!this.discard) onLine(this.line.endsWith("\r") ? this.line.slice(0, -1) : this.line);
        this.line = ""; this.discard = false;
      } else if (!this.discard) {
        if (!byte || this.line.length + 1 >= LIMITS.line) { this.line = ""; this.discard = true; }
        else this.line += String.fromCharCode(byte);
      }
    }
  }
}
export function requestLine(request) {
  const { id, operation, session, offset, length } = request;
  if (!Number.isInteger(id) || id < 1 || id > 0xffffffff) fail("PROTOCOL", "请求编号无效。");
  if (operation === "INFO") return `QDDDRV/1 ${id} INFO\n`;
  if (!validSession(session)) fail("PROTOCOL", "USB 会话无效。");
  if (operation === "CANCEL") return `QDDDRV/1 ${id} CANCEL ${session}\n`;
  if (operation !== "READ" || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) ||
      length < 1 || length > LIMITS.block || offset > LIMITS.size - length) fail("PROTOCOL", "只读区间无效。");
  return `QDDDRV/1 ${id} READ ${session} ${offset} ${length}\n`;
}
export function makeIds(seed = 1) { let id = seed >>> 0; return () => { id = (id + 1) >>> 0; if (!id) id = 1; return id; }; }
export function environmentMessage(serial, secure) {
  if (!secure) return "先点击“保存接收页”，再打开保存的文件。";
  if (!serial) return "请用电脑 Chrome 或 Edge 打开保存的接收页。";
  return "接收页已准备好，点击“下一步”连接设备。";
}
function deviceError(code) {
  const messages = { CONTROL_BUSY: "请退出电脑控制后重试；暂停不一定释放已有控制连接。", BUSY: "设备正忙，请稍后重试。",
    ASSET_ERROR: "设备安装包缺失或校验失败，已拒绝保存。", STALE_SESSION: "USB 会话已失效，请重新接收。",
    BAD_RANGE: "设备拒绝了读取区间，已停止接收。", IO_ERROR: "USB 读取失败，请检查数据线后重试。", USB_ONLY: "此通道只允许 USB 连接。" };
  return new ReceiverError(code, messages[code] || `设备拒绝请求（${code}），未保存文件。`);
}
export class SerialLink {
  constructor(port) { this.port = port; this.decoder = new LineDecoder(); this.pending = null; this.closing = false; this.opened = false; this.readTask = null; this.writes = new Set(); }
  async open(signal) {
    const info = this.port.getInfo();
    if (info.usbVendorId !== 0x303a || info.usbProductId !== 0x1001) fail("DEVICE", "所选串口不是匹配的设备，未打开。");
    if (signal?.aborted) throw cancellation(signal);
    await this.port.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none", bufferSize: 4096 });
    this.opened = true;
    if (this.closing || signal?.aborted) { await this.port.close(); this.opened = false; throw cancellation(signal); }
    this.reader = this.port.readable.getReader(); this.writer = this.port.writable.getWriter();
    this.readTask = this.readLoop();
  }
  async readLoop() {
    try {
      while (!this.closing) {
        const { value, done } = await this.reader.read();
        if (done) { if (!this.closing) fail("DISCONNECTED", "设备已断开，未保存不完整文件。"); break; }
        if (!(value instanceof Uint8Array) || value.length > 65536) fail("PROTOCOL", "串口数据块异常，已停止。");
        this.decoder.feed(value, (line) => {
          const reply = parseReply(line);
          if (reply && this.pending?.id === reply.id) this.pending.finish(null, reply);
        });
      }
    } catch (error) { this.failure = error instanceof ReceiverError ? error : new ReceiverError("DISCONNECTED", "USB 读取已中断，请检查数据线后重新接收。"); this.pending?.finish(this.failure); }
    finally { this.reader.releaseLock(); this.reader = null; }
  }
  exchange(request, { signal, timeoutMs = LIMITS.requestMs } = {}) {
    if (this.closing || !this.opened || this.failure || !this.writer) return Promise.reject(this.failure || new ReceiverError("DISCONNECTED", "USB 串口已关闭。"));
    if (this.pending) return Promise.reject(new ReceiverError("BUSY", "已有读取请求，不能并发接收。"));
    if (signal?.aborted) return Promise.reject(cancellation(signal));
    const bytes = encoder.encode(requestLine(request));
    return new Promise((resolve, reject) => {
      const abort = () => finish(cancellation(signal));
      const timer = setTimeout(() => finish(new ReceiverError("TIMEOUT", "等待设备回复超时。")), timeoutMs);
      const finish = (error, reply) => {
        if (this.pending?.finish !== finish) return;
        clearTimeout(timer); signal?.removeEventListener("abort", abort); this.pending = null;
        if (error) reject(error); else resolve(reply);
      };
      this.pending = { id: request.id, finish }; signal?.addEventListener("abort", abort, { once: true });
      const writing = this.writer.write(bytes);
      this.writes.add(writing);
      writing.catch((error) => finish(new ReceiverError("IO", `USB 写入失败：${String(error.message || error).slice(0, 100)}`))).finally(() => this.writes.delete(writing));
    });
  }
  async close() {
    if (this.closeTask) return this.closeTask;
    this.closeTask = (async () => {
      this.closing = true; this.pending?.finish(cancelled());
      if (this.reader) await this.reader.cancel().catch(() => {});
      await this.readTask;
      // Writer acquisition can fail after the reader was locked, before the
      // read-loop promise exists. That partial-open reader still belongs here.
      if (!this.readTask && this.reader) { this.reader.releaseLock(); this.reader = null; }
      if (this.writer) {
        if (this.writes.size) await this.writer.abort().catch(() => {});
        await Promise.allSettled([...this.writes]); this.writer.releaseLock(); this.writer = null;
      }
      if (this.opened) { await this.port.close(); this.opened = false; }
    })();
    return this.closeTask;
  }
}
export async function receivePackage(io, { signal, nextId = makeIds(), now = () => performance.now(), digest = (bytes) => crypto.subtle.digest("SHA-256", bytes), onProgress = () => {}, onVerifying = () => {} } = {}) {
  const started = now(), deadline = started + LIMITS.totalMs;
  let session = "", info, bytes, recovered = false, readRequests = 0;
  const guard = () => { if (signal?.aborted) throw cancellation(signal); if (now() >= deadline) fail("TIMEOUT", "接收超过三分钟，已停止且未保存。 "); };
  const query = async (operation, offset = 0, length = 0) => {
    guard(); const id = nextId();
    const reply = await io.exchange({ operation, id, session, offset, length }, { signal, timeoutMs: Math.min(LIMITS.requestMs, deadline - now()) });
    return reply?.id === id ? reply : null;
  };
  const timed = async (...args) => { try { return await query(...args); } catch (error) { if (error.code === "TIMEOUT") { guard(); return null; } throw error; } };
  try {
    for (let attempt = 0; attempt < LIMITS.attempts; attempt++) {
      const reply = await timed("INFO");
      if (reply?.kind === "INFO") { session = reply.session; info = reply; guard(); break; }
      if (reply?.kind === "ERR" && !["BUSY", "IO_ERROR"].includes(reply.error)) throw deviceError(reply.error);
    }
    if (!info || !validSession(session) || !Number.isInteger(info.size) || info.size < 1 || info.size > LIMITS.size || !SHA.test(info.sha256) || info.format !== "ZIP") fail("PROTOCOL", "没有收到有效的安装包信息。");
    bytes = new Uint8Array(info.size);
    let offset = 0;
    while (offset < info.size) {
      const length = Math.min(LIMITS.block, info.size - offset);
      let accepted = false;
      for (let attempt = 0; attempt < LIMITS.attempts; attempt++) {
        readRequests++; const reply = await timed("READ", offset, length);
        if (reply?.kind === "ERR" && ["STALE_SESSION", "IO_ERROR"].includes(reply.error) && !recovered) {
          recovered = true; guard(); const fresh = await query("INFO");
          if (fresh?.kind !== "INFO" || !validSession(fresh.session)) fail("PROTOCOL", "USB 会话恢复失败，未保存文件。");
          session = fresh.session; guard();
          if (fresh.size !== info.size || fresh.sha256 !== info.sha256 || fresh.format !== "ZIP") fail("VERSION", "安装包版本已改变，已停止，不能拼接不同版本。");
          continue;
        }
        if (reply?.kind === "ERR" && reply.error !== "BUSY") throw deviceError(reply.error);
        guard();
        if (reply?.kind !== "DATA" || reply.session !== session || reply.offset !== offset || reply.length !== length ||
            !(reply.data instanceof Uint8Array) || reply.data.length !== length) continue;
        bytes.set(reply.data, offset); offset += length; accepted = true;
        onProgress({ received: offset, total: info.size, elapsedMs: Math.max(1, now() - started), readRequests });
        break;
      }
      if (!accepted) fail("PROTOCOL", "当前数据块重试耗尽，未保存不完整文件。");
    }
    guard(); onVerifying(); const hash = new Uint8Array(await digest(bytes)); guard();
    const sha256 = [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (sha256 !== info.sha256) fail("SHA", "完整 SHA-256 不一致，已拒绝保存，请检查 USB 后重试。");
    return { bytes, sha256, readRequests, durationMs: now() - started };
  } finally {
    if (session && validSession(session)) {
      try { await io.exchange({ operation: "CANCEL", id: nextId(), session }, { timeoutMs: 500 }); } catch { /* Best-effort read-session cleanup; port closes independently. */ }
    }
    if (signal?.aborted) { bytes?.fill(0); throw cancellation(signal); }
  }
}
export function initReceiver(document, navigator, window) {
  const el = Object.fromEntries(["connect", "cancel", "save", "status", "progress", "amount", "speed", "verification", "hash", "environment", "offline", "home", "previous", "next", "step-label", "step-1", "step-2", "step-3"].map((id) => [id, document.getElementById(id)]));
  const supported = !!navigator.serial && window.isSecureContext && !!window.crypto?.subtle;
  el.environment.textContent = environmentMessage(navigator.serial, window.isSecureContext);
  if (!window.crypto?.subtle && window.isSecureContext) el.environment.textContent = "请更新电脑 Chrome 或 Edge 后，重新打开保存的接收页。";
  el.connect.disabled = !supported;
  el.offline.hidden = window.location.protocol === "file:";
  const hosted = ["http:", "https:"].includes(window.location.protocol);
  el.home.hidden = !hosted;
  if (hosted) el.home.setAttribute("href", "/");
  let active = null, verified = null, step = 1;
  const refreshSteps = () => {
    for (let index = 1; index <= 3; index++) el[`step-${index}`].hidden = index !== step;
    el["step-label"].textContent = `第 ${step} 步 / 共 3 步`;
    el.previous.disabled = step === 1 || !!active;
    el.next.hidden = step === 3;
    el.next.disabled = !!active || (step === 1 ? !supported : !verified);
  };
  el.previous.addEventListener("click", () => { if (!active && step > 1) { step--; refreshSteps(); } });
  el.next.addEventListener("click", () => {
    if (active || step === 3 || (step === 1 ? !supported : !verified)) return;
    step++; refreshSteps();
    el.status.textContent = step === 2 ? (verified ? "安装包已接收，可继续下一步保存。" : "点击“选择设备并接收”开始。") : "请保存安装包，然后解压打开。";
  });
  refreshSteps();
  const seed = new Uint32Array(1); window.crypto?.getRandomValues(seed); const nextId = makeIds(seed[0]);
  const urls = new Map();
  function clearUrls() { for (const [url, timer] of urls) { clearTimeout(timer); window.URL.revokeObjectURL(url); } urls.clear(); }
  function clearResult() { clearUrls(); verified = null; el.save.hidden = true; el.save.disabled = true; el.save.textContent = "保存安装包"; el.hash.textContent = ""; }
  el.cancel.addEventListener("click", () => active?.controller.abort());
  el.connect.addEventListener("click", async () => {
    if (active || !supported || step !== 2) return;
    clearResult(); const job = { controller: new AbortController(), link: null }; active = job;
    refreshSteps();
    el.connect.disabled = true; el.cancel.disabled = false; el.progress.value = 0; el.amount.textContent = "0 / 0 字节"; el.speed.textContent = "0 KB/s";
    el.status.textContent = "请在弹出的列表中选择设备…"; el.verification.textContent = "每块 CRC32 检查，完整 SHA-256 一致后才允许保存。";
    let cleanupFailed = false;
    try {
      const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x303a, usbProductId: 0x1001 }] });
      job.link = new SerialLink(port); await job.link.open(job.controller.signal);
      el.status.textContent = "正在读取安装包信息…";
      let lastPaint = -Infinity;
      const result = await receivePackage(job.link, { signal: job.controller.signal, nextId,
        digest: (bytes) => window.crypto.subtle.digest("SHA-256", bytes),
        onProgress: ({ received, total, elapsedMs }) => {
          const now = performance.now(); if (now - lastPaint < 100 && received !== total) return; lastPaint = now;
          el.status.textContent = "正在通过 USB 接收…"; el.progress.value = received / total * 100;
          el.amount.textContent = `${received.toLocaleString()} / ${total.toLocaleString()} 字节`;
          el.speed.textContent = `${(received / elapsedMs).toFixed(1)} KB/s`;
        }, onVerifying: () => { el.status.textContent = "正在检查安装包…"; } });
      if (job.controller.signal.aborted) throw cancellation(job.controller.signal);
      verified = result; el.hash.textContent = `SHA-256 ${result.sha256}`;
      el.status.textContent = "接收并校验成功，请点击“下一步”保存。"; el.verification.textContent = "完整 SHA-256 一致。";
    } catch (error) {
      clearResult(); el.status.textContent = error.name === "NotFoundError" ? "未选择串口，可以重新选择。" : String(error.message || error).slice(0, 220);
      el.verification.textContent = "没有保存不完整或未通过校验的文件。";
    } finally {
      try { await job.link?.close(); } catch { cleanupFailed = true; clearResult(); el.status.textContent = "串口关闭失败。请拔插设备并关闭此页后重试。"; }
      if (active === job) { active = cleanupFailed ? job : null; el.cancel.disabled = true; el.connect.disabled = !supported || cleanupFailed; el.connect.textContent = "重新选择并接收";
        el.save.hidden = !verified; el.save.disabled = !verified; refreshSteps(); }
    }
  });
  el.save.addEventListener("click", () => {
    if (!verified || active || step !== 3) return;
    clearUrls(); const url = window.URL.createObjectURL(new Blob([verified.bytes], { type: "application/zip" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "设备操作台.zip"; document.body.append(anchor); anchor.click(); anchor.remove();
    el.save.textContent = "再次保存安装包";
    el.status.textContent = "已发起保存，请在浏览器下载列表中确认文件。";
    urls.set(url, setTimeout(() => { if (urls.delete(url)) window.URL.revokeObjectURL(url); }, 10000));
  });
  window.addEventListener("pagehide", () => { clearUrls(); active?.controller.abort(); void active?.link?.close().catch(() => {}); });
  navigator.serial?.addEventListener("disconnect", (event) => { if (active?.link?.port === event.target || active?.link?.port === event.port) active.controller.abort(new ReceiverError("DISCONNECTED", "USB 设备已断开，请检查数据线后重新选择。")); });
}
if (typeof document !== "undefined" && typeof navigator !== "undefined") initReceiver(document, navigator, window);

"use strict";

// Realtime reports and lease pings share one socket outside the HTTP/1 request pool.
// A new explicit picture click creates a new channel; disconnected input is never replayed.
globalThis.QddRemoteChannel = class {
  constructor(path, sessionId, round) {
    const url = new URL(path, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(url.href);
    this.round = round;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    this.connected = false;
    this.nextSequence = 1;
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.helloDeadline = setTimeout(() => this.fail(new Error("鼠标键盘连接超时，请点击画面重新进入。")), 1000);
    this.socket.addEventListener("open", () => {
      if (this.closed) return;
      try { this.write({ type: "hello", sessionId, round }); } catch (error) { this.fail(error); }
    });
    this.socket.addEventListener("message", (event) => {
      if (this.closed) return;
      try {
        const data = JSON.parse(event.data);
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("鼠标键盘连接返回了无效消息。");
        if (data.type === "error") throw new Error(typeof data.message === "string" ? data.message : "鼠标键盘连接已中断。");
        if (!this.connected) {
          if (data.type !== "ready" || data.round !== this.round) throw new Error("远控连接已更新，请点击画面重新进入。");
          clearTimeout(this.helloDeadline);
          this.connected = true;
          this.resolveReady();
          return;
        }
        if (data.type === "pong") { clearTimeout(this.pongDeadline); this.pongDeadline = null; return; }
        const task = this.pending.get(data.sequence);
        if (data.type !== "ack" || !task || !data.state || typeof data.state !== "object" || Array.isArray(data.state)) {
          throw new Error("鼠标键盘操作确认不匹配，输入已停止。");
        }
        this.pending.delete(data.sequence);
        clearTimeout(task.deadline); task.removeAbort(); task.resolve(data.state);
      } catch (error) { this.fail(error); }
    });
    this.socket.addEventListener("error", () => this.fail(new Error("鼠标键盘连接已中断，请点击画面重新进入。")));
    this.socket.addEventListener("close", () => {
      if (!this.closed) this.fail(new Error("鼠标键盘连接已断开，请点击画面重新进入。"));
    });
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  write(data) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 16 * 1024) {
      throw new Error("鼠标键盘连接不可用，输入已停止。");
    }
    this.socket.send(JSON.stringify(data));
  }

  ping() {
    if (!this.connected || this.closed) return;
    try {
      this.write({ type: "ping" });
      if (!this.pongDeadline) this.pongDeadline = setTimeout(() => this.fail(new Error("鼠标键盘连接没有及时响应，输入已停止。")), 900);
    } catch (error) { this.fail(error); }
  }

  send(sequence, report, signal) {
    if (this.closed || !this.connected || signal?.aborted) return Promise.reject(new Error("HID operation cancelled."));
    if (sequence !== this.nextSequence || this.pending.size >= 4) return Promise.reject(new Error("Realtime input is outside its ordered window."));
    this.nextSequence++;
    return new Promise((resolve, reject) => {
      const abort = () => this.fail(new Error("HID operation cancelled."));
      const deadline = setTimeout(() => this.fail(new Error("鼠标键盘操作未及时确认，已停止输入且不会重发。")), 1500);
      this.pending.set(sequence, { resolve, reject, deadline, removeAbort: () => signal?.removeEventListener("abort", abort) });
      signal?.addEventListener("abort", abort, { once: true });
      try { this.write({ type: "report", sequence, report }); }
      catch (error) { this.fail(error); }
    });
  }

  finish(error, notify) {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    clearTimeout(this.helloDeadline); clearTimeout(this.pongDeadline);
    this.rejectReady(error);
    for (const task of this.pending.values()) { clearTimeout(task.deadline); task.removeAbort(); task.reject(error); }
    this.pending.clear();
    if (this.socket.readyState === WebSocket.OPEN) {
      try { this.socket.send(JSON.stringify({ type: "stop" })); } catch { /* Server closes and watchdogs also release. */ }
    }
    try { this.socket.close(); } catch { /* A failed handshake is already closed. */ }
    if (notify) for (const listener of this.listeners.get("error") ?? []) listener({ error });
  }

  fail(error) { this.finish(error instanceof Error ? error : new Error(String(error)), true); }
  close() { this.finish(new Error("HID operation cancelled."), false); }
};

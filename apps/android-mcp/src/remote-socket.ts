import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { InputState, RemoteReport } from "./input.js";
import { privateRequest } from "./lan.js";

export interface RemoteSocketBinding {
  sessionId: string;
  round: string;
  inputEpoch: number;
}
export interface RemoteSocketHooks {
  bind(sessionId: string, round: string): RemoteSocketBinding;
  current(binding: RemoteSocketBinding): boolean;
  renew(binding: RemoteSocketBinding): void;
  report(binding: RemoteSocketBinding, report: RemoteReport, signal: AbortSignal): Promise<InputState>;
  release(binding: RemoteSocketBinding): void;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid remote socket message.");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Invalid remote socket message fields.");
}
function report(value: unknown): RemoteReport {
  const data = object(value);
  const number = (key: string, min: number, max: number) => {
    const value = data[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error("Invalid remote HID report.");
    return value;
  };
  if (data["kind"] === "mouse") {
    keys(data, ["kind", "dx", "dy", "wheel", "buttons"]);
    return { kind: "mouse", dx: number("dx", -127, 127), dy: number("dy", -127, 127),
      wheel: number("wheel", -127, 127), buttons: number("buttons", 0, 7) };
  }
  if (data["kind"] !== "key") throw new Error("Unsupported remote HID report.");
  keys(data, ["kind", "modifier", "keycode"]);
  return { kind: "key", modifier: number("modifier", 0, 255), keycode: number("keycode", 0, 255) };
}


/** A separate persistent socket keeps lease renewals outside the HTTP/1 request pool. */
export function attachRemoteSocket(server: Server, hooks: RemoteSocketHooks): { close(): Promise<void> } {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
  const owners = new Set<string>();
  const stops = new Map<WebSocket, () => void>();
  let disposed = false;
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (disposed || sockets.clients.size >= 16 || request.url !== "/remote/socket" || !privateRequest(request.headers.host, request.headers.origin, request.socket.remoteAddress)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (connection) => { sockets.emit("connection", connection); });
  };
  server.on("upgrade", onUpgrade);
  sockets.on("connection", (socket) => {
    let binding: RemoteSocketBinding | undefined;
    let ownerKey: string | undefined;
    let closed = false;
    let nextSequence = 1;
    const pending = new Map<number, { abort: AbortController; timer: NodeJS.Timeout }>();
    const helloTimeout = setTimeout(() => stop(new Error("Remote socket handshake timed out.")), 1000);
    helloTimeout.unref();
    const send = (data: Record<string, unknown>) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 64 * 1024) throw new Error("Remote socket receiver is too slow.");
      socket.send(JSON.stringify(data));
    };
    const stop = (error?: Error) => {
      if (closed) return;
      closed = true;
      clearTimeout(helloTimeout);
      for (const task of pending.values()) { clearTimeout(task.timer); task.abort.abort(error); }
      pending.clear();
      if (ownerKey) owners.delete(ownerKey);
      if (binding && hooks.current(binding)) hooks.release(binding);
      if (error) {
        try { send({ type: "error", message: error.message }); } catch { /* The owner has already released input. */ }
      }
      socket.close(error ? 1008 : 1000);
      const timer = setTimeout(() => socket.terminate(), 100);
      timer.unref();
    };
    stops.set(socket, () => stop());
    socket.once("close", () => { stop(); stops.delete(socket); });
    socket.once("error", (error) => stop(error));
    socket.on("message", (bytes, binary) => {
      if (closed) return;
      try {
        if (binary) throw new Error("Remote socket accepts JSON text only.");
        const data = object(JSON.parse(bytes.toString()));
        if (!binding) {
          keys(data, ["type", "sessionId", "round"]);
          if (data["type"] !== "hello" || typeof data["sessionId"] !== "string" || !data["sessionId"]
            || data["sessionId"].length > 256 || typeof data["round"] !== "string" || !data["round"] || data["round"].length > 128) {
            throw new Error("Connect the current operator round before sending input.");
          }
          const candidate = hooks.bind(data["sessionId"], data["round"]);
          const key = `${candidate.sessionId}:${candidate.round}:${candidate.inputEpoch}`;
          if (owners.has(key)) throw new Error("This remote round already has an input socket.");
          binding = candidate; ownerKey = key; owners.add(key);
          clearTimeout(helloTimeout);
          hooks.renew(binding);
          send({ type: "ready", round: binding.round });
          return;
        }
        if (!hooks.current(binding)) throw new Error("The remote control round has ended.");
        if (data["type"] === "ping") {
          keys(data, ["type"]);
          hooks.renew(binding);
          send({ type: "pong" });
          return;
        }
        if (data["type"] === "stop") { keys(data, ["type"]); stop(); return; }
        keys(data, ["type", "sequence", "report"]);
        const sequence = data["sequence"];
        if (data["type"] !== "report" || !Number.isSafeInteger(sequence) || sequence !== nextSequence || pending.size >= 4) {
          throw new Error("Remote report is outside its ordered four-report window.");
        }
        const value = report(data["report"]);
        nextSequence++;
        const controller = new AbortController();
        const timer = setTimeout(() => stop(new Error("Remote report acknowledgement timed out; input was not retried.")), 1500);
        timer.unref();
        pending.set(sequence as number, { abort: controller, timer });
        const active = binding;
        void hooks.report(active, value, controller.signal).then((state) => {
          if (closed || !hooks.current(active)) { stop(new Error("The remote control round has ended.")); return; }
          clearTimeout(timer); pending.delete(sequence as number);
          send({ type: "ack", sequence, state });
        }).catch((error: unknown) => stop(error instanceof Error ? error : new Error(String(error))));
      } catch (error) { stop(error instanceof Error ? error : new Error("Invalid remote socket request.")); }
    });
  });
  return {
    async close() {
      if (disposed) return;
      disposed = true;
      server.off("upgrade", onUpgrade);
      for (const [socket, stop] of stops) { stop(); socket.terminate(); }
      await new Promise<void>((resolve) => { sockets.close(() => resolve()); });
    },
  };
}

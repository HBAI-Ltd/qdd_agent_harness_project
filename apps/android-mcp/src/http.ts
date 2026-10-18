import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { performance } from "node:perf_hooks";
import type { IncomingMessage } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { ANDROID_TOOLS, createMcpServer } from "./mcp.js";
import type { AndroidTools } from "./mcp.js";
import type { LiveScreenSource } from "./live.js";
import type { InputState } from "./input.js";
import { MAX_SCREEN_FRAME_AGE_MS } from "./screen.js";
import { attachRemoteSocket } from "./remote-socket.js";
import type { RemoteSocketBinding } from "./remote-socket.js";
import { lanUrls, privateRequest } from "./lan.js";

async function assertPortAvailable(port: number): Promise<void> {
  if (port === 0) return;
  // Windows can allow a wildcard listener to overlap an existing interface-only
  // listener. Check TCP itself so unrelated, non-HTTP services are detected too.
  const hosts = [...new Set(["127.0.0.1", "::1", ...lanUrls(port).map((url) => new URL(url).hostname)
    .filter((host) => host !== "localhost")])];
  const occupied = await Promise.all(hosts.map(async (host) => {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host, port });
      let finished = false;
      const finish = (value: boolean) => {
        if (finished) return;
        finished = true;
        socket.destroy();
        resolve(value);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(300, () => finish(false));
    });
    return connected ? host : undefined;
  }));
  const address = occupied.find((host) => host !== undefined);
  if (address) throw Object.assign(new Error(`listen EADDRINUSE: address already in use ${address}:${port}`),
    { code: "EADDRINUSE", syscall: "listen", address, port });
}

async function body(request: IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const data of request) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    length += chunk.length;
    if (length > limit) throw new Error("Request body exceeds its size limit.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
export interface HttpMcpOptions {
  port?: number;
  liveScreen?: Pick<LiveScreenSource, "subscribe"> & Partial<Pick<LiveScreenSource, "getPreviewProfile" | "setPreviewProfile">>;
}
export async function startHttpMcp(tools: AndroidTools, options: HttpMcpOptions = {}): Promise<{ url: string; close(): Promise<void> }> {
  const port = options.port ?? 8790;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("HTTP port must be in 0..65535.");
  await assertPortAvailable(port);
  type Session = { mcp: ReturnType<typeof createMcpServer>; transport: StreamableHTTPServerTransport;
    calls: Map<string | number, AbortController> };
  const sessions = new Map<string, Session>();
  const active = new Set<Session>();
  let viewers = 0;
  let remoteOwner: string | undefined;
  let inputOwner: string | undefined;
  let remoteTimer: NodeJS.Timeout | undefined;
  let remoteGeneration = 0;
  let remoteInputEpoch: number | undefined;
  let remoteNextSequence = 1;
  let remoteGapTimer: NodeJS.Timeout | undefined;
  let remoteGapSequence: number | undefined;
  const remotePending = new Map<number, { launch(): void; reject(error: Error): void }>();
  const pause = () => { void tools.input.stop().catch(() => {}); };
  const clearRemote = () => {
    remoteGeneration++;
    clearTimeout(remoteGapTimer); remoteGapTimer = undefined;
    remoteGapSequence = undefined;
    remoteNextSequence = 1;
    for (const pending of remotePending.values()) pending.reject(new Error("Remote control round ended."));
    remotePending.clear();
    clearTimeout(remoteTimer); remoteTimer = undefined;
    remoteOwner = undefined; remoteInputEpoch = undefined;
  };
  const releaseRemote = () => { clearRemote(); pause(); };
  const renewRemote = () => {
    const generation = remoteGeneration, inputEpoch = remoteInputEpoch;
    clearTimeout(remoteTimer);
    remoteTimer = setTimeout(() => {
      if (generation !== remoteGeneration) return;
      if (inputEpoch === tools.input.controlEpoch) releaseRemote();
      else clearRemote();
    }, 900);
  };
  const assets: Record<string, { file: string; type: string }> = {
    "/": { file: "operator.html", type: "text/html; charset=utf-8" },
    "/operator.js": { file: "operator.js", type: "text/javascript; charset=utf-8" },
    "/screen-channel.js": { file: "screen-channel.js", type: "text/javascript; charset=utf-8" },
    "/remote-channel.js": { file: "remote-channel.js", type: "text/javascript; charset=utf-8" },
    "/operator.css": { file: "operator.css", type: "text/css; charset=utf-8" },
  };
  const server = createServer(async (request, response) => {
    const respond = (status: number, message: string) => {
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ error: message }));
    };
    if (!privateRequest(request.headers.host, request.headers.origin, request.socket.remoteAddress)) return respond(403, "Private LAN requests only.");
    if (request.headers.origin) {
      response.setHeader("Access-Control-Allow-Origin", request.headers.origin);
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, MCP-Protocol-Version, X-Remote-Round");
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, X-Remote-Round, X-Remote-Sequence",
        "Access-Control-Max-Age": "600", "Cache-Control": "no-store" });
      response.end(); return;
    }
    const asset = assets[request.url ?? ""];
    if (asset && request.method === "GET") {
      try {
        const bytes = await readFile(new URL(`../assets/${asset.file}`, import.meta.url));
        response.writeHead(200, {
          "Content-Type": asset.type, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' ws://${request.headers.host} wss://${request.headers.host}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
        });
        response.end(bytes);
      } catch { respond(503, "Operator panel assets are unavailable."); }
      return;
    }
    if (request.url === "/health" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      const urls = lanUrls((server.address() as { port: number }).port);
      response.end(JSON.stringify({ status: "ok", name: "qdd-android-hid", runtimeVersion: 9,
        operatorUrl: urls[0], mcpUrl: `${urls[0]}mcp`, lanUrls: urls }));
      return;
    }
    if (request.url === "/screen/profile") {
      const source = options.liveScreen;
      if (!source?.getPreviewProfile || !source.setPreviewProfile) return respond(503, "请更新手机投屏 App 后使用画质选择。");
      if (request.method !== "GET" && request.method !== "POST") return respond(405, "Use GET or POST.");
      let selected: "turbo" | "fast" | "standard" | "original" | undefined;
      if (request.method === "POST") {
        if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
          return respond(415, "画质设置需要 JSON 格式。");
        }
        try {
          const value = await body(request, 256);
          if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1
            || !("profile" in value) || typeof value.profile !== "string"
            || !["turbo", "fast", "standard", "original"].includes(value.profile)) {
            return respond(400, "请选择极速、快速、标准或原画。");
          }
          selected = value.profile as typeof selected;
        } catch { return respond(400, "画质设置格式不正确或内容过长。"); }
      }
      try {
        const result = selected ? await source.setPreviewProfile(selected) : await source.getPreviewProfile();
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify(result));
      } catch (error) { respond(502, error instanceof Error ? error.message : "手机暂时无法切换画质，请检查投屏连接。"); }
      return;
    }
    if (request.url === "/screen/events" && request.method === "GET") {
      if (!options.liveScreen) return respond(503, "Continuous screen stream is unavailable.");
      if (viewers >= 8) return respond(503, "Too many screen viewers.");
      viewers++;
      response.writeHead(200, {
        "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff",
      });
      response.flushHeaders();
      let closed = false;
      const unsubscribe = options.liveScreen.subscribe((frame) => {
        if (closed || response.writableLength > 0) return; // Drop new frames while a previous frame is still buffered.
        response.write(`event: frame\ndata: ${JSON.stringify({
          deviceSerial: frame.serial, sourceFrameId: frame.sourceFrameId, capturedAt: frame.capturedAt,
          width: frame.width, height: frame.height, rotation: frame.rotation ?? 0,
          deviceWidth: frame.deviceWidth ?? frame.width, deviceHeight: frame.deviceHeight ?? frame.height,
          previewProfile: frame.previewProfile ?? "original",
          frameAgeMs: frame.frameAgeMs, sentAt: Date.now(), mimeType: frame.mimeType, image: frame.png.toString("base64"),
        })}\n\n`);
      }, (error) => {
        pause();
        if (!closed && response.writableLength === 0) response.write(`event: unavailable\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
      });
      const heartbeat = setInterval(() => {
        if (!closed && response.writableLength === 0) response.write(": connected\n\n");
      }, 1000);
      response.once("close", () => { closed = true; viewers--; clearInterval(heartbeat); unsubscribe(); });
      return;
    }
    if (request.url === "/screen/stream" && request.method === "GET") {
      if (!options.liveScreen) return respond(503, "Continuous screen stream is unavailable.");
      if (viewers >= 8) return respond(503, "Too many screen viewers.");
      viewers++;
      request.socket.setNoDelay(true);
      response.writeHead(200, {
        "Content-Type": "application/x-qdd-screen", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", Connection: "keep-alive",
      });
      response.flushHeaders();
      let closed = false;
      let writing = false;
      let pending: { metadata: Record<string, unknown>; image: Buffer; queuedAt: number } | undefined;
      const flush = () => {
        if (closed || writing || !pending) return;
        const packet = pending;
        pending = undefined;
        let metadata = packet.metadata;
        if (metadata["type"] === "frame") {
          const age = metadata["frameAgeMs"];
          const queuedMs = Math.max(0, performance.now() - packet.queuedAt);
          if (typeof age !== "number" || !Number.isFinite(age) || age < 0 || age + queuedMs > MAX_SCREEN_FRAME_AGE_MS) return;
          metadata = { ...metadata, frameAgeMs: Math.ceil(age + queuedMs), sentAt: Date.now() };
        }
        const json = Buffer.from(JSON.stringify(metadata));
        const header = Buffer.allocUnsafe(8);
        header.writeUInt32BE(json.length, 0); header.writeUInt32BE(packet.image.length, 4);
        writing = true;
        response.cork();
        response.write(header); response.write(json); response.write(packet.image, (error) => {
          writing = false;
          if (error || closed) { pending = undefined; return; }
          flush();
        });
        response.uncork();
      };
      const write = (metadata: Record<string, unknown>, image: Buffer = Buffer.alloc(0)) => {
        if (closed) return;
        // One active write plus one latest pending record bounds memory. Preserve
        // source loss even if a recovery frame arrives before that loss is sent.
        if (pending?.metadata["type"] === "unavailable" && metadata["type"] !== "unavailable") return;
        pending = { metadata, image, queuedAt: performance.now() };
        flush();
      };
      const unsubscribe = options.liveScreen.subscribe((frame) => {
        write({ type: "frame", deviceSerial: frame.serial, sourceFrameId: frame.sourceFrameId,
          capturedAt: frame.capturedAt, width: frame.width, height: frame.height, rotation: frame.rotation ?? 0,
          deviceWidth: frame.deviceWidth ?? frame.width, deviceHeight: frame.deviceHeight ?? frame.height,
          previewProfile: frame.previewProfile ?? "original",
          frameAgeMs: frame.frameAgeMs, sentAt: Date.now(), mimeType: frame.mimeType }, frame.png);
      }, (error) => { pause(); write({ type: "unavailable", message: error.message }); });
      response.once("close", () => { closed = true; pending = undefined; viewers--; unsubscribe(); });
      return;
    }
    if (request.url === "/remote/lease") {
      const sessionId = request.headers["mcp-session-id"];
      if (typeof sessionId !== "string" || !sessions.has(sessionId)) return respond(400, "Connect the operator first.");
      if (request.method === "DELETE") {
        if (remoteOwner && remoteOwner !== sessionId) return respond(409, "Another operator is controlling the phone.");
        const round = request.headers["x-remote-round"];
        if (round !== undefined && round !== String(remoteGeneration)) return respond(409, "Old remote control round.");
        releaseRemote(); response.writeHead(204); response.end(); return;
      }
      if (request.method !== "POST") return respond(405, "Use POST or DELETE.");
      if (!tools.input.state.armed) return respond(409, "Start control explicitly first.");
      const inputEpoch = tools.input.controlEpoch;
      // MCP pause/re-arm also starts a new round, even without browser DELETE.
      if (remoteOwner && remoteInputEpoch !== inputEpoch) clearRemote();
      const round = request.headers["x-remote-round"];
      if (round !== undefined && round !== String(remoteGeneration)) return respond(409, "Old remote control round.");
      if (remoteOwner && remoteOwner !== sessionId) return respond(409, "Another operator is controlling the phone.");
      if (!remoteOwner) {
        remoteGeneration++;
        remoteOwner = sessionId; remoteInputEpoch = inputEpoch;
        inputOwner = sessionId;
      }
      const generation = remoteGeneration;
      renewRemote();
      response.writeHead(204, { "Cache-Control": "no-store", "X-Remote-Round": String(generation) }); response.end(); return;
    }
    if (request.url === "/remote/input" && request.method === "POST") {
      const sessionId = request.headers["mcp-session-id"];
      if (typeof sessionId !== "string" || !sessions.has(sessionId) || remoteOwner !== sessionId || !tools.input.state.armed) {
        return respond(409, "Start mouse control first.");
      }
      const generation = remoteGeneration;
      const inputEpoch = tools.input.controlEpoch;
      const sequenceHeader = request.headers["x-remote-sequence"];
      const roundHeader = request.headers["x-remote-round"];
      if (sequenceHeader !== undefined && roundHeader !== String(generation)) return respond(409, "Old remote control round.");
      const currentRound = () => remoteOwner === sessionId && remoteGeneration === generation
        && remoteInputEpoch === inputEpoch && tools.input.controlEpoch === inputEpoch;
      response.once("close", () => { if (!response.writableFinished && currentRound()) releaseRemote(); });
      try {
        const value = await body(request, 1024);
        // The same session may have paused and explicitly acquired control again
        // while body() awaited bytes. Its old report belongs to the old round.
        if (!currentRound() || !tools.input.state.armed) return respond(409, "Mouse control has paused.");
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid remote report.");
        const report = value as Record<string, unknown>;
        const read = (key: string, min: number, max: number) => {
          const number = report[key];
          if (typeof number !== "number" || !Number.isInteger(number) || number < min || number > max) throw new Error("Invalid remote report.");
          return number;
        };
        const kind = report["kind"];
        const allowed = kind === "mouse" ? ["kind", "dx", "dy", "wheel", "buttons"]
          : kind === "pointer" ? ["kind", "x", "y", "width", "height", "rotation", "deviceSerial", "buttons", "wheel"]
          : ["kind", "modifier", "keycode"];
        if (Object.keys(report).some((key) => !allowed.includes(key))) throw new Error("Invalid remote report.");
        let state: InputState | undefined;
        const realtime = (launch: () => Promise<InputState>) => {
          if (typeof sequenceHeader !== "string" || !/^[1-9]\d{0,9}$/u.test(sequenceHeader)) throw new Error("Invalid remote sequence.");
          const sequence = Number(sequenceHeader);
          if (sequence < remoteNextSequence || sequence >= remoteNextSequence + 4 || remotePending.has(sequence)) throw new Error("Remote report is outside its ordered window.");
          const result = new Promise<InputState>((resolve, reject) => {
            remotePending.set(sequence, { launch: () => { try { void launch().then(resolve, reject); } catch (error) { reject(error as Error); } }, reject });
          });
          for (;;) {
            const next = remotePending.get(remoteNextSequence);
            if (!next) break;
            remotePending.delete(remoteNextSequence++); next.launch();
          }
          if (!remotePending.size || remoteGapSequence !== remoteNextSequence) {
            clearTimeout(remoteGapTimer); remoteGapTimer = undefined; remoteGapSequence = undefined;
            if (remotePending.size) {
              remoteGapSequence = remoteNextSequence;
              remoteGapTimer = setTimeout(() => { if (currentRound()) releaseRemote(); }, 500);
            }
          }
          return result;
        };
        if (kind === "pointer") {
          const width = read("width", 1, 0x7fffffff), height = read("height", 1, 0x7fffffff);
          const x = read("x", 0, width - 1), y = read("y", 0, height - 1), rotation = read("rotation", 0, 3);
          const buttons = read("buttons", 0, 7), wheel = read("wheel", -127, 127), serial = report["deviceSerial"];
          if (typeof serial !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(serial)) {
            throw new Error("Pointer input requires the current screen App device UUID.");
          }
          const frame = await tools.readLiveFrame();
          if (!currentRound() || !tools.input.state.armed) return respond(409, "Mouse control has paused.");
          const frameReadAt = performance.now();
          const age = frame.frameAgeMs;
          if (frame.source !== "screen-app" || typeof age !== "number" || !Number.isFinite(age) || age < 0 || age > MAX_SCREEN_FRAME_AGE_MS) {
            throw new Error("A fresh phone screen is required for pointer input.");
          }
          if (serial.toLowerCase() !== frame.serial.toLowerCase() || width !== (frame.deviceWidth ?? frame.width)
            || height !== (frame.deviceHeight ?? frame.height) || rotation !== (frame.rotation ?? 0)) {
            throw new Error("Phone identity or screen geometry changed. Reconnect the live picture first.");
          }
          state = await tools.input.pointerTo(x, y, buttons, wheel, undefined, () => {
            if (!currentRound() || age + performance.now() - frameReadAt > MAX_SCREEN_FRAME_AGE_MS) {
              throw new Error("Pointer input expired while waiting. Start control again.");
            }
          });
        } else if (kind === "mouse") {
          const dx = read("dx", -127, 127), dy = read("dy", -127, 127), wheel = read("wheel", -127, 127), buttons = read("buttons", 0, 7);
          state = await (sequenceHeader === undefined ? tools.input.move(dx, dy, wheel, buttons)
            : realtime(() => tools.input.remoteReport({ kind: "mouse", dx, dy, wheel, buttons })));
        } else if (kind === "key") {
          const modifier = read("modifier", 0, 255), keycode = read("keycode", 0, 255);
          state = await (sequenceHeader === undefined ? tools.input.keyReport(modifier, keycode)
            : realtime(() => tools.input.remoteReport({ kind: "key", modifier, keycode })));
        }
        if (!state) throw new Error("Invalid remote report.");
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify(state));
      } catch (error) {
        if (!currentRound()) {
          if (!response.headersSent) respond(409, "Mouse control has paused.");
          return;
        }
        releaseRemote();
        if (!response.headersSent) respond(400, error instanceof Error ? error.message : "Remote input failed.");
      }
      return;
    }
    if (request.url !== "/mcp") return respond(404, "Not found.");
    const id = request.headers["mcp-session-id"];
    if (Array.isArray(id)) return respond(400, "One MCP session ID is required.");
    const session = id ? sessions.get(id) : undefined;
    if (id && !session) return respond(404, "MCP session not found. Initialize again.");
    if (request.method === "GET" || request.method === "DELETE") {
      if (!session) { response.setHeader("Allow", "POST"); return respond(405, "Initialize an MCP session with POST first."); }
      if (request.method === "GET") {
        // Keep an otherwise idle MCP event stream alive through browser/proxy
        // idle deadlines. SSE comments carry no RPC or hardware action.
        const keepalive = setInterval(() => {
          if (response.headersSent && response.statusCode === 200 && !response.writableEnded && response.writableLength === 0) {
            response.write(": qdd-connected\n\n");
          }
        }, 2000);
        keepalive.unref();
        response.once("close", () => clearInterval(keepalive));
      }
      if (request.method === "GET") response.once("close", () => {
        // The SDK's only successful GET is its persistent SSE stream. Error GETs
        // finish as JSON; its writeHead(headers) bypasses Node's getHeader cache.
        if (response.headersSent && response.statusCode === 200 && !response.writableFinished) {
          void session.mcp.close().catch(() => {});
        }
      });
      try { await session.transport.handleRequest(request, response); }
      catch { if (!response.headersSent) respond(500, "MCP session request failed."); else response.destroy(); }
      return;
    }
    if (request.method !== "POST") { response.setHeader("Allow", "POST, GET, DELETE"); return respond(405, "Unsupported MCP method."); }
    let parsed: unknown;
    try { parsed = await body(request); } catch (error) { return respond(400, (error as Error).message); }
    if (Array.isArray(parsed)) return respond(400, "Send one MCP request per HTTP POST.");
    // An old browser's pause POST may finish its body after AI took control and
    // closed that session. Never dispatch its late cleanup against the new owner.
    if (id && sessions.get(id) !== session) return respond(404, "MCP session not found. Initialize again.");
    if (!session && !isInitializeRequest(parsed)) return respond(400, "Initialize an MCP session first.");
    if (!session && active.size >= 32) return respond(503, "Too many MCP sessions. Close an existing session first.");
    // Closing a read-only inspection must not stop a different user's remote
    // control. Only a dispatched input call can own input and its lost POST.
    const call = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: { name?: unknown; arguments?: { action?: unknown } } } : undefined;
    const mutatesInput = call?.jsonrpc === "2.0" && (typeof call.id === "string" || typeof call.id === "number")
      && call.method === "tools/call" && ANDROID_TOOLS.some((entry) =>
      entry.name === call.params?.name && !entry.annotations?.readOnlyHint)
      && !(call.params?.name === "android_control" && call.params.arguments?.action === "wait");
    if (mutatesInput && session && typeof id === "string") {
      if (remoteOwner && remoteOwner !== id) {
        const previousBrowser = sessions.get(remoteOwner);
        clearRemote();
        try {
          try { await tools.input.stop(); }
          finally { await previousBrowser?.mcp.close(); }
        } catch { return respond(503, "Could not release the previous remote controller. Reconnect the ESP32 and try again."); }
      }
      inputOwner = id;
    }
    let current = session;
    let requestController: AbortController | undefined;
    const requestId = call?.jsonrpc === "2.0" && call.method === "tools/call"
      && (typeof call.id === "string" || typeof call.id === "number") ? call.id : undefined;
    try {
      if (!current) {
        const calls = new Map<string | number, AbortController>();
        const mcp = createMcpServer(tools, (requestId) => calls.get(requestId)?.signal);
        const transport = new StreamableHTTPServerTransport({
          // SDK 1.32.1 retains completed JSON POST streams until session close.
          // Its default SSE replies clean them up; both clients support SSE.
          enableJsonResponse: false,
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (sessionId) => { sessions.set(sessionId, { mcp, transport, calls }); },
        });
        current = { mcp, transport, calls };
        active.add(current);
        const owned = current;
        mcp.onclose = () => {
          const sessionId = transport.sessionId;
          if (sessionId && remoteOwner === sessionId) releaseRemote();
          else if (sessionId && inputOwner === sessionId) pause();
          if (sessionId && inputOwner === sessionId) inputOwner = undefined;
          if (transport.sessionId) sessions.delete(transport.sessionId);
          calls.clear();
          active.delete(owned);
        };
        // SDK 1.x's accessor types include undefined; its own Transport uses optional callbacks.
        await mcp.connect(transport as unknown as Transport);
      }
      if (requestId !== undefined) {
        if (current.calls.has(requestId)) return respond(409, "This MCP request id is already active.");
        requestController = new AbortController();
        current.calls.set(requestId, requestController);
        const controller = requestController;
        const cancelLostResponse = () => {
          // Cancel this call through MCP's owned-round guards. An old POST
          // must not globally pause a newer ARM in the same SDK session.
          if (!response.writableFinished && (!mutatesInput || inputOwner === id)) {
            controller.abort(new Error("MCP HTTP response closed before the tool completed."));
          }
        };
        response.once("close", cancelLostResponse);
        if (response.destroyed) cancelLostResponse();
      }
      // Cancellation notifications must reach the same Server as their in-flight call.
      await current.transport.handleRequest(request, response, parsed);
      if (!current.transport.sessionId) { active.delete(current); await current.mcp.close(); }
    } catch (error) {
      if (!response.headersSent) respond(500, error instanceof Error ? error.message : "MCP request failed.");
      else response.destroy();
      if (current) await current.mcp.close().catch(() => {});
    } finally {
      if (requestId !== undefined && current && requestController && current.calls.get(requestId) === requestController) current.calls.delete(requestId);
    }
  });
  const socketCurrent = (binding: RemoteSocketBinding) => sessions.has(binding.sessionId)
    && remoteOwner === binding.sessionId && String(remoteGeneration) === binding.round
    && remoteInputEpoch === binding.inputEpoch && tools.input.controlEpoch === binding.inputEpoch
    && tools.input.state.armed;
  const remoteSocket = attachRemoteSocket(server, {
    bind(sessionId, round) {
      const binding = { sessionId, round, inputEpoch: tools.input.controlEpoch };
      if (!socketCurrent(binding)) throw new Error("Connect the current operator round first.");
      return binding;
    },
    current: socketCurrent,
    renew(binding) { if (socketCurrent(binding)) renewRemote(); },
    async report(binding, report, signal) {
      if (!socketCurrent(binding)) throw new Error("The remote control round has ended.");
      return tools.input.remoteReport(report, signal);
    },
    release(binding) { if (socketCurrent(binding)) releaseRemote(); },
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "0.0.0.0", resolve); });
  } catch (error) { await remoteSocket.close(); throw error; }
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("HTTP listener did not start.");
  return {
    url: `${lanUrls(address.port)[0]}mcp`,
    async close() {
      clearRemote();
      await remoteSocket.close();
      await tools.input.stop().catch(() => {});
      await Promise.allSettled([...active].map(({ mcp }) => mcp.close()));
      await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
    },
  };
}

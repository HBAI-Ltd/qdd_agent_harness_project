import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { startService } from "./index.js";

async function lifecycle(context: TestContext, disconnect: boolean): Promise<void> {
  const phone = createHttpServer((request, response) => {
    if (request.url === "/health") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ status: "ok", service: "qdd-android-screen", projecting: true,
        deviceId: "11111111-1111-4111-8111-111111111111", model: "Offline lifecycle fixture" }));
    } else if (request.url === "/stream.mjpg") {
      response.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=qdd-frame" }); response.flushHeaders();
    } else { response.writeHead(404); response.end(); }
  });
  const peers = new Set<Socket>();
  let shuttingDown = false, reopened = 0, armed = false, heldKey = 0;
  const commands: string[] = [];
  const esp = createTcpServer((socket) => {
    peers.add(socket); socket.on("error", () => {}); socket.once("close", () => peers.delete(socket));
    const refused = shuttingDown;
    if (refused) reopened++;
    let buffered = "";
    socket.on("data", (bytes) => {
      buffered += bytes.toString();
      let end;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const [, id, op, ...args] = buffered.slice(0, end).split(" "); buffered = buffered.slice(end + 1);
        commands.push(op!);
        if (refused) { socket.write(`QDDHID/1 ${id} ERR CONTROL_BUSY\n`); continue; }
        if (op === "ARM") armed = true;
        if (op === "PAUSE") armed = false;
        if (op === "KEY") heldKey = Number(args[1]);
        if (op === "RELEASE") heldKey = 0;
        socket.write(`QDDHID/1 ${id} OK ${JSON.stringify({ v: 1, connected: true, encrypted: true,
          bonded: true, ready: true, armed, locked: false, name: "Offline lifecycle controller" })}\n`);
      }
    });
  });
  await Promise.all([new Promise<void>((resolve) => phone.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => esp.listen(0, "127.0.0.1", resolve))]);
  const phoneAddress = phone.address(), espAddress = esp.address();
  assert.ok(phoneAddress && typeof phoneAddress === "object" && espAddress && typeof espAddress === "object");
  const service = await startService({ transport: "http", port: 0, espHost: "127.0.0.1", espTcpPort: espAddress.port,
    screenUrl: `http://127.0.0.1:${phoneAddress.port}` });
  const client = new Client({ name: "offline-service-lifecycle", version: "1" });
  context.after(async () => {
    await client.close(); await service.close();
    for (const peer of peers) peer.destroy();
    phone.closeAllConnections();
    await Promise.all([new Promise<void>((resolve) => phone.close(() => resolve())), new Promise<void>((resolve) => esp.close(() => resolve()))]);
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${new URL(service.url!).port}/mcp`)) as unknown as Transport);
  assert.notEqual((await client.callTool({ name: "android_hid_arm" })).isError, true);
  assert.notEqual((await client.callTool({ name: "android_key_report", arguments: { modifier: 0, keycode: 4 } })).isError, true);
  assert.equal(heldKey, 4);
  if (disconnect) { for (const peer of peers) peer.destroy(); await delay(30); }
  shuttingDown = true;
  await service.close();
  assert.equal(reopened, 0, "Stopping a service must release existing resources rather than claim a fresh controller connection.");
  if (!disconnect) { assert.equal(heldKey, 0); assert.deepEqual(commands.slice(-2), ["RELEASE", "PAUSE"]); }
}

test("service shutdown cannot reopen a disconnected used controller for repeated cleanup", { timeout: 5000 },
  (context) => lifecycle(context, true));
test("service shutdown still releases a held key through its existing controller connection", { timeout: 5000 },
  (context) => lifecycle(context, false));

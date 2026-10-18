import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, Socket } from "node:net";
import type { AddressInfo } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DEFAULT_ESP_TCP_PORT, parseEspTcpPort, TcpHidBridge, validateEspHost } from "./tcp.js";
import { HidProtocolError } from "./protocol.js";
import type { HidStatus } from "./protocol.js";
import type { TcpBridgeOptions } from "./tcp.js";

interface Command { socket: Socket; id: number; op: string; args: number[]; connection: number }

async function board(onCommand?: (command: Command) => boolean) {
  const commands: Command[] = [];
  const peers = new Set<Socket>();
  let connections = 0;
  const status: HidStatus = { v: 1, connected: true, encrypted: true, armed: false, locked: false, bonded: true, ready: true, name: "中文控制板" };
  const server = createServer((socket) => {
    const connection = ++connections;
    peers.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => { peers.delete(socket); status.armed = false; });
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString("utf8");
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const [, id, op, ...args] = line.split(" ");
        const command: Command = { socket, id: Number(id), op: op!, args: args.map(Number), connection };
        commands.push(command);
        if (onCommand?.(command)) continue;
        if (op === "ARM") status.armed = true;
        if (op === "PAUSE") status.armed = false;
        socket.write(`QDDHID/1 ${id} OK ${JSON.stringify(status)}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { commands, peers, status, port: (server.address() as AddressInfo).port,
    get connections() { return connections; },
    async close() {
      for (const socket of peers) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("TCP replaces a read-only observation with one fresh persistent control connection and FIFO reports", async (t) => {
  const device = await board();
  const bridge = new TcpHidBridge({ host: "127.0.0.1", port: device.port });
  t.after(async () => { await bridge.close(); await device.close(); });
  assert.equal(device.connections, 0);
  assert.equal((await bridge.request("STATUS")).name, "中文控制板");
  assert.deepEqual(device.commands.map(({ op }) => op), ["STATUS"]);
  assert.equal((await bridge.request("ARM")).armed, true);
  await Promise.all([bridge.request("MOVE", [2, 3, 0, 0]), bridge.request("KEY", [0, 4]), bridge.request("KEY", [0, 0])]);
  assert.deepEqual(device.commands.slice(-5).map(({ op }) => op), ["PING", "ARM", "MOVE", "KEY", "KEY"]);
  assert.equal(device.connections, 2);
  assert.equal(new Set(device.commands.map(({ id }) => id)).size, device.commands.length);
  await bridge.close();
  assert.deepEqual(device.commands.slice(-2).map(({ op }) => op), ["RELEASE", "PAUSE"]);
});

test("TCP heartbeats renew the same connection and stop after close", async (t) => {
  const device = await board();
  const bridge = new TcpHidBridge({ host: "127.0.0.1", port: device.port, heartbeatMs: 15 });
  t.after(async () => { await bridge.close(); await device.close(); });
  await bridge.request("ARM");
  const deadline = Date.now() + 500;
  while (device.commands.filter(({ op }) => op === "PING").length < 4 && Date.now() < deadline) await delay(10);
  assert.ok(device.commands.filter(({ op }) => op === "PING").length >= 4);
  assert.equal(device.connections, 1);
  await bridge.close();
  const count = device.commands.length;
  await delay(35);
  assert.equal(device.commands.length, count);
});

test("TCP keeps the same armed session after one timer PING ACK is lost without replaying input", async (t) => {
  let dropNextPing = false;
  let dropped: Command | undefined;
  const device = await board((command) => {
    if (command.op !== "PING" || !dropNextPing) return false;
    dropNextPing = false; dropped = command; return true;
  });
  const bridge = new TcpHidBridge({ host: "127.0.0.1", port: device.port, timeoutMs: 80, heartbeatMs: 15 });
  t.after(async () => { await bridge.close(); await device.close(); });
  await bridge.request("ARM");
  const afterArm = device.commands.length; dropNextPing = true;
  await delay(180);
  assert.ok(dropped);
  assert.equal(device.status.armed, true);
  assert.equal(device.connections, 1);
  assert.equal(device.commands.slice(afterArm).some(({ op }) => op !== "PING"), false);
  dropped.socket.write(`QDDHID/1 ${dropped.id} OK ${JSON.stringify({ ...device.status, armed: false })}\n`);
  await delay(0);
  assert.equal(bridge.lastStatus?.armed, true);
});

test("lost TCP input ACK releases reports without retrying movement", async (t) => {
  const device = await board(({ op }) => op === "MOVE");
  const bridge = new TcpHidBridge({ host: "127.0.0.1", port: device.port, timeoutMs: 35 });
  t.after(async () => { await bridge.close(); await device.close(); });
  await bridge.request("ARM");
  await assert.rejects(bridge.request("MOVE", [40, 0, 0, 1]), /not retried/);
  assert.equal(device.commands.filter(({ op }) => op === "MOVE").length, 1);
  assert.equal(device.commands.at(-1)!.op, "RELEASE");
});

test("TCP disconnect fails the active report, never reconnects from heartbeat and reopens paused", async (t) => {
  const device = await board(({ op, socket }) => {
    if (op !== "KEY") return false;
    socket.destroy();
    return true;
  });
  const bridge = new TcpHidBridge({ host: "127.0.0.1", port: device.port, heartbeatMs: 15 });
  t.after(async () => { await bridge.close(); await device.close(); });
  await bridge.request("ARM");
  await assert.rejects(bridge.request("KEY", [0, 4]), /disconnected/);
  await delay(60);
  assert.equal(device.connections, 1);
  assert.equal((await bridge.request("STATUS")).armed, false);
  assert.equal(device.connections, 2);
  assert.deepEqual(device.commands.filter(({ connection }) => connection === 2).map(({ op }) => op), ["PING", "RELEASE", "PAUSE", "STATUS"]);
});

test("a busy control-source lease never sends ARM, falls back to USB or retries the rejected PING", async (t) => {
  const device = await board(({ socket, id }) => { socket.write(`QDDHID/1 ${id} ERR CONTROL_BUSY\n`); return true; });
  const bridge = new TcpHidBridge({ host: "127.0.0.1", port: device.port });
  t.after(async () => { await bridge.close(); await device.close(); });
  await assert.rejects(bridge.request("ARM"), (error) => error instanceof HidProtocolError && error.code === "CONTROL_BUSY" && /另一个连接/.test(error.message));
  assert.deepEqual(device.commands.map(({ op }) => op), ["PING"]);
  assert.equal(device.connections, 1);
});

test("TCP pairing reports USB-only without exposing or retrying a PIN request", async (t) => {
  const device = await board(({ socket, id, op }) => {
    if (op !== "PAIR" && op !== "PAIR_STATUS") return false;
    socket.write(`QDDHID/1 ${id} ERR USB_ONLY\n`);
    return true;
  });
  const bridge = new TcpHidBridge({ host: "127.0.0.1", port: device.port });
  t.after(async () => { await bridge.close(); await device.close(); });
  await assert.rejects(bridge.request("PAIR"), (error) => error instanceof HidProtocolError && error.code === "USB_ONLY" && /USB/.test(error.message));
  assert.equal(device.commands.filter(({ op }) => op === "PAIR").length, 1);
});

test("TCP shutdown cancels the active and queued reports before closing", async (t) => {
  const device = await board(({ op }) => op === "KEY");
  const bridge = new TcpHidBridge({ host: "127.0.0.1", port: device.port });
  t.after(async () => { await bridge.close(); await device.close(); });
  await bridge.request("ARM");
  const active = bridge.request("KEY", [0, 4]);
  const queued = bridge.request("MOVE", [10, 0, 0, 0]);
  const activeRejected = assert.rejects(active, /closing/);
  const queuedRejected = assert.rejects(queued, /closed/);
  const deadline = Date.now() + 500;
  while (!device.commands.some(({ op }) => op === "KEY") && Date.now() < deadline) await delay(1);
  await bridge.close();
  await Promise.all([activeRejected, queuedRejected]);
  assert.equal(device.commands.some(({ op }) => op === "MOVE"), false);
  assert.deepEqual(device.commands.slice(-2).map(({ op }) => op), ["RELEASE", "PAUSE"]);
});

test("TCP connect timeout destroys the unopened socket without sending reports", async () => {
  class StalledSocket extends Socket {
    override connect(): this { return this; }
  }
  const socket = new StalledSocket();
  const bridge = new TcpHidBridge({ host: "127.0.0.1", timeoutMs: 100, connectTimeoutMs: 20, socketFactory: () => socket });
  await assert.rejects(bridge.request("ARM"), /连接控制板超时/);
  assert.equal(socket.destroyed, true);
  await bridge.close();
});

const interfaceAddress = (address: string, netmask: string): NetworkInterfaceInfo => ({
  address, netmask, family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: null,
});
async function attemptedConnection(options: TcpBridgeOptions) {
  class CapturedSocket extends Socket {
    options: { host?: string; localAddress?: string; lookup?: unknown } | undefined;
    override connect(...args: unknown[]): this { this.options = args[0] as typeof this.options; return this; }
  }
  const socket = new CapturedSocket();
  const bridge = new TcpHidBridge({ ...options, timeoutMs: 100, connectTimeoutMs: 20, socketFactory: () => socket });
  try { await assert.rejects(bridge.request("STATUS"), /连接控制板超时/); }
  finally { await bridge.close(); }
  return socket.options;
}

test("TCP binds the matching physical LAN address instead of leaving a TUN default source", async () => {
  let reads = 0;
  const options = await attemptedConnection({ host: "192.168.100.167", networkInterfaces: () => {
    reads++;
    return { Mihomo: [interfaceAddress("198.18.0.1", "255.255.0.0")], WLAN: [interfaceAddress("192.168.100.160", "255.255.254.0")] };
  } });
  assert.equal(options?.host, "192.168.100.167");
  assert.equal(options?.localAddress, "192.168.100.160");
  assert.equal(reads, 1);
});

test("TCP resolves a hostname only once and binds for its validated literal destination", async () => {
  let lookups = 0;
  const options = await attemptedConnection({ host: "passport.local", resolveHost: async (hostname) => {
    assert.equal(hostname, "passport.local"); lookups++; return "192.168.100.167";
  }, networkInterfaces: () => ({ WLAN: [interfaceAddress("192.168.100.160", "255.255.254.0")] }) });
  assert.equal(lookups, 1);
  assert.equal(options?.host, "192.168.100.167");
  assert.equal(options?.localAddress, "192.168.100.160");
  assert.equal(options?.lookup, undefined, "Connecting the resolved literal must not perform another DNS lookup.");
});

test("TCP preserves loopback and unmatched routed LAN connections without forcing a source", async () => {
  for (const host of ["127.0.0.1", "10.20.30.40"]) {
    const options = await attemptedConnection({ host, networkInterfaces: () => ({ WLAN: [interfaceAddress("192.168.100.160", "255.255.254.0")] }) });
    assert.equal(options?.host, host); assert.equal(options?.localAddress, undefined);
  }
});

test("TCP rejects a public DNS result before connecting or choosing a source address", async () => {
  let connects = 0, interfacesRead = 0;
  class ForbiddenSocket extends Socket { override connect(): this { connects++; return this; } }
  const socket = new ForbiddenSocket();
  const bridge = new TcpHidBridge({ host: "passport.local", socketFactory: () => socket,
    resolveHost: async () => "8.8.8.8", networkInterfaces: () => { interfacesRead++; return {}; } });
  await assert.rejects(bridge.request("STATUS"), /不是局域网 IPv4/);
  assert.equal(connects, 0); assert.equal(interfacesRead, 0); assert.equal(socket.destroyed, true);
  await bridge.close();
});

test("TCP configuration accepts explicit LAN hosts and validates ports before connecting", () => {
  assert.equal(DEFAULT_ESP_TCP_PORT, 3333);
  for (const host of ["10.65.1.2", "172.16.0.1", "172.31.255.254", "192.168.1.20", "127.0.0.1", "passport.local", "board", "esp.home.arpa"]) {
    assert.equal(validateEspHost(` ${host} `), host);
  }
  for (const host of ["", "http://192.168.1.2", "192.168.1.2:3333", "user@board", "board/path", "8.8.8.8", "172.32.0.1", "127.1", "999.1.2.3", "::1", "bad name", "-board.local"]) {
    assert.throws(() => new TcpHidBridge({ host }), /ESP_HOST/);
  }
  assert.equal(parseEspTcpPort(), 3333);
  assert.equal(parseEspTcpPort(" 4444 "), 4444);
  for (const port of [0, -1, 65536, 1.5, NaN, Infinity, "", "33x", "3.3", "3e3"]) assert.throws(() => parseEspTcpPort(port), /ESP_TCP_PORT/);
  assert.throws(() => new TcpHidBridge({ host: "board.local", connectTimeoutMs: 0 }), /连接超时/);
});

test("launcher validates Wi-Fi configuration without starting a service or touching a device", async () => {
  // In isolated outDirs the fixture lives one directory deeper than dist.
  const sourceUrl = new URL(import.meta.url.includes("/build/") ? "../../tools/start.mjs" : "../tools/start.mjs", import.meta.url);
  const script = `
    import assert from "node:assert/strict";
    import { validateConfiguration } from ${JSON.stringify(sourceUrl.href)};
    const base = { ANDROID_SCREEN_URL: "http://192.168.1.2:8791", ESP_PORT: "FAKE" };
    const wifi = validateConfiguration({ ...base, ESP_HOST: " passport.local ", ESP_TCP_PORT: "4444" }, {});
    assert.equal(wifi.env.ESP_HOST, "passport.local");
    assert.equal(wifi.env.ESP_TCP_PORT, "4444");
    assert.equal(wifi.env.ESP_PORT, "FAKE");
    assert.equal(validateConfiguration(base, {}).env.ESP_HOST, "");
    for (const host of ["http://192.168.1.2", "8.8.8.8", "board:3333"]) {
      assert.throws(() => validateConfiguration({ ...base, ESP_HOST: host }, {}), /ESP_HOST/);
    }
    for (const port of ["", "0", "65536", "3e3"]) {
      assert.throws(() => validateConfiguration({ ...base, ESP_TCP_PORT: port }, {}), /ESP_TCP_PORT/);
    }
  `;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { timeout: 5000 });
});

test("CLI help explains Wi-Fi priority and supports board host and TCP port options", async () => {
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("./index.js", import.meta.url)), "--help"], { timeout: 5000 });
  assert.match(result.stderr, /--esp-host/);
  assert.match(result.stderr, /--esp-tcp-port 3333/);
  assert.match(result.stderr, /Wi-Fi/);
});

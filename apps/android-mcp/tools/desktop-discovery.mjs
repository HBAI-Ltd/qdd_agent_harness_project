import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { normalizeBoardUrl, privateIpv4 } from "./desktop-config.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const port = (value) => Number.isInteger(value) && value >= 1 && value <= 65535;

export function boardStatus(value, boardUrl) {
  const url = new URL(normalizeBoardUrl(boardUrl));
  if (!value || value.service !== "qdd-esp-onboarding" || value.version !== 1 || value.ip !== url.hostname || !port(value.tcpPort)) {
    throw new Error("控制板返回的连接信息不完整。");
  }
  const candidate = value.phone;
  const phone = candidate?.fresh === true && privateIpv4(candidate.ip) && port(candidate.port) && typeof candidate.deviceId === "string" && UUID.test(candidate.deviceId)
    && typeof candidate.projecting === "boolean"
    ? { ip: candidate.ip, port: candidate.port, deviceId: candidate.deviceId, projecting: candidate.projecting,
      screenUrl: `http://${candidate.ip}:${candidate.port}` } : null;
  const bluetooth = value.bluetooth && typeof value.bluetooth === "object" ? value.bluetooth : {};
  return { boardUrl: url.origin, ip: value.ip, tcpPort: value.tcpPort, phone,
    name: typeof value.deviceName === "string" ? value.deviceName.slice(0, 100) : "设备控制器",
    bluetooth: { connected: bluetooth.connected === true, ready: bluetooth.ready === true } };
}

export async function fetchBoardStatus(boardUrl, options = {}) {
  const origin = normalizeBoardUrl(boardUrl);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 1000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const response = await fetch(`${origin}/api/status`, { cache: "no-store", redirect: "error", signal });
  if (!response.ok || !response.body) throw new Error("控制板暂时没有响应。");
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length; if (size > 8192) throw new Error("控制板连接信息过长。"); chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return boardStatus(JSON.parse(Buffer.concat(chunks).toString("utf8")), origin);
}

export function broadcastAddresses(interfaces = networkInterfaces()) {
  const result = new Set(["255.255.255.255"]);
  for (const entries of Object.values(interfaces)) for (const entry of entries ?? []) {
    if (entry.family !== "IPv4" || entry.internal || !privateIpv4(entry.address) || entry.address.startsWith("127.")) continue;
    const ip = entry.address.split(".").map(Number), mask = entry.netmask.split(".").map(Number);
    if (mask.length !== 4 || mask.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) continue;
    result.add(ip.map((value, index) => value | (255 ^ mask[index])).join("."));
  }
  return [...result].slice(0, 16);
}

/** One bounded read-only scan. It never saves settings, arms input or opens serial ports. */
export async function discoverBoards(options = {}) {
  const controller = new AbortController(), socket = createSocket("udp4");
  const found = new Map(), probed = new Set(), pending = new Set();
  let finished = false, timer;
  const deadline = Date.now() + Math.max(100, Math.min(5000, options.timeoutMs ?? 1400));
  const probe = (candidate, sender) => {
    if (finished || probed.size >= 8) return;
    let url;
    try { url = normalizeBoardUrl(candidate); if (sender && new URL(url).hostname !== sender) return; } catch { return; }
    if (probed.has(url)) return; probed.add(url);
    const task = fetchBoardStatus(url, { timeoutMs: Math.max(1, deadline - Date.now()), signal: controller.signal })
      .then((value) => { if (!finished) found.set(url, value); }).catch(() => {}).finally(() => pending.delete(task));
    pending.add(task);
  };
  let complete;
  const done = new Promise((resolveDone) => { complete = resolveDone; });
  const finish = () => {
    if (finished) return;
    finished = true; clearTimeout(timer); controller.abort();
    try { socket.close(() => complete()); } catch { complete(); }
  };
  options.signal?.addEventListener("abort", finish, { once: true });
  socket.on("error", () => finish());
  socket.on("message", (bytes, peer) => {
    if (bytes.length > 2048 || !privateIpv4(peer.address)) return;
    try { const value = JSON.parse(bytes.toString("utf8")); if (value.service === "qdd-esp-onboarding" && value.version === 1) probe(value.boardUrl, peer.address); } catch { /* Ignore unrelated LAN datagrams. */ }
  });
  timer = setTimeout(finish, Math.max(1, deadline - Date.now()));
  if (options.signal?.aborted) finish();
  else {
    for (const hint of options.hints ?? []) probe(hint);
    socket.bind(0, "0.0.0.0", () => {
      if (finished) return;
      try {
        socket.setBroadcast(true);
        for (const address of options.broadcasts ?? broadcastAddresses()) socket.send("QDD-DISCOVER/1", options.udpPort ?? 3335, address, () => {});
      } catch { /* Known HTTP hints can still succeed when UDP broadcast is unavailable. */ }
    });
  }
  await done; await Promise.allSettled(pending);
  options.signal?.removeEventListener("abort", finish);
  return [...found.values()].sort((left, right) => Number(Boolean(right.phone?.projecting)) - Number(Boolean(left.phone?.projecting)) || left.ip.localeCompare(right.ip));
}

import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";

type LanInterfaces = Record<string, readonly (Pick<NetworkInterfaceInfo, "address" | "family" | "internal">
  & Partial<Pick<NetworkInterfaceInfo, "netmask">>)[] | undefined>;

function interfaceScore(name: string): number {
  const virtual = /virtual|vethernet|hyper-v|docker|wsl|tun|tap|vmware|virtualbox|vgate|mihomo/iu.test(name);
  return (virtual ? 10 : 0) + (/wi-?fi|wlan|无线/iu.test(name) ? 0 : /ethernet|以太网/iu.test(name) ? 1 : 2);
}

function rfc1918Ipv4(address: string): boolean {
  return isIP(address) === 4 && privateAddress(address) && !address.startsWith("127.");
}

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, octet) => (value << 8) | Number(octet), 0) >>> 0;
}

/** Select the most specific private interface subnet containing the literal LAN target. */
export function matchingLanAddress(target: string, interfaces: LanInterfaces = networkInterfaces()): string | undefined {
  if (!rfc1918Ipv4(target)) return undefined;
  const targetNumber = ipv4Number(target);
  const candidates: { address: string; prefix: number; score: number }[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal || !rfc1918Ipv4(entry.address)
        || !entry.netmask || isIP(entry.netmask) !== 4) continue;
      const mask = ipv4Number(entry.netmask);
      const inverse = (~mask) >>> 0;
      // A LAN interface needs a contiguous, nonzero subnet mask, not a default route.
      if (!mask || (inverse & (inverse + 1)) !== 0) continue;
      if ((ipv4Number(entry.address) & mask) !== (targetNumber & mask)) continue;
      candidates.push({ address: entry.address, prefix: Math.clz32(inverse), score: interfaceScore(name) });
    }
  }
  candidates.sort((a, b) => b.prefix - a.prefix || a.score - b.score || a.address.localeCompare(b.address));
  return candidates[0]?.address;
}

/** LAN access is limited to numeric RFC1918 IPv4 and local loopback addresses. */
export function privateAddress(address: string | undefined): boolean {
  if (!address) return false;
  const value = address.replace(/^\[|\]$/gu, "").replace(/^::ffff:/iu, "");
  if (value === "::1") return true;
  if (isIP(value) !== 4) return false;
  const [a, b] = value.split(".").map(Number);
  return a === 10 || a === 127 || a === 192 && b === 168 || a === 172 && b! >= 16 && b! <= 31;
}

export function privateAuthority(host: string | undefined): boolean {
  if (!host || !/^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[::1\])(?::[1-9]\d{0,4})?$/iu.test(host)) return false;
  try {
    const url = new URL(`http://${host}`);
    return url.hostname === "localhost" || privateAddress(url.hostname);
  } catch { return false; }
}

export function privateOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
      && url.pathname === "/" && privateAuthority(url.host);
  } catch { return false; }
}

export function privateRequest(host: string | undefined, origin: string | undefined, peerAddress: string | undefined): boolean {
  return privateAddress(peerAddress) && privateAuthority(host) && privateOrigin(origin);
}

/** Prefer physical Wi-Fi/Ethernet; retain other private interfaces as alternatives. */
export function lanUrls(port: number, interfaces: LanInterfaces = networkInterfaces()): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError("设备操作台端口应为 1 到 65535。");
  const candidates: { address: string; score: number }[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    const score = interfaceScore(name);
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal || !privateAddress(entry.address) || entry.address.startsWith("127.")) continue;
      candidates.push({ address: entry.address, score });
    }
  }
  candidates.sort((a, b) => a.score - b.score || a.address.localeCompare(b.address));
  const addresses = [...new Set(candidates.map(({ address }) => address))];
  return addresses.length ? addresses.map((address) => `http://${address}:${port}/`) : [`http://localhost:${port}/`];
}

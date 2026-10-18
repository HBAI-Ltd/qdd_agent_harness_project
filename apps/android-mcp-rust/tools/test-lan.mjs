import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
function interfaceScore(name) {
  const virtual = /virtual|vethernet|hyper-v|docker|wsl|tun|tap|vmware|virtualbox|vgate|mihomo/iu.test(name);
  return (virtual ? 10 : 0) + (/wi-?fi|wlan|无线/iu.test(name) ? 0 : /ethernet|以太网/iu.test(name) ? 1 : 2);
}
function rfc1918Ipv4(address) {
  return isIP(address) === 4 && privateAddress(address) && !address.startsWith("127.");
}
function ipv4Number(address) {
  return address.split(".").reduce((value, octet) => value << 8 | Number(octet), 0) >>> 0;
}
function matchingLanAddress(target, interfaces = networkInterfaces()) {
  if (!rfc1918Ipv4(target)) return void 0;
  const targetNumber = ipv4Number(target);
  const candidates = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal || !rfc1918Ipv4(entry.address) || !entry.netmask || isIP(entry.netmask) !== 4) continue;
      const mask = ipv4Number(entry.netmask);
      const inverse = ~mask >>> 0;
      if (!mask || (inverse & inverse + 1) !== 0) continue;
      if ((ipv4Number(entry.address) & mask) !== (targetNumber & mask)) continue;
      candidates.push({ address: entry.address, prefix: Math.clz32(inverse), score: interfaceScore(name) });
    }
  }
  candidates.sort((a, b) => b.prefix - a.prefix || a.score - b.score || a.address.localeCompare(b.address));
  return candidates[0]?.address;
}
function privateAddress(address) {
  if (!address) return false;
  const value = address.replace(/^\[|\]$/gu, "").replace(/^::ffff:/iu, "");
  if (value === "::1") return true;
  if (isIP(value) !== 4) return false;
  const [a, b] = value.split(".").map(Number);
  return a === 10 || a === 127 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31;
}
function privateAuthority(host) {
  if (!host || !/^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[::1\])(?::[1-9]\d{0,4})?$/iu.test(host)) return false;
  try {
    const url = new URL(`http://${host}`);
    return url.hostname === "localhost" || privateAddress(url.hostname);
  } catch {
    return false;
  }
}
function privateOrigin(origin) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/" && privateAuthority(url.host);
  } catch {
    return false;
  }
}
function privateRequest(host, origin, peerAddress) {
  return privateAddress(peerAddress) && privateAuthority(host) && privateOrigin(origin);
}
function lanUrls(port, interfaces = networkInterfaces()) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError("\u8BBE\u5907\u64CD\u4F5C\u53F0\u7AEF\u53E3\u5E94\u4E3A 1 \u5230 65535\u3002");
  const candidates = [];
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
export {
  lanUrls,
  matchingLanAddress,
  privateAddress,
  privateAuthority,
  privateOrigin,
  privateRequest
};

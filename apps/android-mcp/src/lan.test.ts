import assert from "node:assert/strict";
import { test } from "node:test";
import { lanUrls, matchingLanAddress, privateAddress, privateAuthority, privateOrigin, privateRequest } from "./lan.js";

const subnet = (address: string, netmask = "255.255.255.0", internal = false) =>
  ({ address, netmask, family: "IPv4" as const, internal });

test("LAN access accepts local/private IPv4 authorities and rejects public peers, DNS names and malformed origins", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.100.160", "::1", "::ffff:192.168.1.2"]) assert.equal(privateAddress(address), true, address);
  for (const address of [undefined, "8.8.8.8", "172.15.0.1", "172.32.0.1", "169.254.1.2", "0.0.0.0", "localhost", "fd00::1"]) assert.equal(privateAddress(address), false, String(address));
  for (const host of ["localhost:8790", "127.0.0.1", "192.168.100.160:8790", "[::1]:8790"]) assert.equal(privateAuthority(host), true, host);
  for (const host of ["example.com", "192.168.1.1.attacker.example", "8.8.8.8:8790", "192.168.1.1:65536", "localhost:0", "user@localhost", "localhost/path", "0.0.0.0:8790"]) assert.equal(privateAuthority(host), false, host);
  for (const origin of [undefined, "http://localhost", "http://192.168.100.160:8790", "https://10.0.0.2:5173"]) assert.equal(privateOrigin(origin), true, String(origin));
  for (const origin of ["null", "https://public.example", "http://8.8.8.8", "http://user@192.168.1.1", "http://192.168.1.1/path", "http://192.168.1.1?x=1", "file://localhost/"]) assert.equal(privateOrigin(origin), false, origin);
  assert.equal(privateRequest("192.168.100.160:8790", "http://192.168.100.161:5173", "192.168.100.161"), true);
  assert.equal(privateRequest("192.168.100.160:8790", undefined, "8.8.8.8"), false, "A private Host does not authorize a public TCP peer.");
  assert.equal(privateRequest("192.168.100.160:8790", "https://attacker.example", "192.168.100.161"), false);
});

test("advertised URLs prefer real Wi-Fi, deduplicate private interfaces and fall back to localhost", () => {
  const ipv4 = (address: string, internal = false) => ({ address, family: "IPv4" as const, internal });
  assert.deepEqual(lanUrls(8790, {
    "vEthernet (WSL)": [ipv4("172.28.1.1")], Ethernet: [ipv4("192.168.1.10")], "Wi-Fi": [ipv4("192.168.100.160")],
    loopback: [ipv4("127.0.0.1", true)], duplicate: [ipv4("192.168.100.160")], public: [ipv4("8.8.8.8")],
  }), ["http://192.168.100.160:8790/", "http://192.168.1.10:8790/", "http://172.28.1.1:8790/"]);
  assert.deepEqual(lanUrls(8790, {}), ["http://localhost:8790/"]);
  assert.throws(() => lanUrls(0, {}), RangeError);
});

test("LAN target selection skips the Mihomo TUN and matches both halves of a /23 Wi-Fi subnet", () => {
  const interfaces = {
    Mihomo: [subnet("198.18.0.1", "255.254.0.0")],
    "vEthernet (WSL)": [subnet("172.28.1.1", "255.255.0.0")],
    "VPN tunnel": [subnet("10.65.201.2")],
    WLAN: [subnet("192.168.100.160", "255.255.254.0")],
  };
  assert.equal(matchingLanAddress("192.168.100.167", interfaces), "192.168.100.160");
  assert.equal(matchingLanAddress("192.168.101.46", interfaces), "192.168.100.160");
  assert.equal(matchingLanAddress("192.168.102.46", interfaces), undefined);
});

test("LAN target selection uses the longest matching prefix before physical interface preference", () => {
  assert.equal(matchingLanAddress("10.20.1.80", {
    WLAN: [subnet("10.20.0.2", "255.255.0.0")],
    Ethernet: [subnet("10.20.1.3")],
    "VPN tunnel": [subnet("10.20.1.4", "255.255.255.128")],
  }), "10.20.1.4");
  assert.equal(matchingLanAddress("172.24.3.80", {
    "vEthernet (WSL)": [subnet("172.24.3.2")],
    Ethernet: [subnet("172.24.3.3")],
    WLAN: [subnet("172.24.3.4")],
  }), "172.24.3.4");
  assert.equal(matchingLanAddress("10.65.201.94", {
    WLAN: [subnet("192.168.100.160", "255.255.254.0")],
    Ethernet: [subnet("10.65.201.10")],
  }), "10.65.201.10");
});

test("LAN target selection rejects invalid targets and has no unrelated-interface fallback", () => {
  const interfaces = { WLAN: [subnet("192.168.100.160", "255.255.254.0")] };
  for (const target of ["127.0.0.1", "::1", "::ffff:192.168.100.167", "8.8.8.8", "198.18.0.2",
    "172.15.1.2", "172.32.1.2", "169.254.1.2", "192.168.100.999", "192.168.010.167", "board.local",
    "http://192.168.100.167", "192.168.100.167:3333", " 192.168.100.167 ", ""]) {
    assert.equal(matchingLanAddress(target, interfaces), undefined, target);
  }
  assert.equal(matchingLanAddress("172.24.3.80", interfaces), undefined);
  assert.equal(matchingLanAddress("10.1.2.3", {}), undefined);
});

test("LAN target selection skips invalid masks, internal addresses, public interfaces and IPv6", () => {
  const interfaces = {
    missingMask: [{ address: "192.168.100.1", family: "IPv4" as const, internal: false }],
    badMask: [subnet("192.168.100.2", "255.0.255.0"), subnet("192.168.100.3", "not-a-mask"),
      subnet("192.168.100.4", "0.0.0.0"), subnet("192.168.100.5", "255.255.255.256")],
    internal: [subnet("192.168.100.6", "255.255.255.0", true)],
    loopback: [subnet("127.0.0.1", "255.0.0.0")],
    public: [subnet("8.8.8.8", "128.0.0.0")],
    ipv6: [{ address: "fd00::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6" as const, internal: false }],
  };
  assert.equal(matchingLanAddress("192.168.100.167", interfaces), undefined);
  assert.equal(matchingLanAddress("192.168.100.167", {
    ...interfaces, Ethernet: [subnet("192.168.100.20")],
  }), "192.168.100.20");
  assert.equal(matchingLanAddress("10.1.2.3", { Ethernet: [subnet("10.1.2.3", "255.255.255.255")] }), "10.1.2.3");
});

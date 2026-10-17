import assert from "node:assert/strict";
import { test } from "node:test";
import { lanUrls, privateAddress, privateAuthority, privateOrigin, privateRequest } from "./lan.js";

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

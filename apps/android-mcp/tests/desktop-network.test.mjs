import assert from "node:assert/strict";
import test from "node:test";
import { deviceBaseUrl, privateAddress, privateRequest } from "../tools/desktop-network.mjs";

test("desktop URLs prefer the physical private LAN and fall back when offline", () => {
  const entry = (address, internal = false) => ({ address, family: "IPv4", internal });
  assert.equal(deviceBaseUrl(8790, { "vEthernet": [entry("172.22.1.1")], "Wi-Fi": [entry("192.168.100.160")] }), "http://192.168.100.160:8790");
  assert.equal(deviceBaseUrl(8790, { Loopback: [entry("127.0.0.1", true)], Public: [entry("8.8.8.8")] }), "http://localhost:8790");
});

test("desktop setup accepts private peers and private origins but rejects public or malformed access", () => {
  const request = (remoteAddress, host, origin) => ({ socket: { remoteAddress }, headers: { host, ...(origin ? { origin } : {}) } });
  assert.equal(privateRequest(request("192.168.1.8", "192.168.1.2:8790", "http://192.168.1.8:3000")), true);
  assert.equal(privateRequest(request("::ffff:127.0.0.1", "localhost:8790", "http://localhost:3000")), true);
  for (const sample of [request("8.8.8.8", "192.168.1.2:8790"), request("192.168.1.8", "evil.invalid"),
    request("192.168.1.8", "192.168.1.2:8790", "https://evil.invalid"), request("127.0.0.1", "127.0.0.1/path"),
    request("127.0.0.1", "127.0.0.1:8790", "http://127.0.0.1/path"), request("127.0.0.1", "user@127.0.0.1:8790")]) {
    assert.equal(privateRequest(sample), false);
  }
  for (const address of ["0.0.0.0", "8.8.8.8", "172.32.0.1", "192.169.1.1", "::ffff:8.8.8.8"]) assert.equal(privateAddress(address), false);
});

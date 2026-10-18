import assert from "node:assert/strict";
import { test } from "node:test";
import { MockAgent } from "undici";
import type { Agent } from "undici";
import { LanHttpClient } from "./lan-http.js";

const subnet = (address: string, netmask = "255.255.254.0") =>
  ({ address, netmask, family: "IPv4" as const, internal: false });

function localAddress(options: Agent.Options): string | undefined {
  assert.ok(options.connect && typeof options.connect === "object");
  assert.ok("localAddress" in options.connect && typeof options.connect.localAddress === "string");
  return options.connect.localAddress;
}

test("LAN HTTP binds the matching /23 Wi-Fi source and reuses its dispatcher with Node builtin fetch", async (context) => {
  const origin = "http://192.168.101.46:8791";
  const agent = new MockAgent();
  agent.disableNetConnect();
  // MockAgent implements close(), while its inherited destroy() is abstract.
  context.mock.method(agent, "destroy", () => agent.close());
  const pool = agent.get(origin);
  pool.intercept({ path: "/frame", method: "GET" }).reply(200, "first frame");
  pool.intercept({ path: "/status", method: "GET" }).reply(200, "ready");
  const optionsSeen: Agent.Options[] = [];
  const client = new LanHttpClient(origin, {
    networkInterfaces: () => ({
      Mihomo: [subnet("198.18.0.1", "255.254.0.0")],
      "vEthernet (WSL)": [subnet("172.28.1.1", "255.255.0.0")],
      WLAN: [subnet("192.168.100.160")],
    }),
    dispatcherFactory: (options) => { optionsSeen.push(options); return agent; },
  });
  context.after(() => client.close());
  const frame = await client.fetch(`${origin}/frame`);
  assert.equal(frame.status, 200);
  assert.equal(await frame.text(), "first frame");
  assert.equal(await (await client.fetch(new URL("/status", origin))).text(), "ready");
  assert.equal(optionsSeen.length, 1);
  assert.equal(localAddress(optionsSeen[0]!), "192.168.100.160");
  agent.assertNoPendingInterceptors();
  // Even an unexpected request cannot escape the target-only mock to the LAN.
  await assert.rejects(client.fetch(`${origin}/unmatched`), /fetch failed/);
  await assert.rejects(client.fetch("http://192.168.101.47:8791/status"), /endpoint changed/);
  assert.equal(optionsSeen.length, 1);
});

test("LAN HTTP destroys the previous pool when the matching interface address changes", async (context) => {
  const origin = "http://192.168.100.167:3334";
  let address = "192.168.100.160";
  const optionsSeen: Agent.Options[] = [];
  const agents: MockAgent[] = [];
  const destroys: { mock: { callCount(): number } }[] = [];
  const client = new LanHttpClient(origin, {
    networkInterfaces: () => ({ WLAN: [subnet(address)] }),
    dispatcherFactory: (options) => {
      optionsSeen.push(options);
      const agent = new MockAgent();
      agent.disableNetConnect();
      agent.get(origin).intercept({ path: "/api/status", method: "GET" }).reply(200, address);
      destroys.push(context.mock.method(agent, "destroy", () => agent.close()));
      agents.push(agent);
      return agent;
    },
  });
  context.after(() => client.close());
  assert.equal(await (await client.fetch(`${origin}/api/status`)).text(), "192.168.100.160");
  assert.equal(destroys[0]!.mock.callCount(), 0);
  address = "192.168.100.161";
  assert.equal(await (await client.fetch(`${origin}/api/status`)).text(), "192.168.100.161");
  assert.deepEqual(optionsSeen.map(localAddress), ["192.168.100.160", "192.168.100.161"]);
  assert.equal(destroys[0]!.mock.callCount(), 1);
  assert.equal(destroys[1]!.mock.callCount(), 0);
  for (const agent of agents) agent.assertNoPendingInterceptors();
  await Promise.all([client.close(), client.close()]);
  assert.equal(destroys[0]!.mock.callCount(), 1);
  assert.equal(destroys[1]!.mock.callCount(), 1);
  await assert.rejects(client.fetch(`${origin}/api/status`), /connection is closed/);
  assert.equal(optionsSeen.length, 2, "A closed client must never create another pool.");
});

test("LAN HTTP keeps injected fetch compatible without a matching private interface or for loopback", async () => {
  for (const origin of ["http://10.65.201.94:8791", "http://127.0.0.1:8791"]) {
    let created = 0;
    const calls: { input: string; init: RequestInit | undefined }[] = [];
    const fetcher: typeof globalThis.fetch = async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response("injected", { status: 200 });
    };
    const client = new LanHttpClient(origin, {
      networkInterfaces: () => ({ WLAN: [subnet("192.168.100.160")] }),
      dispatcherFactory: () => { created++; throw new Error("Unexpected dispatcher creation."); },
      fetch: fetcher,
    });
    assert.equal(await (await client.fetch(`${origin}/status`, { headers: { "X-Test": "injected" } })).text(), "injected");
    assert.equal(created, 0);
    assert.equal(calls[0]!.input, `${origin}/status`);
    assert.equal(Object.hasOwn(calls[0]!.init!, "dispatcher"), false);
    assert.deepEqual(calls[0]!.init?.headers, { "X-Test": "injected" });
    await Promise.all([client.close(), client.close()]);
    await assert.rejects(client.fetch(`${origin}/status`), /connection is closed/);
    assert.equal(created, 0);
    assert.equal(calls.length, 1);
  }
});

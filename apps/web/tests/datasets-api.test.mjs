import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const bundled = await build({
  entryPoints: [fileURLToPath(new URL("../src/api/datasets.ts", import.meta.url))],
  bundle: true, write: false, format: "esm", platform: "node", target: "node24",
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function fixture(payload, status = 200) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    init.signal?.throwIfAborted();
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  };
  return calls;
}

test("dataset manifests and metric definitions use authenticated documented GET routes", async () => {
  const signal = new AbortController().signal;
  const manifests = [{ name: "sales", version: "v2", watermark: "2026-10-17", rowCount: 9, source: { tool: "mcp__erp__sales", sinceArg: "since" } }];
  const calls = fixture(manifests);
  assert.deepEqual(await api.listDatasets("http://fixture.test/qdd/", " token ", signal), manifests);
  assert.equal(calls[0].url, "http://fixture.test/qdd/api/datasets");
  assert.equal(calls[0].init.signal, signal);
  assert.equal(new Headers(calls[0].init.headers).get("Authorization"), "Bearer token");
  const catalog = { margin: { label: "毛利率", type: "ratio", numerator: "profit", denominator: "revenue", unit: "%" } };
  const metricCalls = fixture(catalog);
  assert.deepEqual(await api.getMetrics("http://fixture.test", "token", signal), catalog);
  assert.equal(metricCalls[0].url, "http://fixture.test/api/metrics");
  assert.equal(metricCalls[0].init.method ?? "GET", "GET");
});

test("incremental refresh preserves all-source and single-dataset requests and HTTP 200 partial errors", async () => {
  const results = [
    { dataset: "sales", added: 8, version: "v3", watermark: "2026-10-17" },
    { dataset: "inventory", added: 0, version: "v1", watermark: null, error: "数据工具不可用" },
  ];
  const calls = fixture(results);
  const signal = new AbortController().signal;
  assert.deepEqual(await api.refreshDatasets("http://fixture.test", "token", undefined, signal), results);
  await api.refreshDatasets("http://fixture.test", "token", ["门店/销售"], signal);
  assert.deepEqual(calls.map((call) => JSON.parse(call.init.body)), [{}, { datasets: ["门店/销售"] }]);
  for (const call of calls) {
    assert.equal(call.url, "http://fixture.test/api/datasets/refresh");
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.signal, signal);
    assert.equal(new Headers(call.init.headers).get("Content-Type"), "application/json");
    assert.equal(new Headers(call.init.headers).get("Authorization"), "Bearer token");
  }
  fixture([]);
  assert.deepEqual(await api.refreshDatasets("http://fixture.test", "token"), []);
});

test("HTTP errors and cancellation remain visible to data-panel callers", async () => {
  fixture({ error: "无权访问数据" }, 403);
  await assert.rejects(api.listDatasets("http://fixture.test", "token"), { name: "GatewayError", status: 403, message: "无权访问数据" });
  const controller = new AbortController();
  controller.abort();
  fixture([]);
  await assert.rejects(api.refreshDatasets("http://fixture.test", "token", ["sales"], controller.signal), { name: "AbortError" });
});

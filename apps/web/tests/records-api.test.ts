import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const bundled = await build({ entryPoints: [fileURLToPath(new URL("../src/api/records.ts", import.meta.url))], bundle: true, write: false, format: "esm", platform: "node", target: "node24" });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]!.text).toString("base64")}`);
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function fixture(payload: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    init.signal?.throwIfAborted();
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  };
  return calls;
}

test("record list and filtered queries use bearer authentication and preserve schema, total and typed values", async () => {
  const sets = [{ name: "loss_log", description: "报损", schema: { label: "报损登记", fields: [{ name: "qty", label: "数量", type: "number" }] }, rowCount: 2, watermark: null, updatedAt: "2026-10-17" }];
  const signal = new AbortController().signal;
  let calls = fixture(sets);
  assert.deepEqual(await api.listRecordSets("http://fixture.test/qdd/", " token ", signal), sets);
  assert.equal(calls[0]!.url, "http://fixture.test/qdd/api/records");
  assert.equal(new Headers(calls[0]!.init.headers).get("Authorization"), "Bearer token");
  const response = { schema: sets[0]!.schema, rows: [{ id: "row", time: "2026-10-17 10:30", page: "@admin", qty: 0, checked: false, note: null }], total: 12 };
  calls = fixture(response);
  assert.deepEqual(await api.queryRecords("http://fixture.test", "token", "name/with space", { from: "2026-10-01", to: "2026-10-17", limit: 500 }, signal), response);
  assert.equal(calls[0]!.url, "http://fixture.test/api/records/name%2Fwith%20space?from=2026-10-01&to=2026-10-17&limit=500");
  assert.equal(calls[0]!.init.signal, signal);
  await api.queryRecords("http://fixture.test", "token", "loss_log");
  assert.equal(calls[1]!.url, "http://fixture.test/api/records/loss_log");
});

test("schema creation and extension POST the full shared field shape without changing types or options", async () => {
  const input = { name: "checks", label: "巡检", description: "交班巡检", fields: [{ name: "checked", label: "已检查", type: "boolean", required: true }, { name: "result", label: "结果", type: "string", options: ["通过", "待处理"] }] };
  const result = { name: "checks", schema: { label: input.label, fields: input.fields } };
  const calls = fixture(result, 201);
  assert.deepEqual(await api.defineRecordSet("http://fixture.test", "token", input), result);
  assert.equal(calls[0]!.url, "http://fixture.test/api/records");
  assert.equal(calls[0]!.init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), input);
});

test("single and bulk writes preserve false, zero, null and string values; edit and void encode the record id", async () => {
  const row = { qty: 0, checked: false, note: null, reason: "试吃" };
  const calls = fixture({ rows: [row], row, ok: true });
  const signal = new AbortController().signal;
  await api.addRecords("http://fixture.test", "token", "checks", row, signal);
  await api.addRecords("http://fixture.test", "token", "checks", [row, { ...row, qty: 2 }], signal);
  await api.updateRecord("http://fixture.test", "token", "checks", "id/with space", { checked: true, note: null }, signal);
  await api.voidRecord("http://fixture.test", "token", "checks", "id/with space", signal);
  assert.deepEqual(calls.map((call) => call.init.method), ["POST", "POST", "PUT", "DELETE"]);
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), row);
  assert.deepEqual(JSON.parse(calls[1]!.init.body as string), [row, { ...row, qty: 2 }]);
  assert.deepEqual(JSON.parse(calls[2]!.init.body as string), { checked: true, note: null });
  assert.equal(calls[2]!.url, "http://fixture.test/api/records/checks/id%2Fwith%20space");
  assert.equal(calls[3]!.url, calls[2]!.url);
  assert.equal(calls[3]!.init.body, undefined);
  assert.ok(calls.every((call) => call.init.signal === signal));
});

test("validation/conflict/authorization failures and aborted requests reach the records panel", async () => {
  fixture({ error: "不能删除已有字段：qty" }, 409);
  await assert.rejects(api.defineRecordSet("http://fixture.test", "token", {}), { name: "GatewayError", status: 409, message: "不能删除已有字段：qty" });
  fixture({ error: "「数量」应为数字" }, 400);
  await assert.rejects(api.addRecords("http://fixture.test", "token", "checks", { qty: "bad" }), { status: 400, message: "「数量」应为数字" });
  fixture({ error: "无权访问" }, 403);
  await assert.rejects(api.listRecordSets("http://fixture.test", "token"), { status: 403 });
  const controller = new AbortController();
  controller.abort();
  fixture([]);
  await assert.rejects(api.queryRecords("http://fixture.test", "token", "checks", {}, controller.signal), { name: "AbortError" });
});

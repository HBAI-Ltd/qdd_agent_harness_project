import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { registerHooks } from "node:module";
import type { ConnectorView, ScheduleInput, SkillInput } from "@qdd/shared";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (cause) {
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context);
      throw cause;
    }
  },
});
const skillApi = await import("../src/api/skills.ts");
const scheduleApi = await import("../src/api/schedules.ts");
const { GatewayError } = await import("../src/api/workspace.ts");
const originalFetch = globalThis.fetch;
const base = "http://127.0.0.1:5173";
const token = "test-domain-token";
afterEach(() => { globalThis.fetch = originalFetch; });
after(() => { hooks.deregister(); });

function response(payload: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  };
  return calls;
}

test("skill CRUD uses exact documented routes, array steps and exact tool identifiers", async () => {
  const signal = new AbortController().signal;
  const input: SkillInput = { name: "经营日报", description: "每天看经营变化", steps: ["查询销售", "整理经营结论"], tools: ["store__sales_summary", "send_notification"] };
  const saved = { ...input, id: "skill/中文", tools: input.tools, source: "user", createdAt: "now", updatedAt: "now" };
  const calls = response(saved);
  await skillApi.listSkills(base + "/", ` ${token} `, signal);
  await skillApi.getSkill(base, token, saved.id, signal);
  assert.deepEqual(await skillApi.createSkill(base, token, input, signal), saved);
  await skillApi.updateSkill(base, token, saved.id, { ...input, steps: ["更新后的步骤"] }, signal);
  await skillApi.deleteSkill(base, token, saved.id, signal);
  const itemPath = `${base}/api/skills/skill%2F%E4%B8%AD%E6%96%87`;
  assert.deepEqual(calls.map((call) => call.url), [base + "/api/skills", itemPath, base + "/api/skills", itemPath, itemPath]);
  assert.deepEqual(calls.map((call) => call.init.method ?? "GET"), ["GET", "GET", "POST", "PUT", "DELETE"]);
  assert.deepEqual(JSON.parse(String(calls[2]!.init.body)), input);
  assert.deepEqual(JSON.parse(String(calls[3]!.init.body)).steps, ["更新后的步骤"]);
  for (const call of calls) {
    assert.equal(new Headers(call.init.headers).get("Authorization"), `Bearer ${token}`);
    assert.equal(call.init.signal, signal);
    assert.equal(call.url.includes(token), false);
  }
});

test("schedule CRUD preserves partial updates, explicit detach values and run session id", async () => {
  const signal = new AbortController().signal;
  const calls = response({ sessionId: "actual-run-session" });
  const input: ScheduleInput = { name: "日报", cron: "0 8 * * *", prompt: "整理昨日经营结论", skillId: "skill-id", slug: "daily-page", notify: { connectorId: "feishu-id" }, enabled: false };
  await scheduleApi.listSchedules(base, token, signal);
  await scheduleApi.getSchedule(base, token, "job/1", signal);
  await scheduleApi.createSchedule(base, token, input, signal);
  await scheduleApi.updateSchedule(base, token, "job/1", { enabled: true }, signal);
  await scheduleApi.updateSchedule(base, token, "job/1", { skillId: null, slug: null, notify: null }, signal);
  const result = await scheduleApi.runSchedule(base, token, "job/1", signal);
  await scheduleApi.deleteSchedule(base, token, "job/1", signal);
  assert.deepEqual(result, { sessionId: "actual-run-session" });
  assert.deepEqual(JSON.parse(String(calls[2]!.init.body)), input);
  assert.deepEqual(JSON.parse(String(calls[3]!.init.body)), { enabled: true });
  assert.deepEqual(JSON.parse(String(calls[4]!.init.body)), { skillId: null, slug: null, notify: null });
  assert.equal(calls[5]!.url, base + "/api/schedules/job%2F1/run");
  assert.equal(calls[5]!.init.method, "POST");
  assert.equal(calls[5]!.init.body, undefined);
  assert.equal(calls[6]!.init.method, "DELETE");
  assert.ok(calls.every((call) => call.init.signal === signal));
});

test("HTTP 409 retains the backend explanation for a skill referenced by a schedule", async () => {
  response({ error: "技能被定时任务使用中：经营日报" }, 409);
  await assert.rejects(skillApi.deleteSkill(base, token, "skill-id"), (cause: unknown) => {
    assert.ok(cause instanceof GatewayError);
    assert.equal(cause.status, 409);
    assert.equal(cause.message, "技能被定时任务使用中：经营日报");
    return true;
  });
});

test("cron shortcuts use gateway-time rules and preserve a custom existing expression", () => {
  assert.equal(scheduleApi.scheduleCron("daily", "08:05", "1", ""), "5 8 * * *");
  assert.equal(scheduleApi.scheduleCron("weekly", "09:00", "0", ""), "0 9 * * 0");
  assert.equal(scheduleApi.scheduleCron("hourly", "", "", ""), "0 */2 * * *");
  assert.equal(scheduleApi.scheduleCron("custom", "", "", "0 8-18/2 * * 1-5"), "0 8-18/2 * * 1-5");
  assert.throws(() => scheduleApi.scheduleCron("custom", "", "", "0 8 * *"), /5 段/);
  assert.throws(() => scheduleApi.scheduleCron("daily", "24:00", "1", ""), /有效/);
});

test("empty optional links are omitted at create and explicitly detached at edit", () => {
  const values = { name: " 日报 ", prompt: " 整理经营结论 ", cron: "0 8 * * *", skillId: "", slug: "", connectorId: "", enabled: false };
  assert.deepEqual(scheduleApi.scheduleInput(values, false), { name: "日报", prompt: "整理经营结论", cron: "0 8 * * *", enabled: false });
  assert.deepEqual(scheduleApi.scheduleInput(values, true), { name: "日报", prompt: "整理经营结论", cron: "0 8 * * *", enabled: false, skillId: null, slug: null, notify: null });
  assert.deepEqual(scheduleApi.scheduleInput({ ...values, connectorId: "target" }, true).notify, { connectorId: "target" });
});

test("notification targets require an installed connected sender and actual recipient capability", () => {
  const connector: ConnectorView = { id: "target", type: "feishu", name: "飞书", origin: "installed", permission: "confirm", status: "connected", detail: "已验证", config: { mode: "webhook", webhookUrl: "https://open.feishu.cn/...****" }, createdAt: null, lastVerifiedAt: null };
  assert.equal(scheduleApi.canNotify(connector), true);
  assert.equal(scheduleApi.canNotify({ ...connector, permission: "read" }), false);
  assert.equal(scheduleApi.canNotify({ ...connector, status: "error" }), false);
  assert.equal(scheduleApi.canNotify({ ...connector, origin: "mcp" }), false);
  assert.equal(scheduleApi.canNotify({ ...connector, config: { mode: "app", appSecret: true, receiveId: "" } }), false);
  assert.equal(scheduleApi.canNotify({ ...connector, config: { mode: "app", appSecret: false, receiveId: "chat-id" } }), false);
  assert.equal(scheduleApi.canNotify({ ...connector, config: { mode: "app", appSecret: true, receiveId: "chat-id" } }), true);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent } from "@qdd/shared";
import { approvalPresentation, recordApprovalPreview, scheduleApprovalPreview } from "../src/utils/approvalPreview.ts";

type Approval = Extract<SessionEvent, { type: "approval_required" }>;
const request = (tool: string, args: Approval["args"]): Approval => ({ type: "approval_required", requestId: "request-1", source: "harness", tool, args, at: "2026-10-17T12:00:00Z" });
const recordArgs = { name: "records/loss_log", label: "试吃报损登记", fields: ["商品（sku，string，必填）", "数量（qty，number，必填）", "原因（reason，string：试吃/破损）"] };
const scheduleArgs = { name: "每日临期提醒", cron: "0 9 * * *", nextRun: "2026/10/18 09:00:00", prompt: "检查未来三天到期的库存，并推送结论。", page: "expiry-page", skill: "临期预警", notify: "门店经营群" };

test("record approval uses the gateway's field summaries including requirements and choices", () => {
  const event = request("define_record", structuredClone(recordArgs));
  const before = structuredClone(event);
  const preview = recordApprovalPreview(event);
  assert.deepEqual(preview, recordArgs);
  assert.match(preview!.fields[0]!, /必填/);
  assert.match(preview!.fields[2]!, /试吃\/破损/);
  assert.notEqual(preview!.fields, event.args.fields);
  assert.deepEqual(event, before);
});

test("malformed record summaries fall back instead of silently hiding unknown fields", () => {
  for (const args of [{ ...recordArgs, fields: [{ name: "sku", type: "string" }] }, { ...recordArgs, fields: [] }, { ...recordArgs, fields: ["数量", null] }, { ...recordArgs, name: "loss_log" }]) {
    assert.equal(recordApprovalPreview(request("define_record", args)), undefined);
  }
  assert.equal(recordApprovalPreview(request("save_skill", recordArgs)), undefined);
});

test("schedule approval preserves gateway-local nextRun and resolved push target without date conversion", () => {
  const event = request("create_schedule", { ...scheduleArgs, confirmed: "true" });
  const before = structuredClone(event);
  assert.deepEqual(scheduleApprovalPreview(event), scheduleArgs);
  assert.deepEqual(event, before);
  assert.equal(scheduleApprovalPreview(request("create_schedule", { name: "经营日报", cron: "0 8 * * *", nextRun: "2026/10/18 08:00:00", prompt: "汇总销售" }))?.notify, undefined);
});

test("malformed schedules preserve the raw approval fallback", () => {
  for (const args of [{ ...scheduleArgs, nextRun: undefined }, { ...scheduleArgs, cron: "0 8 * *" }, { ...scheduleArgs, page: true }, { ...scheduleArgs, notify: { connectorId: "feishu" } }, { ...scheduleArgs, prompt: "" }]) {
    assert.equal(scheduleApprovalPreview(request("create_schedule", args)), undefined);
  }
  assert.equal(scheduleApprovalPreview(request("define_record", scheduleArgs)), undefined);
});

test("approval copy retains explicit opt-in decisions and the existing skill and general labels", () => {
  assert.equal(approvalPresentation("define_record").approve, "确认登记表结构");
  assert.equal(approvalPresentation("create_schedule").decline, "暂不创建");
  assert.equal(approvalPresentation("save_skill").approve, "就这样，保存为技能");
  assert.equal(approvalPresentation("browser").approve, "允许执行");
});

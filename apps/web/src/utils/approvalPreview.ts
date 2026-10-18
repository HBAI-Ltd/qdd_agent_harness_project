import type { SessionEvent } from "@qdd/shared";

type ApprovalEvent = Extract<SessionEvent, { type: "approval_required" }>;

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** The gateway sends human-readable field summaries, rather than RecordField objects. */
export function recordApprovalPreview(request: ApprovalEvent) {
  if (request.tool !== "define_record") return undefined;
  const { name, label, fields } = request.args;
  if (!nonEmptyText(name) || !/^records\/[a-z][a-z0-9_]{0,39}$/.test(name)
    || !nonEmptyText(label) || !Array.isArray(fields) || fields.length < 1
    || !fields.every(nonEmptyText)) return undefined;
  return { name, label, fields: [...fields] };
}

/** nextRun is already formatted in the gateway's local timezone; do not parse it as browser time. */
export function scheduleApprovalPreview(request: ApprovalEvent) {
  if (request.tool !== "create_schedule") return undefined;
  const { name, cron, nextRun, prompt, skill, page, notify } = request.args;
  if (!nonEmptyText(name) || !nonEmptyText(cron) || cron.trim().split(/\s+/).length !== 5
    || !nonEmptyText(nextRun) || !nonEmptyText(prompt)
    || [skill, page, notify].some((value) => value !== undefined && !nonEmptyText(value))) return undefined;
  return { name, cron, nextRun, prompt, skill: skill as string | undefined, page: page as string | undefined, notify: notify as string | undefined };
}

export function approvalPresentation(tool: string) {
  switch (tool) {
    case "save_skill":
      return { title: "把这套做法保存为技能", category: "保存前确认", description: "助手整理了以下步骤，确认后可以在其他对话和定时任务中复用。", decline: "再改改", approve: "就这样，保存为技能" };
    case "define_record":
      return { title: "确认登记表结构", category: "建立或扩展登记表", description: "确认登记字段后，助手将建立或扩展这张表，供门店逐条登记。", decline: "再改改", approve: "确认登记表结构" };
    case "create_schedule":
      return { title: "确认创建定时任务", category: "创建前确认", description: "核对执行规则、任务内容与推送接收方，确认后启用定时执行。", decline: "暂不创建", approve: "确认创建定时任务" };
    case "edit_schedules":
      return { title: "确认修改定时任务", category: "修改前确认", description: "核对任务 ID 和 changes 中的修改项；未列出的配置保持不变，null 表示解除绑定。修改不会取消正在执行的任务。", decline: "暂不修改", approve: "确认修改定时任务" };
    default:
      return { title: "需要你的授权", category: "写入操作", description: "助手申请执行以下操作，请确认后继续。", decline: "拒绝", approve: "允许执行" };
  }
}

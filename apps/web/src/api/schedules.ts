import type { ConnectorView, Schedule, ScheduleInput } from "@qdd/shared";
import { gatewayJson } from "./workspace";

export function listSchedules(base: string, token: string, signal?: AbortSignal): Promise<Schedule[]> {
  return gatewayJson(base, token, "/api/schedules", { signal: signal ?? null });
}
export function getSchedule(base: string, token: string, id: string, signal?: AbortSignal): Promise<Schedule> {
  return gatewayJson(base, token, `/api/schedules/${encodeURIComponent(id)}`, { signal: signal ?? null });
}
export function createSchedule(base: string, token: string, input: ScheduleInput, signal?: AbortSignal): Promise<Schedule> {
  return gatewayJson(base, token, "/api/schedules", { method: "POST", body: JSON.stringify(input), signal: signal ?? null });
}
export function updateSchedule(base: string, token: string, id: string, input: Partial<ScheduleInput>, signal?: AbortSignal): Promise<Schedule> {
  return gatewayJson(base, token, `/api/schedules/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input), signal: signal ?? null });
}
export async function deleteSchedule(base: string, token: string, id: string, signal?: AbortSignal): Promise<void> {
  await gatewayJson(base, token, `/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE", signal: signal ?? null });
}
export function runSchedule(base: string, token: string, id: string, signal?: AbortSignal): Promise<{ sessionId: string }> {
  return gatewayJson(base, token, `/api/schedules/${encodeURIComponent(id)}/run`, { method: "POST", signal: signal ?? null });
}

export type ScheduleFrequency = "daily" | "weekly" | "hourly" | "custom";

export function scheduleCron(frequency: ScheduleFrequency, time: string, weekday: string, raw: string): string {
  if (frequency === "custom") {
    const value = raw.trim();
    if (value.split(/\s+/).length !== 5) throw new Error("执行规则需要填写 5 段 cron。");
    return value;
  }
  if (frequency === "hourly") return "0 */2 * * *";
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error("请选择有效的执行时间。");
  if (frequency === "weekly" && !/^[0-6]$/.test(weekday)) throw new Error("请选择每周执行的日期。");
  return `${Number(match[2])} ${Number(match[1])} * * ${frequency === "weekly" ? weekday : "*"}`;
}

export function scheduleInput(
  values: { name: string; prompt: string; cron: string; skillId: string; slug: string; connectorId: string; enabled: boolean },
  editing: boolean,
): ScheduleInput {
  return {
    name: values.name.trim(), cron: values.cron, prompt: values.prompt.trim(), enabled: values.enabled,
    ...(values.skillId ? { skillId: values.skillId } : editing ? { skillId: null } : {}),
    ...(values.slug ? { slug: values.slug } : editing ? { slug: null } : {}),
    ...(values.connectorId ? { notify: { connectorId: values.connectorId } } : editing ? { notify: null } : {}),
  };
}

export function canNotify(connector: ConnectorView): boolean {
  return connector.origin === "installed" && connector.type === "feishu"
    && connector.status === "connected" && connector.permission !== "read"
    && (connector.config.mode === "webhook" ? !!connector.config.webhookUrl
      : connector.config.mode === "app" && !!connector.config.appSecret
        && typeof connector.config.receiveId === "string" && !!connector.config.receiveId.trim());
}

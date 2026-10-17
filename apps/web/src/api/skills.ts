import type { Skill, SkillInput } from "@qdd/shared";
import { gatewayJson } from "./workspace";

export function listSkills(base: string, token: string, signal?: AbortSignal): Promise<Skill[]> {
  return gatewayJson(base, token, "/api/skills", { signal: signal ?? null });
}
export function getSkill(base: string, token: string, id: string, signal?: AbortSignal): Promise<Skill> {
  return gatewayJson(base, token, `/api/skills/${encodeURIComponent(id)}`, { signal: signal ?? null });
}
export function createSkill(base: string, token: string, input: SkillInput, signal?: AbortSignal): Promise<Skill> {
  return gatewayJson(base, token, "/api/skills", { method: "POST", body: JSON.stringify(input), signal: signal ?? null });
}
export function updateSkill(base: string, token: string, id: string, input: SkillInput, signal?: AbortSignal): Promise<Skill> {
  return gatewayJson(base, token, `/api/skills/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input), signal: signal ?? null });
}
export async function deleteSkill(base: string, token: string, id: string, signal?: AbortSignal): Promise<void> {
  await gatewayJson(base, token, `/api/skills/${encodeURIComponent(id)}`, { method: "DELETE", signal: signal ?? null });
}

import { randomUUID } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Skill, SkillInput } from "@qdd/shared";
import type { HarnessPaths } from "../config.js";
import { writeAtomic } from "../web/site.js";
import { builtinSkills } from "./builtin-skills.js";

const ID_RE = /^[0-9a-f-]{36}$/;
const MAX_STEPS = 12;

export class InvalidInput extends Error {}
export class Missing extends Error {}

/** 校验并规范化技能输入；错误时抛 InvalidInput。 */
export function parseSkillInput(raw: unknown): SkillInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!name) throw new InvalidInput("name 不能为空");
  if (!Array.isArray(body.steps) || !body.steps.length || body.steps.length > MAX_STEPS) throw new InvalidInput(`steps 需要 1-${MAX_STEPS} 个步骤`);
  if (body.steps.some((s) => typeof s !== "string" || !s.trim())) throw new InvalidInput("steps 必须是非空字符串");
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((t) => typeof t !== "string"))) throw new InvalidInput("tools 必须是字符串数组");
  return {
    name: name.slice(0, 30),
    description: description.slice(0, 200),
    steps: (body.steps as string[]).map((s) => s.trim().slice(0, 300)),
    tools: [...new Set(((body.tools as string[] | undefined) ?? []).map((t) => t.trim()).filter(Boolean))],
  };
}

/** 技能存储：skills/<id>.json，一个技能一个文件。 */
export class SkillStore {
  constructor(private readonly paths: HarnessPaths) {}

  private file(id: string): string {
    if (!ID_RE.test(id)) throw new Missing("技能不存在");
    return path.join(this.paths.skills, `${id}.json`);
  }

  async list(): Promise<Skill[]> {
    const builtins = await builtinSkills();
    let names: string[];
    try {
      names = (await readdir(this.paths.skills)).filter((n) => n.endsWith(".json"));
    } catch {
      return builtins;
    }
    const skills = await Promise.all(names.map((n) => this.get(n.slice(0, -5)).catch(() => undefined)));
    return [...builtins, ...skills.filter((s): s is Skill => !!s && !builtins.some((b) => b.id === s.id))]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<Skill> {
    const builtin = (await builtinSkills()).find((s) => s.id === id);
    if (builtin) return builtin;
    try {
      return JSON.parse(await readFile(this.file(id), "utf8")) as Skill;
    } catch (error) {
      if (error instanceof Missing) throw error;
      throw new Missing("技能不存在");
    }
  }

  /** 按 id 或名称查找（agent 常用名称引用）。 */
  async find(ref: string): Promise<Skill | undefined> {
    const key = ref.trim();
    if (ID_RE.test(key)) return this.get(key).catch(() => undefined);
    return (await this.list()).find((s) => s.name === key);
  }

  async create(input: SkillInput, source: Skill["source"], sessionId?: string): Promise<Skill> {
    if ((await this.list()).some((s) => s.name === input.name)) throw new InvalidInput(`已存在同名技能「${input.name}」`);
    const now = new Date().toISOString();
    const skill: Skill = { id: randomUUID(), ...input, tools: input.tools ?? [], source, ...(sessionId ? { sessionId } : {}), createdAt: now, updatedAt: now };
    await writeAtomic(this.file(skill.id), JSON.stringify(skill, null, 2));
    return skill;
  }

  async update(id: string, input: SkillInput): Promise<Skill> {
    const current = await this.get(id);
    if (current.source === "builtin") throw new InvalidInput("内置技能随项目更新，不能在工作台编辑");
    if ((await this.list()).some((s) => s.name === input.name && s.id !== id)) throw new InvalidInput(`已存在同名技能「${input.name}」`);
    const skill: Skill = { ...current, ...input, tools: input.tools ?? [], updatedAt: new Date().toISOString() };
    await writeAtomic(this.file(id), JSON.stringify(skill, null, 2));
    return skill;
  }

  async remove(id: string): Promise<void> {
    const current = await this.get(id);
    if (current.source === "builtin") throw new InvalidInput("内置技能默认加载，不能在工作台删除");
    await rm(this.file(id), { force: true });
  }
}

/** 技能展开为 agent 可执行的说明。 */
export function skillInstructions(skill: Skill): string {
  return `技能「${skill.name}」：${skill.description}\n步骤：\n${skill.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}${skill.tools.length ? `\n会用到的工具：${skill.tools.join("、")}` : ""}${skill.instructions ? `\n\n完整说明：\n${skill.instructions}` : ""}`;
}

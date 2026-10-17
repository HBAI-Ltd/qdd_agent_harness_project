import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Schedule, ScheduleInput, ScheduleRun } from "@qdd/shared";
import type { LoadedConfig } from "../config.js";
import type { SessionHub } from "../sessions.js";
import { readPages, writeAtomic } from "../web/site.js";
import { nextRun, parseCron } from "./cron.js";
import type { Workbench } from "./index.js";
import { InvalidInput, Missing } from "./skills.js";

const TICK_MS = 30_000;
/** 单次执行最长等待（含等待店长授权） */
const RUN_TIMEOUT_MS = 6 * 3600_000;

/**
 * 定时任务：schedules.json 持久化，网关进程内每 30 秒检查一次到期任务。
 * 到点以无人值守模式发起会话（不提问，写入仍需店长在工作台授权），完成后按配置推送。
 * 网关停机期间错过的执行，在启动后补跑一次。
 */
export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private readonly active = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly loaded: LoadedConfig,
    private readonly hub: SessionHub,
    private readonly workbench: Workbench,
    private readonly now: () => Date = () => new Date(),
  ) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 正在执行的任务 id */
  running(): string[] {
    return [...this.active];
  }

  async list(): Promise<Schedule[]> {
    try {
      return (JSON.parse(await readFile(this.loaded.paths.schedules, "utf8")) as { schedules: Schedule[] }).schedules;
    } catch {
      return [];
    }
  }

  async get(id: string): Promise<Schedule> {
    const s = (await this.list()).find((x) => x.id === id);
    if (!s) throw new Missing("定时任务不存在");
    return s;
  }

  async create(raw: unknown, createdBy?: Schedule["createdBy"]): Promise<Schedule> {
    const input = await this.parse(raw, true);
    const now = this.now().toISOString();
    const schedule: Schedule = {
      id: randomUUID(),
      name: input.name,
      cron: input.cron,
      prompt: input.prompt,
      ...(input.skillId ? { skillId: input.skillId } : {}),
      ...(input.slug ? { slug: input.slug } : {}),
      ...(input.notify ? { notify: input.notify } : {}),
      ...(createdBy ? { createdBy } : {}),
      enabled: input.enabled ?? true,
      nextRunAt: null,
      lastRun: null,
      createdAt: now,
      updatedAt: now,
    };
    schedule.nextRunAt = schedule.enabled ? this.next(schedule.cron) : null;
    await this.mutate((all) => all.push(schedule));
    return schedule;
  }

  async update(id: string, raw: unknown): Promise<Schedule> {
    const input = await this.parse(raw, false);
    return this.mutate((all) => {
      const s = all.find((x) => x.id === id);
      if (!s) throw new Missing("定时任务不存在");
      const cronChanged = input.cron !== undefined && input.cron !== s.cron;
      if (input.name !== undefined) s.name = input.name;
      if (input.cron !== undefined) s.cron = input.cron;
      if (input.prompt !== undefined) s.prompt = input.prompt;
      for (const k of ["skillId", "slug", "notify"] as const) {
        if (input[k] === null) delete s[k];
        else if (input[k] !== undefined) (s as unknown as Record<string, unknown>)[k] = input[k];
      }
      const enabling = input.enabled === true && !s.enabled;
      if (input.enabled !== undefined) s.enabled = input.enabled;
      if (!s.enabled) s.nextRunAt = null;
      else if (cronChanged || enabling || !s.nextRunAt) s.nextRunAt = this.next(s.cron);
      s.updatedAt = this.now().toISOString();
      return s;
    });
  }

  async remove(id: string): Promise<void> {
    await this.mutate((all) => {
      const i = all.findIndex((x) => x.id === id);
      if (i < 0) throw new Missing("定时任务不存在");
      all.splice(i, 1);
    });
  }

  /** 立即执行一次（不改变下次执行时间），返回会话 id。 */
  async runNow(id: string): Promise<string> {
    const s = await this.get(id);
    if (this.active.has(id)) throw new InvalidInput("任务正在执行");
    return this.launch(s);
  }

  private ticking: Promise<void> | undefined;

  /** 检查并执行到期任务（测试可直接调用）；并发调用共用同一次检查，避免重复执行。 */
  tick(): Promise<void> {
    this.ticking ??= this.check().finally(() => (this.ticking = undefined));
    return this.ticking;
  }

  private async check(): Promise<void> {
    const now = this.now();
    const due = (await this.list()).filter((s) => s.enabled && s.nextRunAt && new Date(s.nextRunAt) <= now && !this.active.has(s.id));
    for (const s of due) {
      // 先推进下次时间，即使执行失败也不会每 30 秒重试
      await this.mutate((all) => {
        const t = all.find((x) => x.id === s.id);
        if (t) t.nextRunAt = this.next(t.cron);
      });
      await this.launch(s).catch(() => undefined);
    }
  }

  private async launch(s: Schedule): Promise<string> {
    this.active.add(s.id);
    let sessionId: string;
    try {
      const meta = await this.hub.create(s.prompt, {
        slug: s.slug,
        skillId: s.skillId,
        unattended: true,
        origin: { kind: "schedule", scheduleId: s.id, scheduleName: s.name },
      });
      sessionId = meta.id;
    } catch (error) {
      this.active.delete(s.id);
      await this.record(s.id, { at: this.now().toISOString(), sessionId: null, status: "error", message: (error as Error).message });
      throw error;
    }
    this.emitChange();
    void this.follow(s, sessionId);
    return sessionId;
  }

  private async follow(s: Schedule, sessionId: string): Promise<void> {
    const at = this.now().toISOString();
    let run: ScheduleRun;
    try {
      const meta = await Promise.race([
        this.hub.wait(sessionId),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("执行超时")), RUN_TIMEOUT_MS).unref()),
      ]);
      const detail = await this.hub.detail(sessionId);
      const error = [...detail.events].reverse().find((e) => e.type === "error");
      run = meta.status === "error"
        ? { at, sessionId, status: "error", message: error?.type === "error" ? error.message : "执行失败" }
        : { at, sessionId, status: "ok", message: meta.summary || "已完成" };
      if (s.notify) {
        const page = meta.slug ? (await readPages(this.loaded.paths)).find((p) => p.slug === meta.slug) : undefined;
        const text = run.status === "ok"
          ? `【${s.name}】${run.message}${page ? `\n页面：${page.title}` : ""}`
          : `【${s.name}】本次执行失败：${run.message}`;
        try {
          await this.workbench.connectors.send(s.notify.connectorId, text);
          run.notified = { connectorId: s.notify.connectorId, ok: true };
        } catch (e) {
          run.notified = { connectorId: s.notify.connectorId, ok: false, error: (e as Error).message };
        }
      }
    } catch (error) {
      this.hub.cancel(sessionId);
      run = { at, sessionId, status: "error", message: (error as Error).message };
    }
    this.active.delete(s.id);
    await this.record(s.id, run);
  }

  private async record(id: string, run: ScheduleRun): Promise<void> {
    await this.mutate((all) => {
      const t = all.find((x) => x.id === id);
      if (t) t.lastRun = run;
    }).catch(() => undefined);
  }

  private next(cron: string): string | null {
    return nextRun(cron, this.now())?.toISOString() ?? null;
  }

  private mutate<T>(fn: (all: Schedule[]) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const all = await this.list();
      const out = fn(all);
      await writeAtomic(this.loaded.paths.schedules, JSON.stringify({ schedules: all }, null, 2));
      return out;
    });
    this.queue = run.catch(() => undefined);
    return run.then((out) => {
      this.emitChange();
      return out;
    });
  }

  private emitChange(): void {
    for (const l of this.listeners) l();
  }

  private async parse(raw: unknown, creating: boolean): Promise<Partial<ScheduleInput> & { name: string; cron: string; prompt: string }> {
    const body = (raw ?? {}) as Record<string, unknown>;
    const out: Partial<ScheduleInput> = {};
    const str = (k: string, max: number) => {
      if (body[k] === undefined) {
        if (creating) throw new InvalidInput(`${k} 不能为空`);
        return undefined;
      }
      if (typeof body[k] !== "string" || !(body[k] as string).trim()) throw new InvalidInput(`${k} 不能为空`);
      return (body[k] as string).trim().slice(0, max);
    };
    const name = str("name", 30);
    const cron = str("cron", 100);
    const prompt = str("prompt", 2000);
    if (name !== undefined) out.name = name;
    if (prompt !== undefined) out.prompt = prompt;
    if (cron !== undefined) {
      try {
        parseCron(cron);
      } catch (error) {
        throw new InvalidInput((error as Error).message);
      }
      if (!nextRun(cron, this.now())) throw new InvalidInput("cron 在一年内不会触发");
      out.cron = cron;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") throw new InvalidInput("enabled 必须是布尔值");
      out.enabled = body.enabled;
    }
    if (body.skillId !== undefined) {
      if (body.skillId === null) out.skillId = null;
      else {
        const skill = typeof body.skillId === "string" ? await this.workbench.skills.find(body.skillId) : undefined;
        if (!skill) throw new InvalidInput("技能不存在");
        out.skillId = skill.id;
      }
    }
    if (body.slug !== undefined) {
      if (body.slug === null) out.slug = null;
      else {
        if (typeof body.slug !== "string" || !(await readPages(this.loaded.paths)).some((p) => p.slug === body.slug)) throw new InvalidInput("页面不存在");
        out.slug = body.slug;
      }
    }
    if (body.notify !== undefined) {
      if (body.notify === null) out.notify = null;
      else {
        const id = (body.notify as { connectorId?: unknown } | undefined)?.connectorId;
        const target = typeof id === "string" ? await this.workbench.connectors.describe(id).catch(() => undefined) : undefined;
        if (!target) throw new InvalidInput("推送连接器不存在");
        if (target.permission === "read") throw new InvalidInput(`连接器「${target.name}」只允许查看，不能推送`);
        out.notify = { connectorId: target.id };
      }
    }
    return out as Partial<ScheduleInput> & { name: string; cron: string; prompt: string };
  }
}

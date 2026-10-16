import { randomUUID } from "node:crypto";
import { appendFile, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ClarifyAnswers, ClarifyQuestion, JsonObject, SessionDetail, SessionEvent, SessionMeta } from "@qdd/shared";
import { runWish, type AgentEvent } from "./agent/agent.js";
import type { ChatFn, ChatMessage } from "./agent/llm.js";
import type { LoadedConfig } from "./config.js";
import type { DataSources } from "./datasource/registry.js";
import { writeAtomic } from "./web/site.js";

/**
 * 会话存储（文件，无数据库）：
 *   sessions/<id>.meta.json      会话元信息
 *   sessions/<id>.events.jsonl   事件流（给前端回放）
 *   sessions/<id>.messages.json  完整 LLM 对话（续聊用）
 */
const ID_RE = /^[0-9a-f-]{36}$/;
const APPROVAL_TIMEOUT_MS = 5 * 60_000;
const QUESTION_TIMEOUT_MS = 30 * 60_000;

type Distribute<T> = T extends unknown ? Omit<T, "at"> : never;
export type NewEvent = Distribute<SessionEvent>;

interface PendingApproval {
  resolve(approved: boolean): void;
  timer: NodeJS.Timeout;
}

export class SessionHub {
  private readonly running = new Map<string, AbortController>();
  /** 页面 → 正在修改它的会话，同一页面同时只允许一个会话修改 */
  private readonly editing = new Map<string, string>();
  private readonly approvals = new Map<string, PendingApproval & { sessionId: string }>();
  private readonly questions = new Map<string, { sessionId: string; questions: ClarifyQuestion[]; resolve(a: ClarifyAnswers | null): void }>();
  /** 每个会话尚未处理的提问/授权数，>0 时状态为 waiting */
  private readonly pendingCount = new Map<string, number>();
  private readonly rounds = new Map<string, number>();
  private readonly listeners = new Map<string, Set<(e: SessionEvent) => void>>();
  private readonly metaListeners = new Set<(meta: SessionMeta) => void>();

  constructor(
    private readonly loaded: LoadedConfig,
    private readonly sources: DataSources,
    private readonly chat: () => ChatFn,
  ) {}

  private file(id: string, kind: "meta.json" | "events.jsonl" | "messages.json") {
    if (!ID_RE.test(id)) throw new NotFound("会话不存在");
    return path.join(this.loaded.paths.sessions, `${id}.${kind}`);
  }

  async list(): Promise<SessionMeta[]> {
    const names = (await readdir(this.loaded.paths.sessions)).filter((n) => n.endsWith(".meta.json"));
    const metas = await Promise.all(names.map((n) => this.meta(n.slice(0, -".meta.json".length)).catch(() => undefined)));
    return metas.filter((m): m is SessionMeta => !!m).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async meta(id: string): Promise<SessionMeta> {
    try {
      const meta = { summary: "", ...(JSON.parse(await readFile(this.file(id, "meta.json"), "utf8")) as Partial<SessionMeta>) } as SessionMeta;
      // 进程重启后遗留的 running 状态视为中断
      if (meta.status === "running" && !this.running.has(id)) meta.status = "error";
      return meta;
    } catch (error) {
      if (error instanceof NotFound) throw error;
      throw new NotFound("会话不存在");
    }
  }

  async detail(id: string): Promise<SessionDetail> {
    const meta = await this.meta(id);
    let raw = "";
    try {
      raw = await readFile(this.file(id, "events.jsonl"), "utf8");
    } catch {
      // 尚无事件
    }
    const events = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as SessionEvent);
    return { ...meta, events };
  }

  subscribe(id: string, listener: (e: SessionEvent) => void): () => void {
    const set = this.listeners.get(id) ?? new Set();
    set.add(listener);
    this.listeners.set(id, set);
    return () => set.delete(listener);
  }

  onMeta(listener: (meta: SessionMeta) => void): () => void {
    this.metaListeners.add(listener);
    return () => this.metaListeners.delete(listener);
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /** 发起许愿，返回会话 id；agent 在后台运行，进度通过事件推送。 */
  async create(wish: string, slug?: string): Promise<SessionMeta> {
    const now = new Date().toISOString();
    const meta: SessionMeta = { id: randomUUID(), title: wish.slice(0, 40), summary: "", slug: slug ?? null, status: "idle", createdAt: now, updatedAt: now };
    await this.saveMeta(meta);
    await this.start(meta, wish);
    return this.meta(meta.id);
  }

  /** 许愿之后在同一会话里继续对话。 */
  async send(id: string, text: string): Promise<SessionMeta> {
    const meta = await this.meta(id);
    if (this.running.has(id)) throw new Conflict("会话正在运行，请等待完成");
    await this.start(meta, text);
    return this.meta(id);
  }

  approve(id: string, requestId: string, approved: boolean): void {
    const pending = this.approvals.get(requestId);
    if (!pending || pending.sessionId !== id) throw new NotFound("授权请求不存在或已过期");
    pending.resolve(approved);
  }

  /** 回答澄清问题；校验答案必须是候选项（允许自填的问题除外）。 */
  answer(id: string, requestId: string, answers: ClarifyAnswers): void {
    const pending = this.questions.get(requestId);
    if (!pending || pending.sessionId !== id) throw new NotFound("问题不存在或已过期");
    const clean: ClarifyAnswers = {};
    for (const q of pending.questions) {
      const picked = answers[q.id];
      if (picked === undefined) continue;
      if (!Array.isArray(picked) || picked.some((v) => typeof v !== "string" || !v.trim())) throw new BadRequest(`问题 ${q.id} 的回答必须是字符串数组`);
      if (!q.multiSelect && picked.length > 1) throw new BadRequest(`问题 ${q.id} 是单选`);
      const labels = new Set(q.options.map((o) => o.label));
      const other = picked.filter((v) => !labels.has(v));
      if (other.length && !q.allowOther) throw new BadRequest(`问题 ${q.id} 只能从候选项中选择`);
      clean[q.id] = picked.map((v) => v.trim().slice(0, 300));
    }
    pending.resolve(clean);
  }

  cancel(id: string): void {
    this.running.get(id)?.abort();
  }

  /** 等待会话本轮结束（CLI 用）。 */
  async wait(id: string): Promise<SessionMeta> {
    while (this.running.has(id)) await new Promise((r) => setTimeout(r, 100));
    return this.meta(id);
  }

  private async start(meta: SessionMeta, text: string): Promise<void> {
    const chat = this.chat(); // 缺少 API key 时在这里同步报错
    if (meta.slug) {
      const holder = this.editing.get(meta.slug);
      if (holder && holder !== meta.id) throw new Conflict(`页面 ${meta.slug} 正在被会话 ${holder} 修改`);
      this.editing.set(meta.slug, meta.id);
    }
    const controller = new AbortController();
    this.running.set(meta.id, controller);
    await this.emit(meta.id, { type: "user", text });
    await this.setStatus(meta, "running");
    void this.run(meta, text, chat, controller);
  }

  private async run(meta: SessionMeta, text: string, chat: ChatFn, controller: AbortController): Promise<void> {
    const id = meta.id;
    try {
      let history: ChatMessage[] = [];
      try {
        history = JSON.parse(await readFile(this.file(id, "messages.json"), "utf8")) as ChatMessage[];
      } catch {
        // 新会话
      }
      const result = await runWish(
        this.loaded,
        this.sources,
        chat,
        { wish: text, sessionId: id, slug: meta.slug ?? undefined, history },
        {
          signal: controller.signal,
          onEvent: (e: AgentEvent) => {
            if (e.kind !== "ok") void this.emit(id, { type: e.kind, text: e.text });
          },
          authorize: (tool, args) => this.waitFor(meta, this.requestApproval(id, tool.name, tool.source, args)),
          clarify: (questions) => this.waitFor(meta, this.requestClarify(id, questions)),
        },
      );
      await writeAtomic(this.file(id, "messages.json"), JSON.stringify(result.messages));
      if (result.summary) meta.summary = result.summary;
      if (result.gaps.length) await this.emit(id, { type: "gaps", gaps: result.gaps });
      if (result.page) {
        meta.slug = result.page.slug;
        meta.title = result.page.title;
        await this.emit(id, { type: "published", page: result.page, files: result.files });
      }
      this.running.delete(id);
      await this.setStatus(meta, "idle");
    } catch (error) {
      await this.emit(id, { type: "error", message: controller.signal.aborted ? "已取消" : (error as Error).message });
      this.running.delete(id);
      await this.setStatus(meta, "error");
    } finally {
      this.running.delete(id);
      for (const [slug, holder] of this.editing) if (holder === id) this.editing.delete(slug);
      for (const q of this.questions.values()) if (q.sessionId === id) q.resolve(null);
      this.pendingCount.delete(id);
    }
  }

  /** 等待店长期间把状态切到 waiting，全部处理完再切回 running。 */
  private async waitFor<T>(meta: SessionMeta, pending: Promise<T>): Promise<T> {
    const n = (this.pendingCount.get(meta.id) ?? 0) + 1;
    this.pendingCount.set(meta.id, n);
    if (n === 1) await this.setStatus(meta, "waiting");
    try {
      return await pending;
    } finally {
      const left = (this.pendingCount.get(meta.id) ?? 1) - 1;
      this.pendingCount.set(meta.id, left);
      if (left === 0 && this.running.has(meta.id)) await this.setStatus(meta, "running");
    }
  }

  private requestClarify(sessionId: string, questions: ClarifyQuestion[]): Promise<ClarifyAnswers | null> {
    const requestId = randomUUID();
    const round = (this.rounds.get(sessionId) ?? 0) + 1;
    this.rounds.set(sessionId, round);
    return new Promise((resolve) => {
      const done = (answers: ClarifyAnswers | null) => {
        clearTimeout(timer);
        if (!this.questions.delete(requestId)) return;
        void this.emit(sessionId, { type: "question_answered", requestId, answers });
        resolve(answers);
      };
      const timer = setTimeout(() => done(null), QUESTION_TIMEOUT_MS);
      this.questions.set(requestId, { sessionId, questions, resolve: done });
      void this.emit(sessionId, { type: "question_required", requestId, round, questions });
    });
  }

  private requestApproval(sessionId: string, tool: string, source: string, args: JsonObject): Promise<boolean> {
    const requestId = randomUUID();
    return new Promise<boolean>((resolve) => {
      const done = (approved: boolean) => {
        clearTimeout(timer);
        this.approvals.delete(requestId);
        void this.emit(sessionId, { type: "approval_resolved", requestId, approved });
        resolve(approved);
      };
      const timer = setTimeout(() => done(false), APPROVAL_TIMEOUT_MS);
      this.approvals.set(requestId, { sessionId, resolve: done, timer });
      void this.emit(sessionId, { type: "approval_required", requestId, tool, source, args });
    });
  }

  private async setStatus(meta: SessionMeta, status: SessionMeta["status"]): Promise<void> {
    meta.status = status;
    meta.updatedAt = new Date().toISOString();
    await this.saveMeta(meta);
    await this.emit(meta.id, { type: "status", status });
    for (const l of this.metaListeners) l({ ...meta });
  }

  private saveMeta(meta: SessionMeta): Promise<void> {
    return writeAtomic(this.file(meta.id, "meta.json"), JSON.stringify(meta, null, 2));
  }

  private async emit(id: string, event: NewEvent): Promise<void> {
    const full = { ...event, at: new Date().toISOString() } as SessionEvent;
    await appendFile(this.file(id, "events.jsonl"), `${JSON.stringify(full)}\n`);
    for (const l of this.listeners.get(id) ?? []) l(full);
  }
}

export class NotFound extends Error {}
export class Conflict extends Error {}
export class BadRequest extends Error {}

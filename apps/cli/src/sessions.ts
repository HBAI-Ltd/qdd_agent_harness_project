import { randomUUID } from "node:crypto";
import { appendFile, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AttachmentRef, BrowserSessionState, ChatSelection, ClarifyAnswers, ClarifyQuestion, HarnessConfig, JsonObject, PendingItem, SessionDetail, SessionEvent, SessionMeta } from "@qdd/shared";
import { runWish, WishError, type AgentEvent } from "./agent/agent.js";
import { resolveChatSelection } from "./agent/chat-options.js";
import type { ChatFn, ChatMessage } from "./agent/llm.js";
import { AttachmentStore } from "./attachments.js";
import { resolveModel, type LoadedConfig } from "./config.js";
import type { DataSources } from "./datasource/registry.js";
import type { Workbench } from "./workbench/index.js";
import { writeAtomic } from "./web/site.js";

/**
 * 会话存储（文件，无数据库）：
 *   sessions/<id>.meta.json      会话元信息
 *   sessions/<id>.events.jsonl   事件流（给前端回放）
 *   sessions/<id>.messages.json  完整 LLM 对话（续聊用）
 * 定时任务使用相同文件格式，独立保存到 schedule-sessions/。
 */
const ID_RE = /^[0-9a-f-]{36}$/;
const QUESTION_TIMEOUT_MS = 30 * 60_000;

type Distribute<T> = T extends unknown ? Omit<T, "at"> : never;
export type NewEvent = Distribute<SessionEvent>;

type PendingDetail = PendingItem extends infer T ? (T extends unknown ? Omit<T, "sessionTitle" | "origin"> : never) : never;

export interface CreateOptions extends Partial<ChatSelection> {
  /** 在已有页面上修改 */
  slug?: string | undefined;
  origin?: SessionMeta["origin"];
  /** 预先加载的技能 */
  skillId?: string | undefined;
  /** 无人值守（定时任务）：不提问，授权仍进入工作台待办 */
  unattended?: boolean;
  attachments?: AttachmentRef[] | undefined;
}

export interface SendOptions extends Partial<ChatSelection> {
  attachments?: AttachmentRef[] | undefined;
}

export class SessionHub {
  private readonly directories = new Map<string, string>();
  private readonly running = new Map<string, AbortController>();
  private readonly recoveries = new Map<string, Promise<SessionMeta>>();
  private readonly activeMetas = new Map<string, SessionMeta>();
  /** 页面 → 正在修改它的会话，同一页面同时只允许一个会话修改 */
  private readonly editing = new Map<string, string>();
  private readonly approvals = new Map<string, { detail: PendingDetail; resolve(approved: boolean): void }>();
  private readonly questions = new Map<string, { detail: PendingDetail; questions: ClarifyQuestion[]; resolve(a: ClarifyAnswers | null): void }>();
  /** 无人值守运行的会话 */
  private readonly unattended = new Set<string>();
  private readonly pendingListeners = new Set<() => void>();
  /** 每个会话尚未处理的提问/授权数，>0 时状态为 waiting */
  private readonly pendingCount = new Map<string, number>();
  private readonly rounds = new Map<string, number>();
  private readonly listeners = new Map<string, Set<(e: SessionEvent) => void>>();
  private readonly metaListeners = new Set<(meta: SessionMeta) => void>();
  readonly attachments: AttachmentStore;

  constructor(
    private readonly loaded: LoadedConfig,
    private readonly sources: DataSources,
    private readonly chat: (llm: HarnessConfig["llm"]) => ChatFn,
    private readonly workbench?: Workbench,
  ) {
    this.attachments = new AttachmentStore(loaded.paths.attachments);
  }

  private file(id: string, kind: "meta.json" | "events.jsonl" | "messages.json") {
    if (!ID_RE.test(id)) throw new NotFound("会话不存在");
    return path.join(this.directories.get(id) ?? this.loaded.paths.sessions, `${id}.${kind}`);
  }

  async list(): Promise<SessionMeta[]> {
    const names = (await readdir(this.loaded.paths.sessions)).filter((n) => n.endsWith(".meta.json"));
    const metas = await Promise.all(names.map((n) => this.meta(n.slice(0, -".meta.json".length)).catch(() => undefined)));
    return metas.filter((m): m is SessionMeta => !!m && m.origin?.kind !== "schedule").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listScheduleSessions(scheduleId: string): Promise<SessionMeta[]> {
    const directories = [this.loaded.paths.sessions, this.loaded.paths.scheduleSessions];
    const names = await Promise.all(directories.map((directory) => readdir(directory)));
    const ids = new Set(names.flat().filter((name) => name.endsWith(".meta.json")).map((name) => name.slice(0, -".meta.json".length)));
    const metas = await Promise.all([...ids].map((id) => this.meta(id)));
    return metas.filter((meta) => meta.origin?.kind === "schedule" && meta.origin.scheduleId === scheduleId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  async meta(id: string): Promise<SessionMeta> {
    try {
      if (!ID_RE.test(id)) throw new NotFound("会话不存在");
      const known = this.directories.get(id);
      const directories = known ? [known] : [this.loaded.paths.sessions, this.loaded.paths.scheduleSessions];
      for (const directory of directories) {
        let raw: string;
        try {
          raw = await readFile(path.join(directory, `${id}.meta.json`), "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        const meta = { summary: "", ...(JSON.parse(raw) as Partial<SessionMeta>) } as SessionMeta;
        this.directories.set(id, directory);
        if ((meta.status === "running" || meta.status === "waiting") && !this.running.has(id)) {
          let recovery = this.recoveries.get(id);
          if (!recovery) {
            recovery = this.recoverInterrupted(meta).finally(() => this.recoveries.delete(id));
            this.recoveries.set(id, recovery);
          }
          return recovery;
        }
        return meta;
      }
      throw new NotFound("会话不存在");
    } catch (error) {
      if (error instanceof NotFound) throw error;
      throw new NotFound("会话不存在");
    }
  }

  private async recoverInterrupted(meta: SessionMeta): Promise<SessionMeta> {
    // 并发详情/列表请求可能读到恢复前的快照，写入终态前重新确认。
    const current = JSON.parse(await readFile(this.file(meta.id, "meta.json"), "utf8")) as SessionMeta;
    if ((current.status === "running" || current.status === "waiting") && !this.running.has(meta.id)) {
      await this.emit(meta.id, { type: "error", message: "服务已重启，本轮执行已中断，请重新发送消息继续。" });
      await this.setStatus(current, "error");
    }
    return { ...current, summary: current.summary ?? "" };
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

  /** 人工关闭浏览器等外部状态变更也写入历史，并同步给正在观看对话的客户端。 */
  async recordBrowserState(id: string, browser: BrowserSessionState): Promise<void> {
    await this.meta(id);
    await this.emit(id, { type: "browser", browser });
  }

  onMeta(listener: (meta: SessionMeta) => void): () => void {
    this.metaListeners.add(listener);
    return () => this.metaListeners.delete(listener);
  }

  onPending(listener: () => void): () => void {
    this.pendingListeners.add(listener);
    return () => this.pendingListeners.delete(listener);
  }

  private pendingChanged(): void {
    for (const l of this.pendingListeners) l();
  }

  /** 所有会话里等待店长处理的授权与问题（工作台待办）。 */
  async pending(): Promise<PendingItem[]> {
    const details = [...[...this.approvals.values()].map((a) => a.detail), ...[...this.questions.values()].map((q) => q.detail)];
    const metas = new Map<string, SessionMeta | undefined>();
    for (const d of details) if (!metas.has(d.sessionId)) metas.set(d.sessionId, await this.meta(d.sessionId).catch(() => undefined));
    return details
      .map((d) => {
        const meta = metas.get(d.sessionId);
        return { ...d, sessionTitle: meta?.title ?? "", ...(meta?.origin ? { origin: meta.origin } : {}) } as PendingItem;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /** 发起许愿，返回会话 id；agent 在后台运行，进度通过事件推送。 */
  async create(wish: string, options: CreateOptions | string = {}): Promise<SessionMeta> {
    const opts: CreateOptions = typeof options === "string" ? { slug: options } : options;
    const selection = resolveChatSelection(this.loaded.config.llm, opts);
    let skill: { id: string; name: string } | undefined;
    if (opts.skillId) {
      if (!this.workbench) throw new BadRequest("技能不可用");
      const found = await this.workbench.skills.find(opts.skillId);
      if (!found) throw new NotFound("技能不存在");
      skill = { id: found.id, name: found.name };
    }
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id: randomUUID(),
      title: (opts.origin?.scheduleName ?? wish).slice(0, 40),
      summary: "",
      slug: opts.slug ?? null,
      status: "idle",
      ...selection,
      ...(opts.origin ? { origin: opts.origin } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.saveMeta(meta);
    if (opts.unattended) this.unattended.add(meta.id);
    try {
      await this.start(meta, wish, opts.attachments ?? [], skill?.id);
    } catch (error) {
      this.unattended.delete(meta.id);
      throw error;
    }
    return this.meta(meta.id);
  }

  /** 许愿之后在同一会话里继续对话。 */
  async send(id: string, text: string, options: SendOptions = {}): Promise<SessionMeta> {
    const meta = await this.meta(id);
    if (this.running.has(id)) throw new Conflict("会话正在运行，请等待完成");
    await this.start(meta, text, options.attachments ?? [], undefined, options);
    return this.meta(id);
  }

  /** 切换会话模型；运行中的一轮保持原模型，下一轮起生效。 */
  async selectModel(id: string, model: string): Promise<SessionMeta> {
    const meta = this.activeMetas.get(id) ?? await this.meta(id);
    Object.assign(meta, resolveChatSelection(this.loaded.config.llm, { model }, meta));
    meta.updatedAt = new Date().toISOString();
    await this.saveMeta(meta);
    for (const l of this.metaListeners) l({ ...meta });
    return meta;
  }

  approve(id: string, requestId: string, approved: boolean): void {
    const pending = this.approvals.get(requestId);
    if (!pending || pending.detail.sessionId !== id) throw new NotFound("授权请求不存在或已过期");
    pending.resolve(approved);
  }

  /** 回答澄清问题；校验答案必须是候选项（允许自填的问题除外）。 */
  answer(id: string, requestId: string, answers: ClarifyAnswers): void {
    const pending = this.questions.get(requestId);
    if (!pending || pending.detail.sessionId !== id) throw new NotFound("问题不存在或已过期");
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
    const controller = this.running.get(id);
    if (!controller) return;
    controller.abort();
    // 正在等店长回答或授权时，agent 阻塞在等待上收不到中止信号：立即结束这些等待（问题视为未回答、授权视为拒绝）
    for (const q of this.questions.values()) if (q.detail.sessionId === id) q.resolve(null);
    for (const a of this.approvals.values()) if (a.detail.sessionId === id) a.resolve(false);
  }

  /** 等待会话本轮结束（CLI 用）。 */
  async wait(id: string): Promise<SessionMeta> {
    while (this.running.has(id)) await new Promise((r) => setTimeout(r, 100));
    return this.meta(id);
  }

  private async start(meta: SessionMeta, text: string, attachments: AttachmentRef[], skillId?: string, input: Partial<ChatSelection> = {}): Promise<void> {
    if (this.running.has(meta.id)) throw new Conflict("会话正在运行，请等待完成");
    const selection = resolveChatSelection(this.loaded.config.llm, input, meta);
    const chat = this.chat({ ...resolveModel(this.loaded.config.llm, selection.model), reasoningEffort: selection.reasoningEffort }); // 缺少 API key 时在这里同步报错
    let interrupted: SessionMeta | undefined;
    if (meta.slug) {
      const holder = this.editing.get(meta.slug);
      if (holder && holder !== meta.id) {
        const active = this.activeMetas.get(holder);
        if (!this.unattended.has(meta.id) && this.unattended.has(holder) && active?.origin?.kind === "schedule") interrupted = active;
        else throw new Conflict(`页面 ${meta.slug} 正在被会话 ${holder} 修改`);
      }
      // 先预留给手动修改；旧任务退出时只能释放自己仍持有的锁。
      this.editing.set(meta.slug, meta.id);
    }
    const controller = new AbortController();
    this.running.set(meta.id, controller);
    this.activeMetas.set(meta.id, meta);
    Object.assign(meta, selection);
    try {
      await this.emit(meta.id, { type: "user", text, ...(attachments.length ? { attachments } : {}) });
      await this.setStatus(meta, "running");
    } catch (error) {
      this.running.delete(meta.id);
      this.activeMetas.delete(meta.id);
      if (meta.slug && this.editing.get(meta.slug) === meta.id) {
        if (interrupted && this.running.has(interrupted.id)) this.editing.set(meta.slug, interrupted.id);
        else this.editing.delete(meta.slug);
      }
      throw error;
    }
    void this.run(meta, text, attachments, chat, controller, skillId, interrupted);
  }

  private async run(meta: SessionMeta, text: string, attachments: AttachmentRef[], chat: ChatFn, controller: AbortController, skillId?: string, interrupted?: SessionMeta): Promise<void> {
    const id = meta.id;
    try {
      if (interrupted) {
        this.cancel(interrupted.id);
        try {
          await this.emit(id, { type: "say", text: `正在停止定时任务「${interrupted.origin?.scheduleName ?? interrupted.title}」的本次执行，退出后继续修改页面；后续仍按原计划运行。` });
        } finally {
          await this.wait(interrupted.id);
        }
      }
      controller.signal.throwIfAborted();
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
        { wish: text, sessionId: id, origin: meta.origin, slug: meta.slug ?? undefined, history, skillId, workbench: this.workbench, attachments, attachmentStore: this.attachments },
        {
          signal: controller.signal,
          onEvent: (e: AgentEvent) => {
            if (e.kind === "skill") void this.emit(id, { type: "skill", skill: e.skill, action: e.action });
            else if (e.kind === "browser") void this.emit(id, { type: "browser", browser: e.state });
            else if (e.kind === "text" || e.kind === "thinking") {
              const { kind, ...block } = e;
              // 增量只实时推送；完整内容在 done 时落盘
              if (block.delta !== undefined) this.broadcast(id, { type: kind, ...block });
              else void this.emit(id, { type: kind, ...block });
            } else if (e.kind === "tool_call") void this.emit(id, { type: "tool", blockId: e.blockId, tool: e.tool });
            else if (e.kind === "say" || e.kind === "warn") void this.emit(id, { type: e.kind, text: e.text });
          },
          authorize: (tool, args) => this.waitFor(meta, this.requestApproval(id, tool.name, tool.source, args)),
          clarify: this.unattended.has(id) ? undefined : (questions) => this.waitFor(meta, this.requestClarify(id, questions)),
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
      await this.setStatus(meta, "idle");
    } catch (error) {
      // 失败也保存对话，店长可以在同一会话里说「继续」
      if (error instanceof WishError && error.messages.length) {
        await writeAtomic(this.file(id, "messages.json"), JSON.stringify(error.messages)).catch(() => {});
      }
      await this.emit(id, { type: "error", message: controller.signal.aborted ? "已取消" : (error as Error).message });
      await this.setStatus(meta, "error");
    } finally {
      this.running.delete(id);
      this.activeMetas.delete(id);
      for (const [slug, holder] of this.editing) if (holder === id) this.editing.delete(slug);
      for (const q of this.questions.values()) if (q.detail.sessionId === id) q.resolve(null);
      for (const a of this.approvals.values()) if (a.detail.sessionId === id) a.resolve(false);
      this.pendingCount.delete(id);
      this.unattended.delete(id);
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
      const controller = this.running.get(meta.id);
      if (left === 0 && controller && !controller.signal.aborted) await this.setStatus(meta, "running");
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
        this.pendingChanged();
        void this.emit(sessionId, { type: "question_answered", requestId, answers });
        resolve(answers);
      };
      const timer = setTimeout(() => done(null), QUESTION_TIMEOUT_MS);
      const now = Date.now();
      const detail: PendingDetail = { kind: "question", requestId, sessionId, questions, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + QUESTION_TIMEOUT_MS).toISOString() };
      this.questions.set(requestId, { detail, questions, resolve: done });
      this.pendingChanged();
      void this.emit(sessionId, { type: "question_required", requestId, round, questions });
    });
  }

  private requestApproval(sessionId: string, tool: string, source: string, args: JsonObject): Promise<boolean> {
    const requestId = randomUUID();
    const timeoutMs = this.loaded.config.approvalTimeoutMin * 60_000;
    return new Promise<boolean>((resolve) => {
      const done = (approved: boolean) => {
        clearTimeout(timer);
        if (!this.approvals.delete(requestId)) return;
        this.pendingChanged();
        void this.emit(sessionId, { type: "approval_resolved", requestId, approved });
        resolve(approved);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      const now = Date.now();
      const detail: PendingDetail = { kind: "approval", requestId, sessionId, tool, source, args, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + timeoutMs).toISOString() };
      this.approvals.set(requestId, { detail, resolve: done });
      this.pendingChanged();
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
    if (!this.directories.has(meta.id)) {
      this.directories.set(meta.id, meta.origin?.kind === "schedule" ? this.loaded.paths.scheduleSessions : this.loaded.paths.sessions);
    }
    return writeAtomic(this.file(meta.id, "meta.json"), JSON.stringify(meta, null, 2));
  }

  private async emit(id: string, event: NewEvent): Promise<void> {
    const full = { ...event, at: new Date().toISOString() } as SessionEvent;
    await appendFile(this.file(id, "events.jsonl"), `${JSON.stringify(full)}\n`);
    for (const l of this.listeners.get(id) ?? []) l(full);
  }

  /** 不落盘的实时事件（流式增量）；订阅端不应计入 since 续传偏移。 */
  private broadcast(id: string, event: NewEvent): void {
    const full = { ...event, at: new Date().toISOString() } as SessionEvent;
    for (const l of this.listeners.get(id) ?? []) l(full);
  }
}

export class NotFound extends Error {}
export class Conflict extends Error {}
export class BadRequest extends Error {}

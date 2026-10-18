import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatasetManifest, Row } from "@qdd/shared";
import { writeAtomic } from "../web/site.js";

/** 按天的闭区间，YYYY-MM-DD。 */
export interface ScanRange {
  from?: string | undefined;
  to?: string | undefined;
}

export type DatasetDefinition = Pick<DatasetManifest, "name" | "description" | "kind" | "fields" | "key"> &
  Partial<Pick<DatasetManifest, "timeField" | "replay" | "source" | "record">>;

export interface Checkpoint {
  at: string;
  rows: Row[];
}

/**
 * 数据集存储接口。上层（聚合、回放、刷新、工具）只依赖这个接口；
 * 当前实现为 JSONL 文件，数据量或并发写入超出文件方案时可替换为 SQLite 实现，上层无需改动。
 */
export interface DatasetStore {
  list(): Promise<DatasetManifest[]>;
  get(name: string): Promise<DatasetManifest | undefined>;
  /** 创建或更新数据集定义（不影响已有数据）。 */
  define(def: DatasetDefinition): Promise<DatasetManifest>;
  /** 追加行。同主键的行以最后写入为准（重复刷新幂等）；最后一行带 __deleted: true 时该主键视为已删除。 */
  append(name: string, rows: Row[], watermark?: string): Promise<DatasetManifest>;
  /** 在同一写锁内读取最新行并追加变更；找不到（含已删除）时返回 undefined。 */
  updateRow(name: string, matches: (row: Row) => boolean, change: (row: Row) => Row): Promise<Row | undefined>;
  /** 整体替换（维度表）。 */
  replace(name: string, rows: Row[], watermark?: string): Promise<DatasetManifest>;
  /** 按时间范围读取（只读涉及的分区）。 */
  scan(name: string, range?: ScanRange): AsyncIterable<Row>;
  /** 写入某时刻的完整状态。 */
  putCheckpoint(name: string, checkpoint: Checkpoint): Promise<void>;
  /** 不晚于 at 的最近检查点。 */
  checkpoint(name: string, at?: string): Promise<Checkpoint | undefined>;
}

export async function readAll(store: DatasetStore, name: string, range?: ScanRange): Promise<Row[]> {
  const rows: Row[] = [];
  for await (const r of store.scan(name, range)) rows.push(r);
  return rows;
}

/** 墓碑标记：有主键的数据集中，同主键最后一行带此标记即视为删除。 */
export const TOMBSTONE = "__deleted";
const NAME_RE = /^[a-z0-9_]+(\/[a-z0-9_-]+)?$/;
const ALL_PARTITION = "all";
const LOCK_STALE_MS = 30_000;

export class JsonlDatasetStore implements DatasetStore {
  constructor(private readonly root: string) {}

  private dir(name: string): string {
    if (!NAME_RE.test(name)) throw new Error(`数据集名不合法：${name}`);
    return path.join(this.root, ...name.split("/"));
  }

  async list(): Promise<DatasetManifest[]> {
    const out: DatasetManifest[] = [];
    const walk = async (dir: string, prefix: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      if (entries.some((e) => e.name === "manifest.json")) {
        const m = await this.get(prefix);
        if (m) out.push(m);
        return;
      }
      for (const e of entries) if (e.isDirectory()) await walk(path.join(dir, e.name), prefix ? `${prefix}/${e.name}` : e.name);
    };
    await walk(this.root, "");
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(name: string): Promise<DatasetManifest | undefined> {
    try {
      return JSON.parse(await readFile(path.join(this.dir(name), "manifest.json"), "utf8")) as DatasetManifest;
    } catch {
      return undefined;
    }
  }

  async define(def: DatasetDefinition): Promise<DatasetManifest> {
    return this.locked(def.name, async () => {
      const prev = await this.get(def.name);
      const manifest: DatasetManifest = {
        version: "0",
        watermark: null,
        rowCount: 0,
        ...prev,
        ...def,
        updatedAt: new Date().toISOString(),
      };
      await this.saveManifest(manifest);
      return manifest;
    });
  }

  async append(name: string, rows: Row[], watermark?: string): Promise<DatasetManifest> {
    return this.locked(name, async () => this.appendRows(await this.require(name), rows, watermark));
  }

  async updateRow(name: string, matches: (row: Row) => boolean, change: (row: Row) => Row): Promise<Row | undefined> {
    return this.locked(name, async () => {
      const manifest = await this.require(name);
      for await (const current of this.scan(name)) {
        if (!matches(current)) continue;
        const next = change(current);
        await this.appendRows(manifest, [next]);
        return next;
      }
      return undefined;
    });
  }

  private async appendRows(m: DatasetManifest, rows: Row[], watermark?: string): Promise<DatasetManifest> {
    const byPartition = new Map<string, string[]>();
    for (const r of rows) {
      this.validate(m, r);
      const part = m.timeField ? String(r[m.timeField]).slice(0, 10) : ALL_PARTITION;
      if (!byPartition.has(part)) byPartition.set(part, []);
      byPartition.get(part)!.push(JSON.stringify(r));
    }
    const log = path.join(this.dir(m.name), "log");
    await mkdir(log, { recursive: true });
    const hash = createHash("sha256").update(m.version);
    for (const [part, lines] of [...byPartition].sort(([a], [b]) => a.localeCompare(b))) {
      const text = `${lines.join("\n")}\n`;
      hash.update(part).update(text);
      await appendFile(path.join(log, `${part}.jsonl`), text);
    }
    return this.bump(m, hash.digest("hex").slice(0, 12), rows, watermark, m.rowCount + rows.length);
  }

  async replace(name: string, rows: Row[], watermark?: string): Promise<DatasetManifest> {
    return this.locked(name, async () => {
      const m = await this.require(name);
      for (const r of rows) this.validate(m, r);
      const log = path.join(this.dir(name), "log");
      await rm(log, { recursive: true, force: true });
      await mkdir(log, { recursive: true });
      const text = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
      await writeFile(path.join(log, `${ALL_PARTITION}.jsonl`), text);
      return this.bump(m, createHash("sha256").update(text).digest("hex").slice(0, 12), rows, watermark, rows.length);
    });
  }

  async *scan(name: string, range: ScanRange = {}): AsyncIterable<Row> {
    const m = await this.require(name);
    const log = path.join(this.dir(name), "log");
    let files: string[];
    try {
      files = (await readdir(log)).filter((f) => f.endsWith(".jsonl")).sort();
    } catch {
      return;
    }
    const dedup = m.key.length ? new Map<string, Row>() : undefined;
    for (const file of files) {
      const part = file.slice(0, -".jsonl".length);
      if (part !== ALL_PARTITION && ((range.from && part < range.from) || (range.to && part > range.to))) continue;
      for (const line of (await readFile(path.join(log, file), "utf8")).split("\n")) {
        if (!line) continue;
        const row = JSON.parse(line) as Row;
        if (dedup) dedup.set(JSON.stringify(m.key.map((k) => row[k])), row);
        else yield row;
      }
    }
    if (dedup) for (const row of dedup.values()) if (row[TOMBSTONE] !== true) yield row;
  }

  async putCheckpoint(name: string, checkpoint: Checkpoint): Promise<void> {
    await this.locked(name, async () => {
      await this.require(name);
      const file = path.join(this.dir(name), "checkpoints", `${checkpoint.at.replace(/[^0-9]/g, "")}.json`);
      await writeAtomic(file, JSON.stringify(checkpoint));
    });
  }

  async checkpoint(name: string, at?: string): Promise<Checkpoint | undefined> {
    const dir = path.join(this.dir(name), "checkpoints");
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort().reverse();
    } catch {
      return undefined;
    }
    for (const f of files) {
      const cp = JSON.parse(await readFile(path.join(dir, f), "utf8")) as Checkpoint;
      if (at === undefined || cp.at <= at) return cp;
    }
    return undefined;
  }

  private async require(name: string): Promise<DatasetManifest> {
    const m = await this.get(name);
    if (!m) throw new Error(`数据集 ${name} 不存在`);
    return m;
  }

  private validate(m: DatasetManifest, row: Row): void {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`数据集 ${m.name}：每行必须是 JSON 对象`);
    for (const k of [...m.key, ...(m.timeField ? [m.timeField] : [])]) {
      if (row[k] === undefined || row[k] === null) throw new Error(`数据集 ${m.name}：缺少字段 ${k}`);
    }
    for (const [field, type] of Object.entries(m.fields)) {
      const v = row[field];
      if (v !== undefined && v !== null && typeof v !== type) throw new Error(`数据集 ${m.name}：字段 ${field} 应为 ${type}`);
      if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`数据集 ${m.name}：字段 ${field} 应为有限数字`);
    }
    if (m.timeField) {
      const value = row[m.timeField];
      const day = typeof value === "string" ? value.slice(0, 10) : "";
      const timestamp = Date.parse(`${day}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== day) {
        throw new Error(`数据集 ${m.name}：时间字段 ${m.timeField} 必须包含有效 YYYY-MM-DD 日期`);
      }
    }
  }

  private async bump(m: DatasetManifest, version: string, rows: Row[], watermark: string | undefined, rowCount: number) {
    let mark = watermark ?? m.watermark;
    if (!watermark && m.timeField) {
      for (const r of rows) {
        const t = String(r[m.timeField]);
        if (!mark || t > mark) mark = t;
      }
    }
    const next: DatasetManifest = { ...m, version, watermark: mark, rowCount, updatedAt: new Date().toISOString() };
    await this.saveManifest(next);
    return next;
  }

  private saveManifest(m: DatasetManifest): Promise<void> {
    return writeAtomic(path.join(this.dir(m.name), "manifest.json"), `${JSON.stringify(m, null, 2)}\n`);
  }

  /** 跨进程互斥：数据集目录下的 .lock 文件（O_EXCL），超时视为残留并清理。 */
  private async locked<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const dir = this.dir(name);
    await mkdir(dir, { recursive: true });
    const lock = path.join(dir, ".lock");
    for (let attempt = 0; ; attempt++) {
      try {
        const handle = await open(lock, "wx");
        await handle.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const age = Date.now() - (await stat(lock).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
        if (age > LOCK_STALE_MS) await rm(lock, { force: true });
        else if (attempt > 200) throw new Error(`数据集 ${name} 正被其它进程写入`);
        else await new Promise((r) => setTimeout(r, 50));
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lock, { force: true });
    }
  }
}

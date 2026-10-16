import {
  aggregate,
  bucketOf,
  classify,
  join,
  mapKeys,
  replay,
  segments,
  timeline,
  type AggSpec,
  type Bucket,
  type ClassifyRule,
  type JoinSpec,
  type MetricCatalog,
  type Row,
} from "@qdd/shared";
import { readAll, type DatasetStore } from "./store.js";

/** 数据集上的零 SQL 查询：读取（只读相关分区）→ 编号映射 → 关联 → 共享计算引擎。 */

export interface QueryContext {
  store: DatasetStore;
  metrics: () => Promise<MetricCatalog>;
}

export interface JoinArg extends JoinSpec {
  dataset: string;
}

export interface KeymapArg {
  field: string;
  /** 映射数据集，行格式 { from, to } */
  dataset: string;
}

export interface AggregateArgs extends AggSpec {
  dataset: string;
  keymap?: KeymapArg[];
  join?: JoinArg[];
}

async function enrich(ctx: QueryContext, rows: Row[], keymap: KeymapArg[] = [], joins: JoinArg[] = []): Promise<Row[]> {
  for (const k of keymap) rows = mapKeys(rows, await readAll(ctx.store, k.dataset), k.field);
  for (const j of joins) rows = join(rows, await readAll(ctx.store, j.dataset), j);
  return rows;
}

export async function queryAggregate(ctx: QueryContext, args: AggregateArgs): Promise<Row[]> {
  const rows = await readAll(ctx.store, args.dataset, { from: args.time?.from, to: args.time?.to });
  return aggregate(await enrich(ctx, rows, args.keymap, args.join), args, await ctx.metrics());
}

export interface TimelineArgs {
  dataset: string;
  from: string;
  to: string;
  bucket: Bucket;
  /** 只返回这些实体 */
  keys?: string[];
  join?: JoinArg[];
}

/** 连续状态：最近检查点 + 之后的流水回放，逐桶输出（无事件沿用上一期）。 */
export async function queryTimeline(ctx: QueryContext, args: TimelineArgs): Promise<Row[]> {
  const m = await ctx.store.get(args.dataset);
  if (!m?.replay || !m.timeField) throw new Error(`数据集 ${args.dataset} 不是可回放的事件流`);
  if (args.from > args.to) throw new Error("from 不能晚于 to");
  const start = `${bucketOf(args.from, args.bucket)}`.padEnd(10, "-01").slice(0, 10);
  const cp = await ctx.store.checkpoint(args.dataset, `${start} 00:00`);
  const timeField = m.timeField;
  const events = (await readAll(ctx.store, args.dataset, { from: cp?.at.slice(0, 10), to: args.to })).filter(
    (e) => !cp || String(e[timeField]) > cp.at,
  );
  let rows = timeline(cp?.rows ?? [], events, { ...m.replay, time: timeField, bucket: args.bucket, from: args.from, to: args.to });
  if (args.keys?.length) {
    const keys = new Set<unknown>(args.keys);
    rows = rows.filter((r) => keys.has(r[m.replay!.key]));
  }
  return enrich(ctx, rows, [], args.join);
}

export interface SegmentsArgs extends TimelineArgs {
  rules: ClassifyRule[];
  fallback: string;
}

/** 状态区间：时间线 → 按规则分类 → 压缩为连续区间，并按 实体×状态 汇总次数与时长。 */
export async function querySegments(ctx: QueryContext, args: SegmentsArgs) {
  const m = await ctx.store.get(args.dataset);
  const key = m?.replay?.key ?? "key";
  const rows = classify(await queryTimeline(ctx, args), args.rules, args.fallback, "state");
  const segs = segments(rows, { key, state: "state" });
  const summary = new Map<string, { key: unknown; state: unknown; count: number; length: number }>();
  for (const s of segs) {
    const k = JSON.stringify([s.key, s.state]);
    const cur = summary.get(k) ?? { key: s.key, state: s.state, count: 0, length: 0 };
    cur.count++;
    cur.length += s.length;
    summary.set(k, cur);
  }
  return { bucket: args.bucket, segments: segs, summary: [...summary.values()] };
}

/** 合并：在 at 时刻生成检查点，之后的回放只需从这里开始。 */
export async function compactDataset(store: DatasetStore, name: string, at: string): Promise<number> {
  const m = await store.get(name);
  if (!m?.replay || !m.timeField) throw new Error(`数据集 ${name} 不是可回放的事件流`);
  const cp = await store.checkpoint(name, at);
  const timeField = m.timeField;
  const events = (await readAll(store, name, { from: cp?.at.slice(0, 10), to: at.slice(0, 10) })).filter(
    (e) => !cp || String(e[timeField]) > cp.at,
  );
  const state = replay(cp?.rows ?? [], events, { ...m.replay, time: timeField }, at);
  await store.putCheckpoint(name, { at, rows: [...state].map(([k, v]) => ({ [m.replay!.key]: k, [m.replay!.value]: v })) });
  return state.size;
}

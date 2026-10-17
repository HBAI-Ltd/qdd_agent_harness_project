import {
  aggregate,
  bucketOf,
  classify,
  join,
  mapKeys,
  replay,
  resolveMetrics,
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

const AGG_KEYS = new Set(["dataset", "filter", "groupBy", "time", "metrics", "window", "sort", "limit", "keymap", "join"]);
const FILTER_OPS = new Set(["=", "!=", ">", ">=", "<", "<=", "in", "not_in", "contains"]);
const BUCKETS = new Set(["hour", "day", "week", "month"]);
const WINDOW_OPS = new Set(["cumsum", "rolling_mean", "rolling_sum", "pct_change", "diff", "rank", "share"]);

/** 严格校验：未知字段/写法直接报错并给出正确写法，避免静默忽略。 */
async function validateAggregate(ctx: QueryContext, args: AggregateArgs): Promise<void> {
  const errors: string[] = [];
  for (const k of Object.keys(args)) if (!AGG_KEYS.has(k)) errors.push(`未知参数 ${k}（可用：${[...AGG_KEYS].join(", ")}）`);
  const m = await ctx.store.get(args.dataset);
  if (!m) throw new Error(`数据集 ${args.dataset} 不存在，见 store__list_datasets`);
  const fields = new Set(Object.keys(m.fields));
  for (const list of [args.join ?? []]) {
    for (const j of list) {
      const right = await ctx.store.get(j.dataset);
      if (!right) errors.push(`join 数据集 ${j.dataset} 不存在`);
      else for (const f of j.fields ?? Object.keys(right.fields)) fields.add(f);
    }
  }
  const field = (f: unknown, where: string) => {
    if (typeof f !== "string" || !fields.has(f)) errors.push(`${where}：字段 ${String(f)} 不存在（可用：${[...fields].join(", ")}）`);
  };
  if (!Array.isArray(args.metrics) || !args.metrics.length) errors.push("metrics 不能为空");
  else {
    // 指标依赖的字段必须在数据集里，否则会静默聚合出 0
    const catalog = await ctx.metrics();
    const missing = new Set<string>();
    try {
      for (const name of resolveMetrics(args.metrics, catalog).base) {
        const f = catalog[name]?.field;
        if (f && !fields.has(f)) missing.add(`${name}（需要字段 ${f}）`);
      }
    } catch (error) {
      errors.push((error as Error).message);
    }
    if (missing.size) {
      const usable = Object.entries(catalog).filter(([, d]) => d.type !== "ratio" && d.field && fields.has(d.field)).map(([k]) => k);
      errors.push(`数据集 ${args.dataset} 不支持指标 ${[...missing].join("、")}；该数据集可用指标：${usable.join(", ") || "无"}（字段：${Object.keys(m.fields).join(", ")}）`);
    }
  }
  for (const g of args.groupBy ?? []) field(g, "groupBy");
  for (const f of args.filter ?? []) {
    if (!Array.isArray(f) || f.length !== 3) errors.push(`filter 每项应为 [字段, 操作, 值]，收到 ${JSON.stringify(f)}`);
    else {
      field(f[0], "filter");
      if (!FILTER_OPS.has(f[1] as string)) errors.push(`filter 操作 ${String(f[1])} 不支持（可用：${[...FILTER_OPS].join(" ")}）`);
    }
  }
  if (args.time) {
    field(args.time.field, "time.field");
    if (!BUCKETS.has(args.time.bucket)) errors.push(`time.bucket 应为 hour/day/week/month`);
  }
  const outputs = new Set<string>([...(args.groupBy ?? []), ...(args.metrics ?? []), ...(args.time ? ["bucket"] : [])]);
  for (const w of args.window ?? []) {
    if (!WINDOW_OPS.has(w.op)) errors.push(`window.op ${String(w.op)} 不支持（可用：${[...WINDOW_OPS].join(" ")}）`);
    outputs.add(w.as ?? `${w.metric}_${w.op}`);
  }
  for (const s of args.sort ?? []) {
    const raw = s as unknown as Record<string, unknown>;
    if (typeof raw.by !== "string" || Object.keys(raw).some((k) => k !== "by" && k !== "desc")) {
      errors.push(`sort 每项应为 {"by": 输出列, "desc": true|false}，收到 ${JSON.stringify(s)}`);
    } else if (!outputs.has(raw.by)) errors.push(`sort.by ${raw.by} 不是输出列（可用：${[...outputs].join(", ")}）`);
  }
  if (errors.length) throw new Error(`聚合描述有误：\n- ${errors.join("\n- ")}`);
}

async function enrich(ctx: QueryContext, rows: Row[], keymap: KeymapArg[] = [], joins: JoinArg[] = []): Promise<Row[]> {
  for (const k of keymap) rows = mapKeys(rows, await readAll(ctx.store, k.dataset), k.field);
  for (const j of joins) rows = join(rows, await readAll(ctx.store, j.dataset), j);
  return rows;
}

export async function queryAggregate(ctx: QueryContext, args: AggregateArgs): Promise<Row[]> {
  await validateAggregate(ctx, args);
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

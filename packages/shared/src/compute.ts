/**
 * 零 SQL 计算引擎：声明式聚合 / 时间线回放 / 状态区间 / 关联。
 * 纯函数、无依赖、不使用 eval——harness（数据源侧）和浏览器 SDK 共用同一份代码，保证口径一致。
 * 注意：本文件会被原样包装成浏览器脚本，只能使用 `export function` / `export const` / `export type|interface`，不能 import。
 */

export type Row = Record<string, unknown>;

export type MetricType = "flow" | "stock" | "ratio" | "state";
export type MetricAgg = "sum" | "count" | "count_distinct" | "avg" | "min" | "max" | "last" | "first";

export interface MetricDef {
  label: string;
  type: MetricType;
  /** flow/stock/state：取值字段 */
  field?: string;
  /** flow 默认 sum；stock 默认 last */
  agg?: MetricAgg;
  /** stock：按该实体取期末值后再跨实体求和（如 sku） */
  entity?: string;
  /** ratio：分子、分母引用其它（非比率）指标名 */
  numerator?: string;
  denominator?: string;
  unit?: string;
  digits?: number;
  description?: string;
}

export type MetricCatalog = Record<string, MetricDef>;

export type FilterOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "in" | "not_in" | "contains";
/** 第三项可以是常量，也可以是 { field: "其它字段" } 引用同一行的字段。 */
export type Filter = [string, FilterOp, unknown];

export type Bucket = "hour" | "day" | "week" | "month";

export interface TimeSpec {
  field: string;
  bucket: Bucket;
  /** 补齐缺失时间桶：flow 补 0，stock 沿用上一期，ratio 由补齐后的分子分母重算 */
  fill?: boolean;
  /** 含，YYYY-MM-DD */
  from?: string;
  to?: string;
}

export type WindowOp = "cumsum" | "rolling_mean" | "rolling_sum" | "pct_change" | "diff" | "rank" | "share";

export interface WindowSpec {
  metric: string;
  op: WindowOp;
  /** rolling_* 窗口大小 */
  size?: number;
  /** pct_change / diff 间隔 */
  lag?: number;
  /** 输出字段名，默认 <metric>_<op> */
  as?: string;
}

export interface AggSpec {
  filter?: Filter[];
  groupBy?: string[];
  time?: TimeSpec;
  metrics: string[];
  window?: WindowSpec[];
  sort?: { by: string; desc?: boolean }[];
  limit?: number;
}

// ------------------------------------------------------------------ 时间

const pad2 = (n: number) => String(n).padStart(2, "0");

function toUtc(key: string): Date {
  // 支持 YYYY-MM / YYYY-MM-DD / YYYY-MM-DD HH:mm
  const [date = "", clock = "00:00"] = key.split(" ");
  const [y = 1970, m = 1, d = 1] = date.split("-").map(Number);
  const [h = 0] = clock.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, h));
}

function fromUtc(d: Date, bucket: Bucket): string {
  const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  if (bucket === "month") return date.slice(0, 7);
  if (bucket === "hour") return `${date} ${pad2(d.getUTCHours())}:00`;
  return date;
}

/** 把时间字符串归到时间桶：hour → "YYYY-MM-DD HH:00"，day → 日期，week → 周一日期，month → "YYYY-MM"。 */
export function bucketOf(time: string, bucket: Bucket): string {
  if (bucket === "month") return time.slice(0, 7);
  if (bucket === "day") return time.slice(0, 10);
  if (bucket === "hour") return `${time.slice(0, 10)} ${time.slice(11, 13) || "00"}:00`;
  const d = toUtc(time.slice(0, 10));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return fromUtc(d, "day");
}

export function nextBucket(key: string, bucket: Bucket): string {
  const d = toUtc(key);
  if (bucket === "hour") d.setUTCHours(d.getUTCHours() + 1);
  else if (bucket === "day") d.setUTCDate(d.getUTCDate() + 1);
  else if (bucket === "week") d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return fromUtc(d, bucket);
}

/** 枚举 [from, to] 之间的全部时间桶（含两端）。 */
export function bucketRange(from: string, to: string, bucket: Bucket): string[] {
  const out: string[] = [];
  const end = bucketOf(to, bucket);
  for (let k = bucketOf(from, bucket); k <= end && out.length < 100_000; k = nextBucket(k, bucket)) out.push(k);
  return out;
}

// ------------------------------------------------------------------ 过滤 / 关联 / 分类

function compare(a: unknown, op: FilterOp, b: unknown): boolean {
  switch (op) {
    case "=": return a === b;
    case "!=": return a !== b;
    case ">": return (a as number) > (b as number);
    case ">=": return (a as number) >= (b as number);
    case "<": return (a as number) < (b as number);
    case "<=": return (a as number) <= (b as number);
    case "in": return Array.isArray(b) && b.includes(a);
    case "not_in": return Array.isArray(b) && !b.includes(a);
    case "contains": return typeof a === "string" && typeof b === "string" && a.includes(b);
    default: throw new Error(`不支持的过滤操作 ${String(op)}`);
  }
}

export function matches(row: Row, filters: Filter[] | undefined): boolean {
  if (!filters) return true;
  return filters.every(([field, op, value]) => {
    const ref = value && typeof value === "object" && !Array.isArray(value) ? (value as { field?: unknown }).field : undefined;
    return compare(row[field], op, typeof ref === "string" ? row[ref] : value);
  });
}

export interface JoinSpec {
  /** 左表字段 */
  on: string;
  /** 右表字段，默认同 on */
  rightOn?: string;
  /** 只带入这些字段，默认全部 */
  fields?: string[];
}

/** 左关联（哈希查找）。右表同键多行时取第一行。 */
export function join(left: Iterable<Row>, right: Iterable<Row>, spec: JoinSpec): Row[] {
  const rightOn = spec.rightOn ?? spec.on;
  const index = new Map<unknown, Row>();
  for (const r of right) if (!index.has(r[rightOn])) index.set(r[rightOn], r);
  const out: Row[] = [];
  for (const l of left) {
    const r = index.get(l[spec.on]);
    if (!r) {
      out.push({ ...l });
      continue;
    }
    const picked: Row = {};
    for (const f of spec.fields ?? Object.keys(r)) if (f !== rightOn && !(f in l)) picked[f] = r[f];
    out.push({ ...l, ...picked });
  }
  return out;
}

/** 用映射表（from → to）把外部编号换成内部主键，映射不到的行保留原值并标记 _unmapped。 */
export function mapKeys(rows: Iterable<Row>, keymap: Iterable<Row>, field: string): Row[] {
  const map = new Map<unknown, unknown>();
  for (const m of keymap) map.set(m.from, m.to);
  const out: Row[] = [];
  for (const r of rows) {
    out.push(map.has(r[field]) ? { ...r, [field]: map.get(r[field]) } : { ...r, _unmapped: true });
  }
  return out;
}

export interface ClassifyRule {
  when: Filter[];
  state: string;
}

/** 按规则给每行打状态（规则按顺序匹配，第一个命中生效）。 */
export function classify(rows: Iterable<Row>, rules: ClassifyRule[], fallback: string, as = "state"): Row[] {
  const out: Row[] = [];
  for (const r of rows) out.push({ ...r, [as]: rules.find((rule) => matches(r, rule.when))?.state ?? fallback });
  return out;
}

// ------------------------------------------------------------------ 聚合

interface Acc {
  sum: number;
  n: number;
  min: number;
  max: number;
  distinct: Set<unknown> | undefined;
  /** stock：实体 → 期末/期初值 */
  entities: Map<unknown, { t: string; v: number }> | undefined;
  /** state：最后状态 */
  last: { t: string; v: unknown } | undefined;
}

const newAcc = (def: MetricDef): Acc => ({
  sum: 0,
  n: 0,
  min: Infinity,
  max: -Infinity,
  distinct: def.agg === "count_distinct" ? new Set() : undefined,
  entities: def.type === "stock" ? new Map() : undefined,
  last: undefined,
});

function feed(acc: Acc, def: MetricDef, row: Row, timeField: string | undefined): void {
  const t = timeField ? String(row[timeField] ?? "") : "";
  const raw = def.field ? row[def.field] : undefined;
  if (def.type === "state") {
    if (!acc.last || t >= acc.last.t) acc.last = { t, v: raw };
    return;
  }
  if (def.type === "stock") {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    const key = def.entity ? row[def.entity] : "_";
    const prev = acc.entities!.get(key);
    const first = def.agg === "first";
    if (!prev || (first ? t < prev.t : t >= prev.t)) acc.entities!.set(key, { t, v });
    return;
  }
  if (def.agg === "count") {
    if (!def.field || (raw !== undefined && raw !== null)) acc.n++;
    return;
  }
  if (def.agg === "count_distinct") {
    if (raw !== undefined && raw !== null) acc.distinct!.add(raw);
    return;
  }
  const v = Number(raw);
  if (raw === undefined || raw === null || !Number.isFinite(v)) return;
  acc.sum += v;
  acc.n++;
  if (v < acc.min) acc.min = v;
  if (v > acc.max) acc.max = v;
}

function valueOf(acc: Acc | undefined, def: MetricDef): unknown {
  if (!acc) return def.type === "flow" && (def.agg ?? "sum") !== "avg" && def.agg !== "min" && def.agg !== "max" ? 0 : null;
  if (def.type === "state") return acc.last?.v ?? null;
  if (def.type === "stock") {
    if (!acc.entities!.size) return null;
    let s = 0;
    for (const e of acc.entities!.values()) s += e.v;
    return s;
  }
  switch (def.agg ?? "sum") {
    case "count": return acc.n;
    case "count_distinct": return acc.distinct!.size;
    case "avg": return acc.n ? acc.sum / acc.n : null;
    case "min": return acc.n ? acc.min : null;
    case "max": return acc.n ? acc.max : null;
    default: return acc.sum;
  }
}

/** 解析指标依赖：比率指标自动带上分子和分母。 */
export function resolveMetrics(names: string[], catalog: MetricCatalog): { base: string[]; ratios: string[] } {
  const base = new Set<string>();
  const ratios = new Set<string>();
  for (const name of names) {
    const def = catalog[name];
    if (!def) throw new Error(`未知指标 ${name}（可用：${Object.keys(catalog).join(", ")}）`);
    if (def.type !== "ratio") {
      base.add(name);
      continue;
    }
    for (const part of [def.numerator, def.denominator]) {
      const p = part ? catalog[part] : undefined;
      if (!part || !p || p.type === "ratio") throw new Error(`比率指标 ${name} 的分子/分母必须是非比率指标`);
      base.add(part);
    }
    ratios.add(name);
  }
  return { base: [...base], ratios: [...ratios] };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * 声明式聚合：过滤 → 时间分桶 → 分组 → 按指标类型累计 → 补齐 → 比率重算 → 窗口 → 排序。
 * 比率永远由汇总后的分子/分母相除得到，不会对比率求平均。
 */
export function aggregate(rows: Iterable<Row>, spec: AggSpec, catalog: MetricCatalog): Row[] {
  const { base, ratios } = resolveMetrics(spec.metrics, catalog);
  const groupBy = spec.groupBy ?? [];
  const time = spec.time;
  const groups = new Map<string, { dims: unknown[]; bucket: string | null; acc: Record<string, Acc> }>();

  for (const row of rows) {
    if (!matches(row, spec.filter)) continue;
    let bucket: string | null = null;
    if (time) {
      const t = row[time.field];
      if (typeof t !== "string") continue;
      const day = t.slice(0, 10);
      if ((time.from && day < time.from) || (time.to && day > time.to)) continue;
      bucket = bucketOf(t, time.bucket);
    }
    const dims = groupBy.map((g) => row[g] ?? null);
    const key = JSON.stringify([bucket, ...dims]);
    let g = groups.get(key);
    if (!g) {
      g = { dims, bucket, acc: {} };
      for (const m of base) g.acc[m] = newAcc(catalog[m]!);
      groups.set(key, g);
    }
    for (const m of base) feed(g.acc[m]!, catalog[m]!, row, time?.field);
  }

  // 计算基础指标
  let out: Row[] = [...groups.values()].map((g) => {
    const r: Row = {};
    if (time) r.bucket = g.bucket;
    groupBy.forEach((f, i) => (r[f] = g.dims[i]));
    for (const m of base) r[m] = valueOf(g.acc[m], catalog[m]!);
    return r;
  });

  const dimKey = (r: Row) => JSON.stringify(groupBy.map((g) => r[g] ?? null));
  const byTime = (a: Row, b: Row) => String(a.bucket).localeCompare(String(b.bucket));

  // 补齐时间桶
  if (time?.fill) {
    const buckets = out.map((r) => String(r.bucket)).sort();
    const from = time.from ?? buckets[0];
    const to = time.to ?? buckets.at(-1);
    if (from && to) {
      const range = bucketRange(from, to, time.bucket);
      const series = new Map<string, Map<string, Row>>();
      for (const r of out) {
        const k = dimKey(r);
        if (!series.has(k)) series.set(k, new Map());
        series.get(k)!.set(String(r.bucket), r);
      }
      if (!series.size && !groupBy.length) series.set("[]", new Map());
      out = [];
      for (const [k, s] of series) {
        const dims = JSON.parse(k) as unknown[];
        let prev: Row | undefined;
        for (const b of range) {
          let r = s.get(b);
          if (!r) {
            r = { bucket: b };
            groupBy.forEach((f, i) => (r![f] = dims[i]));
            for (const m of base) {
              const def = catalog[m]!;
              r[m] = def.type === "stock" || def.type === "state" ? (prev?.[m] ?? null) : valueOf(undefined, def);
            }
          }
          out.push(r);
          prev = r;
        }
      }
    }
  }

  // 比率：汇总后的分子 / 分母
  for (const r of out) {
    for (const m of ratios) {
      const def = catalog[m]!;
      const n = num(r[def.numerator!]);
      const d = num(r[def.denominator!]);
      r[m] = n === null || d === null || d === 0 ? null : n / d;
    }
  }

  // 窗口
  if (spec.window?.length) {
    const partitions = new Map<string, Row[]>();
    for (const r of out) {
      const k = dimKey(r);
      if (!partitions.has(k)) partitions.set(k, []);
      partitions.get(k)!.push(r);
    }
    const perBucket = new Map<string, Row[]>();
    for (const r of out) {
      const k = String(r.bucket ?? "");
      if (!perBucket.has(k)) perBucket.set(k, []);
      perBucket.get(k)!.push(r);
    }
    for (const w of spec.window) {
      if (!spec.metrics.includes(w.metric)) throw new Error(`窗口指标 ${w.metric} 必须出现在 metrics 中`);
      const as = w.as ?? `${w.metric}_${w.op}`;
      if (w.op === "rank" || w.op === "share") {
        for (const rows of perBucket.values()) {
          const vals = rows.map((r) => num(r[w.metric]));
          const total = vals.reduce<number>((s, v) => s + (v ?? 0), 0);
          const sorted = [...vals].filter((v): v is number => v !== null).sort((a, b) => b - a);
          rows.forEach((r, i) => {
            const v = vals[i] ?? null;
            r[as] = v === null ? null : w.op === "rank" ? sorted.indexOf(v) + 1 : total ? v / total : null;
          });
        }
        continue;
      }
      for (const rows of partitions.values()) {
        rows.sort(byTime);
        let running = 0;
        rows.forEach((r, i) => {
          const v = num(r[w.metric]);
          if (w.op === "cumsum") {
            running += v ?? 0;
            r[as] = running;
          } else if (w.op === "rolling_mean" || w.op === "rolling_sum") {
            const size = Math.max(1, w.size ?? 7);
            const win = rows.slice(Math.max(0, i - size + 1), i + 1).map((x) => num(x[w.metric])).filter((x): x is number => x !== null);
            const s = win.reduce((a, b) => a + b, 0);
            r[as] = win.length ? (w.op === "rolling_sum" ? s : s / win.length) : null;
          } else {
            const lag = Math.max(1, w.lag ?? 1);
            const p = i >= lag ? num(rows[i - lag]![w.metric]) : null;
            r[as] = v === null || p === null ? null : w.op === "diff" ? v - p : p === 0 ? null : (v - p) / p;
          }
        });
      }
    }
  }

  // 只保留请求的指标（依赖项若未请求则移除）
  const keep = new Set(spec.metrics);
  for (const r of out) for (const m of base) if (!keep.has(m)) delete r[m];

  const sort = spec.sort ?? [...(time ? [{ by: "bucket" }] : []), ...groupBy.map((by) => ({ by }))];
  out.sort((a, b) => {
    for (const s of sort) {
      const x = a[s.by];
      const y = b[s.by];
      if (x === y) continue;
      const c = x === null || x === undefined ? 1 : y === null || y === undefined ? -1 : x < y ? -1 : 1;
      return s.desc ? -c : c;
    }
    return 0;
  });
  return spec.limit ? out.slice(0, spec.limit) : out;
}

// ------------------------------------------------------------------ 连续状态

export interface ReplaySpec {
  /** 实体主键字段，如 sku */
  key: string;
  /** 事件时间字段 */
  time: string;
  /** 增量字段（销售为负、到货为正） */
  delta: string;
  /** 操作字段：值为 "set" 时表示绝对值（如盘点），其余视为增量 */
  op?: string;
  /** 状态值字段名（期初行与输出行使用），默认 value */
  value?: string;
}

function apply(state: Map<unknown, number>, e: Row, spec: ReplaySpec): void {
  const k = e[spec.key];
  const valueField = spec.value ?? "value";
  if (spec.op && e[spec.op] === "set") state.set(k, Number(e[valueField] ?? e[spec.delta]) || 0);
  else state.set(k, (state.get(k) ?? 0) + (Number(e[spec.delta]) || 0));
}

const byField = (field: string) => (a: Row, b: Row) => String(a[field]).localeCompare(String(b[field]));

/** 期初状态 + 事件，回放到 until（含）为止，返回各实体的状态。 */
export function replay(opening: Iterable<Row>, events: Iterable<Row>, spec: ReplaySpec, until?: string): Map<unknown, number> {
  const valueField = spec.value ?? "value";
  const state = new Map<unknown, number>();
  for (const r of opening) state.set(r[spec.key], Number(r[valueField]) || 0);
  for (const e of [...events].sort(byField(spec.time))) {
    if (until !== undefined && String(e[spec.time]) > until) break;
    apply(state, e, spec);
  }
  return state;
}

export interface TimelineSpec extends ReplaySpec {
  bucket: Bucket;
  from: string;
  to: string;
}

/** 连续时间线：每个实体在每个时间桶末的状态值，无事件的桶沿用上一期。 */
export function timeline(opening: Iterable<Row>, events: Iterable<Row>, spec: TimelineSpec): Row[] {
  const valueField = spec.value ?? "value";
  const sorted = [...events].sort(byField(spec.time));
  const state = new Map<unknown, number>();
  for (const r of opening) state.set(r[spec.key], Number(r[valueField]) || 0);
  for (const e of sorted) if (!state.has(e[spec.key])) state.set(e[spec.key], 0);

  const out: Row[] = [];
  let i = 0;
  const start = bucketOf(spec.from, spec.bucket);
  // 区间开始前的事件只用于建立期初状态
  while (i < sorted.length && bucketOf(String(sorted[i]![spec.time]), spec.bucket) < start) apply(state, sorted[i++]!, spec);
  for (const b of bucketRange(spec.from, spec.to, spec.bucket)) {
    while (i < sorted.length && bucketOf(String(sorted[i]![spec.time]), spec.bucket) <= b) apply(state, sorted[i++]!, spec);
    for (const [k, v] of state) out.push({ [spec.key]: k, bucket: b, [valueField]: v });
  }
  return out;
}

export interface Segment {
  key: unknown;
  state: unknown;
  from: string;
  to: string;
  /** 连续的时间桶数 */
  length: number;
}

/** 把逐桶状态压缩成连续区间（run-length），用于统计持续时长、次数。 */
export function segments(rows: Iterable<Row>, spec: { key: string; state: string; time?: string }): Segment[] {
  const time = spec.time ?? "bucket";
  const sorted = [...rows].sort((a, b) => String(a[spec.key]).localeCompare(String(b[spec.key])) || String(a[time]).localeCompare(String(b[time])));
  const out: Segment[] = [];
  let cur: Segment | undefined;
  for (const r of sorted) {
    const k = r[spec.key];
    const s = r[spec.state];
    const t = String(r[time]);
    if (cur && cur.key === k && cur.state === s) {
      cur.to = t;
      cur.length++;
    } else {
      cur = { key: k, state: s, from: t, to: t, length: 1 };
      out.push(cur);
    }
  }
  return out;
}

// ------------------------------------------------------------------ 显示

/** 按指标定义格式化：% 比率、¥ 金额、千分位。 */
export function format(value: unknown, def?: Pick<MetricDef, "unit" | "digits">): string {
  if (value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value))) return "—";
  if (typeof value !== "number") return String(value);
  const unit = def?.unit ?? "";
  if (unit === "%") return `${(value * 100).toFixed(def?.digits ?? 1)}%`;
  const digits = def?.digits ?? (unit === "¥" ? 2 : Number.isInteger(value) ? 0 : 2);
  const text = value.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return unit === "¥" ? `¥${text}` : unit ? `${text}${unit}` : text;
}

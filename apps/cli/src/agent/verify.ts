/**
 * agent 输出的事实核验与工具结果压缩。
 * - summarizeResult：结果过大时给出结构化摘要，而不是从中间截断（截断会诱发模型反复重查）。
 * - NumberLedger：记录本次会话工具返回的全部数字，核验摘要/回复里的金额与百分比是否有出处。
 */

const HEAD_ROWS = 12;

type Obj = Record<string, unknown>;

function isRowArray(v: unknown): v is Obj[] {
  return Array.isArray(v) && v.length > 0 && v.every((r) => r !== null && typeof r === "object" && !Array.isArray(r));
}

function describeRows(rows: Obj[]): Obj {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const numeric: Record<string, { min: number; max: number; sum: number }> = {};
  const distinct: Record<string, number> = {};
  for (const c of columns) {
    const vals = rows.map((r) => r[c]);
    const nums = vals.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (nums.length) {
      numeric[c] = {
        min: Math.min(...nums),
        max: Math.max(...nums),
        sum: Math.round(nums.reduce((a, b) => a + b, 0) * 100) / 100,
      };
    } else distinct[c] = new Set(vals.map((v) => JSON.stringify(v))).size;
  }
  return { rows: rows.length, columns, numeric, distinctValues: distinct, head: rows.slice(0, HEAD_ROWS) };
}

/** 返回给模型看的结果文本：小结果原样返回，大结果返回结构摘要并说明如何取全量。 */
export function summarizeResult(result: unknown, limit: number): string {
  const full = JSON.stringify(result) ?? "null";
  if (full.length <= limit) return full;

  let summary: Obj;
  if (isRowArray(result)) summary = describeRows(result);
  else if (result && typeof result === "object" && !Array.isArray(result)) {
    // 对象里最大的行数组做摘要（如 { total, orders: [...] }、{ segments: [...] }）
    summary = {};
    for (const [k, v] of Object.entries(result as Obj)) summary[k] = isRowArray(v) && JSON.stringify(v).length > 2000 ? describeRows(v) : v;
  } else summary = { preview: full.slice(0, 2000) };

  const text = JSON.stringify({
    truncated: true,
    fullSize: full.length,
    summary,
    hint:
      "结果过大，这里只给出结构摘要（行数、列、数值范围与合计、前几行），重复调用不会得到更多内容。" +
      "需要全量数据给页面用：用 snapshot_data 快照，或在页面运行时用 qdd.tool 取数；只是为了理解数据：请粗化分组（如按周/按品类）或缩小日期范围后再查。",
  });
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** 时间范围标识：「MM-DD~MM-DD」；null 表示未限定范围。 */
export type Scope = string | null;

const pad2 = (n: string) => n.padStart(2, "0");

/** 从工具参数中推断查询的时间范围（from/to、time.from/to、对日期字段的过滤）。缺结束日时用 fallbackTo。 */
export function scopeOfArgs(args: Record<string, unknown>, fallbackTo?: string): Scope {
  let from: string | undefined;
  let to: string | undefined;
  const take = (v: unknown, side: "from" | "to") => {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) return;
    if (side === "from") from = v.slice(0, 10);
    else to = v.slice(0, 10);
  };
  take(args.from, "from");
  take(args.to, "to");
  const time = args.time as Record<string, unknown> | undefined;
  if (time) {
    take(time.from, "from");
    take(time.to, "to");
  }
  if (Array.isArray(args.filter)) {
    for (const f of args.filter as unknown[]) {
      if (!Array.isArray(f) || !/date|time/i.test(String(f[0]))) continue;
      if (f[1] === ">=" || f[1] === ">") take(f[2], "from");
      if (f[1] === "<=" || f[1] === "<") take(f[2], "to");
      if (f[1] === "=") {
        take(f[2], "from");
        take(f[2], "to");
      }
    }
  }
  if (from && !to && fallbackTo) to = fallbackTo.slice(0, 10);
  return from && to ? `${from.slice(5)}~${to.slice(5)}` : null;
}

/** 文本里提到的日期范围，如「2026-09-17~10-16」「9/1–9/16」。 */
export function scopesInText(text: string): string[] {
  const out: string[] = [];
  const re = /(?:\d{4}-)?(\d{1,2})[-/](\d{1,2})\s*(?:~|～|至|到|—|–|-)\s*(?:\d{4}-)?(\d{1,2})[-/](\d{1,2})/g;
  for (const m of text.matchAll(re)) out.push(`${pad2(m[1]!)}-${pad2(m[2]!)}~${pad2(m[3]!)}-${pad2(m[4]!)}`);
  return out;
}

interface Entry {
  v: number;
  scope: Scope;
  /** 合计值或小结果中的值；只有这些参与「两数推导」，避免大表里任意两格碰巧凑出数字 */
  salient: boolean;
}

/** 行数不超过这个的结果，其单元格视为显著值 */
const SALIENT_ROWS = 50;

/** 本次会话工具结果中出现过的数字（含每列合计）及其时间范围，用于核验结论。 */
export class NumberLedger {
  private entries: Entry[] = [];
  private index = new Map<string, number[]>();

  add(value: unknown, scope: Scope = null): void {
    const push = (v: number, salient: boolean) => this.entries.push({ v, scope, salient });
    const walk = (v: unknown, salient: boolean) => {
      if (typeof v === "number" && Number.isFinite(v)) push(v, salient);
      else if (Array.isArray(v)) {
        const small = salient && v.length <= SALIENT_ROWS;
        v.forEach((x) => walk(x, small));
        if (isRowArray(v)) {
          // 列合计：结论里的"总计"常由明细相加得到
          const cols = new Set(v.flatMap((r) => Object.keys(r)));
          for (const c of cols) {
            const nums = v.map((r) => r[c]).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
            if (nums.length > 1) push(nums.reduce((a, b) => a + b, 0), true);
          }
        }
      } else if (v && typeof v === "object") Object.values(v).forEach((x) => walk(x, salient));
    };
    walk(value, true);
    this.index.clear();
  }

  /** 店长原话、提问回答中的数字（如"涨价 5%"）视为有出处，不限范围。 */
  addText(text: string): void {
    for (const m of text.matchAll(/-?\d+(?:\.\d+)?/g)) {
      const n = Number(m[0]);
      this.entries.push({ v: n, scope: "*", salient: true }, { v: n / 100, scope: "*", salient: true });
    }
    this.index.clear();
  }

  get size(): number {
    return this.entries.length;
  }

  hasScope(scope: string): boolean {
    return this.entries.some((e) => e.scope === scope);
  }

  /** 已出现过的范围（便于提示）。 */
  scopesOf(v: number, decimals: number): string[] {
    const tol = 0.5 * 10 ** -decimals + 1e-6;
    return [...new Set(this.entries.filter((e) => Math.abs(e.v - v) <= tol).map((e) => e.scope ?? "全部数据"))].filter((x) => x !== "*");
  }

  private values(scopes?: string[], salientOnly = false): number[] {
    const key = `${scopes ? scopes.join("|") : ""}#${salientOnly}`;
    let arr = this.index.get(key);
    if (!arr) {
      const pick = (scopes ? this.entries.filter((e) => e.scope === "*" || scopes.includes(e.scope ?? "")) : this.entries).filter(
        (e) => !salientOnly || e.salient,
      );
      arr = [...new Set(pick.map((e) => e.v))].sort((a, b) => a - b);
      this.index.set(key, arr);
    }
    return arr;
  }

  private static nearest(arr: number[], target: number): number | undefined {
    if (!arr.length) return undefined;
    let lo = 0;
    let hi = arr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid]! < target) lo = mid + 1;
      else hi = mid;
    }
    const a = arr[lo]!;
    const b = lo > 0 ? arr[lo - 1]! : a;
    return Math.abs(a - target) < Math.abs(b - target) ? a : b;
  }

  private static has(arr: number[], target: number, tol: number): boolean {
    const n = NumberLedger.nearest(arr, target);
    return n !== undefined && Math.abs(n - target) <= tol;
  }

  /** 金额：直接出现，或为两个已知数之和/差/商（如客单价 = 销售额 ÷ 订单数）。scopes 给定时只在这些范围内找。 */
  verifyAmount(v: number, decimals: number, scopes?: string[]): boolean {
    const tol = 0.5 * 10 ** -decimals + 1e-6;
    if (NumberLedger.has(this.values(scopes), v, tol)) return true;
    const arr = this.values(scopes, true);
    for (const a of arr) {
      if (NumberLedger.has(arr, v - a, tol) || NumberLedger.has(arr, a - v, tol)) return true;
      if (v !== 0 && a !== 0) {
        const b = NumberLedger.nearest(arr, a / v);
        if (b && Math.abs(a / b - v) <= tol) return true;
      }
    }
    return false;
  }

  /** 百分比：直接出现（比例或百分数），或为两个已知数之比 / 增长率。不限范围（不同期的比率常常相同）。 */
  verifyPercent(p: number, decimals: number): boolean {
    const all = this.values();
    const tol = 0.5 * 10 ** -decimals + 1e-6;
    const r = p / 100;
    if (NumberLedger.has(all, r, tol / 100) || NumberLedger.has(all, p, tol)) return true;
    const arr = this.values(undefined, true);
    for (const a of arr) {
      if (a === 0) continue;
      for (const ratio of [r, 1 + r]) {
        if (ratio === 0) continue;
        const b = NumberLedger.nearest(arr, a / ratio);
        if (b && Math.abs((a / b - ratio) * 100) <= tol) return true;
      }
    }
    return false;
  }
}

/** 含这些词的分句是推演/假设，不要求数字有出处。 */
const ESTIMATE_MARK = /推演|估测|估算|预计|预测|假设|默认|模拟|若|如果|情景|目标/;

export interface Unverified {
  text: string;
  clause: string;
  /** 数字确实存在，但来自其它时间范围 */
  otherScopes?: string[];
  expectedScopes?: string[];
}

/**
 * 找出结论中没有出处的金额和百分比。
 * 分句提到日期范围时，金额必须来自同一范围的工具结果（未提范围的分句沿用上一个范围）。
 */
export function findUnverified(text: string, ledger: NumberLedger): Unverified[] {
  const out: Unverified[] = [];
  let scopes: string[] = [];
  for (const sentence of text.split(/[。；;！!？?\n]/)) {
    // 只按中文逗号或「逗号+非数字」切分，避免拆开千分位
    for (const clause of sentence.split(/，|,(?!\d)/)) {
      const mentioned = scopesInText(clause);
      if (mentioned.length) scopes = mentioned;
      if (!clause.trim() || ESTIMATE_MARK.test(clause)) continue;
      const known = scopes.filter((s) => ledger.hasScope(s));
      for (const m of clause.matchAll(/¥\s?(-?[\d,]+(?:\.(\d+))?)/g)) {
        const v = Number(m[1]!.replace(/,/g, ""));
        const d = m[2]?.length ?? 0;
        if (known.length) {
          if (ledger.verifyAmount(v, d, known)) continue;
          const other = ledger.scopesOf(v, d).filter((s) => !known.includes(s));
          out.push({ text: m[0], clause: clause.trim(), expectedScopes: known, ...(other.length ? { otherScopes: other } : {}) });
        } else if (!ledger.verifyAmount(v, d)) out.push({ text: m[0], clause: clause.trim() });
      }
      for (const m of clause.matchAll(/([+-]?\d+(?:\.(\d+))?)\s?%/g)) {
        const v = Number(m[1]);
        const d = m[2]?.length ?? 0;
        if (!ledger.verifyPercent(Math.abs(v), d) && !ledger.verifyPercent(v, d)) out.push({ text: m[0], clause: clause.trim() });
      }
    }
  }
  return out;
}

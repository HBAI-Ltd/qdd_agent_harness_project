/**
 * 5 段 cron（分 时 日 月 周），按本地时区计算。
 * 支持 *、数字、a-b 区间、a,b 列表、*\/n 与 a-b/n 步长；周 0 和 7 都表示周日。
 * 日与周同时受限时按标准语义取「或」。
 */
export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
  dayAny: boolean;
  weekdayAny: boolean;
}

const FIELDS: [string, number, number][] = [
  ["分钟", 0, 59],
  ["小时", 0, 23],
  ["日", 1, 31],
  ["月", 1, 12],
  ["星期", 0, 7],
];

function parseField(text: string, [label, min, max]: [string, number, number]): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`cron ${label}字段「${part}」格式错误`);
    const step = m[4] ? Number(m[4]) : 1;
    let lo = min;
    let hi = max;
    if (m[2] !== undefined) {
      lo = Number(m[2]);
      hi = m[3] !== undefined ? Number(m[3]) : m[4] ? max : lo;
    }
    if (step < 1 || lo < min || hi > max || lo > hi) throw new Error(`cron ${label}字段「${part}」超出范围 ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron 需要 5 段：分 时 日 月 周，例如 0 8 * * *（每天 08:00）");
  const [minute, hour, day, month, weekday] = parts.map((p, i) => parseField(p, FIELDS[i]!));
  if (weekday!.has(7)) weekday!.add(0);
  return { minute: minute!, hour: hour!, day: day!, month: month!, weekday: weekday!, dayAny: parts[2] === "*", weekdayAny: parts[4] === "*" };
}

function matchesDay(c: Cron, d: Date): boolean {
  const dom = c.day.has(d.getDate());
  const dow = c.weekday.has(d.getDay());
  if (c.dayAny && c.weekdayAny) return true;
  if (c.dayAny) return dow;
  if (c.weekdayAny) return dom;
  return dom || dow;
}

/** after 之后（不含）的下一次触发时间；一年内没有则返回 null。 */
export function nextRun(expr: string | Cron, after: Date): Date | null {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const t = new Date(after);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = after.getTime() + 366 * 24 * 3600_000;
  while (t.getTime() <= limit) {
    if (!c.month.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!matchesDay(c, t)) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minute.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0);
      continue;
    }
    return t;
  }
  return null;
}

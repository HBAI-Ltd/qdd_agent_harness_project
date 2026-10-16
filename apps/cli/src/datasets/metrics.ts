import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveMetrics, type MetricCatalog } from "@qdd/shared";
import type { HarnessPaths } from "../config.js";
import { readPages, writeAtomic, writePages } from "../web/site.js";

/** 指标口径：唯一来源。agent 与页面只能引用，修改需经店长授权并留历史。 */
export const DEFAULT_METRICS: MetricCatalog = {
  revenue: { label: "销售额", type: "flow", field: "revenue", unit: "¥" },
  cost: { label: "成本", type: "flow", field: "cost", unit: "¥" },
  grossProfit: { label: "毛利", type: "flow", field: "grossProfit", unit: "¥" },
  quantity: { label: "销量", type: "flow", field: "qty", digits: 0 },
  orders: { label: "订单数", type: "flow", field: "orderId", agg: "count_distinct", digits: 0 },
  grossMargin: { label: "毛利率", type: "ratio", numerator: "grossProfit", denominator: "revenue", unit: "%", description: "毛利 ÷ 销售额" },
  aov: { label: "客单价", type: "ratio", numerator: "revenue", denominator: "orders", unit: "¥", description: "销售额 ÷ 订单数" },
  stock: { label: "库存", type: "stock", field: "stock", entity: "sku", agg: "last", digits: 0, description: "各 SKU 期末库存之和" },
  status: { label: "库存状态", type: "state", field: "state" },
};

export async function loadMetrics(paths: HarnessPaths): Promise<MetricCatalog> {
  try {
    return JSON.parse(await readFile(paths.metrics, "utf8")) as MetricCatalog;
  } catch {
    return DEFAULT_METRICS;
  }
}

export async function ensureMetrics(paths: HarnessPaths): Promise<void> {
  try {
    await readFile(paths.metrics);
  } catch {
    await writeAtomic(paths.metrics, `${JSON.stringify(DEFAULT_METRICS, null, 2)}\n`);
  }
}

/**
 * 更新指标定义：校验 → 写历史 → 保存 → 标记依赖页面待复核。返回受影响的页面。
 * 调用方负责授权。
 */
export async function updateMetrics(paths: HarnessPaths, changes: MetricCatalog, reason: string): Promise<string[]> {
  const current = await loadMetrics(paths);
  const next = { ...current, ...changes };
  resolveMetrics(Object.keys(next), next); // 校验比率引用
  const stamp = new Date().toISOString();
  await writeAtomic(path.join(path.dirname(paths.metrics), "metrics.history", `${stamp.replace(/[^0-9]/g, "")}.json`), JSON.stringify({ at: stamp, reason, before: current, after: next }, null, 2));
  await writeAtomic(paths.metrics, `${JSON.stringify(next, null, 2)}\n`);

  const changed = new Set(Object.keys(changes));
  // 比率依赖的分子/分母变化也影响比率
  for (const [name, def] of Object.entries(next)) {
    if (def.type === "ratio" && (changed.has(def.numerator ?? "") || changed.has(def.denominator ?? ""))) changed.add(name);
  }
  const pages = await readPages(paths);
  const affected: string[] = [];
  for (const p of pages) {
    const hit = p.metrics.filter((m) => changed.has(m));
    if (hit.length) {
      p.stale = `指标口径已变更（${hit.join("、")}）：${reason}`;
      affected.push(p.slug);
    }
  }
  if (affected.length) await writePages(paths, pages);
  return affected;
}

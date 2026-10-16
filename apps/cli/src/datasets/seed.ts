import type { Row } from "@qdd/shared";
import type { StoreData } from "../datasource/store.js";
import type { DatasetStore } from "./store.js";

/** 把内置示例门店数据物化为数据集（仅在数据集缺失时执行）。 */
export async function seedBuiltinDatasets(store: DatasetStore, load: () => Promise<StoreData>): Promise<void> {
  const missing = await Promise.all(["products", "order_items", "inventory_moves"].map(async (n) => !(await store.get(n))));
  if (!missing.some(Boolean)) return;
  const data = await load();

  if (missing[0]) {
    await store.define({
      name: "products",
      description: "商品维度：SKU、名称、品类、售价、进价、安全库存",
      kind: "dimension",
      key: ["sku"],
      fields: { sku: "string", name: "string", category: "string", price: "number", cost: "number", unit: "string", safetyStock: "number" },
    });
    const safety = new Map(data.inventory.map((i) => [i.sku, i.safetyStock]));
    await store.replace("products", data.products.map((p) => ({ ...p, safetyStock: safety.get(p.sku) ?? 0 })));
  }

  if (missing[1]) {
    await store.define({
      name: "order_items",
      description: "订单明细（每个订单的每个商品一行），含销售额、成本、毛利",
      kind: "fact",
      key: ["orderId", "sku"],
      timeField: "time",
      fields: {
        orderId: "string", time: "string", date: "string", channel: "string", sku: "string", category: "string",
        qty: "number", price: "number", revenue: "number", cost: "number", grossProfit: "number",
      },
    });
    const products = new Map(data.products.map((p) => [p.sku, p]));
    const round = (n: number) => Math.round(n * 100) / 100;
    const rows: Row[] = data.orders.flatMap((o) =>
      o.items.map((it) => {
        const p = products.get(it.sku);
        const revenue = round(it.qty * it.price);
        const cost = round(it.qty * (p?.cost ?? 0));
        return {
          orderId: o.id, time: o.time, date: o.time.slice(0, 10), channel: o.channel, sku: it.sku, category: p?.category ?? "未知",
          qty: it.qty, price: it.price, revenue, cost, grossProfit: round(revenue - cost),
        };
      }),
    );
    await store.append("order_items", rows);
  }

  if (missing[2]) {
    await store.define({
      name: "inventory_moves",
      description: "库存流水：到货(+)、销售(-)、盘点(set 绝对值)。回放得到任意时刻库存",
      kind: "event_log",
      key: ["id"],
      timeField: "time",
      replay: { key: "sku", delta: "delta", op: "op", value: "stock" },
      fields: { id: "string", time: "string", sku: "string", type: "string", op: "string", delta: "number", stock: "number" },
    });
    await store.putCheckpoint("inventory_moves", { at: data.opening.at, rows: data.opening.rows });
    await store.append("inventory_moves", data.movements as unknown as Row[]);
  }
}

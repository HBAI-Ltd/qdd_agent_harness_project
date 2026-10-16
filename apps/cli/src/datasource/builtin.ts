import type { JsonObject, MetricCatalog, ToolSpec } from "@qdd/shared";
import { queryAggregate, querySegments, queryTimeline, type AggregateArgs, type SegmentsArgs, type TimelineArgs } from "../datasets/query.js";
import type { DatasetStore } from "../datasets/store.js";
import type { Order, StoreData } from "./store.js";

/** 内置数据源工具：全部只读，直接读取工作区里的 store.json。 */
export interface LocalTool extends ToolSpec {
  run(args: JsonObject): Promise<unknown>;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function inRange(orders: Order[], args: JsonObject): Order[] {
  const from = str(args.from);
  const to = str(args.to);
  return orders.filter((o) => {
    const day = o.time.slice(0, 10);
    return (!from || day >= from) && (!to || day <= to);
  });
}

const dateRangeProps = {
  from: { type: "string", description: "开始日期（含），YYYY-MM-DD" },
  to: { type: "string", description: "结束日期（含），YYYY-MM-DD" },
};

export interface StoreToolDeps {
  load: () => Promise<StoreData>;
  store: DatasetStore;
  metrics: () => Promise<MetricCatalog>;
}

const filterSchema = {
  type: "array",
  description: '过滤条件，每项 [字段, 操作, 值]；操作 = != > >= < <= in not_in contains；值可为 {"field":"另一字段"}',
  items: { type: "array" },
};
const joinSchema = {
  type: "array",
  description: "左关联其它数据集（如 products 维度），每项 { dataset, on, rightOn?, fields? }",
  items: { type: "object" },
};
const timelineProps = {
  dataset: { type: "string", description: "事件流数据集，如 inventory_moves" },
  from: { type: "string", description: "YYYY-MM-DD" },
  to: { type: "string", description: "YYYY-MM-DD" },
  bucket: { type: "string", enum: ["hour", "day", "week", "month"] },
  keys: { type: "array", items: { type: "string" }, description: "只看这些实体（如 SKU）" },
  join: joinSchema,
};

function datasetTools({ store, metrics }: StoreToolDeps): LocalTool[] {
  const ctx = { store, metrics };
  return [
    {
      name: "list_metrics",
      description: "指标口径目录（唯一口径来源）：flow 可加总，stock 取期末，ratio 由汇总后分子/分母重算，state 为状态。",
      inputSchema: { type: "object", properties: {} },
      run: () => metrics(),
    },
    {
      name: "list_datasets",
      description: "数据集清单：字段、主键、时间字段、版本、水位线（数据截至）、行数。",
      inputSchema: { type: "object", properties: {} },
      async run() {
        return (await store.list()).map(({ source: _source, ...m }) => m);
      },
    },
    {
      name: "aggregate",
      description: "零 SQL 声明式聚合：过滤→时间分桶→分组→按指标口径汇总→补齐→比率重算→窗口（累计/移动平均/环比/排名/占比）。",
      inputSchema: {
        type: "object",
        properties: {
          dataset: { type: "string", description: "数据集名，如 order_items" },
          filter: filterSchema,
          groupBy: { type: "array", items: { type: "string" } },
          time: {
            type: "object",
            description: "{ field, bucket: hour|day|week|month, fill?, from?, to? }",
            properties: { field: { type: "string" }, bucket: { type: "string" }, fill: { type: "boolean" }, from: { type: "string" }, to: { type: "string" } },
          },
          metrics: { type: "array", items: { type: "string" }, description: "指标名，见 list_metrics" },
          window: { type: "array", description: "{ metric, op: cumsum|rolling_mean|rolling_sum|pct_change|diff|rank|share, size?, lag?, as? }", items: { type: "object" } },
          sort: { type: "array", items: { type: "object" } },
          limit: { type: "integer" },
          keymap: { type: "array", description: "外部编号映射，每项 { field, dataset }", items: { type: "object" } },
          join: joinSchema,
        },
        required: ["dataset", "metrics"],
      },
      run: (args) => queryAggregate(ctx, args as unknown as AggregateArgs),
    },
    {
      name: "timeline",
      description: "连续状态时间线：检查点 + 流水回放，返回每个实体在每个时间桶末的状态值（如每日各 SKU 库存）。",
      inputSchema: { type: "object", properties: timelineProps, required: ["dataset", "from", "to", "bucket"] },
      run: (args) => queryTimeline(ctx, args as unknown as TimelineArgs),
    },
    {
      name: "segments",
      description: "状态区间：时间线按规则分类后压缩为连续区间，并汇总每个实体各状态的次数与持续桶数（如缺货时长）。",
      inputSchema: {
        type: "object",
        properties: {
          ...timelineProps,
          rules: {
            type: "array",
            description: '按序匹配，如 [{"when":[["stock","=",0]],"state":"缺货"},{"when":[["stock","<",{"field":"safetyStock"}]],"state":"偏低"}]',
            items: { type: "object" },
          },
          fallback: { type: "string", description: "都不匹配时的状态，如 正常" },
        },
        required: ["dataset", "from", "to", "bucket", "rules", "fallback"],
      },
      run: (args) => querySegments(ctx, args as unknown as SegmentsArgs),
    },
  ];
}

export function createStoreTools(deps: StoreToolDeps): LocalTool[] {
  const { load } = deps;
  return [
    ...datasetTools(deps),
    {
      name: "get_store_info",
      description: "门店基础信息、商品品类列表、订单数据覆盖的日期范围。",
      inputSchema: { type: "object", properties: {} },
      async run() {
        const data = await load();
        return {
          ...data.store,
          categories: [...new Set(data.products.map((p) => p.category))],
          productCount: data.products.length,
          orderCount: data.orders.length,
          dateRange: {
            from: data.orders[0]?.time.slice(0, 10) ?? null,
            to: data.orders.at(-1)?.time.slice(0, 10) ?? null,
          },
        };
      },
    },
    {
      name: "list_products",
      description: "商品清单（SKU、名称、品类、售价、进价、单位）。",
      inputSchema: {
        type: "object",
        properties: { category: { type: "string", description: "按品类过滤" } },
      },
      async run(args) {
        const category = str(args.category);
        return (await load()).products.filter((p) => !category || p.category === category);
      },
    },
    {
      name: "get_inventory",
      description: "当前库存与安全库存，status 为 缺货/偏低/正常。",
      inputSchema: {
        type: "object",
        properties: { lowStockOnly: { type: "boolean", description: "只返回低于安全库存的商品" } },
      },
      async run(args) {
        const data = await load();
        const bySku = new Map(data.products.map((p) => [p.sku, p]));
        return data.inventory
          .map((i) => ({
            ...i,
            name: bySku.get(i.sku)?.name,
            category: bySku.get(i.sku)?.category,
            status: i.stock === 0 ? "缺货" : i.stock < i.safetyStock ? "偏低" : "正常",
          }))
          .filter((i) => !args.lowStockOnly || i.status !== "正常");
      },
    },
    {
      name: "query_orders",
      description: "订单明细（按时间升序）。数据量大时优先用 sales_summary。",
      inputSchema: {
        type: "object",
        properties: {
          ...dateRangeProps,
          channel: { type: "string", enum: ["门店", "外卖", "小程序"] },
          limit: { type: "integer", description: "最多返回条数，默认 200，上限 5000" },
        },
      },
      async run(args) {
        const channel = str(args.channel);
        const limit = Math.min(Math.max(Number(args.limit) || 200, 1), 5000);
        const all = inRange((await load()).orders, args).filter((o) => !channel || o.channel === channel);
        return { total: all.length, returned: Math.min(limit, all.length), orders: all.slice(-limit) };
      },
    },
    {
      name: "sales_summary",
      description: "销售汇总：按 day/week_day/hour/product/category/channel 分组，返回订单数、销量、销售额、毛利。",
      inputSchema: {
        type: "object",
        properties: {
          ...dateRangeProps,
          groupBy: { type: "string", enum: ["day", "week_day", "hour", "product", "category", "channel"] },
        },
        required: ["groupBy"],
      },
      async run(args) {
        const data = await load();
        const groupBy = str(args.groupBy) ?? "day";
        const bySku = new Map(data.products.map((p) => [p.sku, p]));
        const rows = new Map<string, { key: string; label: string; orders: Set<string>; quantity: number; revenue: number; grossProfit: number }>();
        const weekDays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
        for (const o of inRange(data.orders, args)) {
          for (const it of o.items) {
            const p = bySku.get(it.sku);
            let key: string;
            let label: string;
            switch (groupBy) {
              case "hour": key = label = o.time.slice(11, 13); break;
              case "week_day": {
                const d = new Date(`${o.time.slice(0, 10)}T00:00:00`).getDay();
                key = String(d);
                label = weekDays[d]!;
                break;
              }
              case "product": key = it.sku; label = p?.name ?? it.sku; break;
              case "category": key = label = p?.category ?? "未知"; break;
              case "channel": key = label = o.channel; break;
              default: key = label = o.time.slice(0, 10);
            }
            const row = rows.get(key) ?? { key, label, orders: new Set(), quantity: 0, revenue: 0, grossProfit: 0 };
            row.orders.add(o.id);
            row.quantity += it.qty;
            row.revenue += it.qty * it.price;
            row.grossProfit += it.qty * (it.price - (p?.cost ?? 0));
            rows.set(key, row);
          }
        }
        const round = (n: number) => Math.round(n * 100) / 100;
        return [...rows.values()]
          .sort((a, b) => a.key.localeCompare(b.key))
          .map((r) => ({ key: r.key, label: r.label, orders: r.orders.size, quantity: r.quantity, revenue: round(r.revenue), grossProfit: round(r.grossProfit) }));
      },
    },
  ];
}

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, describe, test } from "node:test";
import vm from "node:vm";
import { aggregate, bucketRange, classify, segments, timeline, type Row } from "@qdd/shared";
import { generateStoreData, type StoreData } from "./datasource/store.js";
import { DEFAULT_METRICS } from "./datasets/metrics.js";
import { compactDataset, queryAggregate, querySegments, queryTimeline } from "./datasets/query.js";
import { seedBuiltinDatasets } from "./datasets/seed.js";
import { JsonlDatasetStore, readAll } from "./datasets/store.js";
import { buildComputeScript } from "./gateway/sdk.js";

const M = DEFAULT_METRICS;
const close = (a: unknown, b: number) => assert.ok(Math.abs(Number(a) - b) < 1e-6, `${String(a)} ≠ ${b}`);

describe("计算引擎", () => {
  const rows: Row[] = [
    { time: "2026-10-01 09:00", cat: "A", orderId: "o1", revenue: 100, grossProfit: 50 },
    { time: "2026-10-01 10:00", cat: "B", orderId: "o2", revenue: 10, grossProfit: 1 },
    { time: "2026-10-03 10:00", cat: "A", orderId: "o3", revenue: 300, grossProfit: 30 },
  ];

  test("比率由汇总后的分子/分母重算，不对比率求平均", () => {
    const [all] = aggregate(rows, { metrics: ["grossMargin", "revenue"] }, M);
    close(all!.grossMargin, 81 / 410); // 而不是 (0.5 + 0.1 + 0.1) / 3
    const byCat = aggregate(rows, { groupBy: ["cat"], metrics: ["revenue", "grossMargin"] }, M);
    close(byCat.reduce((s, r) => s + Number(r.revenue), 0), Number(all!.revenue)); // 分组之和 = 总计
    close(byCat.find((r) => r.cat === "A")!.grossMargin, 80 / 400);
    assert.equal("grossProfit" in all!, false, "未请求的依赖项不输出");
  });

  test("补齐时间桶：flow 补 0，比率为空，累计正确", () => {
    const out = aggregate(rows, { time: { field: "time", bucket: "day", fill: true }, metrics: ["revenue", "aov"], window: [{ metric: "revenue", op: "cumsum" }] }, M);
    assert.deepEqual(out.map((r) => r.bucket), ["2026-10-01", "2026-10-02", "2026-10-03"]);
    assert.equal(out[1]!.revenue, 0);
    assert.equal(out[1]!.aov, null);
    assert.equal(out.at(-1)!.revenue_cumsum, 410);
  });

  test("存量：按实体取期末再求和，缺失时间桶沿用上一期", () => {
    const stock: Row[] = [
      { bucket: "2026-10-01", sku: "a", stock: 5 },
      { bucket: "2026-10-01", sku: "b", stock: 3 },
      { bucket: "2026-10-03", sku: "a", stock: 1 },
    ];
    const out = aggregate(stock, { time: { field: "bucket", bucket: "day", fill: true }, metrics: ["stock"] }, M);
    assert.deepEqual(out.map((r) => r.stock), [8, 8, 1]);
  });

  test("窗口：环比、移动平均、排名、占比", () => {
    const out = aggregate(rows, { groupBy: ["cat"], time: { field: "time", bucket: "day", fill: true }, metrics: ["revenue"], window: [
      { metric: "revenue", op: "pct_change" },
      { metric: "revenue", op: "rolling_mean", size: 2 },
      { metric: "revenue", op: "share" },
      { metric: "revenue", op: "rank" },
    ] }, M);
    const a3 = out.find((r) => r.cat === "A" && r.bucket === "2026-10-03")!;
    assert.equal(a3.revenue_pct_change, null); // 上一期为 0
    assert.equal(a3.revenue_rolling_mean, 150);
    const d1 = out.filter((r) => r.bucket === "2026-10-01");
    close(d1.reduce((s, r) => s + Number(r.revenue_share), 0), 1);
    assert.equal(d1.find((r) => r.cat === "A")!.revenue_rank, 1);
  });

  test("时间线 + 状态区间：首尾相接、不重叠、覆盖全部时间桶", () => {
    const tl = timeline([{ sku: "a", stock: 2 }], [
      { time: "2026-10-02 08:00", sku: "a", delta: -2, op: "delta" },
      { time: "2026-10-04 06:00", sku: "a", delta: 0, op: "set", stock: 9 },
    ], { key: "sku", time: "time", delta: "delta", op: "op", value: "stock", bucket: "day", from: "2026-10-01", to: "2026-10-05" });
    assert.deepEqual(tl.map((r) => r.stock), [2, 0, 0, 9, 9]);
    const segs = segments(classify(tl, [{ when: [["stock", "=", 0]], state: "缺货" }], "正常"), { key: "sku", state: "state" });
    assert.deepEqual(segs.map((s) => [s.state, s.from, s.to, s.length]), [
      ["正常", "2026-10-01", "2026-10-01", 1],
      ["缺货", "2026-10-02", "2026-10-03", 2],
      ["正常", "2026-10-04", "2026-10-05", 2],
    ]);
  });

  test("浏览器版引擎与 Node 版结果一致", async () => {
    const sandbox: { window: Record<string, unknown> } = { window: {} };
    vm.runInNewContext(await buildComputeScript(), sandbox);
    const browser = sandbox.window.__qddCompute as { aggregate: typeof aggregate };
    const spec = { groupBy: ["cat"], time: { field: "time", bucket: "day" as const, fill: true }, metrics: ["revenue", "grossMargin"] };
    assert.deepEqual(JSON.parse(JSON.stringify(browser.aggregate(rows, spec, M))), JSON.parse(JSON.stringify(aggregate(rows, spec, M))));
  });
});

describe("数据集", () => {
  let store: JsonlDatasetStore;
  let data: StoreData;
  const ctx = () => ({ store, metrics: async () => M });

  before(async () => {
    store = new JsonlDatasetStore(path.join(await mkdtemp(path.join(tmpdir(), "qdd-ds-")), "datasets"));
    data = generateStoreData(new Date(2026, 9, 16), 45);
    await seedBuiltinDatasets(store, async () => data);
  });

  test("跨分区读取 = 全量计算；只读范围内的分区", async () => {
    const all = await readAll(store, "order_items");
    const part = await queryAggregate(ctx(), { dataset: "order_items", time: { field: "time", bucket: "month", from: "2026-10-01", to: "2026-10-16" }, metrics: ["revenue"] });
    const expected = all.filter((r) => String(r.time) >= "2026-10-01").reduce((s, r) => s + Number(r.revenue), 0);
    close(part[0]!.revenue, expected);
    const ranged = await readAll(store, "order_items", { from: "2026-10-10", to: "2026-10-11" });
    assert.ok(ranged.length > 0 && ranged.every((r) => String(r.date) >= "2026-10-10" && String(r.date) <= "2026-10-11"));
  });

  test("回放结果与生成器的最终库存一致；检查点前后结果相同", async () => {
    const args = { dataset: "inventory_moves", from: "2026-10-05", to: "2026-10-16", bucket: "day" as const };
    const before = await queryTimeline(ctx(), args);
    const final = new Map(before.filter((r) => r.bucket === "2026-10-16").map((r) => [r.sku, r.stock]));
    for (const i of data.inventory) assert.equal(final.get(i.sku), i.stock, i.sku);

    await compactDataset(store, "inventory_moves", "2026-10-03 00:00");
    assert.equal((await store.checkpoint("inventory_moves", "2026-10-05 00:00"))?.at, "2026-10-03 00:00");
    assert.deepEqual(await queryTimeline(ctx(), args), before);
  });

  test("状态区间覆盖每个 SKU 的全部时间桶", async () => {
    const res = await querySegments(ctx(), {
      dataset: "inventory_moves", from: "2026-10-01", to: "2026-10-16", bucket: "day",
      join: [{ dataset: "products", on: "sku", fields: ["safetyStock"] }],
      rules: [{ when: [["stock", "=", 0]], state: "缺货" }, { when: [["stock", "<", { field: "safetyStock" }]], state: "偏低" }],
      fallback: "正常",
    });
    const days = bucketRange("2026-10-01", "2026-10-16", "day").length;
    for (const sku of new Set(res.segments.map((s) => s.key))) {
      const own = res.segments.filter((s) => s.key === sku);
      assert.equal(own.reduce((n, s) => n + s.length, 0), days, String(sku));
      for (let i = 1; i < own.length; i++) assert.ok(own[i]!.from > own[i - 1]!.to);
    }
  });

  test("同主键重复追加幂等；关联与编号映射", async () => {
    await store.define({ name: "keymap/erp", description: "ERP 编号映射", kind: "dimension", key: ["from"], fields: { from: "string", to: "string" } });
    await store.replace("keymap/erp", [{ from: "E-1", to: "SKU001" }]);
    await store.define({ name: "erp_sales", description: "ERP 销售", kind: "fact", key: ["id"], timeField: "time", fields: { id: "string", time: "string", sku: "string", revenue: "number" } });
    const rows = [{ id: "x1", time: "2026-10-16 10:00", sku: "E-1", revenue: 5 }, { id: "x2", time: "2026-10-16 11:00", sku: "E-9", revenue: 7 }];
    await store.append("erp_sales", rows);
    const v1 = (await store.get("erp_sales"))!.version;
    await store.append("erp_sales", rows);
    assert.notEqual((await store.get("erp_sales"))!.version, v1);
    assert.equal((await readAll(store, "erp_sales")).length, 2);

    const out = await queryAggregate(ctx(), {
      dataset: "erp_sales", keymap: [{ field: "sku", dataset: "keymap/erp" }],
      join: [{ dataset: "products", on: "sku", fields: ["category"] }],
      groupBy: ["category"], metrics: ["revenue"],
    });
    assert.deepEqual(out.map((r) => [r.category, r.revenue]), [["饮料", 5], [null, 7]]);
  });

  test("聚合描述严格校验，错误写法给出正确示例", async () => {
    await assert.rejects(
      queryAggregate(ctx(), { dataset: "order_items", metrics: ["revenue"], groupBy: ["category"], sort: [{ field: "revenue", dir: "desc" } as never] }),
      /sort 每项应为 \{"by": 输出列/,
    );
    await assert.rejects(queryAggregate(ctx(), { dataset: "order_items", metrics: ["revenue"], groupBy: ["品类"] }), /字段 品类 不存在/);
    await assert.rejects(queryAggregate(ctx(), { dataset: "order_items", metrics: ["revenue"], filter: [["date", "between" as never, 1]] }), /操作 between 不支持/);
    const ok = await queryAggregate(ctx(), { dataset: "order_items", metrics: ["revenue"], groupBy: ["category"], sort: [{ by: "revenue", desc: true }] });
    assert.ok(Number(ok[0]!.revenue) >= Number(ok[1]!.revenue));
  });

  test("字段类型校验", async () => {
    await assert.rejects(store.append("erp_sales", [{ id: "x3", time: "2026-10-16 12:00", sku: "a", revenue: "5" }]), /应为 number/);
  });
});

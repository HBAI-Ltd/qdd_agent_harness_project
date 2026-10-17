import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { findUnverified, NumberLedger, scopeOfArgs, scopesInText, summarizeResult } from "./agent/verify.js";

describe("结论数字核验", () => {
  const ledger = () => {
    const l = new NumberLedger();
    l.add([{ revenue: 21593, grossProfit: 8742.7, orders: 2337 }], "09-17~10-16");
    l.add([{ revenue: 19446.1, grossProfit: 7866.5 }], "08-18~09-16");
    l.add([{ revenue: 937.1, orders: 95 }], "10-16~10-16");
    return l;
  };

  test("时间范围解析", () => {
    assert.equal(scopeOfArgs({ filter: [["date", ">=", "2026-09-17"], ["date", "<=", "2026-10-16"]] }), "09-17~10-16");
    assert.equal(scopeOfArgs({ time: { field: "time", bucket: "day", from: "2026-09-17" } }, "2026-10-16 22:26"), "09-17~10-16");
    assert.equal(scopeOfArgs({ groupBy: ["sku"] }), null);
    assert.deepEqual(scopesInText("近 30 天（2026-09-17~10-16）对比 9/1–9/16"), ["09-17~10-16", "09-01~09-16"]);
  });

  test("标注的时间范围与数字来源错位时拒绝，并指出错位", () => {
    const [u] = findUnverified("近 30 天（2026-09-17~10-16）销售额 ¥19,446.10、毛利 ¥7,866.50", ledger());
    assert.equal(u?.text, "¥19,446.10");
    assert.deepEqual(u?.otherScopes, ["08-18~09-16"]);
    assert.deepEqual(findUnverified("近 30 天（2026-09-17~10-16）销售额 ¥21,593.00，毛利 ¥8,742.70", ledger()), []);
  });

  test("未提范围的分句沿用上一个范围；同一分句两个范围取并集", () => {
    assert.equal(findUnverified("2026-09-17~10-16 全店表现平稳。毛利 ¥7,866.50", ledger()).length, 1);
    assert.deepEqual(findUnverified("9/17–10/16 对比 8/18–9/16：销售额 ¥21,593.00 对 ¥19,446.10", ledger()), []);
  });

  test("由两数相除得到的金额（客单价）可通过；推演分句不要求出处", () => {
    assert.deepEqual(findUnverified("今日（10-16~10-16）销售额 ¥937.10、客单价 ¥9.86", ledger()), []);
    assert.deepEqual(findUnverified("推演提价后毛利可达 ¥99,999.00", ledger()), []);
    assert.equal(findUnverified("全店毛利 ¥12,345.00", ledger()).length, 1);
  });

  test("大结果给结构摘要而不是截断", () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ sku: `S${i}`, revenue: i }));
    const out = JSON.parse(summarizeResult(rows, 12_000)) as { truncated: boolean; summary: { rows: number; numeric: { revenue: { sum: number } } } };
    assert.equal(out.truncated, true);
    assert.equal(out.summary.rows, 2000);
    assert.equal(out.summary.numeric.revenue.sum, (1999 * 2000) / 2);
  });
});

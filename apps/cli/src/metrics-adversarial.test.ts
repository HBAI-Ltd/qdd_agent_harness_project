import assert from "node:assert/strict";
import { promises as fs, readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { MetricCatalog, PageEntry } from "@qdd/shared";
import { loadConfig, type HarnessPaths } from "./config.js";
import { DEFAULT_METRICS, ensureMetrics, loadMetrics, updateMetrics } from "./datasets/metrics.js";
import { readPages, upsertPage } from "./web/site.js";

async function fixture(t: TestContext): Promise<HarnessPaths> {
  const root = await mkdtemp(path.join(tmpdir(), "qdd-metrics-adversarial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { paths } = await loadConfig(root);
  await ensureMetrics(paths);
  return paths;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function page(slug: string, metric: string): PageEntry {
  const at = new Date().toISOString();
  return {
    slug, title: slug, wish: "test", summary: "test", tools: [], useAgent: false,
    metrics: [metric], datasets: {}, version: 1, stale: null, gaps: [],
    sessionId: "test", createdAt: at, updatedAt: at,
  };
}

interface MetricHistory {
  at: string;
  reason: string;
  before: MetricCatalog;
  after: MetricCatalog;
}

async function history(paths: HarnessPaths): Promise<MetricHistory[]> {
  const directory = path.join(path.dirname(paths.metrics), "metrics.history");
  return Promise.all((await readdir(directory)).map(async (file) =>
    JSON.parse(await readFile(path.join(directory, file), "utf8")) as MetricHistory,
  ));
}

test("concurrent metric changes read the previous committed catalog and retain both page invalidations", async (t) => {
  const paths = await fixture(t);
  await upsertPage(paths, page("metric-a", "metric_a"));
  await upsertPage(paths, page("metric-b", "metric_b"));

  // Freeze the first real catalog snapshot. An unprotected second update reads
  // the same old bytes before the first transaction is allowed to commit.
  const entered = deferred();
  const release = deferred();
  const originalRead = fs.readFile;
  let reads = 0;
  const mockedRead = t.mock.method(fs, "readFile", (async (...args: Parameters<typeof fs.readFile>) => {
    if (args[0] === paths.metrics && args[1] === "utf8") {
      const snapshot = readFileSync(paths.metrics, "utf8");
      if (++reads === 1) { entered.resolve(); await release.promise; }
      return snapshot;
    }
    return originalRead(...args);
  }) as typeof fs.readFile);
  syncBuiltinESMExports();
  t.after(() => { mockedRead.mock.restore(); syncBuiltinESMExports(); });

  const first = updateMetrics(paths, { metric_a: { label: "A", type: "flow", field: "a" } }, "change A");
  await entered.promise;
  const second = updateMetrics(paths, { metric_b: { label: "B", type: "flow", field: "b" } }, "change B");
  release.resolve();
  const affected = await Promise.all([first, second]);

  const catalog = await loadMetrics(paths);
  assert.equal(catalog.metric_a?.field, "a");
  assert.equal(catalog.metric_b?.field, "b");
  assert.deepEqual(affected, [["metric-a"], ["metric-b"]]);
  const pages = await readPages(paths);
  assert.match(pages.find((entry) => entry.slug === "metric-a")!.stale!, /change A/);
  assert.match(pages.find((entry) => entry.slug === "metric-b")!.stale!, /change B/);
  const audit = await history(paths);
  const secondAudit = audit.find((entry) => entry.reason === "change B")!;
  assert.equal(secondAudit.before.metric_a?.field, "a", "Audit history must start from the previous committed change");
  assert.equal(secondAudit.after.metric_b?.field, "b");
});

test("two metric updates in the same millisecond retain separate linked audit records", async (t) => {
  const paths = await fixture(t);
  const stamp = "2026-10-17T00:00:00.123Z";
  t.mock.method(Date.prototype, "toISOString", () => stamp);
  await updateMetrics(paths, { metric_a: { label: "A", type: "flow", field: "a" } }, "first same-time change");
  await updateMetrics(paths, { metric_b: { label: "B", type: "flow", field: "b" } }, "second same-time change");
  const audit = await history(paths);
  assert.equal(audit.length, 2, "Timestamp collisions must not overwrite an earlier audit record");
  assert.ok(audit.every((entry) => entry.at === stamp));
  const first = audit.find((entry) => entry.reason === "first same-time change")!;
  const second = audit.find((entry) => entry.reason === "second same-time change")!;
  assert.deepEqual(first.before, DEFAULT_METRICS);
  assert.deepEqual(second.before, first.after);
});

test("an invalid metric update leaves no audit or catalog changes and does not poison queued updates", async (t) => {
  const paths = await fixture(t);
  const [invalid, valid] = await Promise.allSettled([
    updateMetrics(paths, { broken: { label: "Broken", type: "ratio", numerator: "missing", denominator: "revenue" } }, "invalid change"),
    updateMetrics(paths, { metric_a: { label: "A", type: "flow", field: "a" } }, "valid change"),
  ]);
  assert.equal(invalid.status, "rejected");
  assert.equal(valid.status, "fulfilled");
  const audit = await history(paths);
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.reason, "valid change");
  assert.deepEqual(audit[0]!.before, DEFAULT_METRICS);
  assert.equal("broken" in audit[0]!.after, false);
  await updateMetrics(paths, { metric_b: { label: "B", type: "flow", field: "b" } }, "later change");
  const catalog = await loadMetrics(paths);
  assert.equal("broken" in catalog, false);
  assert.equal(catalog.metric_a?.field, "a");
  assert.equal(catalog.metric_b?.field, "b");
});

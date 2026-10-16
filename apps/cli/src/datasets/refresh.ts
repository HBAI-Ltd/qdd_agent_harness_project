import { mapKeys, type Row } from "@qdd/shared";
import type { DataSources } from "../datasource/registry.js";
import { readAll } from "./store.js";

export interface RefreshResult {
  dataset: string;
  added: number;
  version: string;
  watermark: string | null;
  error?: string;
}

/**
 * 增量刷新：对声明了 source 的数据集，带上水位线调用只读数据工具，把新行追加进数据集。
 * 由 harness 执行（CLI 或网关定时），不经过 agent；同主键重复行以最新为准，因此可重复执行。
 */
export async function refreshDatasets(sources: DataSources, only?: string[]): Promise<RefreshResult[]> {
  const store = sources.datasets;
  const results: RefreshResult[] = [];
  for (const m of await store.list()) {
    if (!m.source || (only?.length && !only.includes(m.name))) continue;
    try {
      const tool = sources.get(m.source.tool);
      if (!tool) throw new Error(`数据工具 ${m.source.tool} 不可用`);
      if (tool.mutating) throw new Error(`数据集来源 ${m.source.tool} 是写入类工具`);
      const args = { ...m.source.args };
      if (m.source.sinceArg && m.watermark) args[m.source.sinceArg] = m.watermark;
      const result = await tool.call(args);
      let rows = (m.source.rowsField ? (result as Record<string, unknown>)?.[m.source.rowsField] : result) as Row[];
      if (!Array.isArray(rows)) throw new Error("数据工具返回的不是行数组");
      for (const [field, dataset] of Object.entries(m.source.keymap ?? {})) {
        rows = mapKeys(rows, await readAll(store, dataset), field);
      }
      const next = rows.length ? await store.append(m.name, rows) : m;
      results.push({ dataset: m.name, added: rows.length, version: next.version, watermark: next.watermark });
    } catch (error) {
      results.push({ dataset: m.name, added: 0, version: m.version, watermark: m.watermark, error: (error as Error).message });
    }
  }
  return results;
}

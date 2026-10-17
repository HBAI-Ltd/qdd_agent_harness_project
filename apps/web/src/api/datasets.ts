import type { DatasetManifest, MetricCatalog } from "@qdd/shared";
import { gatewayJson } from "./workspace";

/** Each dataset can fail independently even when the refresh request returns HTTP 200. */
export interface DatasetRefreshResult {
  dataset: string;
  added: number;
  version: string;
  watermark: string | null;
  error?: string;
}

export function listDatasets(base: string, token: string, signal?: AbortSignal): Promise<DatasetManifest[]> {
  return gatewayJson(base, token, "/api/datasets", { signal: signal ?? null });
}

export function getMetrics(base: string, token: string, signal?: AbortSignal): Promise<MetricCatalog> {
  return gatewayJson(base, token, "/api/metrics", { signal: signal ?? null });
}

export function refreshDatasets(base: string, token: string, datasets?: string[], signal?: AbortSignal): Promise<DatasetRefreshResult[]> {
  return gatewayJson(base, token, "/api/datasets/refresh", {
    method: "POST", body: JSON.stringify(datasets ? { datasets } : {}), signal: signal ?? null,
  });
}

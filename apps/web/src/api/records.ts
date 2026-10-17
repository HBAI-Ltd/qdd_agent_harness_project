import type { RecordField, RecordInput, RecordSchema, Row } from "@qdd/shared";
import { gatewayJson } from "./workspace";

export interface RecordSet {
  name: string;
  description: string;
  schema: RecordSchema;
  rowCount: number;
  watermark: string | null;
  updatedAt: string;
}
export interface RecordDefinitionInput {
  name: string;
  label: string;
  description?: string;
  fields: RecordField[];
}
export interface RecordQuery { from?: string; to?: string; limit?: number }
export interface RecordQueryResult { schema: RecordSchema; rows: Row[]; total: number }

const recordPath = (name: string, id?: string) => `/api/records/${encodeURIComponent(name)}${id === undefined ? "" : `/${encodeURIComponent(id)}`}`;

export function listRecordSets(base: string, token: string, signal?: AbortSignal): Promise<RecordSet[]> {
  return gatewayJson(base, token, "/api/records", { signal: signal ?? null });
}
/** The same POST creates a set or extends its existing schema. */
export function defineRecordSet(base: string, token: string, input: RecordDefinitionInput, signal?: AbortSignal): Promise<{ name: string; schema: RecordSchema }> {
  return gatewayJson(base, token, "/api/records", { method: "POST", body: JSON.stringify(input), signal: signal ?? null });
}
export function queryRecords(base: string, token: string, name: string, query: RecordQuery = {}, signal?: AbortSignal): Promise<RecordQueryResult> {
  const search = new URLSearchParams();
  if (query.from) search.set("from", query.from);
  if (query.to) search.set("to", query.to);
  if (query.limit !== undefined) search.set("limit", String(query.limit));
  return gatewayJson(base, token, `${recordPath(name)}${search.size ? `?${search}` : ""}`, { signal: signal ?? null });
}
export function addRecords(base: string, token: string, name: string, input: RecordInput | RecordInput[], signal?: AbortSignal): Promise<{ rows: Row[] }> {
  return gatewayJson(base, token, recordPath(name), { method: "POST", body: JSON.stringify(input), signal: signal ?? null });
}
export function updateRecord(base: string, token: string, name: string, id: string, patch: RecordInput, signal?: AbortSignal): Promise<{ row: Row }> {
  return gatewayJson(base, token, recordPath(name, id), { method: "PUT", body: JSON.stringify(patch), signal: signal ?? null });
}
export function voidRecord(base: string, token: string, name: string, id: string, signal?: AbortSignal): Promise<{ ok: true }> {
  return gatewayJson(base, token, recordPath(name, id), { method: "DELETE", signal: signal ?? null });
}

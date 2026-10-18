import { randomUUID } from "node:crypto";
import type { DatasetManifest, RecordField, RecordInput, RecordSchema, Row } from "@qdd/shared";
import { readAll, TOMBSTONE, type DatasetStore } from "./store.js";

/**
 * 记录数据集：门店在页面上登记的数据（试吃报损、临期处置回填、日报确认等）。
 * 存为 records/<name> 的普通数据集（主键 id、按 time 分区），因此 store__aggregate 等工具可直接汇总；
 * 结构由 agent 提出、店长确认后建立，页面只能按结构写入，不能改结构。
 */
export const RECORD_PREFIX = "records/";
export const RECORD_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
const FIELD_RE = /^[a-z][a-zA-Z0-9_]{0,39}$/;
const RESERVED = new Set(["id", "time", "page", TOMBSTONE]);
const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const MAX_ROWS_PER_WRITE = 200;
const MAX_TEXT = 500;
const MAX_QUERY = 1000;

/** 带 status 的错误由网关映射为 HTTP 状态码。 */
export class RecordError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface RecordDefinition {
  name: string;
  description: string;
  schema: RecordSchema;
}

export interface RecordQuery {
  /** YYYY-MM-DD，闭区间 */
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
}

export const recordDataset = (name: string) => `${RECORD_PREFIX}${name}`;

/** 校验 agent / 前端提交的登记表结构。 */
export function parseRecordDefinition(raw: unknown): RecordDefinition {
  const body = (raw ?? {}) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!RECORD_NAME_RE.test(name)) throw new RecordError("name 需为小写英文开头的字母/数字/下划线，≤40 字符，如 loss_log");
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 20) : "";
  if (!label) throw new RecordError("label 不能为空（中文名称，如「试吃报损登记」）");
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 200) : "";
  if (!Array.isArray(body.fields) || body.fields.length < 1 || body.fields.length > 30) throw new RecordError("fields 需要 1-30 个字段");
  const fields: RecordField[] = [];
  for (const [i, f] of (body.fields as Record<string, unknown>[]).entries()) {
    const fname = typeof f?.name === "string" ? f.name.trim() : "";
    if (!FIELD_RE.test(fname)) throw new RecordError(`第 ${i + 1} 个字段 name 不合法（英文字母开头，如 qty、reason）`);
    if (RESERVED.has(fname)) throw new RecordError(`字段 ${fname} 是保留字段（id/time/page 由系统填写）`);
    if (fields.some((x) => x.name === fname)) throw new RecordError(`字段 ${fname} 重复`);
    const type = f.type ?? "string";
    if (type !== "string" && type !== "number" && type !== "boolean") throw new RecordError(`字段 ${fname} 的 type 只能是 string/number/boolean`);
    const flabel = typeof f.label === "string" && f.label.trim() ? f.label.trim().slice(0, 20) : fname;
    const field: RecordField = { name: fname, label: flabel, type };
    if (f.required === true) field.required = true;
    if (f.options !== undefined) {
      if (type !== "string") throw new RecordError(`字段 ${fname}：只有 string 字段能设置 options`);
      const options = Array.isArray(f.options) ? [...new Set(f.options.map((o) => String(o).trim().slice(0, 40)).filter(Boolean))] : [];
      if (options.length < 1 || options.length > 30) throw new RecordError(`字段 ${fname}：options 需要 1-30 个候选值`);
      field.options = options;
    }
    fields.push(field);
  }
  return { name, description: description || label, schema: { label, fields } };
}

/** 创建或扩展记录数据集。已有数据集只允许新增字段、调整中文名/候选值，不能删字段或改类型（保证历史记录仍然有效）。 */
export async function defineRecord(store: DatasetStore, def: RecordDefinition): Promise<DatasetManifest> {
  const dataset = recordDataset(def.name);
  const prev = await store.get(dataset);
  if (prev) {
    if (prev.kind !== "record" || !prev.record) throw new RecordError(`数据集 ${dataset} 已存在且不是记录数据集`, 409);
    const removed = prev.record.fields.filter((f) => !def.schema.fields.some((x) => x.name === f.name));
    if (removed.length) throw new RecordError(`不能删除已有字段：${removed.map((f) => f.name).join("、")}`, 409);
    const retyped = def.schema.fields.filter((f) => prev.record!.fields.some((x) => x.name === f.name && x.type !== f.type));
    if (retyped.length) throw new RecordError(`不能修改已有字段的类型：${retyped.map((f) => f.name).join("、")}`, 409);
  }
  const fields: DatasetManifest["fields"] = { id: "string", time: "string", page: "string" };
  for (const f of def.schema.fields) fields[f.name] = f.type;
  return store.define({ name: dataset, description: def.description, kind: "record", fields, key: ["id"], timeField: "time", record: def.schema });
}

export async function listRecordSets(store: DatasetStore): Promise<DatasetManifest[]> {
  return (await store.list()).filter((m) => m.kind === "record" && m.name.startsWith(RECORD_PREFIX));
}

async function requireRecord(store: DatasetStore, name: string): Promise<DatasetManifest & { record: RecordSchema }> {
  if (!RECORD_NAME_RE.test(name)) throw new RecordError(`记录名不合法：${name}`);
  const m = await store.get(recordDataset(name));
  if (!m || m.kind !== "record" || !m.record) throw new RecordError(`记录数据集 ${name} 不存在`, 404);
  return m as DatasetManifest & { record: RecordSchema };
}

/** 当前本地时间，格式与订单、库存流水一致（YYYY-MM-DD HH:mm）。 */
export function localMinute(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 按结构校验一行；partial 时只校验出现的字段。返回规范化后的业务字段。 */
function validate(schema: RecordSchema, input: RecordInput, partial: boolean): Row {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new RecordError("每条记录必须是 JSON 对象");
  const out: Row = {};
  for (const key of Object.keys(input)) {
    if (key === "id" || key === "page" || key === "time") continue;
    if (!schema.fields.some((f) => f.name === key)) throw new RecordError(`未知字段 ${key}（可用：${schema.fields.map((f) => f.name).join(", ")}）`);
  }
  for (const f of schema.fields) {
    const v = input[f.name];
    if (v === undefined || v === null || v === "") {
      if (f.required && (!partial || f.name in input)) throw new RecordError(`「${f.label}」必填`);
      if (f.name in input) out[f.name] = null;
      continue;
    }
    if (typeof v !== f.type) throw new RecordError(`「${f.label}」应为 ${f.type === "number" ? "数字" : f.type === "boolean" ? "是/否" : "文本"}`);
    if (typeof v === "number" && !Number.isFinite(v)) throw new RecordError(`「${f.label}」不是有效数字`);
    if (typeof v === "string") {
      if (v.length > MAX_TEXT) throw new RecordError(`「${f.label}」不能超过 ${MAX_TEXT} 字`);
      if (f.options && !f.options.includes(v)) throw new RecordError(`「${f.label}」只能是：${f.options.join("、")}`);
    }
    out[f.name] = v;
  }
  return out;
}

function parseTime(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !TIME_RE.test(v)) throw new RecordError("time 格式应为 YYYY-MM-DD HH:mm");
  const date = Date.parse(`${v.replace(" ", "T")}:00Z`);
  if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 16).replace("T", " ") !== v) throw new RecordError("time 必须是有效日期和时间");
  return v;
}

/** 追加记录；未给 time 时取当前时间。返回写入的行（含 id）。 */
export async function addRecords(store: DatasetStore, name: string, inputs: RecordInput[], page: string): Promise<Row[]> {
  const m = await requireRecord(store, name);
  if (!inputs.length) throw new RecordError("至少提交一条记录");
  if (inputs.length > MAX_ROWS_PER_WRITE) throw new RecordError(`一次最多提交 ${MAX_ROWS_PER_WRITE} 条`);
  const now = localMinute();
  const rows = inputs.map((input) => {
    const fields = validate(m.record, input, false);
    for (const f of m.record.fields) if (!(f.name in fields)) fields[f.name] = null;
    return { id: randomUUID().slice(0, 12), time: parseTime(input.time) ?? now, page, ...fields };
  });
  await store.append(m.name, rows);
  return rows;
}

/** 按 id 修改部分字段（如处置结果回填），其余字段与登记时间保持不变。 */
export async function updateRecord(store: DatasetStore, name: string, id: string, patch: RecordInput, page: string): Promise<Row> {
  const m = await requireRecord(store, name);
  const row = await store.updateRow(m.name, (current) => current.id === id, (prev) => {
    const fields = validate(m.record, patch, true);
    // time 决定分区：改时间会让按日期范围读取时同一 id 出现在两个分区，因此不允许修改
    if (patch.time !== undefined && patch.time !== prev.time) throw new RecordError("登记时间不能修改；如有误请作废后重新登记");
    return { ...prev, ...fields, page };
  });
  if (!row) throw new RecordError(`记录 ${id} 不存在或已作废`, 404);
  return row;
}

/** 作废记录：写入墓碑，之后读取与聚合都不再包含它（日志中保留原始行便于追溯）。 */
export async function voidRecord(store: DatasetStore, name: string, id: string, page: string): Promise<void> {
  const m = await requireRecord(store, name);
  const row = await store.updateRow(m.name, (current) => current.id === id, (prev) => ({ ...prev, page, [TOMBSTONE]: true }));
  if (!row) throw new RecordError(`记录 ${id} 不存在或已作废`, 404);
}

/** 读取记录，按时间倒序。 */
export async function queryRecords(store: DatasetStore, name: string, query: RecordQuery = {}): Promise<{ schema: RecordSchema; rows: Row[]; total: number }> {
  const m = await requireRecord(store, name);
  for (const d of [query.from, query.to]) {
    if (d === undefined) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new RecordError("from/to 格式应为 YYYY-MM-DD");
    parseTime(`${d} 00:00`);
  }
  if (query.from && query.to && query.from > query.to) throw new RecordError("from 不能晚于 to");
  if (query.limit !== undefined && (!Number.isFinite(query.limit) || query.limit < 1 || !Number.isInteger(query.limit))) throw new RecordError("limit 必须是正整数");
  const rows = (await readAll(store, m.name, { from: query.from, to: query.to })).sort((a, b) =>
    String(b.time).localeCompare(String(a.time)),
  );
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? 200)), MAX_QUERY);
  return { schema: m.record, rows: rows.slice(0, limit), total: rows.length };
}

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ElAlert } from "element-plus/es/components/alert/index";
import { ElButton } from "element-plus/es/components/button/index";
import { ElCard } from "element-plus/es/components/card/index";
import { ElDialog } from "element-plus/es/components/dialog/index";
import { ElEmpty } from "element-plus/es/components/empty/index";
import { ElMessageBox } from "element-plus/es/components/message-box/index";
import type { RecordField, RecordInput, RecordSchema, Row } from "@qdd/shared";
import { addRecords, defineRecordSet, listRecordSets, queryRecords, updateRecord, voidRecord, type RecordDefinitionInput, type RecordSet } from "@/api/records";

const props = defineProps<{ connected: boolean; gatewayUrl: string; token: string; initialName?: string | undefined }>();
const sets = ref<RecordSet[]>([]);
const selectedName = ref("");
const selected = computed(() => sets.value.find((set) => set.name === selectedName.value));
const rows = ref<Row[]>([]);
const schema = ref<RecordSchema>();
const total = ref(0);
const listLoading = ref(false);
const rowsLoading = ref(false);
const busy = ref(false);
const listError = ref("");
const rowsError = ref("");
const actionError = ref("");
const notice = ref("");
const from = ref("");
const to = ref("");
const limit = ref(200);
const entryOpen = ref(false);
const entryId = ref("");
const entryTime = ref("");
const values = ref<Record<string, string>>({});
const original = ref<RecordInput>({});
const schemaOpen = ref(false);
const extending = ref(false);
type DraftField = RecordField & { optionsText: string; existing: boolean };
const definition = ref({ name: "", label: "", description: "", fields: [] as DraftField[] });
let listController: AbortController | undefined;
let rowsController: AbortController | undefined;
let mutationController: AbortController | undefined;
let version = 0;
let disposed = false;

const unavailable = computed(() => !props.connected || busy.value || listLoading.value || rowsLoading.value);
const display = (value: unknown) => value === null || value === undefined ? "—" : value === true ? "是" : value === false ? "否" : String(value);
const date = (value: string | null | undefined) => value ? display(value).replace("T", " ").replace(/\.\d+Z$/, "Z") : "尚无记录";
const errorText = (cause: unknown) => cause instanceof TypeError ? "无法连接网关，请检查连接后重试。" : cause instanceof Error ? cause.message : "记录请求失败，请重试。";
const inputValue = (event: Event) => (event.target as HTMLInputElement).value;
function stopRequests() {
  version++;
  listController?.abort(); rowsController?.abort(); mutationController?.abort();
  listController = rowsController = mutationController = undefined;
  listLoading.value = rowsLoading.value = busy.value = false;
}
async function loadSets() {
  if (!props.connected || disposed) return;
  listController?.abort();
  const controller = listController = new AbortController();
  const currentVersion = version;
  listLoading.value = true;
  listError.value = "";
  try {
    const response = await listRecordSets(props.gatewayUrl, props.token, controller.signal);
    if (controller.signal.aborted || disposed || currentVersion !== version) return;
    sets.value = response;
    if (!response.some((set) => set.name === selectedName.value)) {
      selectedName.value = response.find((set) => set.name === props.initialName)?.name ?? response[0]?.name ?? "";
    }
  } catch (cause) {
    if (!controller.signal.aborted && !disposed && currentVersion === version) listError.value = errorText(cause);
  } finally {
    if (listController === controller) { listController = undefined; listLoading.value = false; }
  }
}
async function loadRows() {
  if (!props.connected || !selectedName.value || disposed) return;
  rowsController?.abort();
  rowsController = undefined;
  rowsLoading.value = false;
  if (from.value && to.value && from.value > to.value) { rowsError.value = "开始日期不能晚于结束日期。"; return; }
  if (!Number.isInteger(limit.value) || limit.value < 1 || limit.value > 1000) { rowsError.value = "显示条数须为 1–1000 的整数。"; return; }
  const controller = rowsController = new AbortController();
  const currentVersion = version;
  const name = selectedName.value;
  rowsLoading.value = true;
  rowsError.value = "";
  try {
    const response = await queryRecords(props.gatewayUrl, props.token, name, {
      ...(from.value ? { from: from.value } : {}), ...(to.value ? { to: to.value } : {}), limit: limit.value,
    }, controller.signal);
    if (controller.signal.aborted || disposed || currentVersion !== version || selectedName.value !== name) return;
    rows.value = response.rows;
    schema.value = response.schema;
    total.value = response.total;
  } catch (cause) {
    if (!controller.signal.aborted && !disposed && currentVersion === version) rowsError.value = errorText(cause);
  } finally {
    if (rowsController === controller) { rowsController = undefined; rowsLoading.value = false; }
  }
}
async function reload() { const currentVersion = version; await loadSets(); if (!disposed && props.connected && currentVersion === version) await loadRows(); }
function openEntry(row?: Row) {
  if (unavailable.value || !schema.value) return;
  entryId.value = row ? String(row.id) : "";
  entryTime.value = row ? String(row.time) : "";
  values.value = Object.fromEntries(schema.value.fields.map((field) => [field.name, row?.[field.name] == null ? "" : String(row[field.name])]));
  original.value = Object.fromEntries(schema.value.fields.map((field) => [field.name, (row?.[field.name] ?? null) as RecordInput[string]]));
  actionError.value = "";
  entryOpen.value = true;
}
function entryInput(): RecordInput {
  const input: RecordInput = {};
  for (const field of schema.value?.fields ?? []) {
    const value = values.value[field.name] ?? "";
    const parsed = value === "" ? null : field.type === "number" ? Number(value) : field.type === "boolean" ? value === "true" : value;
    if (entryId.value && parsed === original.value[field.name]) continue;
    if (field.required && parsed === null) throw new Error(`「${field.label}」必填。`);
    if (typeof parsed === "number" && !Number.isFinite(parsed)) throw new Error(`「${field.label}」须为有效数字。`);
    if (typeof parsed === "string" && parsed.length > 500) throw new Error(`「${field.label}」不能超过 500 字。`);
    if (parsed !== null && field.options && !field.options.includes(String(parsed))) throw new Error(`「${field.label}」请选择候选值。`);
    input[field.name] = parsed;
  }
  return input;
}
function newField(): DraftField { return { name: "", label: "", type: "string", optionsText: "", existing: false }; }
function openSchema(extend = false) {
  if (unavailable.value || (extend && !schema.value)) return;
  extending.value = extend;
  definition.value = extend ? {
    name: selectedName.value, label: schema.value!.label, description: selected.value?.description ?? "",
    fields: schema.value!.fields.map((field) => ({ ...field, optionsText: field.options?.join("\n") ?? "", existing: true })),
  } : { name: "", label: "", description: "", fields: [newField()] };
  actionError.value = "";
  schemaOpen.value = true;
}
function schemaInput(): RecordDefinitionInput {
  const draft = definition.value;
  const name = draft.name.trim();
  const label = draft.label.trim();
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(name)) throw new Error("记录名须为小写英文开头的字母、数字或下划线，最多 40 字符。");
  if (!label || label.length > 20) throw new Error("中文名称须为 1–20 字。");
  if (draft.description.trim().length > 200) throw new Error("说明最多 200 字。");
  if (draft.fields.length < 1 || draft.fields.length > 30) throw new Error("请设置 1–30 个字段。");
  const names = new Set<string>();
  const fields = draft.fields.map((field): RecordField => {
    const fieldName = field.name.trim();
    if (!/^[a-z][a-zA-Z0-9_]{0,39}$/.test(fieldName) || ["id", "time", "page", "__deleted"].includes(fieldName)) throw new Error(`字段「${fieldName || "未命名"}」名称不合法或为系统保留字段。`);
    if (names.has(fieldName)) throw new Error(`字段「${fieldName}」重复。`);
    names.add(fieldName);
    const fieldLabel = field.label.trim() || fieldName;
    if (fieldLabel.length > 20) throw new Error(`字段「${fieldName}」中文名最多 20 字。`);
    const result: RecordField = { name: fieldName, label: fieldLabel, type: field.type, ...(field.required ? { required: true } : {}) };
    if (field.type === "string" && field.optionsText.trim()) {
      const options = [...new Set(field.optionsText.split("\n").map((option) => option.trim()).filter(Boolean))];
      if (options.length > 30 || options.some((option) => option.length > 40)) throw new Error(`字段「${fieldLabel}」最多 30 个候选值，每个最多 40 字。`);
      result.options = options;
    }
    return result;
  });
  return { name, label, description: draft.description.trim(), fields };
}
async function mutate(title: string, detail: string, operation: (base: string, token: string, signal: AbortSignal) => Promise<unknown>, success: string, nextName?: string) {
  if (unavailable.value || disposed) return;
  const controller = mutationController = new AbortController();
  const currentVersion = version;
  const name = selectedName.value;
  const base = props.gatewayUrl;
  const token = props.token;
  const current = () => !disposed && !controller.signal.aborted && version === currentVersion && selectedName.value === name;
  busy.value = true;
  actionError.value = notice.value = "";
  try {
    await ElMessageBox.confirm(detail, title, { confirmButtonText: "确认提交", cancelButtonText: "取消", type: "warning" });
    if (!current()) return;
    await operation(base, token, controller.signal);
    if (!current()) return;
    entryOpen.value = schemaOpen.value = false;
    notice.value = success;
    await loadSets();
    if (!current()) return;
    if (nextName && nextName !== selectedName.value) selectedName.value = nextName;
    else await loadRows();
  } catch (cause) {
    if (current() && cause !== "cancel" && cause !== "close") actionError.value = errorText(cause);
  } finally {
    if (mutationController === controller) { mutationController = undefined; busy.value = false; }
  }
}
async function saveEntry() {
  if (unavailable.value) return;
  try {
    const input = entryInput();
    if (!Object.keys(input).length) { actionError.value = "尚未修改任何字段。"; return; }
    const name = selectedName.value;
    const id = entryId.value;
    const summary = (schema.value?.fields ?? []).filter((field) => field.name in input).map((field) => `${field.label}：${display(input[field.name])}`).join("\n");
    await mutate(id ? "确认修改记录" : "确认新增记录", `${schema.value?.label}\n${summary}${id ? `\n记录编号：${id}` : "\n登记时间与编号由系统生成。"}`,
      (base, token, signal) => id ? updateRecord(base, token, name, id, input, signal) : addRecords(base, token, name, input, signal), id ? "记录已修改。" : "记录已新增。");
  } catch (cause) { actionError.value = errorText(cause); }
}
async function saveSchema() {
  if (unavailable.value) return;
  try {
    const input = schemaInput();
    await mutate(extending.value ? "确认更新登记表结构" : "确认创建登记表", `${input.label}（${input.name}）\n${input.fields.map((field) => `${field.label} · ${field.type}${field.required ? " · 必填" : ""}${field.options ? ` · ${field.options.join(" / ")}` : ""}`).join("\n")}`,
      (base, token, signal) => defineRecordSet(base, token, input, signal), extending.value ? "登记表结构已更新。" : "登记表已创建。", input.name);
  } catch (cause) { actionError.value = errorText(cause); }
}
async function removeEntry(row: Row) {
  const name = selectedName.value;
  const id = String(row.id);
  await mutate("确认作废记录", `作废 ${schema.value?.label} 的记录 ${id}（${display(row.time)}）？\n作废后不再参与查询与统计，原始日志保留供追溯。`,
    (base, token, signal) => voidRecord(base, token, name, id, signal), "记录已作废。");
}
watch(selectedName, () => {
  rowsController?.abort();
  rowsController = undefined;
  rowsLoading.value = false;
  mutationController?.abort();
  mutationController = undefined;
  busy.value = false;
  rows.value = []; schema.value = undefined; total.value = 0; rowsError.value = actionError.value = "";
  entryOpen.value = schemaOpen.value = false;
  if (selectedName.value) void loadRows();
}, { flush: "sync" });
watch(() => props.initialName, (name) => { if (name && sets.value.some((set) => set.name === name)) selectedName.value = name; });
watch(() => [props.connected, props.gatewayUrl, props.token], () => {
  stopRequests();
  sets.value = []; selectedName.value = ""; rows.value = []; schema.value = undefined; total.value = 0;
  listError.value = rowsError.value = actionError.value = notice.value = from.value = to.value = "";
  entryOpen.value = schemaOpen.value = false;
  if (props.connected) void loadSets();
}, { immediate: true, flush: "sync" });
onBeforeUnmount(() => { disposed = true; stopRequests(); });
</script>

<template>
  <ElCard id="settings-records" class="workspace-records" shadow="never">
    <template #header><div class="records-heading"><div><h2>门店登记</h2><p>查看、登记和回填门店记录；所有写入提交前均需确认。</p></div><div class="record-actions"><ElButton :disabled="unavailable" @click="reload">重新读取</ElButton><ElButton type="primary" :disabled="unavailable" @click="openSchema()">新建登记表</ElButton></div></div></template>
    <ElAlert v-if="!connected" title="连接网关后，管理门店登记记录。" type="info" :closable="false" show-icon />
    <template v-else>
      <ElAlert v-if="listError" :title="listError" type="error" :closable="false" show-icon />
      <ElAlert v-if="actionError && !entryOpen && !schemaOpen" :title="actionError" type="error" :closable="false" show-icon />
      <ElAlert v-if="notice" :title="notice" type="success" :closable="false" show-icon />
      <p v-if="listLoading" class="records-muted" role="status">正在读取登记表…</p>
      <ElEmpty v-else-if="!sets.length && !listError" description="尚无登记表，可新建或在对话中请助手建立。" :image-size="55" />
      <template v-if="sets.length">
        <label class="record-label" for="record-set">登记表<select id="record-set" v-model="selectedName" :disabled="busy || listLoading"><option v-for="set in sets" :key="set.name" :value="set.name">{{ set.schema.label }}（{{ set.name }}）</option></select></label>
        <p class="records-muted record-description">{{ selected?.description }}<br>数据截至：{{ date(selected?.watermark) }} · 最近更新：{{ date(selected?.updatedAt) }}</p>
        <form class="record-filters" @submit.prevent="loadRows"><label class="record-label">开始日期<input v-model="from" type="date" aria-label="开始日期" :disabled="busy" /></label><label class="record-label">结束日期<input v-model="to" type="date" aria-label="结束日期" :disabled="busy" /></label><label class="record-label">显示条数<input v-model.number="limit" type="number" min="1" max="1000" step="1" aria-label="显示条数" :disabled="busy" /></label><ElButton native-type="submit" :disabled="busy || listLoading" :loading="rowsLoading">查询记录</ElButton></form>
        <ElAlert v-if="rowsError" :title="rowsError" type="error" :closable="false" show-icon />
        <div class="records-heading record-summary"><span aria-live="polite">匹配 {{ total }} 条 · 当前显示 {{ rows.length }} 条<span v-if="total > rows.length">，可调整日期或显示条数</span></span><div class="record-actions"><ElButton :disabled="unavailable || !schema" @click="openSchema(true)">调整登记表</ElButton><ElButton type="primary" plain :disabled="unavailable || !schema" @click="openEntry()">新增记录</ElButton></div></div>
        <p v-if="rowsLoading" class="records-muted" role="status">正在查询记录…</p>
        <ElEmpty v-else-if="!rows.length && !rowsError" description="当前条件下没有登记记录" :image-size="55" />
        <div v-if="rows.length && schema" class="record-table-wrap" :aria-busy="rowsLoading"><table class="record-table"><caption class="visually-hidden">{{ schema.label }}，按登记时间倒序</caption><thead><tr><th scope="col">登记时间</th><th v-for="field in schema.fields" :key="field.name" scope="col">{{ field.label }}</th><th scope="col">来源 / 编号</th><th scope="col">操作</th></tr></thead><tbody><tr v-for="row in rows" :key="String(row.id)"><td>{{ display(row.time) }}</td><td v-for="field in schema.fields" :key="field.name">{{ display(row[field.name]) }}</td><td><span>{{ display(row.page) }}</span><small>{{ display(row.id) }}</small></td><td><div class="record-actions"><ElButton size="small" :disabled="unavailable" :aria-label="`编辑记录 ${row.id}`" @click="openEntry(row)">编辑</ElButton><ElButton size="small" type="danger" plain :disabled="unavailable" :aria-label="`作废记录 ${row.id}`" @click="removeEntry(row)">作废</ElButton></div></td></tr></tbody></table></div>
      </template>
    </template>
    <ElDialog v-model="entryOpen" :title="entryId ? '编辑登记记录' : '新增登记记录'" width="min(560px, calc(100vw - 32px))" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" append-to-body>
      <form class="record-editor" @submit.prevent="saveEntry">
        <p class="records-muted">{{ schema?.label }}<template v-if="entryId"> · {{ entryTime }} · 编号 {{ entryId }}</template><template v-else> · 编号、时间和来源由系统填写</template></p>
        <ElAlert v-if="actionError" :title="actionError" type="error" :closable="false" show-icon />
        <label v-for="field in schema?.fields" :key="field.name" class="record-label" :for="`record-value-${field.name}`">{{ field.label }}<span v-if="field.required" class="required-mark">（必填）</span>
          <select v-if="field.type === 'boolean' || field.options" :id="`record-value-${field.name}`" v-model="values[field.name]" :disabled="busy"><option value="">{{ field.required ? '请选择' : '未填写' }}</option><template v-if="field.type === 'boolean'"><option value="true">是</option><option value="false">否</option></template><template v-else><option v-for="option in field.options" :key="option" :value="option">{{ option }}</option></template><option v-if="values[field.name] && field.options && !field.options.includes(values[field.name]!)" :value="values[field.name]" disabled>{{ values[field.name] }}（历史值，请重新选择）</option></select>
          <input v-else :id="`record-value-${field.name}`" :value="values[field.name]" :type="field.type === 'number' ? 'number' : 'text'" :step="field.type === 'number' ? 'any' : undefined" :maxlength="field.type === 'string' ? 500 : undefined" :disabled="busy" @input="values[field.name] = inputValue($event)" />
        </label>
        <div class="record-actions editor-footer"><ElButton :disabled="busy" @click="entryOpen = false">取消</ElButton><ElButton native-type="submit" type="primary" :loading="busy">{{ entryId ? '保存修改' : '提交登记' }}</ElButton></div>
      </form>
    </ElDialog>
    <ElDialog v-model="schemaOpen" :title="extending ? '调整登记表' : '新建登记表'" width="min(700px, calc(100vw - 32px))" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" append-to-body>
      <form class="record-editor" @submit.prevent="saveSchema">
        <p class="records-muted">{{ extending ? '已有字段的英文名、类型和必填设置保持不变，可调整中文名、候选值或增加字段。' : '设置登记表名称与字段，最多 30 个字段。' }}</p>
        <ElAlert v-if="actionError" :title="actionError" type="error" :closable="false" show-icon />
        <div class="record-field-grid"><label class="record-label">英文记录名<input v-model="definition.name" aria-label="英文记录名" placeholder="例如 loss_log" maxlength="40" :disabled="busy || extending" /></label><label class="record-label">中文名称<input v-model="definition.label" aria-label="登记表中文名称" maxlength="20" :disabled="busy" /></label></div>
        <label class="record-label">说明<textarea v-model="definition.description" aria-label="登记表说明" rows="2" maxlength="200" :disabled="busy" /></label>
        <fieldset v-for="(field, index) in definition.fields" :key="index" class="record-schema-field" :disabled="busy"><legend>字段 {{ index + 1 }}{{ field.existing ? ' · 已有字段' : ' · 新字段' }}</legend><div class="record-field-grid"><label class="record-label">英文名<input v-model="field.name" :aria-label="`字段 ${index + 1} 英文名`" maxlength="40" :disabled="field.existing" /></label><label class="record-label">中文名<input v-model="field.label" :aria-label="`字段 ${index + 1} 中文名`" maxlength="20" /></label><label class="record-label">类型<select v-model="field.type" :aria-label="`字段 ${index + 1} 类型`" :disabled="field.existing"><option value="string">文本</option><option value="number">数字</option><option value="boolean">是 / 否</option></select></label><label class="record-checkbox"><input v-model="field.required" type="checkbox" :aria-label="`字段 ${index + 1} 必填`" :disabled="field.existing" />必填</label></div><label v-if="field.type === 'string'" class="record-label">候选值（选填，每行一项）<textarea v-model="field.optionsText" :aria-label="`字段 ${index + 1} 候选值`" rows="2" placeholder="留空允许自由填写" /></label><ElButton v-if="!field.existing" size="small" :disabled="busy || definition.fields.length === 1" @click="definition.fields.splice(index, 1)">移除此字段</ElButton></fieldset>
        <ElButton :disabled="busy || definition.fields.length >= 30" @click="definition.fields.push(newField())">增加字段</ElButton>
        <div class="record-actions editor-footer"><ElButton :disabled="busy" @click="schemaOpen = false">取消</ElButton><ElButton native-type="submit" type="primary" :loading="busy">{{ extending ? '保存登记表' : '创建登记表' }}</ElButton></div>
      </form>
    </ElDialog>
  </ElCard>
</template>

<style scoped>
.workspace-records { min-width:0; border-radius:var(--qdd-radius); scroll-margin-top:24px; }
.records-heading { display:flex; align-items:flex-start; justify-content:space-between; flex-wrap:wrap; gap:12px; }
.records-heading h2 { margin:0 0 4px; font-size:16px; }
.records-heading p, .records-muted { margin:0; color:var(--qdd-muted); font-size:12px; line-height:1.7; overflow-wrap:anywhere; }
.record-actions { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.record-actions :deep(.el-button + .el-button) { margin-left:0; }
.workspace-records :deep(.el-alert), .record-editor :deep(.el-alert) { margin-bottom:14px; }
.record-label { display:flex; flex-direction:column; gap:7px; min-width:0; font-size:13px; font-weight:500; }
.record-label input, .record-label select, .record-label textarea { box-sizing:border-box; min-width:0; width:100%; border:1px solid var(--qdd-border); border-radius:6px; padding:8px 10px; font:inherit; font-weight:400; color:var(--qdd-text); background:var(--qdd-bg); }
.record-label input:focus, .record-label select:focus, .record-label textarea:focus { outline:2px solid var(--qdd-primary); outline-offset:1px; }
.record-label input:disabled, .record-label select:disabled { opacity:.6; cursor:not-allowed; }
.record-label textarea { resize:vertical; line-height:1.6; }
.record-description { margin:12px 0 18px; }
.record-filters { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)) minmax(75px,.65fr) auto; align-items:end; gap:10px; margin:18px 0; }
.record-summary { align-items:center; margin:18px 0 14px; font-size:12px; color:var(--qdd-muted); }
.record-table-wrap { overflow:auto; max-width:100%; }
.record-table { width:100%; border-collapse:collapse; text-align:left; font-size:12px; }
.record-table th, .record-table td { padding:12px 9px; border-bottom:1px solid var(--qdd-border); vertical-align:top; min-width:85px; max-width:280px; overflow-wrap:anywhere; line-height:1.7; }
.record-table thead { color:var(--qdd-muted); }
.record-table td:first-child { min-width:116px; }
.record-table td:last-child { min-width:125px; }
.record-table small { display:block; color:var(--qdd-muted); }
.record-editor { display:grid; gap:18px; color:var(--qdd-text); }
.required-mark { color:var(--qdd-muted); font-size:11px; font-weight:400; }
.editor-footer { justify-content:flex-end; padding-top:8px; }
.record-field-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); align-items:end; gap:14px; }
.record-schema-field { display:grid; gap:14px; min-width:0; border:1px solid var(--qdd-border); padding:16px; border-radius:8px; margin:0; }
.record-schema-field legend { padding:0 6px; font-size:12px; color:var(--qdd-muted); }
.record-schema-field > :deep(.el-button) { justify-self:start; }
.record-checkbox { display:flex; align-items:center; gap:7px; min-height:35px; font-size:13px; }
.visually-hidden { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
@media (max-width:600px) { .record-filters { grid-template-columns:repeat(2,minmax(0,1fr)); } .record-field-grid { grid-template-columns:minmax(0,1fr); } .record-schema-field { padding:12px; } }
</style>

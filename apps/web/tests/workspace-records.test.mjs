import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { after, afterEach, test } from "node:test";
import { compileScript, parse } from "@vue/compiler-sfc";
import { createRenderer, h, nextTick, reactive } from "vue";

const moduleUrl = (source) => "data:text/javascript," + encodeURIComponent(source);
const vueUrl = import.meta.resolve("vue");
const apiUrl = moduleUrl(`
  export const calls = [];
  const request = (kind, base, token, signal, name, input, id) => new Promise((resolve, reject) => calls.push({ kind, base, token, signal, name, input, id, resolve, reject }));
  export const listRecordSets = (base, token, signal) => request("list", base, token, signal);
  export const queryRecords = (base, token, name, query, signal) => request("query", base, token, signal, name, query);
  export const defineRecordSet = (base, token, input, signal) => request("define", base, token, signal, input.name, input);
  export const addRecords = (base, token, name, input, signal) => request("add", base, token, signal, name, input);
  export const updateRecord = (base, token, name, id, input, signal) => request("update", base, token, signal, name, input, id);
  export const voidRecord = (base, token, name, id, signal) => request("void", base, token, signal, name, undefined, id);
`);
const controlsUrl = moduleUrl(`
  import { h } from "vue";
  export const confirmations = [];
  export const ElMessageBox = { confirm: (detail, title, options) => new Promise((resolve, reject) => confirmations.push({ detail, title, options, resolve, reject })) };
  export const ElButton = { inheritAttrs: false, props: ["disabled", "loading", "nativeType"], setup: (props, { attrs, slots }) => () => h("button", { ...attrs, type: props.nativeType ?? "button", disabled: !!(props.disabled || props.loading) }, slots.default?.()) };
  export const ElAlert = { props: ["title", "type"], setup: (props) => () => h("div", { role: "alert", "data-type": props.type }, props.title) };
  export const ElCard = { setup: (_, { attrs, slots }) => () => h("section", attrs, [slots.header?.(), slots.default?.()]) };
  export const ElEmpty = { props: ["description"], setup: (props) => () => h("div", props.description) };
  export const ElDialog = { props: ["modelValue", "title"], setup: (props, { slots }) => () => props.modelValue ? h("dialog", { open: true }, [h("h2", props.title), slots.default?.()]) : null };
`);
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith("data:text/javascript,")) {
    const url = specifier === "vue" ? vueUrl : specifier.startsWith("element-plus/es/components/") ? controlsUrl : specifier === "@/api/records" ? apiUrl : undefined;
    if (url) return { url, shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });
const { descriptor } = parse(await readFile(new URL("../src/components/WorkspaceRecords.vue", import.meta.url), "utf8"));
const compiled = compileScript(descriptor, { id: "workspace-records-test", inlineTemplate: true });
const { default: WorkspaceRecords } = await import(moduleUrl(stripTypeScriptTypes(compiled.content, { mode: "strip" })));
const { calls } = await import(apiUrl);
const { confirmations } = await import(controlsUrl);
const mounted = [];
const originalDocument = globalThis.document;
globalThis.document = { activeElement: null };
afterEach(() => { for (const app of mounted.splice(0)) app.unmount(); calls.splice(0); confirmations.splice(0); });
after(() => { hooks.deregister(); if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument; });

const findAll = (node, predicate) => [...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => findAll(child, predicate))];
const textContent = (node) => (node.text ?? "") + node.children.map(textContent).join("");
function remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null; }
function element(tag) {
  const node = { tag, tagName: tag.toUpperCase(), props: {}, children: [], parent: null, listeners: {}, value: "", checked: false, selected: false,
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); },
    dispatchEvent(event) { for (const handler of this.listeners[event.type] ?? []) handler(event); },
  };
  Object.defineProperties(node, {
    options: { get: () => findAll(node, (child) => child.tag === "option") },
    selectedIndex: { get: () => node.options.findIndex((option) => option.selected), set: (index) => node.options.forEach((option, i) => { option.selected = i === index; }) },
  });
  return node;
}
const renderer = createRenderer({
  createElement: element,
  createText: (text) => ({ text, children: [], parent: null }),
  createComment: (text) => ({ comment: text, children: [], parent: null }),
  setText: (node, text) => { node.text = text; },
  setElementText: (node, text) => { node.text = text; node.children = []; },
  patchProp(node, key, _old, value) { node.props[key] = value; if (["value", "type", "multiple", "checked", "selected"].includes(key)) node[key] = value; if (key === "value") node._value = value; },
  insert(node, parent, anchor = null) { remove(node); const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index < 0 ? parent.children.length : index, 0, node); node.parent = parent; },
  remove, parentNode: (node) => node.parent, nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
});
const fields = [
  { name: "qty", label: "数量", type: "number", required: true },
  { name: "checked", label: "已检查", type: "boolean" },
  { name: "reason", label: "原因", type: "string", options: ["试吃", "破损"] },
  { name: "note", label: "备注", type: "string" },
];
const recordSet = (name = "loss_log") => ({ name, description: "逐条登记门店报损", schema: { label: name === "loss_log" ? "报损登记" : "巡检登记", fields }, rowCount: 1, watermark: "2026-10-17 10:30", updatedAt: "2026-10-17T02:30:00Z" });
const row = { id: "row-1", time: "2026-10-17 10:30", page: "@admin", qty: 0, checked: false, reason: "试吃", note: null };
function mount(extra = {}) {
  const props = reactive({ connected: true, gatewayUrl: "http://fixture-a.test", token: "token-a", ...extra });
  const root = { children: [] };
  const changes = [];
  const app = renderer.createApp({ setup: () => () => h(WorkspaceRecords, { ...props, onChanged: () => changes.push(true) }) });
  app.mount(root); mounted.push(app);
  return { props, root, changes, unmount() { mounted.splice(mounted.indexOf(app), 1); app.unmount(); } };
}
const button = (root, name) => findAll(root, (node) => node.tag === "button" && (textContent(node) === name || node.props["aria-label"] === name))[0];
const field = (root, name) => findAll(root, (node) => node.props?.["aria-label"] === name || node.props?.id === name)[0];
async function settle() { await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick(); }
async function click(root, name) { const node = button(root, name); assert.ok(node, `button ${name} exists`); assert.equal(node.props.disabled, false); const pending = node.props.onClick?.(); await settle(); return pending; }
async function input(node, value) { assert.ok(node, "input exists"); node.value = String(value); for (const handler of node.listeners.input ?? []) handler({ target: node }); node.props.onInput?.({ target: node }); await settle(); }
async function select(node, value) { assert.ok(node, "select exists"); node.options.forEach((option) => { option.selected = option._value === value; }); for (const handler of node.listeners.change ?? []) handler({ target: node }); await settle(); }
function submit(root) { const form = findAll(root, (node) => node.tag === "dialog")[0].children.find((node) => node.tag === "form"); assert.ok(form); return form.props.onSubmit({ preventDefault() {} }); }
async function load(offset = 0, sets = [recordSet()], data = [row], total = data.length) {
  assert.equal(calls[offset].kind, "list"); calls[offset].resolve(sets); await settle();
  if (!sets.length) return;
  const query = calls.at(-1); assert.equal(query.kind, "query"); query.resolve({ schema: sets.find((set) => set.name === query.name).schema, rows: data, total }); await settle();
}
async function finishMutation(kind, result, data = [row]) {
  const mutation = calls.at(-1); assert.equal(mutation.kind, kind); mutation.resolve(result); await settle();
  await load(calls.length - 1, [recordSet()], data);
}

test("records panel loads only when connected and selects the requested record, displaying false/zero/null distinctly", async () => {
  const { props, root } = mount({ connected: false, initialName: "checks" });
  assert.equal(calls.length, 0); assert.match(textContent(root), /连接网关后/);
  props.connected = true; await settle(); await load(0, [recordSet(), recordSet("checks")], [row], 24);
  assert.equal(calls[1].name, "checks"); assert.equal(calls[1].token, "token-a");
  assert.match(textContent(root), /匹配 24 条 · 当前显示 1 条/);
  assert.match(textContent(root), /2026-10-17 10:300否试吃—@adminrow-1/);
  assert.equal(findAll(root, (node) => node.props?.id === "settings-records").length, 1);
});

test("date and limit filters query real records with total counts and prevent reversed ranges", async () => {
  const { root } = mount(); await load();
  await input(field(root, "开始日期"), "2026-10-01"); await input(field(root, "结束日期"), "2026-10-17"); await input(field(root, "显示条数"), "500");
  const filter = findAll(root, (node) => node.tag === "form")[0];
  const request = filter.props.onSubmit({ preventDefault() {} });
  assert.deepEqual(calls.at(-1).input, { from: "2026-10-01", to: "2026-10-17", limit: 500 });
  calls.at(-1).resolve({ schema: recordSet().schema, rows: [], total: 0 }); await request; await settle();
  assert.match(textContent(root), /当前条件下没有登记记录/);
  await input(field(root, "开始日期"), "2026-10-18");
  const before = calls.length; await filter.props.onSubmit({ preventDefault() {} }); await settle();
  assert.equal(calls.length, before); assert.match(textContent(root), /开始日期不能晚于结束日期/);
});

test("new record waits for confirmation, blocks duplicate submits and preserves typed values", async () => {
  const { root, changes } = mount(); await load(); await click(root, "新增记录");
  await input(field(root, "record-value-qty"), "0"); await select(field(root, "record-value-checked"), "false"); await select(field(root, "record-value-reason"), "试吃");
  const pending = submit(root); await settle();
  assert.equal(confirmations.length, 1); assert.match(confirmations[0].detail, /数量：0\n已检查：否/); assert.equal(calls.length, 2); assert.equal(changes.length, 0);
  await submit(root); assert.equal(confirmations.length, 1);
  confirmations[0].resolve(); await settle();
  assert.equal(calls.at(-1).kind, "add"); assert.deepEqual(calls.at(-1).input, { qty: 0, checked: false, reason: "试吃", note: null });
  await finishMutation("add", { rows: [row] }); await pending; await settle();
  assert.equal(changes.length, 1);
  assert.match(textContent(root), /记录已新增/); assert.equal(findAll(root, (node) => node.tag === "dialog").length, 0);
});

test("edit sends only changed business fields, preserves time/id and clears a value as null", async () => {
  const { root } = mount(); await load(0, [recordSet()], [{ ...row, note: "原备注" }]); await click(root, "编辑记录 row-1");
  assert.equal(field(root, "record-value-qty").value, "0"); await input(field(root, "record-value-note"), "");
  const pending = submit(root); await settle(); confirmations[0].resolve(); await settle();
  assert.equal(calls.at(-1).kind, "update"); assert.equal(calls.at(-1).id, "row-1"); assert.deepEqual(calls.at(-1).input, { note: null });
  await finishMutation("update", { row }); await pending;
});

test("void requires explicit confirmation, cancelling is inert and backend failure remains retryable", async () => {
  const { root, changes } = mount(); await load();
  let pending = button(root, "作废记录 row-1").props.onClick(); await settle(); assert.equal(calls.length, 2);
  confirmations[0].reject("cancel"); await pending; await settle(); assert.equal(calls.length, 2);
  pending = button(root, "作废记录 row-1").props.onClick(); await settle(); confirmations[1].resolve(); await settle();
  assert.equal(calls.at(-1).kind, "void"); assert.equal(calls.at(-1).id, "row-1"); calls.at(-1).reject(new Error("记录已被他人作废")); await pending; await settle();
  assert.match(textContent(root), /记录已被他人作废/); assert.equal(button(root, "作废记录 row-1").props.disabled, false);
  assert.equal(changes.length, 0);
});

test("schema extension locks names/types/required flags and sends original fields plus new typed fields", async () => {
  const { root } = mount(); await load(); await click(root, "调整登记表");
  assert.equal(field(root, "英文记录名").props.disabled, true); assert.equal(field(root, "字段 1 英文名").props.disabled, true); assert.equal(field(root, "字段 1 类型").props.disabled, true); assert.equal(field(root, "字段 1 必填").props.disabled, true);
  await input(field(root, "登记表中文名称"), "报损与处置"); await input(field(root, "字段 3 候选值"), "试吃\n破损\n到期"); await click(root, "增加字段");
  await input(field(root, "字段 5 英文名"), "cost"); await input(field(root, "字段 5 中文名"), "金额"); await select(field(root, "字段 5 类型"), "number");
  const pending = submit(root); await settle(); confirmations[0].resolve(); await settle();
  const definition = calls.at(-1); assert.equal(definition.kind, "define"); assert.equal(definition.input.label, "报损与处置"); assert.deepEqual(definition.input.fields.slice(0, 2), fields.slice(0, 2)); assert.deepEqual(definition.input.fields[2].options, ["试吃", "破损", "到期"]); assert.deepEqual(definition.input.fields[4], { name: "cost", label: "金额", type: "number" });
  await finishMutation("define", { name: "loss_log", schema: recordSet().schema }); await pending;
});

test("schema creation rejects reserved/duplicate fields and required values before any write", async () => {
  const { root } = mount(); await load(); await click(root, "新建登记表");
  await input(field(root, "英文记录名"), "new_log"); await input(field(root, "登记表中文名称"), "新登记"); await input(field(root, "字段 1 英文名"), "time");
  await submit(root); await settle(); assert.match(textContent(root), /系统保留字段/); assert.equal(confirmations.length, 0);
  await input(field(root, "字段 1 英文名"), "note"); await click(root, "增加字段"); await input(field(root, "字段 2 英文名"), "note");
  await submit(root); await settle(); assert.match(textContent(root), /字段「note」重复/); assert.equal(confirmations.length, 0);
  await click(root, "取消"); await click(root, "新增记录"); await submit(root); await settle(); assert.match(textContent(root), /「数量」必填/); assert.equal(calls.length, 2);
});

test("gateway/token changes abort reads and ignore a confirmation approved for the previous identity", async () => {
  const { props, root } = mount(); const oldList = calls[0];
  props.gatewayUrl = "http://fixture-b.test"; props.token = "token-b"; await settle();
  assert.equal(oldList.signal.aborted, true); oldList.resolve([recordSet("old_account")]); await settle(); assert.doesNotMatch(textContent(root), /old_account/);
  await load(calls.length - 1); await click(root, "新增记录"); await input(field(root, "record-value-qty"), "3");
  const pending = submit(root); await settle(); props.token = "token-c"; await settle(); const count = calls.length;
  confirmations[0].resolve(); await pending; await settle(); assert.equal(calls.length, count); assert.equal(calls.some((call) => call.kind === "add"), false);
  await load(calls.length - 1); assert.equal(calls.at(-1).token, "token-c");
});

test("disconnect and unmount abort pending mutation/query and suppress late failures", async () => {
  const { props, root, changes, unmount } = mount(); await load();
  const pending = button(root, "作废记录 row-1").props.onClick(); await settle(); confirmations[0].resolve(); await settle(); const mutation = calls.at(-1);
  props.connected = false; await settle(); assert.equal(mutation.signal.aborted, true); mutation.reject(new Error("旧账号失败")); await pending; await settle();
  assert.doesNotMatch(textContent(root), /旧账号失败|row-1/);
  assert.equal(changes.length, 0);
  props.connected = true; await settle(); calls.at(-1).resolve([recordSet()]); await settle(); const query = calls.at(-1); unmount(); assert.equal(query.signal.aborted, true); query.reject(new Error("卸载后失败")); await settle();
});

test("HTTP validation failure preserves the row editor for correction and another confirmed attempt", async () => {
  const { root } = mount(); await load(); await click(root, "新增记录"); await input(field(root, "record-value-qty"), "5");
  const pending = submit(root); await settle(); confirmations[0].resolve(); await settle(); calls.at(-1).reject(new Error("字段结构已更新，请重新读取")); await pending; await settle();
  assert.match(textContent(root), /字段结构已更新/); assert.equal(findAll(root, (node) => node.tag === "dialog").length, 1); assert.equal(button(root, "提交登记").props.disabled, false);
});

test("creating the first record set refreshes the list and opens its empty records without an extra manual selection", async () => {
  const { root } = mount(); await load(0, []); await click(root, "新建登记表");
  await input(field(root, "英文记录名"), "checks"); await input(field(root, "登记表中文名称"), "巡检登记"); await input(field(root, "字段 1 英文名"), "note"); await input(field(root, "字段 1 中文名"), "说明");
  const pending = submit(root); await settle(); assert.equal(calls.length, 1); confirmations[0].resolve(); await settle();
  const created = { ...recordSet("checks"), schema: { label: "巡检登记", fields: [{ name: "note", label: "说明", type: "string" }] }, rowCount: 0 };
  assert.equal(calls.at(-1).kind, "define"); assert.deepEqual(calls.at(-1).input.fields, created.schema.fields);
  calls.at(-1).resolve({ name: "checks", schema: created.schema }); await settle(); await load(calls.length - 1, [created], []); await pending; await settle();
  assert.equal(calls.at(-1).name, "checks"); assert.equal(button(root, "新增记录").props.disabled, false); assert.match(textContent(root), /登记表已创建/);
});

test("switching selected record isolates slow row queries and an outstanding write confirmation", async () => {
  const { props, root } = mount();
  calls[0].resolve([recordSet(), recordSet("checks")]); await settle(); const oldQuery = calls.at(-1);
  await select(field(root, "record-set"), "checks"); assert.equal(oldQuery.signal.aborted, true); const latest = calls.at(-1); assert.equal(latest.name, "checks");
  oldQuery.resolve({ schema: recordSet().schema, rows: [{ ...row, id: "obsolete-row" }], total: 50 }); latest.resolve({ schema: recordSet("checks").schema, rows: [row], total: 1 }); await settle();
  assert.doesNotMatch(textContent(root), /obsolete-row|匹配 50/);
  const pending = button(root, "作废记录 row-1").props.onClick(); await settle(); props.initialName = "loss_log"; await settle();
  const count = calls.length; confirmations[0].resolve(); await pending; await settle(); assert.equal(calls.length, count); assert.equal(calls.some((call) => call.kind === "void"), false); assert.equal(calls.at(-1).name, "loss_log");
  calls.at(-1).resolve({ schema: recordSet().schema, rows: [row], total: 1 }); await settle(); assert.equal(button(root, "编辑记录 row-1").props.disabled, false);
});

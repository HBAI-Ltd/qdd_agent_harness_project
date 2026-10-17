import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { after, afterEach, test } from "node:test";
import { compileScript, parse } from "@vue/compiler-sfc";
import { createRenderer, nextTick } from "vue";

const moduleUrl = (source) => "data:text/javascript," + encodeURIComponent(source);
const vueUrl = import.meta.resolve("vue");
const contextUrl = moduleUrl(`
  import { reactive, ref } from "vue";
  export const route = reactive({ query: {}, hash: "" });
  export const useRoute = () => route;
  const workspace = {
    gatewayUrl: ref("http://fixture.test"), token: ref("token"), connected: ref(false),
    preferences: ref({ theme: "light", enterToSend: true }), loadingSessions: ref(false), loadingPages: ref(false),
    error: ref(""), async loadWorkspace() {},
  };
  export const useWorkspaceContext = () => ({ workspace });
  export const getStyle = async () => "style";
  export const saveStyle = async () => "style";
  export const resetStyle = async () => "style";
`);
const componentsUrl = moduleUrl(`
  import { h } from "vue";
  export const refreshes = [];
  export const WorkspaceSettings = { setup: (_, { slots }) => () => h("section", { class: "settings-panel" }, slots.default?.()) };
  export const WorkspaceData = { setup(_, { expose }) { expose({ refresh() { refreshes.push(true); } }); return () => h("div"); } };
  export const WorkspaceRecords = {
    props: ["initialName"], emits: ["changed"],
    setup: (props, { emit }) => () => h("button", { "data-record": props.initialName, onClick: () => emit("changed") }, "record changed"),
  };
`);
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith("data:text/javascript,")) {
    if (specifier === "vue") return { url: vueUrl, shortCircuit: true };
    if (specifier === "vue-router" || specifier.startsWith("@/api/") || specifier.startsWith("@/composables/")) return { url: contextUrl, shortCircuit: true };
    if (specifier.startsWith("@/components/")) return { url: componentsUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });
const { descriptor } = parse(await readFile(new URL("../src/views/settings/index.vue", import.meta.url), "utf8"));
const script = compileScript(descriptor, { id: "settings-records-integration", inlineTemplate: true });
// Point each component default import at its individual export while keeping shared state.
let code = stripTypeScriptTypes(script.content, { mode: "strip" });
for (const name of ["WorkspaceSettings", "WorkspaceData", "WorkspaceRecords"]) {
  code = code.replace(`import ${name} from "@/components/${name}.vue";`, `import { ${name} } from "@/components/${name}.vue";`);
}
const { default: SettingsView } = await import(moduleUrl(code));
const { route } = await import(contextUrl);
const { refreshes } = await import(componentsUrl);
const mounted = [];
const scrolls = [];
const originalDocument = globalThis.document;
const panel = { scrollTop: 40, getBoundingClientRect: () => ({ top: 100 }), scrollTo: (options) => scrolls.push(options) };
const section = { closest: (selector) => selector === ".settings-panel" ? panel : null, getBoundingClientRect: () => ({ top: 600 }) };
globalThis.document = { getElementById: (id) => id === "settings-records" ? section : null };
afterEach(async () => {
  for (const app of mounted.splice(0)) app.unmount();
  route.query = {}; route.hash = "";
  await nextTick(); scrolls.length = refreshes.length = 0;
});
after(() => { hooks.deregister(); if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument; });
function remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null; }
const renderer = createRenderer({
  createElement: (tag) => ({ tag, props: {}, children: [], parent: null }),
  createText: (text) => ({ text, children: [], parent: null }), createComment: () => ({ children: [], parent: null }),
  setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; node.children = []; },
  patchProp: (node, key, _previous, value) => { node.props[key] = value; },
  insert(node, parent, anchor = null) { remove(node); const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index < 0 ? parent.children.length : index, 0, node); node.parent = parent; },
  remove, parentNode: (node) => node.parent, nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
});
async function settle() { await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick(); }
async function mount() {
  const root = { children: [] }; const app = renderer.createApp(SettingsView); app.mount(root); mounted.push(app);
  await settle(); return root;
}
const findAll = (node, predicate) => [...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => findAll(child, predicate))];

test("record deep links select the table and scroll the settings container on first mount and query changes", async () => {
  route.query = { record: "loss_log" }; route.hash = "#settings-records";
  const root = await mount();
  assert.equal(findAll(root, (node) => node.tag === "button")[0].props["data-record"], "loss_log");
  assert.deepEqual(scrolls, [{ top: 516 }]);
  route.query = { record: "checks" }; await settle();
  assert.equal(findAll(root, (node) => node.tag === "button")[0].props["data-record"], "checks");
  assert.deepEqual(scrolls, [{ top: 516 }, { top: 516 }]);
});

test("ordinary settings visits stay in place and a successful record change refreshes data and metrics", async () => {
  const root = await mount();
  assert.deepEqual(scrolls, []); assert.deepEqual(refreshes, []);
  findAll(root, (node) => node.tag === "button")[0].props.onClick(); await settle();
  assert.deepEqual(refreshes, [true]);
  route.hash = "#settings-records"; await settle();
  assert.deepEqual(scrolls, [{ top: 516 }]);
});

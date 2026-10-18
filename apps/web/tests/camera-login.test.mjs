import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { compileScript, parse } from "@vue/compiler-sfc";
import { createRenderer, h, nextTick, reactive, ref } from "vue";

const vueUrl = import.meta.resolve("vue");
const apiUrl = new URL("../src/api/cameras.ts", import.meta.url).href;
const workspaceUrl = new URL("../src/api/workspace.ts", import.meta.url).href;
const controlsUrl = "data:text/javascript," + encodeURIComponent(`
  import { h } from "vue";
  const Control = { setup: (_, { slots }) => () => h("div", slots.default?.()) };
  export { Control as ElAlert, Control as ElButton, Control as ElDialog, Control as ElForm, Control as ElFormItem, Control as ElInput };
`);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith("data:text/javascript,")) {
      if (specifier === "vue") return { url: vueUrl, shortCircuit: true };
      if (specifier.startsWith("element-plus/es/components/")) return { url: controlsUrl, shortCircuit: true };
      if (specifier === "@/api/cameras") return { url: apiUrl, shortCircuit: true };
    }
    if (context.parentURL === apiUrl && specifier === "./workspace") return { url: workspaceUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const source = await readFile(new URL("../src/components/CameraLoginDialog.vue", import.meta.url), "utf8");
const exposed = source.replace("</script>", "defineExpose({ phone, code, callbackUrl, busy, error, cooldown, tyslState, sendCode, haikLogin, tyslStart, tyslComplete, openNativeConsole });\n</script>");
const { descriptor } = parse(exposed);
const compiled = compileScript(descriptor, { id: "camera-login-adversarial" });
const componentUrl = "data:text/javascript," + encodeURIComponent(stripTypeScriptTypes(compiled.content, { mode: "strip" }));
const { default: CameraLogin } = await import(componentUrl);
CameraLogin.render = () => h("div");

const settle = () => new Promise((resolve) => setImmediate(resolve));
const json = (body) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function mount(t, provider = "haik") {
  const captchas = [];
  const windows = [];
  const intervals = [];
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    initAliyunCaptcha(options) { captchas.push(options); options.getInstance({ destroy() {} }); },
    open(...args) { windows.push(args); },
  } });
  t.mock.method(globalThis, "setInterval", (callback) => { intervals.push(callback); return intervals.length; });
  t.mock.method(globalThis, "clearInterval", () => {});
  const props = reactive({ provider, gatewayUrl: "http://127.0.0.1:3000", token: "original-token" });
  const open = ref(true);
  const vm = ref();
  let connected = 0;
  const renderer = createRenderer({
    patchProp() {}, insert(node, parent) { parent.children.push(node); }, remove() {},
    createElement: (tag) => ({ tag, children: [] }), createText: (text) => ({ text, children: [] }),
    createComment: () => ({ children: [] }), setText() {}, setElementText() {},
    parentNode: () => null, nextSibling: () => null,
  });
  const app = renderer.createApp({ setup: () => () => h(CameraLogin, {
    ...props, modelValue: open.value, "onUpdate:modelValue": (value) => { open.value = value; },
    onConnected: () => { connected++; }, ref: vm,
  }) });
  app.mount({ children: [] });
  t.after(() => {
    app.unmount();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  await nextTick();
  await settle();
  return { vm: vm.value, props, open, captchas, windows, intervals, connections: () => connected };
}

test("camera login aborts on account changes and ignores late success from the old identity", async (t) => {
  const pending = deferred();
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => { requests.push({ url, init }); return pending.promise; });
  const fixture = await mount(t);
  fixture.vm.phone = "13800138000";
  fixture.vm.code = "123456";
  const loggingIn = fixture.vm.haikLogin();
  assert.equal(requests.length, 1);
  fixture.props.token = "replacement-account";
  await nextTick();
  assert.equal(requests[0].init.signal.aborted, true);
  assert.equal(fixture.vm.phone, "");
  assert.equal(fixture.vm.code, "");
  pending.resolve(json({ ok: true }));
  await loggingIn;
  assert.equal(fixture.connections(), 0);
  assert.equal(fixture.open.value, true);
  assert.equal(fixture.vm.busy, false);
  assert.equal(fixture.vm.error, "");
});

test("obsolete captcha callbacks cannot send SMS or overwrite a reopened provider", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return json({ sent: true }); });
  const fixture = await mount(t);
  const oldCaptcha = fixture.captchas[0];
  assert.ok(oldCaptcha);
  fixture.props.provider = "tysl";
  await nextTick();
  fixture.vm.phone = "13800138000";
  oldCaptcha.success("obsolete-verification");
  oldCaptcha.fail();
  oldCaptcha.onError();
  await settle();
  assert.equal(requests, 0);
  assert.equal(fixture.vm.error, "");
  assert.equal(fixture.connections(), 0);
});

test("SMS requests prevent duplicate submissions and cooldown responses cannot cross dialog closure", async (t) => {
  const pending = deferred();
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => { requests.push(init); return pending.promise; });
  const fixture = await mount(t);
  fixture.vm.phone = "13800138000";
  const sending = fixture.vm.sendCode("verification");
  await fixture.vm.sendCode("duplicate");
  assert.equal(requests.length, 1);
  fixture.open.value = false;
  await nextTick();
  pending.resolve(json({ sent: true }));
  await sending;
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(fixture.vm.cooldown, 0);
  assert.equal(fixture.vm.busy, false);
  assert.equal(fixture.vm.error, "");
});

test("TYSL rejects lookalike callback origins and does not open a stale login response", async (t) => {
  const pending = deferred();
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => { requests.push({ url, init }); return pending.promise; });
  const fixture = await mount(t, "tysl");
  for (const callback of ["https://active1-e.ctseelink.cn.attacker.example/?paras=x", "https://active1-e.ctseelink.cn@attacker.example/?paras=x", "https://user:secret@active1-e.ctseelink.cn/?paras=x"]) {
    fixture.vm.callbackUrl = callback;
    await fixture.vm.tyslComplete();
  }
  assert.equal(requests.length, 0);
  const starting = fixture.vm.tyslStart();
  fixture.props.gatewayUrl = "http://127.0.0.1:4000";
  await nextTick();
  pending.resolve(json({ state: "old-state", url: "https://official.example/login", expiresIn: 60 }));
  await starting;
  assert.equal(requests[0].init.signal.aborted, true);
  assert.equal(fixture.vm.tyslState, "");
  assert.deepEqual(fixture.windows, []);
});

test("local camera console polling aborts on dismissal and ignores an old connected account", async (t) => {
  const pending = deferred();
  let signal;
  t.mock.method(globalThis, "fetch", async (_url, init) => { signal = init.signal; return pending.promise; });
  const fixture = await mount(t);
  fixture.vm.openNativeConsole();
  const polling = fixture.intervals.at(-1)();
  fixture.open.value = false;
  await nextTick();
  assert.equal(signal.aborted, true);
  pending.resolve(json([{ provider: "haik", connected: true }]));
  await polling;
  assert.equal(fixture.connections(), 0);
});

test("valid camera login emits its confirmed connection once", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => { requests.push({ url, init }); return json({ ok: true }); });
  const fixture = await mount(t);
  fixture.vm.phone = "bad-phone";
  fixture.vm.code = "123456";
  await fixture.vm.haikLogin();
  assert.equal(requests.length, 0);
  fixture.vm.phone = "13800138000";
  await fixture.vm.haikLogin();
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].init.body), { phone: "13800138000", code: "123456" });
  assert.equal(fixture.connections(), 1);
  assert.equal(fixture.open.value, false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createRenderer, nextTick, ref } from "vue";

// Preserve the same Vue runtime for the component scope and the bundled helper.
// The explicit workspace parameter avoids injecting a real gateway session.
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("../src/composables/useGatewayResource.ts", import.meta.url))],
  bundle: true, write: false, format: "esm", platform: "node", target: "node24", external: ["vue"],
});
const source = bundled.outputFiles[0].text.replaceAll('from "vue"', `from ${JSON.stringify(import.meta.resolve("vue"))}`);
const { useGatewayResource } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

const renderer = createRenderer({
  createElement: (tag) => ({ tag, children: [], parent: null }),
  createText: (text) => ({ text, children: [], parent: null }),
  createComment: (text) => ({ comment: text, children: [], parent: null }),
  setText: (node, text) => { node.text = text; },
  setElementText: (node, text) => { node.text = text; },
  patchProp: (node, key, _previous, value) => { node[key] = value; },
  insert(node, parent, anchor = null) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
    node.parent = parent;
  },
  remove(node) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = null;
  },
  parentNode: (node) => node.parent,
  nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function setup(t, { connected = true, key = "connectors" } = {}) {
  const workspace = {
    gatewayUrl: ref("http://fixture-gateway-a.test"), token: ref("fixture-token-a"), connected: ref(connected),
    gatewayChanges: ref({ overview: 0, pending: 0, skills: 0, schedules: 0, connectors: 0 }),
  };
  const calls = [];
  let resource;
  const app = renderer.createApp({
    setup() {
      resource = useGatewayResource(key, (base, token, signal) => {
        const pending = deferred();
        calls.push({ base, token, signal, ...pending });
        // Deliberately ignore abort here to emulate a late transport response.
        return pending.promise;
      }, workspace);
      return () => null;
    },
  });
  app.mount({ children: [] });
  let mounted = true;
  const unmount = () => { if (mounted) { mounted = false; app.unmount(); } };
  t.after(unmount);
  return { workspace, resource, calls, unmount };
}

async function settle() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
}

test("credential changes immediately clear prior data and discard late results from either identity", async (t) => {
  const { workspace, resource, calls } = setup(t);
  assert.equal(calls.length, 1);
  calls[0].resolve({ account: "a" });
  await settle();
  assert.deepEqual(resource.data.value, { account: "a" });
  workspace.gatewayUrl.value = "http://fixture-gateway-b.test";
  assert.equal(resource.data.value, undefined);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls[1].base, "http://fixture-gateway-b.test");
  workspace.token.value = "fixture-token-b";
  assert.equal(calls[1].signal.aborted, true);
  assert.equal(calls[2].token, "fixture-token-b");
  calls[1].resolve({ account: "obsolete-gateway-token-pair" });
  await settle();
  assert.equal(resource.data.value, undefined);
  assert.equal(resource.loading.value, true);
  calls[2].resolve({ account: "b" });
  await settle();
  assert.deepEqual(resource.data.value, { account: "b" });
  assert.equal(resource.loading.value, false);
});

test("disconnect clears loading and data, suppresses stale failures, and reconnect loads afresh", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { workspace, resource, calls } = setup(t);
  workspace.connected.value = false;
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(resource.loading.value, false);
  assert.equal(resource.data.value, undefined);
  calls[0].reject(new Error("obsolete account failure"));
  await settle();
  assert.equal(resource.error.value, "");
  workspace.gatewayChanges.value.connectors++;
  await nextTick();
  t.mock.timers.tick(200);
  await resource.refresh();
  assert.equal(calls.length, 1);
  workspace.connected.value = true;
  assert.equal(calls.length, 2);
  assert.equal(resource.loading.value, true);
  calls[1].resolve({ fresh: true });
  await settle();
  assert.deepEqual(resource.data.value, { fresh: true });
});

test("SSE revisions are coalesced and unrelated resource events do not refresh", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { workspace, resource, calls } = setup(t, { key: "skills" });
  calls[0].resolve(["initial skill"]);
  await settle();
  workspace.gatewayChanges.value.connectors++;
  await nextTick();
  t.mock.timers.tick(200);
  assert.equal(calls.length, 1);
  workspace.gatewayChanges.value.skills++;
  await nextTick();
  t.mock.timers.tick(60);
  workspace.gatewayChanges.value.skills++;
  await nextTick();
  t.mock.timers.tick(99);
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  assert.equal(calls.length, 2);
  calls[1].resolve(["new skill"]);
  await settle();
  assert.deepEqual(resource.data.value, ["new skill"]);
});

test("a newer manual refresh owns loading, data and errors when requests complete out of order", async (t) => {
  const { resource, calls } = setup(t);
  const fresh = resource.refresh();
  assert.equal(calls[0].signal.aborted, true);
  calls[0].reject(new Error("stale failure"));
  await settle();
  assert.equal(resource.error.value, "");
  assert.equal(resource.loading.value, true);
  calls[1].resolve({ revision: 2 });
  await fresh;
  assert.deepEqual(resource.data.value, { revision: 2 });
  assert.equal(resource.loading.value, false);
});

test("failed refresh retains last data, exposes backend error, then clears error on retry", async (t) => {
  const { resource, calls } = setup(t);
  calls[0].resolve(["known data"]);
  await settle();
  const failed = resource.refresh();
  calls[1].reject(new Error("访问权限不足"));
  await failed;
  assert.equal(resource.error.value, "访问权限不足");
  assert.deepEqual(resource.data.value, ["known data"]);
  assert.equal(resource.loading.value, false);
  const retry = resource.refresh();
  assert.equal(resource.error.value, "");
  assert.equal(resource.loading.value, true);
  calls[2].resolve(["refreshed data"]);
  await retry;
  assert.deepEqual(resource.data.value, ["refreshed data"]);
  assert.equal(resource.error.value, "");
});

test("network failures receive the gateway guidance and credential changes clear old errors", async (t) => {
  const { workspace, resource, calls } = setup(t);
  calls[0].reject(new TypeError("fixture network failure"));
  await settle();
  assert.equal(resource.error.value, "无法连接网关，请检查服务状态。");
  workspace.token.value = "fixture-replacement-token";
  assert.equal(resource.error.value, "");
  assert.equal(resource.data.value, undefined);
  calls[1].resolve({ ready: true });
  await settle();
  assert.deepEqual(resource.data.value, { ready: true });
});

test("unmount aborts in-flight loading, cancels queued SSE refreshes and rejects late writes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { workspace, resource, calls, unmount } = setup(t);
  workspace.gatewayChanges.value.connectors++;
  await nextTick();
  unmount();
  assert.equal(calls[0].signal.aborted, true);
  t.mock.timers.tick(200);
  assert.equal(calls.length, 1);
  calls[0].resolve({ shouldNeverAppear: true });
  await settle();
  assert.equal(resource.data.value, undefined);
  assert.equal(resource.error.value, "");
  await resource.refresh();
  workspace.connected.value = false;
  workspace.connected.value = true;
  await settle();
  assert.equal(calls.length, 1);
});

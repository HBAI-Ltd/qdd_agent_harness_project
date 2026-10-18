import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../tools/desktop-entry.mjs", import.meta.url), "utf8");
const start = source.indexOf("function installSettings(");
const end = source.indexOf("\nasync function configure(", start);
assert.ok(start >= 0 && end > start, "The desktop settings handler must remain available for its concurrency contract.");

test("rejected concurrent settings saves cannot unlock the first pending restart for a third POST", async () => {
  const saved = [], restarts = [], errors = [];
  let finishRestart;
  const pendingRestart = new Promise((resolve) => { finishRestart = resolve; });
  const context = vm.createContext({
    readConfiguration: async (request) => request.config,
    hash: (value) => value,
    saveConfiguration: (_path, value) => saved.push(value),
    deviceBaseUrl: (port) => `http://127.0.0.1:${port}`,
    failDesktop: (error) => errors.push(error),
  });
  vm.runInContext(source.slice(start, end), context);
  const initial = { ANDROID_MCP_PORT: "8790", marker: "original" };
  context.installSettings("fixture.json", initial, JSON.stringify(initial), "http://127.0.0.1:8790/", async (next) => {
    restarts.push(next); await pendingRestart;
  });
  class Response extends EventEmitter {
    writeHead(status) { this.status = status; }
    end(body) { this.body = JSON.parse(body); this.emit("finish"); }
  }
  const response = () => new Response();
  const first = response(), second = response(), third = response();
  const request = (marker) => ({ url: "/desktop/settings", method: "POST", config: { ...initial, marker } });
  await Promise.all([
    context.__QDD_DESKTOP_SETTINGS__(request("first"), first),
    context.__QDD_DESKTOP_SETTINGS__(request("second"), second),
  ]);
  await context.__QDD_DESKTOP_SETTINGS__(request("third"), third);
  finishRestart();
  assert.equal(first.status, 200);
  assert.equal(second.status, 400); assert.match(second.body.error, /正在应用/);
  assert.equal(third.status, 400, "A rejected second save must not clear the first save's restart claim.");
  assert.deepEqual(saved.map(({ marker }) => marker), ["first"]);
  assert.deepEqual(restarts.map(({ marker }) => marker), ["first"]);
  assert.deepEqual(errors, []);
});

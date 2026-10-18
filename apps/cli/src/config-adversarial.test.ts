import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "./config.js";

const invalid: [unknown, RegExp][] = [
  [null, /配置.*对象/],
  [[], /配置.*对象/],
  [{ llm: null }, /llm.*对象/],
  [{ gateway: [] }, /gateway.*对象/],
  [{ workspace: "" }, /workspace/],
  [{ llm: { maxTokens: -1 } }, /maxTokens/],
  [{ llm: { thinking: "sometimes" } }, /thinking/],
  [{ browser: { enabled: "false" } }, /browser.enabled/],
  [{ gateway: { corsOrigins: "http://localhost:5177" } }, /corsOrigins/],
  [{ gateway: { corsOrigins: [123] } }, /corsOrigins/],
  [{ datasets: { refreshIntervalSec: -1 } }, /refreshIntervalSec/],
  [{ mcpServers: { broken: null } }, /MCP.*broken/],
  [{ llm: { models: [{ id: "test", maxTokens: 0 }] } }, /maxTokens/],
];

for (const [input, message] of invalid) {
  test(`invalid configuration fails before starting services: ${JSON.stringify(input)}`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "qdd-config-adversarial-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "harness.config.json"), JSON.stringify(input));
    await assert.rejects(loadConfig(root), message);
  });
}

test("valid configuration retains explicit model budgets and disabled refresh", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "qdd-config-adversarial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "harness.config.json"), JSON.stringify({
    llm: { maxTokens: 393216, models: [{ id: "custom", maxTokens: 1024 }] },
    browser: { enabled: false }, gateway: { corsOrigins: ["http://localhost:5177"] }, datasets: { refreshIntervalSec: 0 },
  }));
  const { config } = await loadConfig(root);
  assert.equal(config.llm.maxTokens, 393216);
  assert.equal(config.llm.models?.[0]?.maxTokens, 1024);
  assert.equal(config.datasets.refreshIntervalSec, 0);
});

test("legacy maxSteps does not prevent loading configuration", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "qdd-config-adversarial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "harness.config.json"), JSON.stringify({ llm: { maxSteps: 0 } }));
  await loadConfig(root);
});

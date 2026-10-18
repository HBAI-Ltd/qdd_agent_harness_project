import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { systemPrompt } from "./agent/prompt.js";
import { loadConfig } from "./config.js";
import { InvalidInput, SkillStore, skillInstructions } from "./workbench/skills.js";

test("空工作空间默认提供完整内置技能，允许自建技能并在重开后保留", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qdd-builtin-skills-"));
  try {
    const { paths } = await loadConfig(root);
    const store = new SkillStore(paths);
    const skills = await store.list();
    assert.deepEqual(skills.map((s) => s.name), ["android-operator", "xiaohongshu-hid-control"]);
    const android = (await store.find("android-operator"))!;
    assert.equal((await store.get(android.id)).id, android.id);
    assert.match(skillInstructions(android), /定位与点击必须分开/);
    assert.match(android.instructions!, /四大能力/);
    const methodology = await readFile(new URL("../../../skills/android-operator/METHODOLOGY.md", import.meta.url), "utf8");
    assert.ok(android.instructions!.includes(methodology), "完整方法论应随默认手机技能加载");
    const xhs = (await store.find("xiaohongshu-hid-control"))!;
    assert.match(skillInstructions(xhs), /布局族/);
    // 完整说明保留原文后半部分，不经过普通技能步骤的 300 字截断。
    assert.ok(android.instructions!.length > 10000);
    assert.ok(xhs.instructions!.length > 8000);
    const prompt = systemPrompt({
      slug: "test", style: "", theme: "", cdnAllowlist: [], pages: [], updating: undefined,
      metrics: {}, datasets: [], sessions: [], skills,
    });
    assert.match(prompt, /默认已加载的技能/);
    assert.ok(prompt.includes(android.instructions!));
    assert.ok(prompt.includes(xhs.instructions!));
    await assert.rejects(store.update(android.id, { name: "x", description: "", steps: ["x"] }), InvalidInput);
    await assert.rejects(store.remove(android.id), InvalidInput);
    await assert.rejects(store.create({ name: android.name, description: "", steps: ["x"] }, "user"), InvalidInput);
    const custom = await store.create({ name: "用户巡检", description: "", steps: ["检查库存"] }, "user");
    const reopened = new SkillStore(paths);
    assert.equal((await reopened.list()).length, 3);
    assert.equal((await reopened.get(custom.id)).source, "user");
    await reopened.remove(custom.id);
    assert.equal((await reopened.list()).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

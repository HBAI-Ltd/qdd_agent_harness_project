import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { writeAtomic } from "./web/site.js";

for (const permanent of [false, true]) {
  test(`atomic writes handle ${permanent ? "permanent" : "transient"} destination sharing errors without data loss`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "qdd-atomic-adversarial-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const target = path.join(root, "state.json");
    await writeFile(target, "previous");
    const rename = fs.rename;
    let attempts = 0;
    const mock = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      if (args[1] === target && (++attempts <= 2 || permanent)) throw Object.assign(new Error("File is in use"), { code: "EPERM" });
      return rename(...args);
    });
    syncBuiltinESMExports();
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
    if (permanent) {
      await assert.rejects(writeAtomic(target, "next"), { code: "EPERM" });
      assert.equal(await readFile(target, "utf8"), "previous");
      assert.equal(attempts, 6, "Persistent errors must not retry indefinitely");
    } else {
      await writeAtomic(target, "next");
      assert.equal(await readFile(target, "utf8"), "next");
      assert.equal(attempts, 3);
    }
    assert.deepEqual(await readdir(root), ["state.json"], "Temporary files are removed on success and failure");
    mock.mock.restore();
    syncBuiltinESMExports();
    await writeAtomic(target, "recovered");
    assert.equal(await readFile(target, "utf8"), "recovered", "A failed write must not poison the queue");
  });
}

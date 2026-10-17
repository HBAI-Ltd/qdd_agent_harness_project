import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { utils, write } from "xlsx";
import { AttachmentStore } from "./attachments.js";

test("uploaded Excel attachments expose all sheets and preserve original bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qdd-excel-"));
  try {
    const store = new AttachmentStore(root);
    for (const bookType of ["xlsx", "xls", "xlsm"] as const) {
      const book = utils.book_new();
      utils.book_append_sheet(book, utils.aoa_to_sheet([
        ["门店", "销售额", "备注"], ["上海", 1200, "含,逗号\n第二行"], ["北京", 0, false],
      ]), "销售");
      utils.book_append_sheet(book, utils.aoa_to_sheet([["日期"], ["2026-10-17"]]), "日期");
      utils.book_append_sheet(book, utils.aoa_to_sheet([]), "空表");
      const bytes = write(book, { type: "buffer", bookType }) as Buffer;
      const ref = await store.save(`报表/销售.${bookType}`, bytes);
      const text = await store.readForModel(ref.id);
      assert.match(text, /工作表：销售\n门店,销售额,备注/);
      assert.match(text, /上海,1200,"含,逗号\n第二行"/);
      assert.match(text, /北京,0,FALSE/);
      assert.match(text, /工作表：日期\n日期\n2026-10-17/);
      assert.match(text, /工作表：空表\n（空工作表）/);
      assert.ok((await store.bytes(ref.id)).bytes.equals(bytes));
      assert.doesNotMatch(text, /这是二进制文件/);
    }
    const largeBook = utils.book_new();
    utils.book_append_sheet(largeBook, utils.aoa_to_sheet(Array.from({ length: 5000 }, (_, i) => [`门店${i}`, i])), "大表");
    const large = await store.save("large.xlsx", write(largeBook, { type: "buffer", bookType: "xlsx" }) as Buffer);
    const first = await store.readForModel(large.id);
    assert.match(first, /offset=40000/);
    const rest = await store.readForModel(large.id, 40000);
    assert.match(rest, /门店4999,4999/);
    const invalid = await store.save("broken.xlsx", Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    await assert.rejects(store.readForModel(invalid.id), /无法读取 Excel 附件/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

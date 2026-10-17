import { constants } from "node:fs";
import { copyFile, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { SessionMeta } from "@qdd/shared";
import type { HarnessPaths } from "./config.js";

/** 启动时迁移旧定时会话；完整复制后才移除原文件，重复运行可恢复未完成的迁移。 */
export async function migrateScheduleSessions(paths: HarnessPaths): Promise<void> {
  const names = (await readdir(paths.sessions)).filter((name) => /^[0-9a-f-]{36}\.meta\.json$/.test(name));
  for (const name of names) {
    let meta: Partial<SessionMeta>;
    try {
      meta = JSON.parse(await readFile(path.join(paths.sessions, name), "utf8")) as Partial<SessionMeta>;
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (meta?.origin?.kind !== "schedule") continue;
    const id = name.slice(0, -".meta.json".length);
    const originals: string[] = [];
    // 元数据最后复制，目标目录中出现元数据时事件与续聊记录已经就绪。
    for (const kind of ["events.jsonl", "messages.json", "meta.json"]) {
      const source = path.join(paths.sessions, `${id}.${kind}`);
      const destination = path.join(paths.scheduleSessions, `${id}.${kind}`);
      try {
        await copyFile(source, destination, constants.COPYFILE_EXCL);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" && kind !== "meta.json") continue;
        if (code !== "EEXIST") throw error;
        const [original, existing] = await Promise.all([readFile(source), readFile(destination)]);
        if (!original.equals(existing)) throw new Error(`迁移定时任务会话 ${id} 失败：目标文件已存在且内容不同`);
      }
      originals.push(source);
    }
    for (const source of originals) {
      await unlink(source).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}

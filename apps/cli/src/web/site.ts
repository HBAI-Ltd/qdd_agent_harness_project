import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PageEntry } from "@qdd/shared";
import type { HarnessPaths } from "../config.js";
import { ensureStoreData } from "../datasource/store.js";
import { migrateScheduleSessions } from "../session-storage.js";
import { DEFAULT_STYLE_PROMPT, THEME_CSS } from "./assets.js";

async function writeIfMissing(file: string, content: string): Promise<void> {
  try {
    await writeFile(file, content, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export async function writeAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, file);
}

/** 初始化工作区；用户可改的文件只在缺失时生成。 */
export async function ensureWorkspace(paths: HarnessPaths): Promise<void> {
  await mkdir(path.join(paths.site, "assets"), { recursive: true });
  await mkdir(paths.pages, { recursive: true });
  await mkdir(paths.sessions, { recursive: true });
  await mkdir(paths.scheduleSessions, { recursive: true });
  await migrateScheduleSessions(paths);
  await writeIfMissing(paths.style, DEFAULT_STYLE_PROMPT);
  await writeIfMissing(path.join(paths.site, "assets", "theme.css"), THEME_CSS);
  await ensureStoreData(paths.store);
}

export async function readStyle(paths: HarnessPaths): Promise<string> {
  try {
    return await readFile(paths.style, "utf8");
  } catch {
    return DEFAULT_STYLE_PROMPT;
  }
}

export const writeStyle = (paths: HarnessPaths, text: string) => writeAtomic(paths.style, text);
export const resetStyle = (paths: HarnessPaths) => writeStyle(paths, DEFAULT_STYLE_PROMPT);

export async function readTheme(paths: HarnessPaths): Promise<string> {
  try {
    return await readFile(path.join(paths.site, "assets", "theme.css"), "utf8");
  } catch {
    return THEME_CSS;
  }
}

export async function readPages(paths: HarnessPaths): Promise<PageEntry[]> {
  let raw: Partial<PageEntry>[];
  try {
    raw = JSON.parse(await readFile(path.join(paths.site, "pages.json"), "utf8")) as Partial<PageEntry>[];
  } catch {
    return [];
  }
  // 兼容旧版本清单
  return raw.map((p) => ({ tools: [], useAgent: false, metrics: [], datasets: {}, version: 1, stale: null, gaps: [], sessionId: "", ...p }) as PageEntry);
}

export const writePages = (paths: HarnessPaths, pages: PageEntry[]) => writeManifest(paths, pages);

async function writeManifest(paths: HarnessPaths, pages: PageEntry[]): Promise<void> {
  await writeAtomic(path.join(paths.site, "pages.json"), `${JSON.stringify(pages, null, 2)}\n`);
}

export async function upsertPage(paths: HarnessPaths, entry: PageEntry): Promise<void> {
  const pages = (await readPages(paths)).filter((p) => p.slug !== entry.slug);
  pages.push(entry);
  await writeManifest(paths, pages);
}

export interface PagePin {
  slug: string;
  pinnedAt: string;
}

const pinsFile = (paths: HarnessPaths) => path.join(paths.site, "pins.json");

/** 置顶记录单独存放，重新发布页面（upsertPage 整条替换）不会丢失；按置顶先后排列。 */
export async function readPins(paths: HarnessPaths): Promise<PagePin[]> {
  try {
    return JSON.parse(await readFile(pinsFile(paths), "utf8")) as PagePin[];
  } catch {
    return [];
  }
}

let pinQueue: Promise<unknown> = Promise.resolve();

/** 串行读改写，避免并发置顶互相覆盖。 */
function updatePins(paths: HarnessPaths, change: (pins: PagePin[]) => PagePin[]): Promise<PagePin[]> {
  const next = pinQueue.then(async () => {
    const pins = change(await readPins(paths));
    await writeAtomic(pinsFile(paths), `${JSON.stringify(pins, null, 2)}\n`);
    return pins;
  });
  pinQueue = next.catch(() => undefined);
  return next;
}

/** 已置顶时保持原有位置（幂等）。 */
export const pinPage = (paths: HarnessPaths, slug: string) =>
  updatePins(paths, (pins) => (pins.some((x) => x.slug === slug) ? pins : [...pins, { slug, pinnedAt: new Date().toISOString() }]));

export const unpinPage = (paths: HarnessPaths, slug: string) => updatePins(paths, (pins) => pins.filter((x) => x.slug !== slug));

/** 可安全内联到 <script> 的 JSON。 */
export function toScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replaceAll(String.fromCharCode(0x2028), "\\u2028")
    .replaceAll(String.fromCharCode(0x2029), "\\u2029");
}

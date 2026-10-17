import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { PageEntry, SessionEvent, SessionMeta } from "@qdd/shared";
import type { HarnessPaths } from "../config.js";
import { readPages } from "../web/site.js";

/**
 * 跨会话记忆：会话只保留自己的对话，共享知识来自工作区——页面清单（产出索引）与会话摘要。
 * 检索用字符二元组打分，中文无需分词，也不需要向量库。
 */

export async function listSessionMetas(paths: HarnessPaths): Promise<SessionMeta[]> {
  let names: string[];
  try {
    names = (await readdir(paths.sessions)).filter((n) => n.endsWith(".meta.json"));
  } catch {
    return [];
  }
  const metas = await Promise.all(
    names.map(async (n) => {
      try {
        return { summary: "", ...(JSON.parse(await readFile(path.join(paths.sessions, n), "utf8")) as Partial<SessionMeta>) } as SessionMeta;
      } catch {
        return undefined;
      }
    }),
  );
  return metas.filter((m): m is SessionMeta => !!m && m.origin?.kind !== "schedule").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function grams(text: string): Set<string> {
  const s = text.toLowerCase().replace(/\s+/g, " ");
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  if (s.length === 1) out.add(s);
  return out;
}

function score(query: Set<string>, text: string): number {
  const g = grams(text);
  let hit = 0;
  for (const q of query) if (g.has(q)) hit++;
  return query.size ? hit / query.size : 0;
}

export interface RecallHit {
  kind: "page" | "session";
  id: string;
  title: string;
  summary: string;
  score: number;
  updatedAt: string;
}

export async function recall(paths: HarnessPaths, query: string, limit = 6): Promise<RecallHit[]> {
  const q = grams(query);
  const pages = (await readPages(paths)).map((p): RecallHit => ({
    kind: "page",
    id: p.slug,
    title: p.title,
    summary: `${p.summary}（愿望：${p.wish}；指标：${p.metrics.join("、") || "-"}）`,
    score: score(q, `${p.title} ${p.wish} ${p.summary} ${p.metrics.join(" ")}`),
    updatedAt: p.updatedAt,
  }));
  const sessions = (await listSessionMetas(paths)).map((s): RecallHit => ({
    kind: "session",
    id: s.id,
    title: s.title,
    summary: s.summary,
    score: score(q, `${s.title} ${s.summary}`),
    updatedAt: s.updatedAt,
  }));
  return [...pages, ...sessions]
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

/** 会话要点：只取店长消息、agent 回复与发布结果，不含工具细节。 */
export async function readSessionDigest(paths: HarnessPaths, id: string): Promise<string> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("会话 id 不合法");
  const meta = (await listSessionMetas(paths)).find((m) => m.id === id);
  if (!meta) throw new Error("会话不存在");
  let raw = "";
  try {
    raw = await readFile(path.join(paths.sessions, `${id}.events.jsonl`), "utf8");
  } catch {
    // 无事件
  }
  const lines = raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SessionEvent)
    .flatMap((e) => {
      if (e.type === "user") return [`店长：${e.text}`];
      if (e.type === "say") return [`agent：${e.text}`];
      if (e.type === "text" && e.done && e.content?.trim()) return [`agent：${e.content.trim()}`];
      if (e.type === "published") return [`发布页面 ${e.page.slug}「${e.page.title}」：${e.page.summary}`];
      return [];
    });
  return [`会话「${meta.title}」${meta.slug ? `（页面 ${meta.slug}）` : ""}`, ...lines].join("\n").slice(0, 8000);
}

export async function readArtifact(paths: HarnessPaths, slug: string): Promise<PageEntry & { files: string[] }> {
  const page = (await readPages(paths)).find((p) => p.slug === slug);
  if (!page) throw new Error(`页面 ${slug} 不存在`);
  const dir = path.join(paths.pages, slug);
  const files = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).replaceAll("\\", "/"));
  return { ...page, files };
}

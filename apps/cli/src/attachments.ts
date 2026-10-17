import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AttachmentRef } from "@qdd/shared";
import { writeAtomic } from "./web/site.js";

/**
 * 会话附件（参考 dsh-attachment-local）：任意扩展名的文件与文件夹。
 *   attachments/objects/<sha256 前两位>/<sha256>   不可变、内容寻址的字节
 *   attachments/refs/<id>.json                    引用：文件名、文件夹内相对路径、大小、类型
 * 会话事件只记录引用，不记录字节或宿主路径；模型经 read_attachment 按需读取内容。
 */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 500;
const ID_RE = /^[0-9a-f-]{36}$/;
const READ_LIMIT = 40_000;

const MIME: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".tsv": "text/tab-separated-values",
  ".json": "application/json", ".html": "text/html", ".xml": "application/xml", ".yaml": "application/yaml", ".yml": "application/yaml",
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".zip": "application/zip", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** 规范化上传时的相对路径（文件夹上传保留目录结构），拒绝绝对路径与 `..`。 */
export function normalizeAttachmentPath(raw: string): string {
  const parts = raw.replace(/\\/g, "/").split("/").filter((p) => p && p !== ".");
  if (!parts.length || parts.some((p) => p === ".." || /[\0-\x1f]/.test(p)) || parts.join("/").length > 512) {
    throw new AttachmentError("附件文件名不合法");
  }
  return parts.join("/");
}

export class AttachmentError extends Error {}

export class AttachmentStore {
  constructor(private readonly root: string) {}

  private object(sha: string) {
    return path.join(this.root, "objects", sha.slice(0, 2), sha);
  }

  private ref(id: string) {
    if (!ID_RE.test(id)) throw new AttachmentError(`附件 ${id} 不存在`);
    return path.join(this.root, "refs", `${id}.json`);
  }

  async save(rawPath: string, bytes: Buffer, mime?: string): Promise<AttachmentRef> {
    const relPath = normalizeAttachmentPath(rawPath);
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new AttachmentError(`附件超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const target = this.object(sha);
    await mkdir(path.dirname(target), { recursive: true });
    if (!(await stat(target).catch(() => undefined))) {
      // 先写私有临时文件，再以排他硬链接发布，避免读到半个对象
      const tmp = path.join(this.root, "tmp", randomUUID());
      await mkdir(path.dirname(tmp), { recursive: true });
      await writeFile(tmp, bytes, { mode: 0o600 });
      await link(tmp, target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      await rm(tmp, { force: true });
    }
    const name = path.posix.basename(relPath);
    const ref: AttachmentRef & { sha256: string } = {
      id: randomUUID(),
      name,
      path: relPath,
      size: bytes.length,
      mime: MIME[path.extname(name).toLowerCase()] ?? (mime && mime !== "application/octet-stream" ? mime.split(";")[0]! : "application/octet-stream"),
      sha256: sha,
    };
    await mkdir(path.join(this.root, "refs"), { recursive: true });
    await writeAtomic(this.ref(ref.id), JSON.stringify(ref));
    return publicRef(ref);
  }

  async get(id: string): Promise<AttachmentRef & { sha256: string }> {
    try {
      return JSON.parse(await readFile(this.ref(id), "utf8")) as AttachmentRef & { sha256: string };
    } catch (error) {
      if (error instanceof AttachmentError) throw error;
      throw new AttachmentError(`附件 ${id} 不存在`);
    }
  }

  /** 按 id 解析客户端提交的引用，只信任服务端记录的元数据。 */
  async resolve(ids: unknown): Promise<AttachmentRef[]> {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new AttachmentError(`attachments 必须是不超过 ${MAX_ATTACHMENTS_PER_MESSAGE} 项的数组`);
    return Promise.all(ids.map(async (x) => publicRef(await this.get(typeof x === "string" ? x : String((x as { id?: unknown })?.id)))));
  }

  async bytes(id: string): Promise<{ ref: AttachmentRef; bytes: Buffer }> {
    const ref = await this.get(id);
    return { ref: publicRef(ref), bytes: await readFile(this.object(ref.sha256)) };
  }

  /** 给模型读的内容：文本按偏移分段返回，二进制只给元信息。 */
  async readForModel(id: string, offset = 0): Promise<string> {
    const { ref, bytes } = await this.bytes(id);
    const head = `附件 ${ref.path}（${ref.mime}，${ref.size} 字节）`;
    if (!isText(bytes)) return `${head}\n这是二进制文件，无法直接读取文本内容。可根据文件名和类型向店长说明，或请店长提供可读格式（如 CSV、TXT）。`;
    const text = bytes.toString("utf8");
    const start = Math.max(0, Math.floor(offset));
    const slice = text.slice(start, start + READ_LIMIT);
    const end = start + slice.length;
    const more = end < text.length ? `\n\n…（共 ${text.length} 字符，已显示 ${start}-${end}；用 offset=${end} 继续读取）` : "";
    return `${head}\n\n${slice}${more}`;
  }
}

function publicRef({ id, name, path: p, size, mime }: AttachmentRef): AttachmentRef {
  return { id, name, path: p, size, mime };
}

function isText(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 8192);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample.length === bytes.length ? sample : trimPartial(sample));
    return true;
  } catch {
    return false;
  }
}

/** 截断的样本末尾可能落在多字节字符中间，去掉不完整的尾字节。 */
function trimPartial(sample: Buffer): Buffer {
  let end = sample.length;
  for (let i = 1; i <= 3 && end - i >= 0; i++) {
    const b = sample[end - i]!;
    if ((b & 0xc0) === 0x80) continue;
    if (b >= 0xc0) end -= i;
    break;
  }
  return sample.subarray(0, end);
}

/** 附在用户消息后的附件清单，模型据此调用 read_attachment。 */
export function attachmentPrompt(refs: readonly AttachmentRef[]): string {
  if (!refs.length) return "";
  const lines = refs.map((r) => `- ${r.path}（${r.mime}，${formatSize(r.size)}）id=${r.id}`);
  return `\n\n[店长上传的附件，共 ${refs.length} 个；需要内容时用 read_attachment 读取，未读取前不要声称已看过]\n${lines.join("\n")}`;
}

export function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

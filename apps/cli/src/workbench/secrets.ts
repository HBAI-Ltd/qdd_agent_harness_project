import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { HarnessPaths } from "../config.js";

/**
 * 连接器凭据的本地加密（AES-256-GCM）。
 * 密钥来自环境变量 QDD_SECRET_KEY；未设置时首次使用自动生成到 workspace/.secret-key（权限 600）。
 */
export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  static async open(paths: HarnessPaths): Promise<SecretBox> {
    const env = process.env.QDD_SECRET_KEY;
    if (env) return new SecretBox(createHash("sha256").update(env).digest());
    let raw: string;
    try {
      raw = (await readFile(paths.secretKey, "utf8")).trim();
    } catch {
      raw = randomBytes(32).toString("hex");
      try {
        await writeFile(paths.secretKey, raw, { mode: 0o600, flag: "wx" });
      } catch {
        // 并发创建：以先写入的为准
        raw = (await readFile(paths.secretKey, "utf8")).trim();
      }
    }
    return new SecretBox(createHash("sha256").update(raw).digest());
  }

  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
  }

  open<T>(sealed: string): T {
    const [iv, tag, data] = sealed.split(".").map((s) => Buffer.from(s, "base64"));
    if (!iv || !tag || !data) throw new Error("凭据已损坏");
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    try {
      return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")) as T;
    } catch {
      throw new Error("凭据无法解密（密钥已变更？请重新安装连接器）");
    }
  }
}

import type { AskImage } from "@qdd/shared";

export const MAX_ASK_IMAGES = 4;
export const MAX_ASK_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_ASK_IMAGES_BYTES = 10 * 1024 * 1024;
export const MAX_ASK_BODY_BYTES = 15 * 1024 * 1024;
const MAX_IMAGE_URL_LENGTH = 8192;

export class AskImageError extends Error {
  readonly status = 400;
}

function matchesImageType(bytes: Buffer, mime: string): boolean {
  switch (mime) {
    case "image/png": return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case "image/jpeg": return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    case "image/gif": return ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
    case "image/webp": return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    default: return false;
  }
}

/** Remote images are passed to the provider, never downloaded by the gateway. */
export function parseAskImages(value: unknown, limits: {
  maxImages?: number;
  maxImageBytes?: number;
  maxTotalBytes?: number;
} = {}): AskImage[] {
  const maxImages = limits.maxImages ?? MAX_ASK_IMAGES;
  const maxImageBytes = limits.maxImageBytes ?? MAX_ASK_IMAGE_BYTES;
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_ASK_IMAGES_BYTES;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxImages) {
    throw new AskImageError(`images 必须是不超过 ${maxImages} 项的数组`);
  }
  let totalBytes = 0;
  return value.map((entry: unknown, index) => {
    const label = `images[${index}]`;
    if (!entry || typeof entry !== "object" || !("url" in entry) || typeof entry.url !== "string" || !entry.url) {
      throw new AskImageError(`${label}.url 必须是非空字符串`);
    }
    const url = entry.url;
    const detail = "detail" in entry ? entry.detail : undefined;
    if (detail !== undefined && detail !== "auto" && detail !== "low" && detail !== "high") {
      throw new AskImageError(`${label}.detail 必须是 auto、low 或 high`);
    }
    if (url.startsWith("data:")) {
      if (url.length > 4 * Math.ceil(maxImageBytes / 3) + 64) {
        throw new AskImageError(`${label} 图片不能超过 ${maxImageBytes / 1024 / 1024} MiB`);
      }
      const comma = url.indexOf(",");
      const header = url.slice(0, comma);
      const mime = /^data:(image\/(?:png|jpeg|gif|webp));base64$/.exec(header)?.[1];
      if (!mime) throw new AskImageError(`${label} 只支持 PNG、JPEG、GIF、WebP 的 Base64 data URL`);
      const encoded = url.slice(comma + 1);
      if (!encoded || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded)) {
        throw new AskImageError(`${label} Base64 编码不合法`);
      }
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded) throw new AskImageError(`${label} Base64 编码不合法`);
      if (bytes.length > maxImageBytes) throw new AskImageError(`${label} 图片不能超过 ${maxImageBytes / 1024 / 1024} MiB`);
      totalBytes += bytes.length;
      if (totalBytes > maxTotalBytes) throw new AskImageError(`Base64 图片总大小不能超过 ${maxTotalBytes / 1024 / 1024} MiB`);
      if (!matchesImageType(bytes, mime)) throw new AskImageError(`${label} 图片内容与声明的类型不匹配`);
    } else {
      if (url.length > MAX_IMAGE_URL_LENGTH || /[\s\\\u0000-\u001f\u007f]/.test(url)) {
        throw new AskImageError(`${label} HTTPS 图片 URL 不合法或超过 8192 字符`);
      }
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new AskImageError(`${label} 必须是 Base64 data URL 或 HTTPS 图片 URL`);
      }
      if (!/^https:\/\//i.test(url) || parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
        throw new AskImageError(`${label} 必须是无内嵌用户名密码的 HTTPS 图片 URL`);
      }
    }
    return { url, ...(detail === undefined ? {} : { detail }) };
  });
}

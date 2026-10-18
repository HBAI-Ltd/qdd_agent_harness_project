export type MediaKind = "image" | "video" | "hls" | "flv";

export function mediaKind(path: string, mime = ""): MediaKind | undefined {
  const type = mime.toLowerCase().split(";")[0]?.trim();
  if (type === "application/vnd.apple.mpegurl" || type === "application/x-mpegurl") return "hls";
  if (type === "video/x-flv") return "flv";
  if (type?.startsWith("image/")) return "image";
  if (type?.startsWith("video/")) return "video";
  const extension = path.split(/[?#]/)[0]?.split(".").pop()?.toLowerCase();
  if (extension === "m3u8") return "hls";
  if (extension === "flv") return "flv";
  if (extension && ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"].includes(extension)) return "image";
  if (extension && ["mp4", "webm", "ogv", "ogg", "mov", "m4v"].includes(extension)) return "video";
  return undefined;
}

export function safeMediaUrl(value: string): boolean {
  // Relative URLs are supported; reject disguised schemes, credentials and backslashes.
  if (!value || /[\u0000-\u0020\u007f-\u009f\\]/.test(value)) return false;
  try {
    const url = new URL(value, "https://media.invalid/");
    return /^https?:$/.test(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Recognize camera-generated frames; the gateway separately validates the connected source. */
export function isCameraCaptureUrl(value: string): boolean {
  if (!safeMediaUrl(value)) return false;
  try {
    const url = new URL(value);
    return !url.search && !url.hash && /^\/captures\/[a-f0-9]{32}\/frame_\d{6}\.jpg$/.test(url.pathname);
  } catch {
    return false;
  }
}

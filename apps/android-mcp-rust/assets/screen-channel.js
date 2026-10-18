"use strict";

// Each record is [metadata length:u32be, JPEG length:u32be, JSON, JPEG].
// Read bounded records without Base64 conversion or an ever-growing video queue.
globalThis.QddScreenChannel = class {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    void this.run();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  emit(type, data) {
    if (!this.closed) for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    this.controller?.abort();
  }

  async run() {
    this.controller = new AbortController();
    try {
      const response = await fetch(this.url, { cache: "no-store", signal: this.controller.signal });
      if (!response.ok || !response.body || response.headers.get("content-type") !== "application/x-qdd-screen") throw new Error("Invalid screen stream.");
      const reader = response.body.getReader();
      let chunk = new Uint8Array(0), offset = 0;
      const read = async (size) => {
        const bytes = new Uint8Array(size);
        for (let copied = 0; copied < size;) {
          if (offset === chunk.length) {
            const next = await reader.read();
            if (next.done) throw new Error("Screen stream ended.");
            chunk = next.value; offset = 0;
          }
          const count = Math.min(size - copied, chunk.length - offset);
          bytes.set(chunk.subarray(offset, offset + count), copied);
          offset += count; copied += count;
        }
        return bytes;
      };
      try {
        while (!this.closed) {
          const header = new DataView((await read(8)).buffer);
          const metadataLength = header.getUint32(0), imageLength = header.getUint32(4);
          if (metadataLength < 2 || metadataLength > 8192 || imageLength > 32 * 1024 * 1024) throw new Error("Screen record exceeds its limit.");
          const data = JSON.parse(new TextDecoder().decode(await read(metadataLength)));
          if (data.type === "unavailable" && imageLength === 0) { this.emit("unavailable", data); continue; }
          if (data.type !== "frame" || imageLength === 0) throw new Error("Invalid screen record.");
          const image = new Blob([await read(imageLength)], { type: "image/jpeg" });
          this.emit("frame", { ...data, image });
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch (error) {
      if (!this.closed) this.emit("error", { message: String(error) });
    }
    if (!this.closed) this.retry = setTimeout(() => { void this.run(); }, 1000);
  }
};

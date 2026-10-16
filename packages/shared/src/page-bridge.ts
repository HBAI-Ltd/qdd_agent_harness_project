/** Versioned postMessage envelope used by task templates and their host. */
export const PAGE_BRIDGE_CHANNEL = "qdd-page-bridge";
export const PAGE_BRIDGE_VERSION = 1;
export const MAX_PAGE_BRIDGE_PAYLOAD_BYTES = 64 * 1024;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface PageBridgeMessage {
  channel: typeof PAGE_BRIDGE_CHANNEL;
  version: typeof PAGE_BRIDGE_VERSION;
  slug: string;
  /** A new ID for each frame load; messages from older loads are ignored. */
  bridgeId: string;
  /** host:init starts a connection; page:ready/page:error report its state. */
  type: string;
  payload: JsonValue;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TYPE_RE = /^[a-z][a-z0-9]*(?:[.:-][a-z0-9]+)*$/i;
const MESSAGE_FIELDS = ["channel", "version", "slug", "bridgeId", "type", "payload"] as const;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const encoder = new TextEncoder();

/** Checks JSON data without invoking accessors or toJSON methods. */
function isJsonPayload(value: unknown): value is JsonValue {
  let bytes = 0;
  const ancestors = new Set<object>();
  function add(text: string): boolean {
    bytes += encoder.encode(text).byteLength;
    return bytes <= MAX_PAGE_BRIDGE_PAYLOAD_BYTES;
  }
  function visit(current: unknown, depth: number): boolean {
    if (depth > 64 || bytes > MAX_PAGE_BRIDGE_PAYLOAD_BYTES) return false;
    if (current === null) return add("null");
    if (typeof current === "boolean") return add(current ? "true" : "false");
    if (typeof current === "number") return Number.isFinite(current) && add(JSON.stringify(current));
    if (typeof current === "string") {
      return current.length <= MAX_PAGE_BRIDGE_PAYLOAD_BYTES && add(JSON.stringify(current));
    }
    if (typeof current !== "object" || ancestors.has(current)) return false;

    const array = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(current);
    if (keys.length > MAX_PAGE_BRIDGE_PAYLOAD_BYTES) return false;
    ancestors.add(current);
    try {
      if (array) {
        // Only dense arrays with ordinary element properties round-trip as JSON.
        if (keys.length !== current.length + 1 || !add("[]")) return false;
        for (let i = 0; i < current.length; i += 1) {
          const property = Object.getOwnPropertyDescriptor(current, String(i));
          if (!property || !("value" in property) || !property.enumerable) return false;
          if ((i > 0 && !add(",")) || !visit(property.value, depth + 1)) return false;
        }
      } else {
        if (!add("{}")) return false;
        for (let i = 0; i < keys.length; i += 1) {
          const key = keys[i];
          if (typeof key !== "string" || UNSAFE_KEYS.has(key) || key.length > MAX_PAGE_BRIDGE_PAYLOAD_BYTES) return false;
          const property = Object.getOwnPropertyDescriptor(current, key);
          if (!property || !("value" in property) || !property.enumerable) return false;
          if ((i > 0 && !add(",")) || !add(JSON.stringify(key)) || !add(":")) return false;
          if (!visit(property.value, depth + 1)) return false;
        }
      }
      return true;
    } finally {
      ancestors.delete(current);
    }
  }
  return visit(value, 0);
}

/**
 * Validates the wire format only. Receivers must also verify event.source,
 * event.origin, the current slug/bridgeId and the message direction.
 */
export function isPageBridgeMessage(value: unknown): value is PageBridgeMessage {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Reflect.ownKeys(value).length !== MESSAGE_FIELDS.length) return false;
    const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of MESSAGE_FIELDS) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !("value" in property) || !property.enumerable) return false;
      fields[key] = property.value;
    }
    return fields["channel"] === PAGE_BRIDGE_CHANNEL
      && fields["version"] === PAGE_BRIDGE_VERSION
      && typeof fields["slug"] === "string" && SLUG_RE.exec(fields["slug"])?.[0] === fields["slug"]
      && typeof fields["bridgeId"] === "string" && fields["bridgeId"].trim().length > 0 && fields["bridgeId"].length <= 128
      && typeof fields["type"] === "string" && fields["type"].length <= 80 && TYPE_RE.exec(fields["type"])?.[0] === fields["type"]
      && isJsonPayload(fields["payload"]);
  } catch {
    return false;
  }
}

/** Creates a validated host:init, page:ready/page:error or business event. */
export function createPageBridgeMessage(slug: string, bridgeId: string, type: string, payload: JsonValue): PageBridgeMessage {
  const message: PageBridgeMessage = { channel: PAGE_BRIDGE_CHANNEL, version: PAGE_BRIDGE_VERSION, slug, bridgeId, type, payload };
  if (!isPageBridgeMessage(message)) throw new TypeError("Invalid page bridge message metadata or JSON payload");
  return message;
}

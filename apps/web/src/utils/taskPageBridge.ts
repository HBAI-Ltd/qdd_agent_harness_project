import {
  createPageBridgeMessage,
  isPageBridgeMessage,
  type PageBridgeMessage,
  type JsonValue as PageBridgePayload,
} from "@qdd/shared";

export const TASK_PAGE_MESSAGE_EVENT = "qdd:task-message";

export interface TaskPageEvent {
  slug: string;
  type: string;
  payload: PageBridgePayload;
  reply(type: string, payload?: PageBridgePayload): boolean;
}

interface BridgeOptions {
  getWindow(): Window | null;
  getOrigin(): string;
  getSlug(): string;
  isOpaque(): boolean;
  getContext(): PageBridgePayload;
  onMessage(message: TaskPageEvent): void;
}

/** Only the currently mounted page window can enter the shell's message handler. */
export function createTaskPageBridge(options: BridgeOptions) {
  // randomUUID requires a secure context; getRandomValues works on LAN HTTP too.
  const newBridgeId = () => typeof crypto.randomUUID === "function" ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, "0")).join("");
  let bridgeId = newBridgeId();
  let ready = false;

  function send(type: string, payload: PageBridgePayload = null, initialize = false): boolean {
    const target = options.getWindow();
    const origin = options.getOrigin();
    if (!target || !origin || (!initialize && !ready) || !type.startsWith("host:")) return false;
    try {
      const message = createPageBridgeMessage(options.getSlug(), bridgeId, type, payload);
      // Opaque sandbox frames can only be addressed with '*'; no credentials are sent.
      target.postMessage(message, options.isOpaque() ? "*" : origin);
      return true;
    } catch {
      return false;
    }
  }

  function receive(event: Pick<MessageEvent<unknown>, "data" | "origin" | "source">): boolean {
    const target = options.getWindow();
    const expectedOrigin = options.isOpaque() ? "null" : options.getOrigin();
    if (!target || event.source !== target || event.origin !== expectedOrigin || !isPageBridgeMessage(event.data)) return false;
    const message: PageBridgeMessage = event.data;
    if (message.slug !== options.getSlug() || message.bridgeId !== bridgeId || message.type.toLowerCase().startsWith("host:")) return false;
    if (message.type === "page:ready") ready = true;
    else if (!ready) return false;
    const receivedId = bridgeId;
    options.onMessage({
      slug: message.slug,
      type: message.type,
      payload: message.payload,
      reply: (type, payload = null) => receivedId === bridgeId && send(type, payload),
    });
    return true;
  }

  return {
    receive,
    postMessage: (type: string, payload: PageBridgePayload = null) => send(type, payload),
    initialize: () => send("host:init", options.getContext(), true),
    reset() { bridgeId = newBridgeId(); ready = false; },
    isReady: () => ready,
  };
}

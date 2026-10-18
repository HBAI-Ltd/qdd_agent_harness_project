import { networkInterfaces } from "node:os";
import { Agent } from "undici";
import type { Dispatcher } from "undici";
import { matchingLanAddress } from "./lan.js";

export interface LanHttpOptions {
  fetch?: typeof globalThis.fetch;
  networkInterfaces?: () => Parameters<typeof matchingLanAddress>[1];
  dispatcherFactory?: (options: Agent.Options) => Dispatcher;
}

/** One endpoint owns at most one source-bound pool; no global proxy changes. */
export class LanHttpClient {
  private dispatcher: { address: string; value: Dispatcher } | undefined;
  private retired: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly origin: string;
  private readonly hostname: string;

  constructor(endpoint: string, private readonly options: LanHttpOptions = {}) {
    const url = new URL(endpoint);
    this.origin = url.origin;
    this.hostname = url.hostname;
  }

  fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    if (this.closed) return Promise.reject(new Error("LAN HTTP connection is closed."));
    if (new URL(input).origin !== this.origin) return Promise.reject(new Error("LAN HTTP endpoint changed."));
    const address = matchingLanAddress(this.hostname, (this.options.networkInterfaces ?? networkInterfaces)());
    if (this.dispatcher?.address !== address) this.retire();
    if (address && !this.dispatcher) {
      const options: Agent.Options = { connect: { localAddress: address } };
      this.dispatcher = { address, value: this.options.dispatcherFactory?.(options) ?? new Agent(options) };
    }
    const request: RequestInit = {
      // Node's bundled undici types and the pinned Agent have distinct FormData
      // types; their dispatcher wire contract is exercised by the fetch tests.
      ...init, ...(this.dispatcher ? { dispatcher: this.dispatcher.value as unknown as NonNullable<RequestInit["dispatcher"]> } : {}),
    };
    return (this.options.fetch ?? globalThis.fetch)(input, request);
  }

  private retire(): void {
    const current = this.dispatcher;
    this.dispatcher = undefined;
    if (!current) return;
    const destroying = current.value.destroy().catch(() => {});
    this.retired = Promise.all([this.retired, destroying]).then(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.retire();
    await this.retired;
  }
}

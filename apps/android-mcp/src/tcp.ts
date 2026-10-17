import { lookup } from "node:dns";
import { EventEmitter } from "node:events";
import { isIP, Socket } from "node:net";
import { SerialHidBridge } from "./serial.js";
import type { SerialTransport } from "./serial.js";

export const DEFAULT_ESP_TCP_PORT = 3333;

export interface TcpBridgeOptions {
  host: string;
  port?: number;
  timeoutMs?: number;
  heartbeatMs?: number;
  connectTimeoutMs?: number;
  socketFactory?: () => Socket;
}

function privateIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const octets = address.split(".").map(Number);
  return octets[0] === 10 || octets[0] === 127
    || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

export function validateEspHost(value: string): string {
  const host = value.trim();
  const ipv = isIP(host);
  if (ipv) {
    if (ipv === 4 && privateIpv4(host)) return host;
    throw new Error("ESP_HOST 请填写控制板的局域网 IPv4 地址或局域网主机名。");
  }
  if (host.length > 253 || /^[\d.]+$/.test(host)
    || !host.split(".").every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) {
    throw new Error("ESP_HOST 请只填写控制板的局域网 IP 或主机名，不要包含 http://、端口或路径。");
  }
  return host;
}

export function parseEspTcpPort(value: string | number = DEFAULT_ESP_TCP_PORT): number {
  if ((typeof value === "string" && !/^\d+$/.test(value.trim()))
    || !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error("ESP_TCP_PORT 必须是 1 到 65535 之间的整数，默认 3333。");
  }
  return Number(value);
}

/** Adapts a persistent socket to the exact same HID session used by USB serial. */
class TcpTransport extends EventEmitter implements SerialTransport {
  private socket: Socket | undefined;
  private connected = false;

  constructor(private readonly options: TcpBridgeOptions & { port: number; connectTimeoutMs: number }) { super(); }

  get isOpen(): boolean { return this.connected && Boolean(this.socket?.writable && !this.socket.destroyed); }

  open(callback: (error?: Error | null) => void): void {
    const socket = this.options.socketFactory?.() ?? new Socket();
    this.socket = socket;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(error);
    };
    const timer = setTimeout(() => {
      const error = new Error("连接控制板超时，请检查板子和电脑是否在同一 Wi-Fi，以及 ESP_HOST 地址是否正确。");
      finish(error);
      socket.destroy(error);
    }, this.options.connectTimeoutMs);
    socket.on("data", (data: Buffer) => this.emit("data", data));
    socket.on("error", (error: Error) => { finish(error); this.emit("error", error); });
    socket.on("close", () => {
      this.connected = false;
      finish(new Error("控制板 Wi-Fi 连接已断开，请重新连接后再启用控制。"));
      this.emit("close");
    });
    socket.on("end", () => socket.destroy());
    socket.once("connect", () => {
      this.connected = true;
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 1000);
      finish();
    });
    try {
      socket.connect({ host: this.options.host, port: this.options.port, family: 4, autoSelectFamily: false,
        lookup: (hostname, _options, done) => {
          lookup(hostname, { family: 4 }, (error, address) => {
            if (error) done(error, "", 4);
            else if (!privateIpv4(address)) done(new Error("ESP_HOST 解析到的不是局域网 IPv4 地址，请检查控制板地址。"), "", 4);
            else done(null, address, 4);
          });
        },
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      socket.destroy();
    }
  }

  write(data: string, callback: (error?: Error | null) => void): unknown {
    if (!this.isOpen) { callback(new Error("控制板 Wi-Fi 尚未连接。")); return false; }
    return this.socket!.write(data, "utf8", callback);
  }

  close(callback: (error?: Error | null) => void): void {
    const socket = this.socket;
    this.connected = false;
    if (!socket || socket.closed) { callback(); return; }
    socket.once("close", () => callback());
    socket.destroy();
  }
}

/** Lazy, single-source Wi-Fi HID connection. Never falls back to USB or re-arms. */
export class TcpHidBridge extends SerialHidBridge {
  constructor(options: TcpBridgeOptions) {
    const host = validateEspHost(options.host);
    const port = parseEspTcpPort(options.port);
    const requestedTimeout = options.connectTimeoutMs ?? 3000;
    if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) throw new Error("控制板连接超时必须大于零。");
    const connectTimeoutMs = Math.min(requestedTimeout, (options.timeoutMs ?? 1200) * 3);
    super({ path: `${host}:${port}`,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
      portFactory: () => new TcpTransport({ ...options, host, port, connectTimeoutMs }),
    });
  }
}

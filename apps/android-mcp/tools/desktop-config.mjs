import { isIP } from "node:net";

export const CONFIG_FIELDS = ["ANDROID_SCREEN_URL", "ANDROID_DEVICE_ID", "ESP_HOST", "ESP_PORT", "ESP_TCP_PORT", "ANDROID_MCP_PORT", "ESP_SETUP_URL"];

export function privateIpv4(value) {
  if (typeof value !== "string" || isIP(value) !== 4) return false;
  const octets = value.split(".").map(Number);
  return octets[0] === 10 || octets[0] === 127 || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
}

export function normalizeBoardUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error("设备控制器连接地址无效，请重新自动查找。"); }
  if (url.protocol !== "http:" || !privateIpv4(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("设备控制器连接地址应为内网 HTTP 地址，请重新自动查找。");
  }
  return url.origin;
}

export function normalizeDesktopConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("连接配置格式不正确。");
  let screenUrl = String(value.ANDROID_SCREEN_URL ?? "").trim().replaceAll("：", ":");
  if (screenUrl && !screenUrl.includes("://")) screenUrl = `http://${screenUrl}`;
  let screen;
  try { screen = new URL(screenUrl); } catch { throw new Error("请填写手机投屏 App 显示的地址，例如 192.168.1.20:8791。"); }
  if (!["http:", "https:"].includes(screen.protocol) || screen.username || screen.password || screen.search || screen.hash
    || (screen.pathname !== "/" && screen.pathname !== "")) throw new Error("手机投屏地址应为 HTTP 地址，不含账号、密码或页面路径。");
  const phoneOctets = screen.hostname.split(".").map(Number);
  if (isIP(screen.hostname) !== 4 || !(phoneOctets[0] === 10 || phoneOctets[0] === 127
    || (phoneOctets[0] === 192 && phoneOctets[1] === 168) || (phoneOctets[0] === 172 && phoneOctets[1] >= 16 && phoneOctets[1] <= 31))) {
    throw new Error("手机地址请填写 App 显示的内网 IPv4 地址，例如 192.168.1.20:8791。");
  }
  const espHost = String(value.ESP_HOST ?? "").trim();
  const octets = espHost.split(".").map(Number);
  const privateIp = isIP(espHost) === 4 && (octets[0] === 10 || octets[0] === 127 || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31));
  const hostname = !isIP(espHost) && !/^[\d.]+$/.test(espHost) && espHost.length <= 253
    && espHost.split(".").every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label));
  if (espHost && !privateIp && !hostname) throw new Error("设备控制器 Wi-Fi 地址只填内网 IP 或主机名，端口单独填写。");
  const espPort = String(value.ESP_PORT ?? "COM5").trim().toUpperCase();
  if (!espHost && !/^COM[1-9]\d{0,4}$/.test(espPort)) throw new Error("请选择设备控制器的 USB 串口，例如 COM5。");
  const port = Number(value.ANDROID_MCP_PORT ?? 8790), tcpPort = Number(value.ESP_TCP_PORT ?? 3333);
  if (![port, tcpPort].every((item) => Number.isInteger(item) && item >= 1 && item <= 65535)) throw new Error("端口应为 1 到 65535 之间的整数。");
  const deviceId = String(value.ANDROID_DEVICE_ID ?? "").trim();
  if (deviceId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)) throw new Error("手机设备 ID 格式不正确，请清除旧配置后重新连接。");
  const setupUrl = String(value.ESP_SETUP_URL ?? "").trim();
  return { ANDROID_SCREEN_URL: screen.origin, ANDROID_DEVICE_ID: deviceId, ESP_HOST: espHost,
    ESP_PORT: espPort, ESP_TCP_PORT: String(tcpPort), ANDROID_MCP_PORT: String(port), ESP_SETUP_URL: setupUrl ? normalizeBoardUrl(setupUrl) : "" };
}

export function safeDesktopDefaults(value) {
  return Object.fromEntries(CONFIG_FIELDS.filter((key) => typeof value[key] === "string").map((key) => [key, value[key]]));
}

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SerialPort } from "serialport";

// Optional local USB diagnostics. Normal setup uses the board's own keyboard.
const args = process.argv.slice(2);
const configIndex = args.indexOf("--config");
const path = configIndex >= 0 ? args[configIndex + 1] : fileURLToPath(new URL("../.wifi.local.json", import.meta.url));
let port;
try {
  if (!path) throw new Error("请提供本机配置文件路径。");
  const config = JSON.parse(await readFile(path, "utf8"));
  if (typeof config.port !== "string" || !config.port.trim() ||
      typeof config.ssid !== "string" || typeof config.password !== "string" ||
      config.ssid.includes("\0") || config.password.includes("\0") ||
      Buffer.byteLength(config.ssid) < 1 || Buffer.byteLength(config.ssid) > 32 ||
      !(config.password === "" || Buffer.byteLength(config.password) >= 8 && Buffer.byteLength(config.password) <= 63 || /^[0-9a-fA-F]{64}$/.test(config.password))) {
    throw new Error("请检查 port、网络名称和密码长度。");
  }
  if (args.includes("--check")) {
    process.stdout.write("本机 Wi-Fi 配置格式正确。\n");
    process.exitCode = 0;
  } else {
    port = new SerialPort({ path: config.port, baudRate: 115200, autoOpen: false });
    await new Promise((resolve, reject) => port.open(error => error ? reject(new Error("无法打开数据线连接。请先手动停止占用串口的电脑服务，再重试。")) : resolve()));
    let id = 0;
    let incoming = "";
    let pending;
    port.on("data", data => {
      incoming += data.toString("ascii");
      if (incoming.length > 4096) incoming = incoming.slice(-1024);
      for (;;) {
        const end = incoming.indexOf("\n");
        if (end < 0) break;
        const line = incoming.slice(0, end).replace(/\r$/, "");
        incoming = incoming.slice(end + 1);
        if (!pending || !line.startsWith(`${pending.prefix} ${pending.id} `)) continue;
        const current = pending;
        pending = undefined;
        clearTimeout(current.timer);
        if (line.includes(" ERR ")) current.reject(new Error(line.endsWith("CONTROL_BUSY") ? "电脑正在控制手机。请先暂停并停止当前电脑连接。" : "设备没有接受设置，请检查网络名称与密码后重试。"));
        else current.resolve(line);
      }
    });
    port.on("error", () => {
      if (pending) { clearTimeout(pending.timer); pending.reject(new Error("数据线连接中断。")); pending = undefined; }
    });
    const command = (prefix, operation, value = "") => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending = undefined; reject(new Error("设备没有回应，请检查数据线连接。")); }, 3000);
      pending = { prefix, id: requestId, timer, resolve, reject };
      port.write(`${prefix} ${requestId} ${operation}${value ? ` ${value}` : ""}\n`, error => {
        if (error && pending?.id === requestId) { clearTimeout(timer); pending = undefined; reject(new Error("无法发送设置。")); }
      });
    });
    await command("QDDHID/1", "PING");
    await command("QDDHID/1", "PAUSE");
    await command("QDDNET/1", "WIFI_SSID", Buffer.from(config.ssid).toString("base64"));
    await command("QDDNET/1", "WIFI_PASS", config.password ? Buffer.from(config.password).toString("base64") : "-");
    config.password = "";
    await command("QDDNET/1", "WIFI_SAVE");
    await command("QDDHID/1", "PAUSE");
    process.stdout.write("网络已保存。设备会尝试连接，屏幕显示电脑连接地址；手机操作保持暂停。\n");
  }
} catch (error) {
  // Never print raw parser/driver errors: they may contain file contents or paths.
  process.stderr.write(`${error instanceof Error && /^(请|无法|电脑|设备|数据线)/.test(error.message) ? error.message : "未能完成设置。请检查本机配置文件并重试。"}\n`);
  process.exitCode = 1;
} finally {
  if (port?.isOpen) await new Promise(resolve => port.close(() => resolve()));
}

#!/usr/bin/env node
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { SerialHidBridge } from "../dist/serial.js";

const environmentFile = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(environmentFile)) loadEnvFile(environmentFile);

async function main() {
  const { values } = parseArgs({ options: {
    port: { type: "string" },
    status: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    console.log("node apps/android-mcp/tools/pair.mjs [--port COM_PORT] [--status]\nWithout --status: pause HID and open the local USB pairing window.\nWith --status: read the current pairing-window/passkey state only.\nStop the MCP server first so this helper can open the USB serial port. Pairing PINs are printed only to this local terminal, never stored or exposed as MCP tools.");
    return;
  }
  const port = values.port ?? process.env.ESP_PORT;
  if (!port?.trim()) throw new Error("Set ESP_PORT in apps/android-mcp/.env or pass --port.");
  const bridge = new SerialHidBridge({ path: port });
  try {
    const status = await bridge.request(values.status ? "PAIR_STATUS" : "PAIR");
    console.log(`USB bridge: ${status.name}`);
    console.log(`Pairing window: ${status.pairingOpen === true ? "open" : "closed"}; bonded: ${status.bonded}; BLE connected: ${status.connected}`);
    if (status.pairingOpen === true && status.passkeyVisible === true && Number.isInteger(status.passkey)
      && status.passkey >= 0 && status.passkey <= 999999) {
      console.log(`Local pairing PIN: ${String(status.passkey).padStart(6, "0")}`);
      console.log("Enter this PIN in the Android Bluetooth pairing dialog. Keep it in this trusted local USB session.");
    } else if (status.pairingOpen === true) {
      console.log("Select the Passport keyboard in Android Bluetooth settings. When its pairing dialog appears, run this helper with --status to read the visible PIN.");
    }
    console.log("This helper preserves stored bonds and the physical stop lock. HID remains paused; arm explicitly after pairing.");
  } finally {
    await bridge.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

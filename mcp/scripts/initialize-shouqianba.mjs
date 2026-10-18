import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { NativeCloudClient } from "../sites/shouqianba-console/lib/native-cloud.mjs";
import { CredentialStore } from "../sites/shouqianba-console/lib/credentials.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const stateDir = process.env.SQB_STATE_DIR || path.join(root, ".local/shouqianba");
const configPath = process.env.SQB_CLIENT_CONFIG_PATH || path.join(root, ".local/shouqianba-client-config.json");
try {
  const store = await new CredentialStore({root: stateDir}).init();
  if (store.snapshot().nativeProfile) {
    console.log("Native profile already exists; its credentials and device identity were preserved.");
  } else {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (!config.appId?.trim() || !config.appSecret?.trim() || /replace|placeholder|your[_ -]/i.test(config.appId + config.appSecret)) throw new Error("Missing client configuration");
    const profile = {
      schemaVersion: 1, appId: config.appId, appSecret: config.appSecret, version: config.version,
      commonDeviceModel: config.commonDeviceModel || "1",
      device: {fingerprint: randomUUID(), brand: "Windows", model: "SQB Local Bridge", name: "本机经营台"},
      deviceSource: "local-stable-uuid-fallback", createdAt: new Date().toISOString(),
    };
    new NativeCloudClient({profile});
    await store.update(value => value.nativeProfile ? value : {...value, nativeProfile: profile});
    console.log("Native profile encrypted in credentials.dpapi. Restart this installation, then sign in on its webpage.");
  }
} catch {
  console.error("Native profile was not changed. Fill in your authorized local client parameters and check this Windows user's credential access.");
  process.exitCode = 1;
}

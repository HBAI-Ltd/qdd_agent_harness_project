import path from "node:path";
import { fileURLToPath } from "node:url";
import { access, mkdir, open, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { NativeCloudClient } from "../sites/shouqianba-console/lib/native-cloud.mjs";
import { writeVault } from "../sites/shouqianba-console/lib/vault.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const stateDir = process.env.SQB_STATE_DIR || path.join(root, ".local/shouqianba");
const configPath = process.env.SQB_CLIENT_CONFIG_PATH || path.join(root, ".local/shouqianba-client-config.json");
const profilePath = path.join(stateDir, "native-profile.dpapi");
let lock;
try {
  await mkdir(stateDir, { recursive: true });
  lock = await open(profilePath + ".lock", "wx");
  let exists = false;
  try { await access(profilePath); exists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (exists) {
    console.log("Native profile already exists; its credentials and device identity were preserved.");
  } else {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (!config.appId?.trim() || !config.appSecret?.trim() || /replace|placeholder|your[_ -]/i.test(config.appId + config.appSecret)) {
      throw new Error("Missing client configuration");
    }
    const profile = {
      schemaVersion: 1,
      appId: config.appId,
      appSecret: config.appSecret,
      version: config.version,
      commonDeviceModel: config.commonDeviceModel || "1",
      device: { fingerprint: randomUUID(), brand: "Windows", model: "SQB Local Bridge", name: "本机经营台" },
      deviceSource: "local-stable-uuid-fallback",
      createdAt: new Date().toISOString(),
    };
    new NativeCloudClient({ profile }); // Validate locally; never calls the cloud or sends SMS.
    await writeVault(profilePath, profile);
    console.log("Native profile encrypted for this Windows user. Restart this installation, then sign in on its webpage.");
  }
} catch {
  console.error("Native profile was not changed. Fill in your authorized client parameters in the local configuration, check file permissions, and ensure no initializer is running.");
  process.exitCode = 1;
} finally {
  if (lock) { await lock.close(); await rm(profilePath + ".lock", { force: true }); }
}

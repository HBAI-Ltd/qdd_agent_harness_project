#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { build } from "esbuild";
import { writePortableConfigIfAbsent } from "./desktop-config.mjs";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = resolve(appRoot, "../..");
const output = join(appRoot, "build", "windows");
const require = createRequire(import.meta.url);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function files(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]))).flat();
}
async function run(args) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { cwd: output, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveRun() : reject(new Error(`构建子进程退出：${code}`)));
  });
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "x64" || process.versions.node !== "24.15.0") {
    throw new Error("Windows EXE 请使用 Windows x64 的 Node.js 24.15.0 构建，与 .node-version 保持一致。");
  }
  await mkdir(output, { recursive: true });
  const bindingRoot = dirname(dirname(require.resolve("@serialport/bindings-cpp")));
  const nativePath = join(bindingRoot, "prebuilds", "win32-x64", "@serialport+bindings-cpp.node");
  const sources = [...await files(join(appRoot, "src")), ...await files(join(appRoot, "assets")),
    join(appRoot, "tools", "desktop-entry.mjs"), join(appRoot, "tools", "desktop-config.mjs"), join(appRoot, "tools", "build-exe.mjs"),
    join(appRoot, "tools", "desktop-page.mjs"), join(appRoot, "tools", "desktop-discovery.mjs"),
    join(appRoot, "tools", "desktop-network.mjs"),
    join(appRoot, "package.json"), nativePath, join(repoRoot, "package-lock.json")]
    .filter((path) => !path.includes(".test.") && !path.includes(`${join("src", "fixtures")}`)).sort();
  const sourceManifest = await Promise.all(sources.map(async (path) => ({ path: path.slice(repoRoot.length + 1).replaceAll("\\", "/"), sha256: sha(await readFile(path)) })));
  const buildId = sha(JSON.stringify(sourceManifest)).slice(0, 20);
  const httpSource = await readFile(join(appRoot, "src", "http.ts"), "utf8");
  const versionMatch = /runtimeVersion:\s*(\d+)/.exec(httpSource);
  if (!versionMatch) throw new Error("未找到服务版本，不能生成版本不明确的 EXE。");
  const runtimeVersion = Number(versionMatch[1]);
  const assetNames = (await readdir(join(appRoot, "assets"))).filter((name) => /^[a-z.-]+\.(?:html|css|js)$/.test(name));
  const assets = Object.fromEntries(assetNames.map((name) => [`assets/${name}`, join(appRoot, "assets", name)]));
  const originalHtml = await readFile(assets["assets/operator.html"], "utf8");
  const settingsAnchor = '<div class="card-heading"><h2>连接手机</h2></div>';
  if (!originalHtml.includes(settingsAnchor)) throw new Error("未找到操作台连接设置入口位置。");
  const desktopHtmlPath = join(output, "operator.desktop.html");
  await writeFile(desktopHtmlPath, originalHtml.replace(settingsAnchor,
    '<div class="card-heading"><h2>连接手机</h2><a class="text-button" href="/desktop/settings">连接设置</a></div>'));
  assets["assets/operator.html"] = desktopHtmlPath;
  assets["native/serialport.node"] = nativePath;
  const runtimeManifest = await Promise.all(Object.entries(assets).map(async ([path, source]) => ({ path, sha256: sha(await readFile(source)) })));
  const runtimeManifestPath = join(output, "runtime-manifest.json");
  await writeFile(runtimeManifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`);
  assets["runtime-manifest.json"] = runtimeManifestPath;
  const bundle = join(output, "desktop.cjs");
  await build({ entryPoints: [join(appRoot, "tools", "desktop-entry.mjs")], outfile: bundle,
    bundle: true, platform: "node", target: "node24", format: "cjs", logLevel: "info", legalComments: "inline",
    external: ["bufferutil", "utf-8-validate"],
    define: { "import.meta.url": "globalThis.__QDD_MODULE_URL__", __QDD_BUILD_ID__: JSON.stringify(buildId), __QDD_RUNTIME_VERSION__: String(runtimeVersion) },
    plugins: [{ name: "sea-native-and-build-identity", setup(context) {
      context.onLoad({ filter: /[\\/]@serialport[\\/]bindings-cpp[\\/]dist[\\/]serialport-bindings\.js$/ }, () => ({ loader: "js",
        contents: "const nativeModule={exports:{}};process.dlopen(nativeModule,process.env.QDD_ANDROID_NATIVE_PATH);exports.binding=nativeModule.exports;" }));
      context.onLoad({ filter: /[\\/]android-mcp[\\/]src[\\/]http\.ts$/ }, async (args) => {
        const source = await readFile(args.path, "utf8");
        let contents = source.replace(/name: "qdd-android-hid", runtimeVersion:/g,
          'name: "qdd-android-hid", desktopBuildId: process.env.QDD_ANDROID_BUILD_ID, desktopConfigHash: process.env.QDD_ANDROID_CONFIG_HASH, desktopPid: process.pid, runtimeVersion:');
        if (contents === source) throw new Error("无法在 EXE 健康检查中写入构建身份。");
        const assetGuard = '    const asset = assets[request.url ?? ""];';
        if (!contents.includes(assetGuard)) throw new Error("无法插入 EXE 优雅退出入口。");
        contents = contents.replace(assetGuard, '    if (request.url === "/desktop/quit" && request.method === "POST") { response.writeHead(204); response.end(); setImmediate(() => process.emit("SIGINT")); return; }\n'
          + '    if (request.url === "/desktop/status" && request.method === "GET") { response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": request.headers.origin || `http://${request.headers.host}`, "Vary": "Origin", "Cache-Control": "no-store" }); response.end(JSON.stringify({ desktopConfigHash: process.env.QDD_ANDROID_CONFIG_HASH })); return; }\n'
          + '    if (request.url === "/desktop/settings" || request.url === "/desktop/discover") { await (globalThis as any).__QDD_DESKTOP_SETTINGS__(request, response); return; }\n' + assetGuard);
        return { contents, loader: "ts" };
      });
    } }],
  });
  const blob = join(output, "desktop.blob");
  const seaConfig = join(output, "sea-config.json");
  await writeFile(seaConfig, `${JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true,
    useSnapshot: false, useCodeCache: false, execArgvExtension: "none", assets }, null, 2)}\n`);
  await run(["--experimental-sea-config", seaConfig]);
  const executable = join(output, "设备操作台.exe");
  await copyFile(process.execPath, executable);
  await require("postject").inject(executable, "NODE_SEA_BLOB", await readFile(blob), {
    sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  });
  const configurationPath = join(output, "qdd-android.json");
  try {
    const values = parseEnv(await readFile(join(appRoot, ".env"), "utf8"));
    await writePortableConfigIfAbsent(configurationPath, values);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const localConfiguration = existsSync(configurationPath);
  for (let index = 0; index < sources.length; index++) {
    if (sha(await readFile(sources[index])) !== sourceManifest[index].sha256) throw new Error("源码在打包期间发生变化，请待本轮修改完成后重新打包。");
  }
  const manifest = { buildId, builtAt: new Date().toISOString(), platform: "win32-x64", node: process.versions.node,
    runtimeVersion, executable: "设备操作台.exe", bytes: (await stat(executable)).size,
    sha256: sha(await readFile(executable)), bundleSha256: sha(await readFile(bundle)),
    embeddedAssets: runtimeManifest, localConfiguration, sources: sourceManifest };
  await writeFile(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Windows EXE 已生成：${executable}\nSHA-256：${manifest.sha256}\n大小：${manifest.bytes} 字节；不需要另装 Node.js。`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

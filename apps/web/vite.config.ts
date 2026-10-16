import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";

import AutoImport from "unplugin-auto-import/vite";
import Components from "unplugin-vue-components/vite";
import { ElementPlusResolver } from "unplugin-vue-components/resolvers";

import { webUpdateNotice } from "@plugin-web-update-notification/vite";

const envDir = fileURLToPath(new URL("../..", import.meta.url));
const FRONTEND_PORT = 5177;

function gatewayAddress(): { host?: string; port?: number } {
  try {
    const config: unknown = JSON.parse(readFileSync(new URL("../../harness.config.json", import.meta.url), "utf8"));
    if (!config || typeof config !== "object" || !("gateway" in config)
      || !config.gateway || typeof config.gateway !== "object") return {};
    const gateway = config.gateway;
    return {
      ...("host" in gateway && typeof gateway.host === "string" ? { host: gateway.host } : {}),
      ...("port" in gateway && typeof gateway.port === "number" ? { port: gateway.port } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    // Never include config content: it can contain credentials for other services.
    throw new Error("无法读取 harness.config.json 的网关地址，请检查文件格式。");
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, "");
  const gateway = gatewayAddress();
  const host = env.HOST ?? gateway.host ?? "127.0.0.1";
  const proxyHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const displayHost = proxyHost.includes(":") ? `[${proxyHost}]` : proxyHost;
  let target: string;
  try {
    const url = new URL(env.API_PROXY_TARGET ?? `http://${displayHost}:3000`);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid gateway URL");
    target = url.origin;
  } catch {
    throw new Error("网关代理地址无效，请检查 API_PROXY_TARGET 或 HOST、PORT。");
  }
  const proxy = {
    "/api": {
      target,
      changeOrigin: true,
    },
    "/health": {
      target,
      changeOrigin: true,
    },
  };

  return {
    envDir,
    build: {
      outDir: "dist",
      assetsInlineLimit: Infinity,
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
        },
      },
    },
    plugins: [
      vue({
        template: {
          compilerOptions: {
            isCustomElement: (tag) => tag.startsWith("media-"),
          },
        },
      }),
      AutoImport({
        dts: "src/types/auto-imports.d.ts",
        dtsMode: "overwrite",
        imports: ["vue", "pinia", "vue-router"],
        resolvers: [
          ElementPlusResolver({ importStyle: false }),
        ],
      }),
      Components({
        dts: "src/types/components.d.ts",
        syncMode: "overwrite",

        resolvers: [
          ElementPlusResolver({ importStyle: false }),
        ],
      }),
      webUpdateNotice({
        versionType: "build_timestamp",
        checkInterval: 24 * 60 * 60 * 1000,
        notificationProps: {
          title: "系统更新",
          description: "系统更新啦！ 请您刷新页面体验最新版本以免遇到异常问题！ 如需手动刷新，请使用Ctrl加F5进行刷新",
          buttonText: "立即刷新",
          dismissButtonText: "忽略",
        },
      }),
    ],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      host: "127.0.0.1",
      port: FRONTEND_PORT,
      strictPort: true,
      proxy,
    },
    preview: {
      host: "127.0.0.1",
      port: FRONTEND_PORT,
      strictPort: true,
      proxy,
    },
  };
});

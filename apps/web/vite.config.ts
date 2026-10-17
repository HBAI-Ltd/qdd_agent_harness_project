import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";

import AutoImport from "unplugin-auto-import/vite";
import Components from "unplugin-vue-components/vite";

import { webUpdateNotice } from "@plugin-web-update-notification/vite";
import { resolveGatewayTarget } from "./gateway.config";

const envDir = fileURLToPath(new URL("../..", import.meta.url));
const FRONTEND_PORT = 5177;

function gatewayAddress(): { host?: string; port?: number } {
  try {
    const config: unknown = JSON.parse(readFileSync(new URL("../../harness.config.json", import.meta.url), "utf8"));
    if (!config || typeof config !== "object" || !("gateway" in config) || !config.gateway || typeof config.gateway !== "object") return {};
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

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, envDir, "");
  const gateway = gatewayAddress();
  const target = resolveGatewayTarget(env, gateway);
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

  // 本地开发：用 .env 中的网关地址与 token 预填连接，免去每次手动输入；生产构建不注入 token。
  const devGateway = command === "serve" ? { url: target, token: env.QDD_GATEWAY_TOKEN ?? "" } : { url: "", token: "" };

  return {
    envDir,
    // 公开网关地址始终注入；开发预填的 token 只在 vite serve 时注入，生产构建为空。
    define: {
      __QDD_GATEWAY_URL__: JSON.stringify(target),
      __DEV_GATEWAY_URL__: JSON.stringify(devGateway.url),
      __DEV_GATEWAY_TOKEN__: JSON.stringify(devGateway.token),
    },
    build: {
      outDir: "dist",
      assetsInlineLimit: Infinity,
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
      }),
      Components({
        dts: "src/types/components.d.ts",
        syncMode: "overwrite",
      }),
      ...(command === "build"
        ? [
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
          ]
        : []),
    ],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      host: "0.0.0.0",
      port: FRONTEND_PORT,
      strictPort: true,
      proxy,
      warmup: {
        // Transform the default screen before the browser requests its modules.
        clientFiles: ["./src/main.ts", "./src/page/layout/index.vue", "./src/views/chat/index.vue"],
      },
    },
    preview: {
      host: "0.0.0.0",
      port: FRONTEND_PORT,
      strictPort: true,
      proxy,
    },
  };
});

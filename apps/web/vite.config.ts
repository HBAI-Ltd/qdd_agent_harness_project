import { fileURLToPath, URL } from "node:url";

import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";

import AutoImport from "unplugin-auto-import/vite";
import Components from "unplugin-vue-components/vite";
import { TDesignResolver } from "@tdesign-vue-next/auto-import-resolver";

import { webUpdateNotice } from "@plugin-web-update-notification/vite";

const envDir = fileURLToPath(new URL("../..", import.meta.url));
const FRONTEND_PORT = 5177;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, "");
  const host = env.HOST ?? "127.0.0.1";
  const proxyHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const displayHost = proxyHost.includes(":") ? `[${proxyHost}]` : proxyHost;
  // TODO: 接入业务后端时确认代理地址；生产环境需要单独配置 /api 反向代理。
  const target = env.API_PROXY_TARGET ?? `http://${displayHost}:${env.PORT ?? "3000"}`;
  const proxy = {
    "/api": {
      target,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/api(?=\/|$)/, ""),
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
        imports: ["vue", "pinia", "vue-router"],
        resolvers: [
          TDesignResolver({
            library: "vue-next",
          }),
        ],
      }),
      Components({
        dts: "src/types/components.d.ts",

        resolvers: [
          TDesignResolver({
            library: "vue-next",
          }),
        ],
      }),
      webUpdateNotice({
        versionType: "build_timestamp",
        checkInterval: 24 * 60 * 60 * 1000,
        notificationProps: {
          title: "📢 系统更新",
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

<script setup lang="ts">
import { createVNode, defineComponent } from "vue";
import { ElConfigProvider } from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";

try {
  const saved: unknown = JSON.parse(localStorage.getItem("harness-preferences-v1") || "null");
  if (saved && typeof saved === "object" && "theme" in saved && (saved.theme === "light" || saved.theme === "dark")) {
    document.documentElement.dataset.theme = saved.theme;
    document.documentElement.classList.toggle("dark", saved.theme === "dark");
  }
} catch {
  // Keep the system theme when browser storage is unavailable.
}

// The vendor's locale prop declaration does not support exactOptionalPropertyTypes.
// Keep the fixed, typed locale at this boundary without weakening project checks.
const LocalizedConfigProvider = defineComponent({
  name: "LocalizedConfigProvider",
  setup(_props, { slots }) {
    return () => createVNode(ElConfigProvider, { locale: zhCn }, slots);
  },
});
</script>

<template>
  <LocalizedConfigProvider>
    <router-view />
  </LocalizedConfigProvider>
</template>

<style>
:root {
  --bg-color-page: var(--qdd-bg);
  --bg-color-container: var(--qdd-surface);
  --bg-color-container-hover: var(--qdd-hover);
  --bg-color-container-active: var(--qdd-primary-soft);
  --border-color: var(--qdd-border);
  --text-color-primary: var(--qdd-text);
  --text-color-secondary: var(--qdd-muted);
  --text-color-placeholder: var(--qdd-muted);
}
</style>

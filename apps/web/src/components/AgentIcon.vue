<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 });

const paths: Record<string, string> = {
  plus: "M12 5v14M5 12h14",
  refresh: "M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2l1 4M18 18a8 8 0 0 1-13-2l-1-4",
  chat: "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5A8.5 8.5 0 0 1 10.5 3h2a8.5 8.5 0 0 1 8.5 8.5Z M7 9h10M7 13h7",
  settings: "M9 3h6l.7 3 2.6 1.5 2.9-.9 3 5.2-2.2 2.1v3l2.2 2.1-3 5.2-2.9-.9-2.6 1.5-.7 3H9l-.7-3-2.6-1.5-2.9.9-3-5.2L2 13.9v-3L-.2 8.8l3-5.2 2.9.9L8.3 3Z",
  sliders: "M4 7h7m4 0h5M4 17h3m4 0h9M11 4v6M7 14v6",
  search: "M21 21l-5-5M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z",
  arrow: "M12 19V5m-6 6 6-6 6 6",
  chevron: "m9 5 7 7-7 7",
  down: "m6 9 6 6 6-6",
  panel: "M3 4h18v16H3ZM9 4v16",
  spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 2v4m-2-2h4",
  code: "m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16",
  tool: "m14 6 4 4 3-3a6 6 0 0 1-8 8l-6 6a2.1 2.1 0 0 1-3-3l6-6a6 6 0 0 1 8-8Z",
  thinking: "M9 18h6m-5 3h4M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 4H9c0-2 0-3-1-4Z",
  pen: "m15 4 5 5M4 20l5-1L21 7l-5-5L4 14Z",
  shop: "M3 10v11h18V10M2 10l2-7h16l2 7M2 10c1 3 4 3 5 0 1 3 4 3 5 0 1 3 4 3 5 0 1 3 4 3 5 0M9 21v-7h6v7",
  plan: "M5 3h14v18H5ZM9 7h6M9 12h6M9 17h4",
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  edit: "m14 5 5 5M3 21l6-2L21 7l-5-5L4 14ZM13 21h8",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
  close: "m6 6 12 12M6 18 18 6",
  check: "m5 12 4 4L19 6",
  copy: "M8 8h13v13H8ZM16 8V3H3v13h5",
  sun: "M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  moon: "M20 15A9 9 0 0 1 9 3a9 9 0 1 0 11 12Z",
  stop: "M6 6h12v12H6Z",
  folder: "M3 6h7l2 3h9v12H3ZM3 6V3h7l2 3h7v3",
};
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path :d="paths[name] || paths.spark" />
  </svg>
</template>

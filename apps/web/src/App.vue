<template>
  <t-config-provider>
    <router-view />
  </t-config-provider>
</template>

<style lang="scss">
html[theme-mode="dark"] {
  --bg-color-page: #181818;
  --bg-color-container: #242424;
  --bg-color-container-hover: #2c2c2c;
  --bg-color-container-active: #333;
  --border-color: #383838;
  --text-color-primary: rgba(255, 255, 255, 0.9);
  --text-color-secondary: rgba(255, 255, 255, 0.6);
  --text-color-placeholder: rgba(255, 255, 255, 0.35);
}
</style>

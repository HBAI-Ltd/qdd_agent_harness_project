import { createApp } from "vue";
import { createPinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";

import "./assets/main.scss";

import App from "./App.vue";
import router from "./router";

import { LoadingDirective, LoadingPlugin } from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";
import "@/utils/global";

const app = createApp(App);
app.use(createPinia().use(piniaPluginPersistedstate));
app.use(router);
app.use(LoadingPlugin);
app.directive("loading", LoadingDirective);
app.mount("#app");

import { createRouter, createWebHistory } from "vue-router";
const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/:catchAll(.*)",
      name: "404",
      component: () => import("@/pages/error/404.vue"),
    },
    {
      path: "/",
      name: "chat",
      component: () => import("@/pages/chat/index.vue"),
    },
    {
      path: "/test",
      component: () => import("@/pages/test/index.vue"),
    },
  ],
});
export default router;

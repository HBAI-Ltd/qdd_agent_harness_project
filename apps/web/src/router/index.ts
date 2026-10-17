import { createRouter, createWebHistory } from "vue-router";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      component: () => import("@/page/layout/index.vue"),
      children: [
        { path: "", redirect: { name: "chat" } },
        { path: "chat", name: "chat", component: () => import("@/views/chat/index.vue") },
        { path: "overview", name: "overview", component: () => import("@/views/overview/index.vue") },
        { path: "tasks/:slug?", name: "tasks", component: () => import("@/views/tasks/index.vue") },
        { path: "settings", name: "settings", component: () => import("@/views/settings/index.vue") },
        { path: "schedules", name: "schedules", component: () => import("@/views/schedules/index.vue") },
        { path: "skills", name: "skills", component: () => import("@/views/skills/index.vue") },
        { path: "connectors", name: "connectors", component: () => import("@/views/connectors/index.vue") },
      ],
    },
    {
      path: "/test",
      component: () => import("@/views/test/index.vue"),
    },
    {
      path: "/:catchAll(.*)",
      name: "404",
      component: () => import("@/views/error/404.vue"),
    },
  ],
});
export default router;

<script setup lang="ts">
import StoreOverview from "@/components/StoreOverview.vue";
import DashboardPending from "@/components/DashboardPending.vue";
import { ElAlert } from "element-plus/es/components/alert/index";
import { useWorkspaceContext } from "@/composables/workspaceContext";

const { workspace, overview, navigation } = useWorkspaceContext();
const { activeSession, sessions, pages, connected, loadingSessions, loadingPages } = workspace;
const { openConversation, newConversation, openSession, openPage, editPage, openView } = navigation;
</script>

<template>
  <ElAlert v-if="overview.error.value" :title="overview.error.value" type="error" show-icon :closable="false" />
  <StoreOverview
    :active-session="activeSession"
    :sessions="sessions"
    :pages="pages"
    :connected="connected"
    :loading="loadingSessions || loadingPages || overview.loading.value"
    :overview="overview.data.value"
    @open-conversation="openConversation"
    @new-conversation="newConversation"
    @open-session="openSession"
    @open-settings="openView('settings')"
    @open-tasks="openView('tasks')"
    @open-page="openPage"
    @revise-page="editPage"><template #pending><DashboardPending /></template></StoreOverview>
</template>

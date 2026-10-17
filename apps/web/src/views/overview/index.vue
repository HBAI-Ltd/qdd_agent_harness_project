<script setup lang="ts">
import StoreOverview from "@/components/StoreOverview.vue";
import { useWorkspaceContext } from "@/composables/workspaceContext";

const { workspace, navigation } = useWorkspaceContext();
const { activeSession, sessions, pages, connected, loadingSessions, loadingPages } = workspace;
const { openConversation, newConversation, openSession, openPage, editPage, openView } = navigation;
</script>

<template>
  <StoreOverview
    :active-session="activeSession"
    :sessions="sessions"
    :pages="pages"
    :connected="connected"
    :loading="loadingSessions || loadingPages"
    @open-conversation="openConversation"
    @new-conversation="newConversation"
    @open-session="openSession"
    @open-settings="openView('settings')"
    @open-tasks="openView('tasks')"
    @open-page="openPage"
    @revise-page="editPage" />
</template>

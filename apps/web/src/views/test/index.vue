<template>
  <main class="connectionPage">
    <el-card shadow="never">
      <template #header>钱多多门店助手</template>
      <p>检查门店助手服务的连接状态。</p>
      <p role="status" aria-live="polite">{{ statusMessage }}</p>
      <p v-if="health">网关状态：{{ health.status }}</p>
      <el-button type="primary" :loading="loading" @click="checkHealth">重新检查</el-button>
    </el-card>
  </main>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { getHealth, type HealthResponse } from "@/api/health";

const health = ref<HealthResponse | null>(null);
const loading = ref(false);
const statusMessage = ref("正在连接服务…");

async function checkHealth() {
  if (loading.value) return;
  loading.value = true;
  health.value = null;
  statusMessage.value = "正在连接服务…";

  try {
    const result = await getHealth();
    if (result.status !== "ok") {
      throw new Error("Unexpected health status");
    }
    health.value = result;
    statusMessage.value = "服务连接正常";
  } catch {
    statusMessage.value = "服务连接失败，请稍后重试。";
  } finally {
    loading.value = false;
  }
}

onMounted(checkHealth);
</script>

<style lang="scss" scoped>
.connectionPage {
  min-height: 100%;
  padding: 32px;
  background: var(--qdd-bg);
  color: var(--qdd-text);
  font-family: var(--qdd-font);

  .el-card {
    max-width: 720px;
    margin: 0 auto;
    border-color: var(--qdd-border);
    border-radius: var(--qdd-radius);
    background: var(--qdd-surface);
    color: var(--qdd-text);
  }
}
</style>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { ElAlert, ElButton, ElEmpty, ElSkeleton, ElTag } from "element-plus";
import type { ClarifyAnswers, PendingItem, SessionEvent } from "@qdd/shared";
import SessionActions from "./SessionActions.vue";
import { answerQuestions, resolveApproval } from "@/api/workspace";
import { useWorkspaceContext } from "@/composables/workspaceContext";

const { workspace, pending, overview, navigation, notify } = useWorkspaceContext();
const { data, loading, error, refresh } = pending;
const busy = ref(new Set<string>());
const actionErrors = ref<Record<string, string>>({});
const requests = new Set<AbortController>();
let disposed = false;

function eventsFor(item: PendingItem): SessionEvent[] {
  return item.kind === "question"
    ? [{ type: "question_required", at: item.createdAt, requestId: item.requestId, round: 0, questions: item.questions }]
    : [{ type: "approval_required", at: item.createdAt, requestId: item.requestId, tool: item.tool, source: item.source, args: item.args }];
}
function deadline(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function stopRequests() {
  for (const request of requests) request.abort();
  requests.clear();
  busy.value.clear();
  actionErrors.value = {};
}
watch([workspace.gatewayUrl, workspace.token, workspace.connected], stopRequests, { flush: "sync" });
onBeforeUnmount(() => { disposed = true; stopRequests(); });

async function submit(item: PendingItem, decision: ClarifyAnswers | boolean) {
  const key = `${item.sessionId}:${item.requestId}`;
  if (!workspace.connected.value || busy.value.has(key)) return;
  const request = new AbortController();
  requests.add(request);
  busy.value.add(key);
  delete actionErrors.value[key];
  const base = workspace.gatewayUrl.value;
  const token = workspace.token.value;
  try {
    if (typeof decision === "boolean") await resolveApproval(base, token, item.sessionId, item.requestId, decision, request.signal);
    else await answerQuestions(base, token, item.sessionId, item.requestId, decision, request.signal);
    if (request.signal.aborted || disposed) return;
    notify(typeof decision === "boolean" ? decision ? "已授权，助手将继续执行" : "已拒绝该操作" : "已提交回答");
    await Promise.all([refresh(), overview.refresh()]);
  } catch (cause) {
    if (!request.signal.aborted && !disposed) {
      actionErrors.value[key] = cause instanceof Error ? cause.message : "提交失败，请重试。";
      void refresh();
    }
  } finally {
    requests.delete(request);
    if (!request.signal.aborted) busy.value.delete(key);
  }
}
</script>

<template>
  <section class="dashboard-pending" aria-labelledby="pending-confirmations-title" :aria-busy="loading">
    <header class="pending-heading"><div><h2 id="pending-confirmations-title">待处理确认 <ElTag type="warning" size="small" effect="plain" round>{{ data?.length ?? 0 }}</ElTag></h2><p>统一处理对话和定时任务中的问题与授权。</p></div><ElButton :disabled="!workspace.connected.value" :loading="loading" @click="refresh">刷新</ElButton></header>
    <ElAlert v-if="error" :title="error" type="error" show-icon :closable="false" />
    <ElSkeleton v-if="loading && !data" :rows="3" animated />
    <ElEmpty v-else-if="data && !data.length" :image-size="58" description="当前没有需要你确认的事项" />
    <article v-for="item in data ?? []" :key="`${item.sessionId}:${item.requestId}`" class="pending-item">
      <div class="pending-meta"><ElButton link type="primary" @click="navigation.openSession(item.sessionId)">{{ item.sessionTitle || '未命名对话' }}</ElButton><ElTag v-if="item.origin" type="info" size="small" effect="plain">定时任务：{{ item.origin.scheduleName }}</ElTag><time :datetime="item.expiresAt">{{ deadline(item.expiresAt) }} 前处理</time></div>
      <SessionActions :session-id="item.sessionId" :events="eventsFor(item)" status="waiting" :busy="busy.has(`${item.sessionId}:${item.requestId}`)" @answer="(_id, answers) => submit(item, answers)" @approve="(_id, approved) => submit(item, approved)" />
      <ElAlert v-if="actionErrors[`${item.sessionId}:${item.requestId}`]" :title="actionErrors[`${item.sessionId}:${item.requestId}`] ?? ''" type="error" show-icon :closable="false" />
    </article>
  </section>
</template>

<style scoped>
.pending-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.pending-heading h2 { display: flex; align-items: center; gap: 8px; font-size: 17px; margin: 0; }
.pending-heading p { color: var(--qdd-muted); font-size: 12px; margin: 7px 0 0; }
.pending-item + .pending-item { margin-top: 24px; }
.pending-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin: 0 0 12px 49px; }
.pending-meta time { color: var(--qdd-muted); font-size: 11px; margin-left: auto; }
.pending-item > .el-alert { margin-top: 12px; }
@media (max-width: 760px) { .pending-meta { margin-left: 0; } .pending-meta time { margin-left: 0; } }
</style>

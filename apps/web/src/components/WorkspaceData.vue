<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ElAlert } from "element-plus/es/components/alert/index";
import { ElButton } from "element-plus/es/components/button/index";
import { ElCard } from "element-plus/es/components/card/index";
import { ElEmpty } from "element-plus/es/components/empty/index";
import { ElSkeleton } from "element-plus/es/components/skeleton/index";
import { ElTag } from "element-plus/es/components/tag/index";
import type { DatasetManifest, MetricCatalog, MetricDef } from "@qdd/shared";
import { getMetrics, listDatasets, refreshDatasets, type DatasetRefreshResult } from "@/api/datasets";

const props = defineProps<{ connected: boolean; gatewayUrl: string; token: string }>();
const datasets = ref<DatasetManifest[]>();
const metrics = ref<MetricCatalog>();
const loading = ref(false);
const datasetError = ref("");
const metricError = ref("");
const refreshing = ref<string | null>(null);
const refreshError = ref("");
const results = ref<DatasetRefreshResult[]>();
const refreshable = computed(() => datasets.value?.filter((dataset) => dataset.source) ?? []);
const failures = computed(() => results.value?.filter((result) => result.error !== undefined).length ?? 0);
const resultNotice = computed(() => {
  if (!results.value) return "";
  if (!results.value.length) return "本次没有可刷新的来源，无需增量刷新。";
  if (failures.value) return `${results.value.length - failures.value} 个数据集刷新完成，${failures.value} 个失败，请查看各项结果。`;
  return `${results.value.length} 个数据集刷新完成。`;
});
const datasetKinds = { fact: "业务记录", dimension: "基础资料", event_log: "变更记录", record: "登记记录" };
const metricTypes = { flow: "可加总指标", stock: "期末存量", ratio: "比率", state: "状态" };
const aggregateLabels = { sum: "求和", count: "计数", count_distinct: "去重计数", avg: "平均值", min: "最小值", max: "最大值", last: "期末值", first: "期初值" };
let loadController: AbortController | undefined;
let refreshController: AbortController | undefined;
let version = 0;
let disposed = false;

function requestError(cause: unknown): string {
  return cause instanceof TypeError ? "无法连接网关，请检查连接后重试。" : cause instanceof Error ? cause.message : "读取数据失败，请重试。";
}
function displayDate(value: string | null): string {
  if (!value) return "尚无数据时间";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}
function metricRule(definition: MetricDef): string {
  if (definition.type === "ratio") {
    const label = (name: string | undefined) => name ? metrics.value?.[name]?.label ?? name : "未定义";
    return `${label(definition.numerator)} ÷ ${label(definition.denominator)}（先汇总，再计算）`;
  }
  if (definition.type === "state") return `按状态区间统计 · 字段 ${definition.field ?? "未定义"}`;
  const aggregate = aggregateLabels[definition.agg ?? (definition.type === "stock" ? "last" : "sum")];
  return `${definition.field ?? "未定义字段"} · ${aggregate}${definition.entity ? ` · 按 ${definition.entity} 分别取值后汇总` : ""}`;
}
function stopRequests() {
  version++;
  loadController?.abort();
  refreshController?.abort();
  loadController = undefined;
  refreshController = undefined;
  loading.value = false;
  refreshing.value = null;
}
async function load() {
  if (!props.connected || disposed) return;
  loadController?.abort();
  const controller = new AbortController();
  loadController = controller;
  const currentVersion = version;
  loading.value = true;
  datasetError.value = "";
  metricError.value = "";
  const responses = await Promise.allSettled([
    listDatasets(props.gatewayUrl, props.token, controller.signal),
    getMetrics(props.gatewayUrl, props.token, controller.signal),
  ]);
  if (controller.signal.aborted || disposed || version !== currentVersion || loadController !== controller) return;
  const [datasetResponse, metricResponse] = responses;
  if (datasetResponse.status === "fulfilled") datasets.value = datasetResponse.value;
  else datasetError.value = requestError(datasetResponse.reason);
  if (metricResponse.status === "fulfilled") metrics.value = metricResponse.value;
  else metricError.value = requestError(metricResponse.reason);
  loading.value = false;
}
async function refresh(name?: string) {
  if (!props.connected || disposed || loading.value || refreshing.value !== null) return;
  if (name ? !refreshable.value.some((dataset) => dataset.name === name) : !refreshable.value.length) return;
  const controller = new AbortController();
  refreshController = controller;
  const currentVersion = version;
  refreshing.value = name ?? "";
  refreshError.value = "";
  results.value = undefined;
  try {
    const response = await refreshDatasets(props.gatewayUrl, props.token, name ? [name] : undefined, controller.signal);
    if (controller.signal.aborted || disposed || version !== currentVersion) return;
    results.value = response;
    await load();
  } catch (cause) {
    if (!controller.signal.aborted && !disposed && version === currentVersion) refreshError.value = requestError(cause);
  } finally {
    if (refreshController === controller) {
      refreshController = undefined;
      refreshing.value = null;
    }
  }
}
watch(() => [props.connected, props.gatewayUrl, props.token], () => {
  stopRequests();
  datasets.value = undefined;
  metrics.value = undefined;
  results.value = undefined;
  datasetError.value = "";
  metricError.value = "";
  refreshError.value = "";
  if (props.connected) void load();
}, { immediate: true, flush: "sync" });
onBeforeUnmount(() => { disposed = true; stopRequests(); });
defineExpose({ refresh: load });
</script>

<template>
  <ElCard class="workspace-data" shadow="never">
    <template #header>
      <div class="data-heading"><div><h2>数据与指标</h2><p>检查数据更新时间与统一的指标口径。</p></div><ElButton :disabled="!connected || refreshing !== null" :loading="loading" @click="load">重新读取</ElButton></div>
    </template>
    <ElAlert v-if="!connected" title="连接网关后，查看数据集与指标口径。" type="info" show-icon :closable="false" />
    <template v-else>
      <section class="data-section" aria-labelledby="settings-datasets-title" :aria-busy="loading || refreshing !== null">
        <div class="data-heading"><div><h3 id="settings-datasets-title">数据集 <span v-if="datasets">{{ datasets.length }}</span></h3><p>增量刷新按来源水位线取数，已有相同主键的数据会更新。</p></div><ElButton type="primary" plain :disabled="loading || refreshing !== null || !refreshable.length" :loading="refreshing === ''" @click="refresh()">刷新全部来源</ElButton></div>
        <ElAlert v-if="datasetError" :title="datasetError" type="error" show-icon :closable="false" />
        <ElAlert v-if="refreshError" :title="refreshError" type="error" show-icon :closable="false" />
        <div v-if="results" class="refresh-results" aria-live="polite">
          <ElAlert :title="resultNotice" :type="failures ? 'warning' : results.length ? 'success' : 'info'" show-icon :closable="false" />
          <ul v-if="results.length"><li v-for="result in results" :key="result.dataset" :class="{ 'result-error': result.error !== undefined }"><strong>{{ result.dataset }}</strong><span>{{ result.error !== undefined ? `刷新失败：${result.error}` : `处理 ${result.added} 行 · 版本 ${result.version}` }}</span><small>数据截至：{{ displayDate(result.watermark) }}</small></li></ul>
        </div>
        <ElSkeleton v-if="loading && !datasets" :rows="4" animated />
        <ElEmpty v-else-if="datasets && !datasets.length" description="尚无数据集" :image-size="55" />
        <div v-if="datasets?.length" class="dataset-list">
          <article v-for="dataset in datasets" :key="dataset.name" class="dataset-item">
            <div class="data-heading"><div><h4>{{ dataset.name }}<ElTag type="info" size="small" effect="plain">{{ datasetKinds[dataset.kind] }}</ElTag></h4><p v-if="dataset.description">{{ dataset.description }}</p></div><ElButton size="small" :disabled="!dataset.source || loading || refreshing !== null" :loading="refreshing === dataset.name" :aria-label="`刷新数据集 ${dataset.name}`" @click="refresh(dataset.name)">增量刷新</ElButton></div>
            <dl><div><dt>行数</dt><dd>{{ dataset.rowCount.toLocaleString('zh-CN') }}</dd></div><div><dt>版本</dt><dd>{{ dataset.version }}</dd></div><div><dt>数据截至</dt><dd>{{ displayDate(dataset.watermark) }}</dd></div><div><dt>最近更新</dt><dd>{{ displayDate(dataset.updatedAt) }}</dd></div><div class="dataset-source"><dt>来源</dt><dd>{{ dataset.source?.tool || "本地数据（未配置增量来源）" }}<span v-if="dataset.source?.sinceArg"> · 增量参数 {{ dataset.source.sinceArg }}</span></dd></div></dl>
          </article>
        </div>
      </section>
      <section class="data-section metrics-section" aria-labelledby="settings-metrics-title" :aria-busy="loading">
        <div class="data-heading"><div><h3 id="settings-metrics-title">指标口径 <span v-if="metrics">{{ Object.keys(metrics).length }}</span></h3><p>所有页面共用这份定义；需要修改时，可在对话中提出并确认。</p></div></div>
        <ElAlert v-if="metricError" :title="metricError" type="error" show-icon :closable="false" />
        <ElSkeleton v-if="loading && !metrics" :rows="3" animated />
        <ElEmpty v-else-if="metrics && !Object.keys(metrics).length" description="尚无指标定义" :image-size="55" />
        <div v-if="metrics && Object.keys(metrics).length" class="metrics-table-wrap"><table class="metrics-table"><caption class="visually-hidden">当前工作空间的指标口径</caption><thead><tr><th scope="col">指标</th><th scope="col">类型</th><th scope="col">计算口径</th><th scope="col">展示</th></tr></thead><tbody><tr v-for="(definition, name) in metrics" :key="name"><th scope="row">{{ definition.label }}<small>{{ name }}</small></th><td>{{ metricTypes[definition.type] }}</td><td>{{ metricRule(definition) }}<small v-if="definition.description">{{ definition.description }}</small></td><td>{{ definition.unit || '无单位' }}<small v-if="definition.digits !== undefined">{{ definition.digits }} 位小数</small></td></tr></tbody></table></div>
      </section>
    </template>
  </ElCard>
</template>

<style scoped>
.workspace-data { min-width:0; border-radius:var(--qdd-radius); }
.data-heading { display:flex; align-items:flex-start; justify-content:space-between; flex-wrap:wrap; gap:12px; }
.data-heading > div { min-width:0; }
.data-heading h2 { margin:0 0 4px; font-size:16px; }
.data-heading h3 { margin:0 0 5px; font-size:15px; }
.data-heading h3 span { color:var(--qdd-muted); font-size:12px; font-weight:400; margin-left:5px; }
.data-heading p { margin:0; color:var(--qdd-muted); font-size:12px; line-height:1.7; overflow-wrap:anywhere; }
.data-heading :deep(.el-button) { flex-shrink:0; }
.data-section > .data-heading { margin-bottom:16px; }
.data-section :deep(.el-alert) { margin-bottom:14px; }
.dataset-list { display:grid; gap:14px; }
.dataset-item { min-width:0; padding:16px; border:1px solid var(--qdd-border); border-radius:8px; background:var(--qdd-bg); }
.dataset-item h4 { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin:0 0 5px; font-size:13px; overflow-wrap:anywhere; }
.dataset-item dl { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px 20px; margin:15px 0 0; font-size:12px; }
.dataset-item dt { color:var(--qdd-muted); margin-bottom:5px; }
.dataset-item dd { margin:0; line-height:1.6; overflow-wrap:anywhere; }
.dataset-source { grid-column:1 / -1; }
.refresh-results ul { padding:0; list-style:none; margin:0 0 18px; font-size:12px; }
.refresh-results li { display:grid; gap:4px; padding:10px 0; border-bottom:1px solid var(--qdd-border); overflow-wrap:anywhere; }
.refresh-results small { color:var(--qdd-muted); }
.result-error { color:var(--qdd-bad); }
.metrics-section { margin-top:26px; padding-top:22px; border-top:1px solid var(--qdd-border); }
.metrics-table-wrap { max-width:100%; overflow:auto; }
.metrics-table { width:100%; border-collapse:collapse; text-align:left; font-size:12px; }
.metrics-table th, .metrics-table td { padding:12px 9px; border-bottom:1px solid var(--qdd-border); vertical-align:top; line-height:1.7; overflow-wrap:anywhere; }
.metrics-table thead { color:var(--qdd-muted); }
.metrics-table tbody th { min-width:90px; font-weight:550; }
.metrics-table td:nth-child(2) { min-width:70px; }
.metrics-table td:nth-child(3) { min-width:180px; }
.metrics-table td:last-child { min-width:65px; }
.metrics-table small { display:block; margin-top:3px; color:var(--qdd-muted); font-weight:400; }
.visually-hidden { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
@media (max-width:600px) { .dataset-item dl { grid-template-columns:minmax(0,1fr); } }
</style>

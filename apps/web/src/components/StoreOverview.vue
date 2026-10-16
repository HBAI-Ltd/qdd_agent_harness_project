<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { PageView, SessionMeta, SessionStatus } from "@qdd/shared";
import AgentIcon from "./AgentIcon.vue";

const props = defineProps<{
  sessions: SessionMeta[];
  pages: PageView[];
  connected: boolean;
  loading: boolean;
}>();

const emit = defineEmits<{
  startConversation: [];
  openSettings: [];
  openPage: [slug: string];
  revisePage: [slug: string];
}>();

interface ChartInstance {
  setOption: (option: Record<string, unknown>, replace?: boolean) => void;
  resize: () => void;
  dispose: () => void;
}
interface ChartLibrary {
  init: (element: HTMLElement, theme?: string, options?: { renderer: string }) => ChartInstance;
}

const rootElement = ref<HTMLElement>();
const activityElement = ref<HTMLElement>();
const statusElement = ref<HTMLElement>();
const chartState = ref<"loading" | "ready" | "failed">("loading");
const today = ref(new Date());
const numberFormat = new Intl.NumberFormat("zh-CN");
const dateFormat = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
const timeFormat = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const statusLabels: Record<SessionStatus, string> = {
  running: "正在执行", waiting: "等待确认", idle: "已就绪", error: "执行失败",
};
const statuses: SessionStatus[] = ["running", "waiting", "idle", "error"];
const hasData = computed(() => props.connected && !props.loading);
const statusCounts = computed(() => statuses.map((status) => ({
  status, name: statusLabels[status], value: props.sessions.filter((session) => session.status === status).length,
})));
const runningCount = computed(() => props.sessions.filter((session) => session.status === "running").length);
const waitingCount = computed(() => props.sessions.filter((session) => session.status === "waiting").length);
const recentPages = computed(() => [...props.pages]
  .sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt)).slice(0, 6));
const days = computed(() => Array.from({ length: 7 }, (_, index) => {
  const date = new Date(today.value);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - 6 + index);
  return { date, key: dateKey(date), label: `${date.getMonth() + 1}/${date.getDate()}` };
}));
const activity = computed(() => days.value.map((day) => ({
  ...day,
  count: props.sessions.filter((session) => dateKey(new Date(session.createdAt)) === day.key).length,
})));
const activityTotal = computed(() => activity.value.reduce((total, day) => total + day.count, 0));
const conclusion = computed(() => {
  if (!props.connected) return "连接网关后，即可查看对话进展与已发布的经营页面。";
  if (props.loading) return "正在同步工作空间数据，请稍候。";
  if (waitingCount.value > 0) return `有 ${formatCount(waitingCount.value)} 个对话等待确认，处理后即可继续推进。`;
  if (runningCount.value > 0) return `有 ${formatCount(runningCount.value)} 个对话正在执行，经营分析正在推进。`;
  if (props.pages.length > 0) return `已发布 ${formatCount(props.pages.length)} 个页面，可随时查看数据或继续完善分析。`;
  return "从一个经营问题开始，把真实门店数据变成可用的分析页面。";
});
const kpis = computed(() => [
  { label: "对话总数", value: props.sessions.length, hint: "当前工作空间", icon: "chat", tone: "default" },
  { label: "已发布页面", value: props.pages.length, hint: "可查看与继续修改", icon: "plan", tone: "default" },
  { label: "正在执行", value: runningCount.value, hint: "实时会话状态", icon: "refresh", tone: "primary" },
  { label: "等待确认", value: waitingCount.value, hint: "需要回答问题或授权", icon: "clock", tone: "warn" },
]);
const chartSummary = computed(() => activity.value.map((day) => `${day.label}：${formatCount(day.count)} 个`).join("；"));
let chartLibrary: ChartLibrary | undefined;
let activityChart: ChartInstance | undefined;
let statusChart: ChartInstance | undefined;
let resizeObserver: ResizeObserver | undefined;
let themeObserver: MutationObserver | undefined;
let themeQuery: MediaQueryList | undefined;
let clockTimer: ReturnType<typeof setInterval> | undefined;
let frame: number | undefined;
let disposed = false;
let loadAttempt = 0;
let cancelPendingLoad: (() => void) | undefined;

function formatCount(value: number) { return numberFormat.format(value); }
function timestamp(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function dateKey(date: Date) {
  return Number.isFinite(date.getTime()) ? `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}` : "";
}
function displayDate(value: string) { return timestamp(value) ? timeFormat.format(new Date(value)) : "日期未知"; }
function pageStatus(page: PageView) {
  if (page.stale) return { label: "待复核", tone: "warn" };
  if (page.gaps.length > 0) return { label: "有能力缺口", tone: "warn" };
  return { label: "已发布", tone: "good" };
}
function getLibrary() { return (window as Window & { echarts?: ChartLibrary }).echarts; }

function loadCharts(): Promise<ChartLibrary> {
  const available = getLibrary();
  if (available) return Promise.resolve(available);
  return new Promise((resolve, reject) => {
    const existing = document.getElementById("qdd-overview-echarts") as HTMLScriptElement | null;
    const script = existing ?? document.createElement("script");
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      script.removeEventListener("load", loaded);
      script.removeEventListener("error", failed);
      cancelPendingLoad = undefined;
    };
    const finish = (library?: ChartLibrary) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (library) resolve(library);
      else {
        script.remove();
        reject(new Error("图表资源加载失败"));
      }
    };
    const loaded = () => finish(getLibrary());
    const failed = () => finish();
    const timer = setTimeout(failed, 12_000);
    cancelPendingLoad = () => finish();
    script.addEventListener("load", loaded, { once: true });
    script.addEventListener("error", failed, { once: true });
    if (!existing) {
      script.id = "qdd-overview-echarts";
      script.src = "https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js";
      script.async = true;
      document.head.append(script);
    }
  });
}

async function initializeCharts() {
  if (!hasData.value || disposed) return;
  const attempt = ++loadAttempt;
  chartState.value = "loading";
  try {
    chartLibrary = chartLibrary ?? await loadCharts();
    if (disposed || attempt !== loadAttempt || !hasData.value) return;
    chartState.value = "ready";
    await nextTick();
    drawCharts();
  } catch {
    if (!disposed && attempt === loadAttempt) chartState.value = "failed";
  }
}

function drawCharts() {
  if (!hasData.value || !chartLibrary || !rootElement.value || !activityElement.value || !statusElement.value) return;
  const style = getComputedStyle(rootElement.value);
  const token = (name: string) => style.getPropertyValue(`--qdd-${name}`).trim();
  const colors = Array.from({ length: 6 }, (_, index) => token(`chart-${index + 1}`));
  const muted = token("muted");
  const border = token("border");
  const surface = token("surface");
  const fontFamily = token("font");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  activityChart ??= chartLibrary.init(activityElement.value, undefined, { renderer: "svg" });
  statusChart ??= chartLibrary.init(statusElement.value, undefined, { renderer: "svg" });
  activityChart.setOption({
    color: colors,
    animation: !reducedMotion,
    textStyle: { color: muted, fontFamily },
    grid: { left: 12, right: 16, top: 24, bottom: 12, containLabel: true },
    tooltip: { trigger: "axis", renderMode: "richText", backgroundColor: surface, borderColor: border, textStyle: { color: muted, fontFamily }, valueFormatter: (value: number) => `${formatCount(value)} 个` },
    xAxis: { type: "category", data: activity.value.map((day) => day.label), axisTick: { show: false }, axisLine: { lineStyle: { color: border } }, axisLabel: { color: muted, fontFamily } },
    yAxis: { type: "value", min: 0, minInterval: 1, axisLabel: { color: muted, fontFamily, formatter: (value: number) => formatCount(value) }, splitLine: { lineStyle: { color: border, type: "dashed" } } },
    series: [{ name: "新增会话", type: "bar", data: activity.value.map((day) => day.count), barMaxWidth: 28, itemStyle: { borderRadius: [4, 4, 0, 0] } }],
  }, true);
  statusChart.setOption({
    color: colors,
    animation: !reducedMotion,
    textStyle: { color: muted, fontFamily },
    tooltip: { trigger: "item", renderMode: "richText", backgroundColor: surface, borderColor: border, textStyle: { color: muted, fontFamily }, valueFormatter: (value: number) => `${formatCount(value)} 个` },
    title: { text: formatCount(props.sessions.length), subtext: "全部会话", left: "center", top: "35%", itemGap: 7, textStyle: { color: muted, fontFamily, fontSize: 28, fontWeight: 600 }, subtextStyle: { color: muted, fontFamily, fontSize: 12 } },
    series: [{ name: "会话状态", type: "pie", radius: ["59%", "78%"], center: ["50%", "49%"], label: { show: false }, labelLine: { show: false }, emphasis: { scale: false }, itemStyle: { borderColor: surface, borderWidth: 3 }, data: statusCounts.value.map(({ name, value }) => ({ name, value })) }],
  }, true);
  activityChart.resize();
  statusChart.resize();
}

function queueRedraw() {
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => { frame = undefined; drawCharts(); });
}
function resizeCharts() { activityChart?.resize(); statusChart?.resize(); }
function disposeCharts() {
  activityChart?.dispose();
  statusChart?.dispose();
  activityChart = undefined;
  statusChart = undefined;
}

watch([() => props.sessions, () => props.pages], queueRedraw, { deep: true });
watch([activityElement, statusElement], () => { disposeCharts(); queueRedraw(); }, { flush: "post" });
watch(hasData, async (available) => {
  if (available) { await nextTick(); void initializeCharts(); }
  else { ++loadAttempt; cancelPendingLoad?.(); disposeCharts(); }
});
watch(today, queueRedraw);
onMounted(() => {
  resizeObserver = new ResizeObserver(resizeCharts);
  if (rootElement.value) resizeObserver.observe(rootElement.value);
  themeObserver = new MutationObserver(queueRedraw);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
  const harness = rootElement.value?.closest(".harness-app");
  if (harness) themeObserver.observe(harness, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
  themeQuery = window.matchMedia("(prefers-color-scheme: dark)");
  themeQuery.addEventListener("change", queueRedraw);
  window.addEventListener("resize", resizeCharts);
  clockTimer = setInterval(() => {
    const now = new Date();
    if (dateKey(now) !== dateKey(today.value)) today.value = now;
  }, 60_000);
  void initializeCharts();
});
onBeforeUnmount(() => {
  disposed = true;
  ++loadAttempt;
  cancelPendingLoad?.();
  disposeCharts();
  resizeObserver?.disconnect();
  themeObserver?.disconnect();
  themeQuery?.removeEventListener("change", queueRedraw);
  window.removeEventListener("resize", resizeCharts);
  clearInterval(clockTimer);
  if (frame !== undefined) cancelAnimationFrame(frame);
});
</script>

<template>
  <div ref="rootElement" class="qdd-page store-overview" :aria-busy="loading">
    <header class="qdd-header overview-header">
      <div>
        <div class="overview-eyebrow"><span class="overview-status-dot" :class="{ connected }" />{{ connected ? "工作空间已连接" : "工作空间未连接" }}</div>
        <h1>门店经营工作台</h1>
        <p class="overview-conclusion" aria-live="polite">{{ conclusion }}</p>
        <p class="overview-date">活动统计：{{ dateFormat.format(days[0]!.date) }} — {{ dateFormat.format(today) }}<span>本地时间 · 工作空间数据</span></p>
      </div>
      <button class="overview-button overview-button-primary" @click="connected ? emit('startConversation') : emit('openSettings')">
        <AgentIcon :name="connected ? 'plus' : 'sliders'" :size="17" />{{ connected ? "新建经营分析" : "连接工作空间" }}
      </button>
    </header>

    <section class="qdd-kpis" aria-label="工作空间关键指标">
      <article v-for="kpi in kpis" :key="kpi.label" class="qdd-card qdd-kpi overview-kpi" :class="`tone-${kpi.tone}`">
        <div class="overview-kpi-heading"><span class="label">{{ kpi.label }}</span><AgentIcon :name="kpi.icon" :size="18" /></div>
        <div class="value" :aria-label="hasData ? `${kpi.label} ${formatCount(kpi.value)}` : `${kpi.label}尚未获取`">{{ hasData ? formatCount(kpi.value) : "—" }}<span v-if="hasData" class="overview-kpi-unit">{{ kpi.label === "已发布页面" ? "页" : "个" }}</span></div>
        <p class="qdd-muted">{{ loading ? "正在同步数据" : !connected ? "连接后获取真实数据" : kpi.hint }}</p>
      </article>
    </section>

    <section v-if="!connected" class="qdd-card overview-connection" aria-label="连接说明">
      <div class="overview-empty-icon"><AgentIcon name="shop" :size="24" /></div>
      <div><h2>连接你的门店工作空间</h2><p>在设置中配置网关地址与访问凭据，开始查看已有会话和经营页面。</p></div>
      <button class="overview-button" @click="emit('openSettings')">前往设置<AgentIcon name="chevron" :size="15" /></button>
    </section>

    <section class="qdd-grid overview-charts" aria-label="会话统计图表">
      <article class="qdd-card overview-chart-card">
        <div class="overview-card-heading"><div><h2>近 7 天新增会话</h2><p class="qdd-muted">按会话创建日期统计</p></div><span v-if="hasData" class="overview-chart-total">{{ formatCount(activityTotal) }}<span>个</span></span></div>
        <div v-if="hasData && sessions.length && chartState === 'ready'" ref="activityElement" class="qdd-chart overview-activity-chart" role="img" aria-label="近 7 天新增会话柱状图" aria-describedby="overview-activity-summary" />
        <div v-else-if="hasData && sessions.length && chartState === 'failed'" class="overview-chart-fallback">
          <p>图表暂时无法加载，以下为实际统计数据。</p>
          <dl class="overview-fallback-data"><div v-for="day in activity" :key="day.key"><dt>{{ day.label }}</dt><dd>{{ formatCount(day.count) }}</dd></div></dl>
          <button class="overview-text-button" @click="initializeCharts">重新加载图表</button>
        </div>
        <div v-else class="overview-chart-empty"><AgentIcon :name="loading || (hasData && sessions.length) ? 'refresh' : 'chat'" :size="24" /><strong>{{ loading || (hasData && sessions.length) ? "正在加载统计" : !connected ? "连接后查看会话趋势" : "还没有会话记录" }}</strong><span>{{ loading ? "正在读取工作空间数据" : !connected ? "真实数据将在连接后显示" : sessions.length ? "正在加载图表资源" : "创建第一段对话，开始积累经营分析" }}</span></div>
        <p id="overview-activity-summary" class="sr-only">{{ hasData ? chartSummary : "暂无可用的会话统计数据" }}</p>
        <div class="overview-chart-footnote"><span class="overview-legend-dot chart-color-1" />新增会话<span>仅统计当前工作空间</span></div>
      </article>

      <article class="qdd-card overview-chart-card overview-status-card">
        <div class="overview-card-heading"><div><h2>会话状态分布</h2><p class="qdd-muted">掌握当前分析进展</p></div><AgentIcon name="sliders" :size="18" /></div>
        <div v-if="hasData && sessions.length && chartState === 'ready'" ref="statusElement" class="qdd-chart overview-status-chart" role="img" aria-label="当前会话状态环形图" aria-describedby="overview-status-summary" />
        <div v-else class="overview-chart-empty overview-status-empty"><AgentIcon name="clock" :size="24" /><strong>{{ loading || (hasData && sessions.length && chartState === 'loading') ? "正在加载统计" : !connected ? "连接后查看会话状态" : sessions.length ? "图表暂时无法加载" : "暂无进行中的工作" }}</strong><span>{{ hasData && sessions.length && chartState === 'failed' ? "可在下方查看各状态的实际数量" : "会话状态将在这里集中展示" }}</span></div>
        <ul id="overview-status-summary" class="overview-status-list" aria-label="会话状态数量">
          <li v-for="(item, index) in statusCounts" :key="item.status"><span><i class="overview-legend-dot" :class="`chart-color-${index + 1}`" />{{ item.name }}</span><strong>{{ hasData ? formatCount(item.value) : "—" }}</strong></li>
        </ul>
      </article>
    </section>

    <section class="qdd-card overview-pages" aria-labelledby="overview-pages-heading">
      <div class="overview-card-heading"><div><h2 id="overview-pages-heading">最近发布的页面<span v-if="hasData" class="overview-page-count">{{ formatCount(pages.length) }}</span></h2><p class="qdd-muted">查看分析成果，或在现有页面上继续完善</p></div><AgentIcon name="plan" :size="18" /></div>
      <div v-if="hasData && recentPages.length" class="qdd-table-wrap overview-table-wrap" tabindex="0" role="region" aria-label="最近页面明细，可横向滚动">
        <table class="qdd-table overview-table">
          <caption class="sr-only">最近更新的六个页面；时间以本地时区显示</caption>
          <thead><tr><th scope="col">页面名称</th><th scope="col">版本</th><th scope="col">状态</th><th scope="col">更新时间</th><th scope="col" class="overview-actions-column">操作</th></tr></thead>
          <tbody><tr v-for="page in recentPages" :key="page.slug">
            <td><button class="overview-page-title" @click="emit('openPage', page.slug)">{{ page.title }}</button><p v-if="page.summary" class="overview-page-summary">{{ page.summary }}</p></td>
            <td class="overview-version">v{{ formatCount(page.version) }}</td>
            <td><span class="qdd-badge" :class="pageStatus(page).tone">{{ pageStatus(page).label }}</span></td>
            <td><time :datetime="page.updatedAt">{{ displayDate(page.updatedAt) }}</time></td>
            <td><div class="overview-row-actions"><button class="overview-text-button" :aria-label="`查看${page.title}`" @click="emit('openPage', page.slug)">查看<AgentIcon name="chevron" :size="13" /></button><button class="overview-text-button overview-revise" :aria-label="`修改${page.title}`" @click="emit('revisePage', page.slug)"><AgentIcon name="edit" :size="13" />修改</button></div></td>
          </tr></tbody>
        </table>
      </div>
      <div v-else class="overview-pages-empty"><div class="overview-empty-icon"><AgentIcon :name="loading ? 'refresh' : 'plan'" :size="25" /></div><h3>{{ loading ? "正在同步页面" : connected ? "让你的第一个经营想法成为页面" : "连接后查看已发布页面" }}</h3><p>{{ loading ? "正在读取工作空间中的已发布页面" : connected ? "告诉钱多多你想分析的问题，确认需求后生成专属页面。" : "已发布页面、版本与最近更新时间将在这里展示。" }}</p><button v-if="!loading" class="overview-button" @click="connected ? emit('startConversation') : emit('openSettings')"><AgentIcon :name="connected ? 'plus' : 'sliders'" :size="15" />{{ connected ? "开始第一段对话" : "配置连接" }}</button></div>
      <p class="overview-data-note"><AgentIcon name="check" :size="13" />以上仅展示工作空间中的真实会话与页面数据。</p>
    </section>
  </div>
</template>

<style scoped>
.store-overview { width: 100%; gap: 22px; padding: 32px 32px 40px; color: var(--qdd-text); font-family: var(--qdd-font); }
.qdd-kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.overview-header { display: flex; justify-content: space-between; align-items: center; gap: 24px; padding: 2px 0 5px; }
.overview-eyebrow { display: flex; align-items: center; gap: 7px; color: var(--qdd-muted); font-size: 12px; margin-bottom: 13px; }
.overview-status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--qdd-muted); }
.overview-status-dot.connected { background: var(--qdd-good); }
.overview-header h1 { font-size: 26px; line-height: 1.4; font-weight: 600; letter-spacing: -.5px; }
.overview-header .overview-conclusion { color: var(--qdd-text); font-size: 13px; margin-top: 11px; line-height: 1.8; }
.overview-header .overview-date { font-size: 12px; margin-top: 9px; line-height: 1.8; }
.overview-date > span { margin-left: 14px; }
.overview-button { display: inline-flex; justify-content: center; align-items: center; gap: 7px; padding: 10px 14px; border: 1px solid var(--qdd-border); border-radius: var(--qdd-radius); color: var(--qdd-text); background: var(--qdd-surface); white-space: nowrap; font-size: 12px; line-height: 1.5; }
.overview-button:hover { border-color: var(--qdd-primary); color: var(--qdd-primary); background: var(--qdd-primary-soft); }
.overview-button.overview-button-primary { background: var(--qdd-primary); color: var(--qdd-on-primary); border-color: var(--qdd-primary); }
.overview-button-primary:hover { background: var(--qdd-primary-soft); color: var(--qdd-primary); }
.overview-kpi { padding: 19px 20px 17px; }
.overview-kpi-heading { display: flex; align-items: center; justify-content: space-between; color: var(--qdd-muted); gap: 12px; }
.overview-kpi .value { font-size: 31px; line-height: 1.4; margin-top: 13px; }
.overview-kpi.tone-primary .value, .overview-kpi.tone-primary .overview-kpi-heading > svg { color: var(--qdd-primary); }
.overview-kpi.tone-warn .value, .overview-kpi.tone-warn .overview-kpi-heading > svg { color: var(--qdd-warn); }
.overview-kpi-unit { color: var(--qdd-muted); font-size: 12px; margin-left: 7px; font-weight: 400; }
.overview-kpi p { margin: 10px 0 0; font-size: 12px; }
.overview-connection { display: flex; align-items: center; gap: 15px; background: var(--qdd-surface); }
.overview-connection h2 { margin: 0 0 5px; font-size: 13px; }
.overview-connection p { margin: 0; color: var(--qdd-muted); font-size: 12px; line-height: 1.8; }
.overview-connection > .overview-button { margin-left: auto; }
.overview-empty-icon { display: grid; place-items: center; width: 46px; height: 46px; border-radius: var(--qdd-radius); background: var(--qdd-bg); color: var(--qdd-muted); flex-shrink: 0; }
.overview-charts { grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr); gap: 18px; }
.overview-chart-card { padding: 21px 21px 15px; }
.overview-card-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.overview-card-heading h2 { font-size: 14px; font-weight: 600; margin: 0; }
.overview-card-heading p { font-size: 12px; margin: 5px 0 0; }
.overview-card-heading > svg { color: var(--qdd-muted); }
.overview-chart-total { font-size: 23px; font-weight: 600; font-variant-numeric: tabular-nums; }
.overview-chart-total > span { color: var(--qdd-muted); font-size: 12px; margin-left: 6px; font-weight: 400; }
.overview-activity-chart { height: 254px; margin-top: 14px; }
.overview-status-chart { height: 205px; margin-top: 3px; }
.overview-chart-empty { min-height: 268px; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 10px; text-align: center; color: var(--qdd-muted); }
.overview-chart-empty > svg { margin-bottom: 4px; }
.overview-chart-empty strong { color: var(--qdd-text); font-size: 12px; font-weight: 500; }
.overview-chart-empty > span { font-size: 12px; line-height: 1.8; }
.overview-status-empty { min-height: 208px; }
.overview-chart-footnote { display: flex; align-items: center; gap: 6px; border-top: 1px solid var(--qdd-border); padding-top: 13px; color: var(--qdd-muted); font-size: 12px; }
.overview-chart-footnote > span:last-child { margin-left: auto; }
.overview-legend-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.chart-color-1 { background: var(--qdd-chart-1); }
.chart-color-2 { background: var(--qdd-chart-2); }
.chart-color-3 { background: var(--qdd-chart-3); }
.chart-color-4 { background: var(--qdd-chart-4); }
.overview-status-list { display: grid; grid-template-columns: 1fr 1fr; gap: 11px 20px; list-style: none; margin: 0; padding: 11px 2px 0; border-top: 1px solid var(--qdd-border); }
.overview-status-list li { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; color: var(--qdd-muted); }
.overview-status-list li > span { display: flex; align-items: center; gap: 6px; }
.overview-status-list strong { color: var(--qdd-text); font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
.overview-chart-fallback { display: flex; justify-content: center; flex-direction: column; min-height: 268px; gap: 16px; color: var(--qdd-muted); font-size: 12px; }
.overview-chart-fallback p { margin: 0; }
.overview-fallback-data { display: grid; grid-template-columns: repeat(7, 1fr); gap: 5px; margin: 0; text-align: center; }
.overview-fallback-data > div { border: 1px solid var(--qdd-border); border-radius: var(--qdd-radius); padding: 10px 2px; }
.overview-fallback-data dd { color: var(--qdd-text); font-size: 15px; margin: 8px 0 0; font-variant-numeric: tabular-nums; }
.overview-pages { padding: 22px 21px 0; }
.overview-page-count { font-size: 12px; margin-left: 9px; padding: 2px 6px; border: 1px solid var(--qdd-border); color: var(--qdd-muted); border-radius: var(--qdd-radius); font-variant-numeric: tabular-nums; vertical-align: middle; }
.overview-table-wrap { margin-top: 22px; }
.overview-table { min-width: 660px; }
.overview-table th { padding-top: 11px; padding-bottom: 11px; background: var(--qdd-bg); }
.overview-table td { font-size: 12px; padding-top: 15px; padding-bottom: 15px; color: var(--qdd-muted); }
.overview-table td:first-child { max-width: 300px; min-width: 180px; white-space: normal; }
.overview-page-title { display: block; color: var(--qdd-text); font-size: 12px; font-weight: 500; background: var(--qdd-surface); padding: 0; text-align: left; line-height: 1.7; overflow-wrap: anywhere; }
.overview-page-title:hover { color: var(--qdd-primary); }
.overview-page-summary { color: var(--qdd-muted); font-size: 12px; margin: 4px 0 0; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; line-height: 1.7; }
.overview-version { font-variant-numeric: tabular-nums; }
.overview-table .qdd-badge { font-size: 12px; line-height: 1.7; }
.overview-actions-column { width: 114px; }
.overview-row-actions { display: flex; align-items: center; gap: 13px; }
.overview-text-button { display: inline-flex; align-items: center; justify-content: center; gap: 3px; color: var(--qdd-primary); background: var(--qdd-surface); padding: 5px 0; font-size: 12px; line-height: 1.4; }
.overview-text-button:hover { text-decoration: underline; text-underline-offset: 3px; }
.overview-revise { color: var(--qdd-muted); }
.overview-pages-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 42px 12px 38px; text-align: center; }
.overview-pages-empty h3 { font-size: 13px; margin: 16px 0 7px; font-weight: 500; }
.overview-pages-empty > p { font-size: 12px; color: var(--qdd-muted); line-height: 1.9; margin: 0 0 19px; }
.overview-data-note { display: flex; align-items: center; gap: 6px; color: var(--qdd-muted); font-size: 12px; line-height: 1.8; border-top: 1px solid var(--qdd-border); margin: 0; padding: 13px 0 14px; }
.store-overview :focus-visible { outline: 2px solid var(--qdd-primary); outline-offset: 4px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (min-width: 1500px) { .store-overview { padding-top: 42px; } }
@media (max-width: 1100px) {
  .store-overview { padding: 26px 22px 32px; }
  .qdd-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .overview-charts { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .overview-kpi { padding: 16px; }
}
@media (max-width: 760px) {
  .store-overview { padding: 22px 16px 30px; gap: 16px; }
  .overview-header { flex-direction: column; align-items: flex-start; gap: 17px; }
  .overview-header h1 { font-size: 23px; }
  .overview-date > span { display: block; margin: 3px 0 0; }
  .overview-header > .overview-button { width: 100%; }
  .qdd-kpis, .overview-charts { grid-template-columns: minmax(0, 1fr); }
  .overview-kpi { padding: 16px 18px; }
  .overview-kpi .value { margin-top: 8px; }
  .overview-kpi p { margin-top: 7px; }
  .overview-connection { align-items: flex-start; flex-wrap: wrap; padding: 17px; }
  .overview-connection > div:nth-child(2) { flex: 1; min-width: 160px; }
  .overview-connection > .overview-button { margin-left: 61px; }
  .overview-chart-card, .overview-pages { padding-left: 17px; padding-right: 17px; }
  .overview-pages-empty { padding-left: 0; padding-right: 0; }
  .overview-data-note { align-items: flex-start; }
  .overview-data-note svg { margin-top: 3px; }
}
</style>

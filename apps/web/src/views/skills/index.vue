<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";
import { ElAlert, ElButton, ElCard, ElCheckbox, ElCheckboxGroup, ElDialog, ElEmpty, ElForm, ElFormItem, ElInput, ElMessageBox, ElSkeleton, ElTag } from "element-plus";
import type { InputInstance } from "element-plus";
import type { Skill, SkillInput, ToolInfo } from "@qdd/shared";
import AgentIcon from "@/components/AgentIcon.vue";
import { useWorkspaceContext } from "@/composables/workspaceContext";
import { useGatewayResource } from "@/composables/useGatewayResource";
import { gatewayJson } from "@/api/workspace";
import { createSkill, deleteSkill, listSkills, updateSkill } from "@/api/skills";

const { workspace, navigation, notify } = useWorkspaceContext();
const { connected, gatewayUrl, token } = workspace;
const { data, loading, error, refresh } = useGatewayResource("skills", listSkills);
const toolsResource = useGatewayResource<ToolInfo[]>("connectors", (base, accessToken, signal) =>
  gatewayJson(base, accessToken, "/api/tools", { signal }));
const skills = computed(() => data.value ?? []);
const availableTools = computed(() => toolsResource.data.value ?? []);
const selectedId = ref("");
const selectedSkill = computed(() => skills.value.find((skill) => skill.id === selectedId.value));
const activeTab = ref<"library" | "templates">("library");
const query = ref("");
const templateQuery = ref("");
const activeQuery = computed({
  get: () => activeTab.value === "library" ? query.value : templateQuery.value,
  set: (value: string) => { if (activeTab.value === "library") query.value = value; else templateQuery.value = value; },
});
const sourceFilter = ref<"all" | Skill["source"]>("all");
const sourceFilters = [
  { value: "all", label: "全部" },
  { value: "user", label: "我创建的" },
  { value: "agent", label: "对话提炼" },
] as const;
const sourceCounts = computed(() => ({
  all: skills.value.length,
  user: skills.value.filter((skill) => skill.source === "user").length,
  agent: skills.value.filter((skill) => skill.source === "agent").length,
}));
const filteredSkills = computed(() => skills.value.filter((skill) =>
  (sourceFilter.value === "all" || skill.source === sourceFilter.value)
  && matchesQuery([skill.name, skill.description, ...skill.steps, ...skill.tools].join(" "))));
// Local examples are templates; they are never counted as saved skills.
const templates = [
  { name: "临期预警", icon: "clock", category: "库存管理", description: "提前发现临期商品，整理优先处理建议。", steps: ["查询商品批次与保质期，找出未来 3 天内到期的商品。", "结合库存与货架情况列出优先处理的商品。", "给出处理建议；涉及改价或发布时先交给店长确认。"] },
  { name: "经营日报", icon: "plan", category: "经营分析", description: "汇总销售表现，找出值得关注的变化。", steps: ["汇总昨日销售额、订单量和各品类表现。", "比较前一日及上周同期，标出明显变化。", "说明数据依据，整理今日经营关注事项。"] },
  { name: "损耗分析", icon: "search", category: "经营分析", description: "追踪高损耗商品，梳理变化原因。", steps: ["确认门店、时间范围与损耗口径。", "汇总商品和品类损耗，对照采购、销售与库存变化。", "给出可验证的原因线索和处理建议。"] },
  { name: "排班建议", icon: "shop", category: "门店协作", description: "结合客流与员工安排，准备合适班次。", steps: ["确认营业时间、岗位与员工可出勤时间。", "结合客流高峰检查人手需求、休息时间及岗位覆盖。", "输出排班建议，将冲突交给店长确认。"] },
  { name: "补货建议", icon: "folder", category: "库存管理", description: "结合销售与库存，规划下一次补货。", steps: ["确认补货周期、到货时间与安全库存要求。", "对照近期销量、当前库存及在途采购。", "列出建议补货量、估算依据与需要店长确认的采购。"] },
];
const filteredTemplates = computed(() => templates.filter((template) =>
  matchesQuery([template.name, template.description, template.category, ...template.steps].join(" "), templateQuery.value)));
const editorOpen = ref(false);
const editingId = ref<string | null>(null);
const toolsExpanded = ref(false);
const editorName = ref<InputInstance>();
const stepInputs = new Map<number, InputInstance>();
const form = reactive({ name: "", description: "", steps: [""], tools: [] as string[], extraTools: "" });
const formError = ref("");
const actionError = ref("");
const saving = ref(false);
const busyId = ref("");
const runningId = ref("");
const controllers = new Set<AbortController>();
let saveController: AbortController | undefined;
let version = 0;
let editorVersion = 0;
let editorConnection = { gatewayUrl: "", token: "" };
let saveInterrupted = false;

watch(filteredSkills, (entries) => {
  if (!entries.some((skill) => skill.id === selectedId.value)) selectedId.value = entries[0]?.id ?? "";
}, { immediate: true });
function matchesQuery(text: string, keyword = query.value): boolean {
  return text.toLocaleLowerCase().includes(keyword.trim().toLocaleLowerCase());
}
function showTab(tab: typeof activeTab.value) {
  activeTab.value = tab;
}
function clearFilters() {
  query.value = "";
  sourceFilter.value = "all";
}
function displayDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间待同步" : date.toLocaleDateString("zh-CN", { year: "numeric", month: "numeric", day: "numeric" });
}
function errorText(cause: unknown): string {
  return cause instanceof TypeError ? "暂时无法连接工作空间，请检查连接后重试。" : cause instanceof Error ? cause.message : "操作失败，请稍后重试。";
}
function toolTitle(tool: ToolInfo): string { return tool.description.split(/[：:。\r\n]/)[0]?.trim() || "数据工具"; }
function toolLabel(name: string): string {
  const tool = availableTools.value.find((entry) => entry.name === name);
  return tool ? toolTitle(tool) : name;
}
function updateToolsExpanded(event: Event) {
  toolsExpanded.value = (event.target as HTMLDetailsElement).open;
}
function setStepInput(instance: unknown, index: number) {
  if (instance) stepInputs.set(index, instance as InputInstance);
  else stepInputs.delete(index);
}
function focusStep(index: number) {
  void nextTick(() => stepInputs.get(index)?.focus());
}
function addStep() {
  if (saving.value || form.steps.length >= 12) return;
  form.steps.push("");
  focusStep(form.steps.length - 1);
}
function removeStep(index: number) {
  if (saving.value || form.steps.length <= 1) return;
  form.steps.splice(index, 1);
  focusStep(Math.min(index, form.steps.length - 1));
}
function moveStep(index: number, direction: -1 | 1) {
  const target = index + direction;
  if (saving.value || target < 0 || target >= form.steps.length) return;
  const [step] = form.steps.splice(index, 1);
  form.steps.splice(target, 0, step!);
  focusStep(target);
}
function updateSelectedTools(value: unknown) {
  if (saving.value || !Array.isArray(value)) return;
  form.tools = value.filter((name): name is string => typeof name === "string");
}
function openEditor(skill?: Skill, template?: (typeof templates)[number]) {
  if (!connected.value || saving.value) return;
  editorVersion++;
  editorConnection = { gatewayUrl: gatewayUrl.value, token: token.value };
  saveInterrupted = false;
  editingId.value = skill?.id ?? null;
  const content = skill ?? template;
  Object.assign(form, {
    name: content?.name ?? "", description: content?.description ?? "", steps: content ? [...content.steps] : [""],
    tools: skill?.tools.filter((name) => availableTools.value.some((tool) => tool.name === name)) ?? [],
    extraTools: skill?.tools.filter((name) => !availableTools.value.some((tool) => tool.name === name)).join("\n") ?? "",
  });
  toolsExpanded.value = form.tools.length > 0 || !!form.extraTools;
  formError.value = "";
  editorOpen.value = true;
}
function closeEditor() {
  editorVersion++;
  saveController?.abort();
  saving.value = false;
}
function editorConnectionChanged(): boolean {
  return editorConnection.gatewayUrl !== gatewayUrl.value || editorConnection.token !== token.value;
}
function connectionFeedback(): string {
  if (editorConnectionChanged()) return "工作空间连接配置已更改，编辑内容已保留。请恢复原连接后保存，或取消后重新编辑。";
  if (saveInterrupted) return "连接发生变化，上次保存结果尚未确认。编辑内容已保留，请恢复连接并检查列表后再重试。";
  return connected.value ? "连接已恢复，编辑内容已保留，请重新保存。" : "工作空间未连接，暂时无法保存。编辑内容已保留，请恢复连接后重试。";
}
function resetOperations() {
  version++;
  for (const controller of controllers) controller.abort();
  controllers.clear();
  saveController = undefined;
  saving.value = false;
  busyId.value = "";
  runningId.value = "";
  actionError.value = "";
}
watch([gatewayUrl, token, connected], () => {
  saveInterrupted ||= saving.value;
  resetOperations();
  if (editorOpen.value) formError.value = connectionFeedback();
}, { flush: "sync" });
onBeforeUnmount(resetOperations);
async function save() {
  if (saving.value) return;
  if (!connected.value || editorConnectionChanged()) {
    formError.value = connectionFeedback();
    return;
  }
  const steps = form.steps.map((step) => step.trim());
  if (!form.name.trim()) {
    formError.value = "请先填写技能名称。";
    editorName.value?.focus();
    return;
  }
  if (steps.length < 1 || steps.length > 12 || steps.some((step) => !step)) {
    formError.value = "请填写 1–12 个完整步骤，或移除多余的空步骤。";
    focusStep(Math.max(0, steps.findIndex((step) => !step)));
    return;
  }
  const input: SkillInput = {
    name: form.name.trim(), description: form.description.trim(), steps,
    tools: [...new Set([...form.tools, ...form.extraTools.split(/[\n,，]/).map((name) => name.trim()).filter(Boolean)])],
  };
  const controller = new AbortController();
  controllers.add(controller);
  saveController = controller;
  const currentVersion = version;
  const currentEditor = editorVersion;
  saving.value = true;
  saveInterrupted = false;
  formError.value = "";
  try {
    const skill = editingId.value
      ? await updateSkill(gatewayUrl.value, token.value, editingId.value, input, controller.signal)
      : await createSkill(gatewayUrl.value, token.value, input, controller.signal);
    if (controller.signal.aborted || currentVersion !== version || currentEditor !== editorVersion) return;
    clearFilters();
    activeTab.value = "library";
    data.value = editingId.value
      ? skills.value.map((entry) => entry.id === skill.id ? skill : entry)
      : [skill, ...skills.value];
    selectedId.value = skill.id;
    editorOpen.value = false;
    notify(editingId.value ? "技能已更新" : "技能已创建");
    await refresh();
  } catch (cause) {
    if (!controller.signal.aborted && currentVersion === version && currentEditor === editorVersion) formError.value = errorText(cause);
  } finally {
    controllers.delete(controller);
    if (saveController === controller) { saving.value = false; saveController = undefined; }
  }
}
async function remove(skill: Skill) {
  if (busyId.value || !connected.value) return;
  const currentVersion = version;
  try { await ElMessageBox.confirm(`删除“${skill.name}”后无法恢复，确定删除吗？`, "删除技能", { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" }); }
  catch { return; }
  if (currentVersion !== version || busyId.value) return;
  const controller = new AbortController();
  controllers.add(controller);
  busyId.value = skill.id;
  actionError.value = "";
  try {
    await deleteSkill(gatewayUrl.value, token.value, skill.id, controller.signal);
    if (controller.signal.aborted || currentVersion !== version) return;
    data.value = skills.value.filter((entry) => entry.id !== skill.id);
    notify("技能已删除");
    await refresh();
  } catch (cause) {
    if (!controller.signal.aborted && currentVersion === version) actionError.value = errorText(cause);
  } finally {
    controllers.delete(controller);
    if (currentVersion === version) busyId.value = "";
  }
}
async function run(skill: Skill) {
  if (runningId.value || !connected.value) return;
  const currentVersion = version;
  runningId.value = skill.id;
  actionError.value = "";
  try { await navigation.runSkill(skill); }
  catch (cause) { if (currentVersion === version) actionError.value = errorText(cause); }
  finally { if (currentVersion === version) runningId.value = ""; }
}
</script>

<template>
  <div class="feature-page skills-page">
    <header class="feature-header">
      <div>
        <span class="feature-eyebrow">可复用的做事方法</span>
        <h1>技能库</h1>
        <p>把门店经验写成步骤，让助手每次都按你的方法完成。</p>
      </div>
      <ElButton type="primary" :disabled="!connected" @click="openEditor()">
        <AgentIcon name="plus" :size="16" />新建技能
      </ElButton>
    </header>

    <ElAlert v-if="actionError || (error && data)" :title="actionError || error" type="error" show-icon :closable="false" />

    <div class="skills-navigation">
      <nav class="skills-tabs" aria-label="技能分组">
        <button type="button" :class="{ active: activeTab === 'library' }" :aria-pressed="activeTab === 'library'" @click="showTab('library')">
          我的技能<span class="tab-count">{{ skills.length }}</span>
        </button>
        <button type="button" :class="{ active: activeTab === 'templates' }" :aria-pressed="activeTab === 'templates'" @click="showTab('templates')">
          模板广场<span class="tab-count">{{ templates.length }}</span>
        </button>
      </nav>
      <ElButton v-if="activeTab === 'library' && connected" class="skills-refresh" text :loading="loading" @click="refresh">
        <AgentIcon name="refresh" :size="15" />刷新
      </ElButton>
    </div>

    <div v-if="connected || activeTab === 'templates'" class="skills-toolbar">
      <ElInput
        v-model="activeQuery"
        clearable
        :placeholder="activeTab === 'library' ? '搜索名称、说明或步骤' : '搜索模板或场景'"
        :aria-label="activeTab === 'library' ? '搜索已保存技能' : '搜索技能模板'">
        <template #prefix><AgentIcon name="search" :size="17" /></template>
      </ElInput>
      <div v-if="activeTab === 'library'" class="skill-source-filters" role="group" aria-label="按技能来源筛选">
        <button
          v-for="filter in sourceFilters"
          :key="filter.value"
          type="button"
          :class="{ active: sourceFilter === filter.value }"
          :aria-pressed="sourceFilter === filter.value"
          @click="sourceFilter = filter.value">
          {{ filter.label }}<span>{{ sourceCounts[filter.value] }}</span>
        </button>
      </div>
    </div>

    <template v-if="activeTab === 'library'">
      <section v-if="!connected" class="skills-state" aria-labelledby="skills-disconnected-title">
        <span class="state-icon"><AgentIcon name="folder" :size="28" /></span>
        <h2 id="skills-disconnected-title">连接工作空间，打开你的技能库</h2>
        <p>已保存的技能会在连接后同步。你也可以先浏览模板，看看助手能做什么。</p>
        <div class="state-actions">
          <ElButton type="primary" @click="navigation.openView('settings')">连接工作空间</ElButton>
          <ElButton @click="showTab('templates')">浏览模板</ElButton>
        </div>
      </section>
      <div v-else-if="loading && !data" class="skills-loading" role="status" aria-label="正在加载技能库" aria-busy="true">
        <ElSkeleton :rows="7" animated />
        <ElSkeleton :rows="10" animated />
      </div>
      <section v-else-if="error && !data" class="skills-state" aria-labelledby="skills-error-title">
        <span class="state-icon"><AgentIcon name="refresh" :size="28" /></span>
        <h2 id="skills-error-title">技能库暂时没有加载成功</h2>
        <p role="alert">{{ error }}</p>
        <ElButton type="primary" :loading="loading" @click="refresh">重新加载</ElButton>
      </section>
      <div v-else-if="filteredSkills.length" class="skills-layout" :aria-busy="loading">
        <aside class="skill-library" aria-labelledby="saved-skills-title">
          <div class="library-heading">
            <h2 id="saved-skills-title">已保存技能</h2>
            <span role="status" aria-live="polite">{{ filteredSkills.length }} 个结果</span>
          </div>
          <div class="skill-list">
            <button
              v-for="skill in filteredSkills"
              :key="skill.id"
              type="button"
              class="skill-select"
              :class="{ selected: selectedId === skill.id }"
              :aria-pressed="selectedId === skill.id"
              :aria-label="`查看技能：${skill.name}`"
              aria-controls="skill-detail"
              @click="selectedId = skill.id">
              <span class="skill-card-heading">
                <span class="skill-mark"><AgentIcon :name="skill.source === 'agent' ? 'spark' : 'plan'" :size="18" /></span>
                <strong>{{ skill.name }}</strong>
                <AgentIcon class="skill-chevron" name="chevron" :size="15" />
              </span>
              <span class="skill-card-description">{{ skill.description || "打开查看具体做事步骤" }}</span>
              <span class="skill-card-meta">
                <span>{{ skill.source === "agent" ? "对话提炼" : "我创建的" }}</span>
                <span>{{ skill.steps.length }} 个步骤</span>
              </span>
            </button>
          </div>
          <button type="button" class="library-template-link" @click="showTab('templates')">
            <AgentIcon name="plus" :size="16" />从模板添加技能<AgentIcon name="chevron" :size="14" />
          </button>
        </aside>

        <article v-if="selectedSkill" id="skill-detail" class="skill-detail" aria-labelledby="skill-detail-title">
          <div class="skill-detail-heading">
            <div class="detail-title">
              <span class="detail-eyebrow"><AgentIcon name="spark" :size="14" />{{ selectedSkill.source === "agent" ? "来自助手对话" : "我的技能" }}</span>
              <h2 id="skill-detail-title">{{ selectedSkill.name }}</h2>
            </div>
            <div class="detail-actions">
              <ElButton :disabled="!connected || !!busyId || !!runningId" @click="openEditor(selectedSkill)"><AgentIcon name="edit" :size="15" />编辑</ElButton>
              <ElButton type="primary" :loading="runningId === selectedSkill.id" :disabled="!connected || !!runningId || !!busyId" @click="run(selectedSkill)">
                <AgentIcon name="arrow" :size="15" />运行技能
              </ElButton>
            </div>
          </div>
          <p class="skill-description">{{ selectedSkill.description || "助手会依照以下步骤完成任务。你可以编辑步骤，让它更贴合门店的工作方式。" }}</p>
          <div class="skill-detail-meta">
            <span><AgentIcon name="plan" :size="14" />{{ selectedSkill.steps.length }} 个步骤</span>
            <span><AgentIcon name="code" :size="14" />{{ selectedSkill.tools.length ? `${selectedSkill.tools.length} 个工具` : "由助手选择工具" }}</span>
            <span><AgentIcon name="clock" :size="14" />{{ displayDate(selectedSkill.updatedAt) }} 更新</span>
          </div>

          <section class="detail-section" aria-labelledby="skill-steps-title">
            <div class="detail-section-heading"><h3 id="skill-steps-title">执行步骤</h3><span>助手会依次完成</span></div>
            <ol class="skill-instructions">
              <li v-for="(step, index) in selectedSkill.steps" :key="index">
                <span class="step-number" aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</span>
                <p>{{ step }}</p>
              </li>
            </ol>
          </section>
          <section v-if="selectedSkill.tools.length" class="detail-section" aria-labelledby="skill-tools-title">
            <div class="detail-section-heading"><h3 id="skill-tools-title">使用的工具</h3></div>
            <div class="skill-tool-tags"><ElTag v-for="name in selectedSkill.tools" :key="name" type="info" effect="plain" :title="name">{{ toolLabel(name) }}</ElTag></div>
          </section>
          <div class="skill-run-note"><AgentIcon name="chat" :size="17" /><p>运行后会打开新对话，你可以继续补充要求、查看执行进度和结果。</p></div>
          <footer class="skill-detail-footer">
            <ElButton v-if="selectedSkill.sessionId" link type="primary" @click="navigation.openSession(selectedSkill.sessionId)"><AgentIcon name="chat" :size="14" />查看来源对话</ElButton>
            <ElButton class="delete-skill" link type="danger" :loading="busyId === selectedSkill.id" :disabled="!connected || !!busyId || !!runningId" @click="remove(selectedSkill)"><AgentIcon name="trash" :size="14" />删除技能</ElButton>
          </footer>
        </article>
      </div>
      <section v-else-if="skills.length || query || sourceFilter !== 'all'" class="skills-state" aria-labelledby="skills-no-results-title">
        <span class="state-icon"><AgentIcon name="search" :size="28" /></span>
        <h2 id="skills-no-results-title">没有找到匹配的技能</h2>
        <p>试试其他关键词，或清除来源筛选查看全部技能。</p>
        <ElButton @click="clearFilters">清除搜索和筛选</ElButton>
      </section>
      <section v-else class="skills-state" aria-labelledby="skills-empty-title">
        <span class="state-icon"><AgentIcon name="spark" :size="28" /></span>
        <h2 id="skills-empty-title">从一个常做的任务开始</h2>
        <p>创建你的第一个技能，或使用现成模板，保存后随时交给助手运行。</p>
        <div class="state-actions">
          <ElButton type="primary" @click="showTab('templates')">挑选技能模板</ElButton>
          <ElButton @click="openEditor()">从空白创建</ElButton>
        </div>
      </section>
    </template>

    <section v-else class="skill-examples" aria-labelledby="skill-templates-title">
      <div class="template-heading">
        <div><h2 id="skill-templates-title">给日常工作一个好起点</h2><p>选择适合的场景，修改步骤后保存到你的技能库。</p></div>
        <span>模板 {{ filteredTemplates.length }} / {{ templates.length }}</span>
      </div>
      <p v-if="!connected" class="template-connect-note">可以先查看模板；连接工作空间后即可创建和运行技能。</p>
      <div v-if="filteredTemplates.length" class="example-grid">
        <ElCard v-for="template in filteredTemplates" :key="template.name" class="template-card" shadow="never">
          <div class="template-card-top"><span class="template-icon"><AgentIcon :name="template.icon" :size="23" /></span><span class="template-category">{{ template.category }}</span></div>
          <h3>{{ template.name }}</h3>
          <p class="template-description">{{ template.description }}</p>
          <ol class="template-steps"><li v-for="step in template.steps" :key="step">{{ step }}</li></ol>
          <div class="template-card-footer"><span>{{ template.steps.length }} 个步骤 · 可自定义</span><ElButton type="primary" plain :disabled="!connected" @click="openEditor(undefined, template)">使用模板<AgentIcon name="chevron" :size="14" /></ElButton></div>
        </ElCard>
      </div>
      <ElEmpty v-else description="没有找到相关模板" :image-size="65"><ElButton @click="templateQuery = ''">清除搜索</ElButton></ElEmpty>
    </section>

    <ElDialog
      v-model="editorOpen"
      class="skill-editor-dialog"
      :title="editingId ? '编辑技能' : '新建技能'"
      width="min(760px, calc(100vw - 32px))"
      top="24px"
      destroy-on-close
      :close-on-click-modal="false"
      :close-on-press-escape="!saving"
      :show-close="!saving"
      @opened="editorName?.focus()"
      @close="closeEditor">
      <p class="editor-intro">写清楚要做什么、按什么顺序做。保存后，助手会按照这些步骤执行。</p>
      <ElForm :model="form" class="skill-editor-form" label-position="top" :disabled="saving" @submit.prevent="save">
        <ElAlert v-if="formError" :title="formError" type="error" show-icon :closable="false" class="form-feedback" />
        <ElFormItem label="技能名称" for="skill-editor-name" required>
          <ElInput id="skill-editor-name" ref="editorName" v-model="form.name" maxlength="30" show-word-limit placeholder="例如：每日闭店库存检查" autocomplete="off" />
        </ElFormItem>
        <ElFormItem label="简短说明" for="skill-editor-description">
          <ElInput id="skill-editor-description" v-model="form.description" maxlength="200" placeholder="描述使用场景，以及你希望得到的结果" />
        </ElFormItem>
        <div class="editor-section-heading"><h3>执行步骤<span aria-hidden="true"> *</span></h3><span>{{ form.steps.length }} / 12</span></div>
        <p class="editor-section-note">每一步写一件事，说明数据范围或判断条件。可以用右侧按钮调整顺序。</p>
        <div class="step-editor" role="group" aria-label="技能执行步骤">
          <div v-for="(_step, index) in form.steps" :key="index" class="step-row">
            <span class="editor-step-number" aria-hidden="true">{{ index + 1 }}</span>
            <ElInput
              :id="`skill-editor-step-${index}`"
              :ref="(instance) => setStepInput(instance, index)"
              v-model="form.steps[index]"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 5 }"
              maxlength="300"
              :placeholder="index === 0 ? '例如：查询今天的库存，找出低于安全库存的商品。' : '接下来让助手做什么？'"
              :aria-label="`第 ${index + 1} 个步骤`"
              aria-required="true"
              :disabled="saving" />
            <div class="step-actions">
              <ElButton text :disabled="saving || index === 0" :aria-label="`上移第 ${index + 1} 个步骤`" title="上移步骤" @click="moveStep(index, -1)"><AgentIcon name="arrow" :size="15" /></ElButton>
              <ElButton text :disabled="saving || index === form.steps.length - 1" :aria-label="`下移第 ${index + 1} 个步骤`" title="下移步骤" @click="moveStep(index, 1)"><AgentIcon class="move-down" name="arrow" :size="15" /></ElButton>
              <ElButton text type="danger" :disabled="saving || form.steps.length === 1" :aria-label="`移除第 ${index + 1} 个步骤`" title="移除步骤" @click="removeStep(index)"><AgentIcon name="close" :size="15" /></ElButton>
            </div>
          </div>
          <ElButton class="add-step" :disabled="saving || form.steps.length >= 12" @click="addStep"><AgentIcon name="plus" :size="15" />{{ form.steps.length >= 12 ? "已达到 12 个步骤上限" : "添加步骤" }}</ElButton>
        </div>
        <details class="editor-tools" :open="toolsExpanded" @toggle="updateToolsExpanded">
          <summary><AgentIcon name="code" :size="17" /><span>工具设置<span class="optional-label">可选</span></span><span class="tools-selected">{{ form.tools.length ? `已选择 ${form.tools.length} 个` : "按需指定" }}</span></summary>
          <p class="editor-section-note">知道需要哪些工具时可在这里指定；留空时由助手根据任务选择。</p>
          <div class="tool-picker">
            <p v-if="toolsResource.loading.value && !availableTools.length" class="tool-note" role="status">正在加载可用工具…</p>
            <p v-else-if="toolsResource.error.value" class="tool-note" role="alert">{{ toolsResource.error.value }} 你仍可以先保存步骤。</p>
            <ElCheckboxGroup v-if="availableTools.length" class="tool-options" :model-value="form.tools" :disabled="saving" aria-label="可用数据工具" @update:model-value="updateSelectedTools">
              <ElCheckbox v-for="tool in availableTools" :key="tool.name" :title="tool.description" :value="tool.name"><span>{{ toolTitle(tool) }}</span><small>{{ tool.name }}</small></ElCheckbox>
            </ElCheckboxGroup>
            <p v-else-if="!toolsResource.loading.value && !toolsResource.error.value" class="tool-note">当前工作空间没有提供工具列表，可以直接保存步骤。</p>
          </div>
          <ElFormItem label="其他工具标识" for="skill-editor-extra-tools">
            <ElInput id="skill-editor-extra-tools" v-model="form.extraTools" type="textarea" :rows="2" placeholder="已知但未列出的工具，每行填写一个准确标识" />
          </ElFormItem>
        </details>
      </ElForm>
      <template #footer><ElButton :disabled="saving" @click="editorOpen = false">取消</ElButton><ElButton type="primary" :loading="saving" @click="save">{{ editingId ? "保存修改" : "创建技能" }}</ElButton></template>
    </ElDialog>
  </div>
</template>

<style scoped>
.skills-navigation { display:flex; align-items:center; justify-content:space-between; gap:16px; border-bottom:1px solid var(--qdd-border); }
.skills-tabs { display:flex; gap:26px; }
.skills-tabs button { display:flex; align-items:center; gap:8px; position:relative; padding:15px 0; background:transparent; color:var(--qdd-muted); font-size:14px; white-space:nowrap; }
.skills-tabs button.active { color:var(--qdd-text); font-weight:600; }
.skills-tabs button.active::after { content:""; position:absolute; inset:auto 0 -1px; height:2px; background:var(--qdd-primary); border-radius:2px; }
.tab-count { padding:1px 6px; border-radius:5px; background:var(--qdd-bg); color:var(--qdd-muted); font-size:11px; font-weight:500; }
.skills-tabs button.active .tab-count { background:var(--qdd-primary-soft); color:var(--qdd-primary); }
.skills-refresh { flex-shrink:0; }
.skills-toolbar { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:14px; margin:23px 0; }
.skills-toolbar > :deep(.el-input) { width:min(360px,100%); }
.skill-source-filters { display:flex; flex-wrap:wrap; gap:5px; padding:4px; border-radius:8px; background:var(--qdd-bg); }
.skill-source-filters button { display:flex; align-items:center; gap:7px; padding:7px 11px; border-radius:6px; background:transparent; color:var(--qdd-muted); font-size:12px; }
.skill-source-filters button span { font-size:11px; opacity:.8; }
.skill-source-filters button.active { color:var(--qdd-text); background:var(--qdd-surface); box-shadow:0 1px 3px rgb(0 0 0 / 6%); font-weight:600; }
.skills-layout { display:grid; grid-template-columns:minmax(250px, .8fr) minmax(0, 1.8fr); align-items:start; gap:22px; }
.skill-library { min-width:0; }
.library-heading { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:12px; padding:0 2px; }
.library-heading h2 { margin:0; font-size:13px; font-weight:600; }
.library-heading > span { color:var(--qdd-muted); font-size:11px; }
.skill-list { display:grid; gap:9px; }
.skill-select { display:block; min-width:0; width:100%; padding:17px; border:1px solid var(--qdd-border); border-radius:10px; background:var(--qdd-surface); color:var(--qdd-text); text-align:left; transition:background .15s, border-color .15s; }
.skill-select:hover { background:var(--qdd-hover); }
.skill-select.selected { border-color:var(--qdd-primary); background:var(--qdd-primary-soft); }
.skill-card-heading { display:flex; align-items:center; gap:10px; }
.skill-mark { display:grid; place-items:center; flex:0 0 31px; height:31px; border-radius:7px; background:var(--qdd-bg); color:var(--qdd-muted); }
.selected .skill-mark { background:var(--qdd-surface); color:var(--qdd-primary); }
.skill-card-heading strong { min-width:0; font-size:14px; line-height:1.6; overflow-wrap:anywhere; }
.skill-chevron { flex-shrink:0; margin-left:auto; color:var(--qdd-muted); }
.selected .skill-chevron { color:var(--qdd-primary); }
.skill-card-description { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; margin:11px 0 14px; color:var(--qdd-muted); font-size:12px; line-height:1.8; overflow-wrap:anywhere; }
.skill-card-meta { display:flex; align-items:center; justify-content:space-between; gap:10px; color:var(--qdd-muted); font-size:11px; }
.library-template-link { display:flex; align-items:center; justify-content:center; gap:7px; width:100%; padding:15px 8px; margin-top:9px; border:1px dashed var(--qdd-border); border-radius:9px; background:transparent; color:var(--qdd-muted); font-size:12px; }
.library-template-link:hover { color:var(--qdd-primary); border-color:var(--qdd-primary); }
.skill-detail { min-width:0; padding:28px; border:1px solid var(--qdd-border); border-radius:12px; background:var(--qdd-surface); }
.skill-detail-heading { display:flex; align-items:flex-start; justify-content:space-between; flex-wrap:wrap; gap:18px; }
.detail-title { min-width:0; flex:1 1 190px; }
.detail-eyebrow { display:flex; align-items:center; gap:6px; color:var(--qdd-primary); font-size:11px; }
.skill-detail h2 { margin:10px 0 0; font-size:23px; font-weight:650; line-height:1.5; overflow-wrap:anywhere; }
.detail-actions { display:flex; flex-wrap:wrap; gap:8px; padding-top:3px; }
.detail-actions :deep(.el-button + .el-button) { margin-left:0; }
.skill-description { color:var(--qdd-muted); font-size:13px; line-height:1.9; margin:17px 0; overflow-wrap:anywhere; }
.skill-detail-meta { display:flex; align-items:center; flex-wrap:wrap; gap:9px 18px; padding-bottom:24px; border-bottom:1px solid var(--qdd-border); color:var(--qdd-muted); font-size:11px; }
.skill-detail-meta > span { display:flex; align-items:center; gap:5px; }
.detail-section { margin-top:25px; }
.detail-section-heading { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; margin-bottom:16px; }
.detail-section-heading h3 { margin:0; color:var(--qdd-text); font-size:14px; font-weight:600; }
.detail-section-heading > span { color:var(--qdd-muted); font-size:11px; }
.skill-instructions { list-style:none; margin:0; padding:0; }
.skill-instructions li { display:flex; align-items:flex-start; gap:14px; position:relative; padding-bottom:22px; }
.skill-instructions li:last-child { padding-bottom:0; }
.skill-instructions li:not(:last-child)::after { content:""; position:absolute; left:15px; top:38px; bottom:6px; width:1px; background:var(--qdd-border); }
.step-number { display:grid; place-items:center; flex:0 0 32px; height:32px; border:1px solid var(--qdd-border); border-radius:9px; background:var(--qdd-bg); color:var(--qdd-muted); font-size:11px; font-weight:600; font-variant-numeric:tabular-nums; }
.skill-instructions li p { margin:4px 0 0; color:var(--qdd-text); font-size:13px; line-height:1.9; overflow-wrap:anywhere; white-space:pre-wrap; }
.skill-tool-tags { display:flex; flex-wrap:wrap; gap:8px; }
.skill-tool-tags :deep(.el-tag) { max-width:100%; height:auto; white-space:normal; line-height:1.8; }
.skill-run-note { display:flex; align-items:flex-start; gap:9px; padding:13px 15px; margin-top:26px; border-radius:8px; background:var(--qdd-bg); color:var(--qdd-muted); }
.skill-run-note > svg { flex-shrink:0; margin-top:3px; }
.skill-run-note p { margin:0; font-size:12px; line-height:1.8; }
.skill-detail-footer { display:flex; align-items:center; flex-wrap:wrap; gap:12px; margin-top:22px; }
.skill-detail-footer :deep(.el-button) { margin-left:0; font-size:12px; }
.skill-detail-footer :deep(.delete-skill) { margin-left:auto; }
.skills-state { display:flex; align-items:center; flex-direction:column; justify-content:center; min-height:360px; padding:40px 24px; margin-top:23px; border:1px dashed var(--qdd-border); border-radius:12px; text-align:center; }
.state-icon { display:grid; place-items:center; width:62px; height:62px; margin-bottom:20px; border:1px solid var(--qdd-border); border-radius:18px; color:var(--qdd-primary); background:var(--qdd-surface); }
.skills-state h2 { margin:0; font-size:18px; font-weight:600; line-height:1.6; }
.skills-state p { max-width:440px; margin:12px 0 24px; color:var(--qdd-muted); font-size:13px; line-height:1.9; overflow-wrap:anywhere; }
.state-actions { display:flex; flex-wrap:wrap; align-items:center; justify-content:center; gap:10px; }
.state-actions :deep(.el-button + .el-button) { margin-left:0; }
.skills-loading { display:grid; grid-template-columns:1fr 2fr; gap:25px; padding:24px; border:1px solid var(--qdd-border); border-radius:12px; background:var(--qdd-surface); }
.template-heading { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin:26px 0 20px; }
.template-heading h2 { font-size:17px; font-weight:600; margin:0; }
.template-heading p { margin:7px 0 0; color:var(--qdd-muted); font-size:12px; line-height:1.8; }
.template-heading > span { font-size:11px; color:var(--qdd-muted); }
.template-connect-note { padding:12px 15px; margin:0 0 20px; border-radius:8px; background:var(--qdd-primary-soft); color:var(--qdd-primary); font-size:12px; line-height:1.8; }
.example-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:18px; }
.template-card { min-width:0; border-radius:12px; }
.template-card :deep(.el-card__body) { display:flex; flex-direction:column; height:100%; padding:22px; }
.template-card-top { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.template-icon { display:grid; place-items:center; width:44px; height:44px; border-radius:11px; background:var(--qdd-primary-soft); color:var(--qdd-primary); }
.template-category { color:var(--qdd-muted); font-size:11px; }
.template-card h3 { margin:18px 0 8px; font-size:17px; font-weight:600; color:var(--qdd-text); }
.template-description { color:var(--qdd-muted); font-size:12px; line-height:1.9; margin:0; }
.template-steps { display:grid; gap:9px; padding:17px 0 19px; margin:0 0 auto; list-style:none; }
.template-steps li { position:relative; padding-left:12px; color:var(--qdd-muted); font-size:12px; line-height:1.9; overflow-wrap:anywhere; }
.template-steps li::before { content:""; position:absolute; width:4px; height:4px; left:0; top:9px; border-radius:50%; background:var(--qdd-border); }
.template-card-footer { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; padding-top:16px; border-top:1px solid var(--qdd-border); }
.template-card-footer > span { color:var(--qdd-muted); font-size:11px; }
.template-card-footer :deep(.el-button) { margin:0; font-size:12px; }
.skills-page :deep(.skill-editor-dialog) { display:flex; flex-direction:column; max-height:calc(100vh - 48px); max-height:calc(100dvh - 48px); margin:24px auto; padding:0; overflow:hidden; }
.skills-page :deep(.skill-editor-dialog .el-dialog__header) { flex:0 0 auto; margin:0; padding:21px 24px; border-bottom:1px solid var(--qdd-border); background:var(--qdd-surface); }
.skills-page :deep(.skill-editor-dialog .el-dialog__body) { flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain; padding:22px 24px; scroll-padding-block:16px; }
.skills-page :deep(.skill-editor-dialog .el-dialog__footer) { flex:0 0 auto; padding:16px 24px 20px; border-top:1px solid var(--qdd-border); background:var(--qdd-surface); }
.editor-intro { margin:0 0 22px; color:var(--qdd-muted); font-size:13px; line-height:1.8; }
.skill-editor-form :deep(.el-form-item) { margin-bottom:22px; }
.editor-section-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.editor-section-heading h3 { margin:0; color:var(--qdd-text); font-size:14px; font-weight:500; }
.editor-section-heading h3 > span { color:var(--qdd-bad); }
.editor-section-heading > span { color:var(--qdd-muted); font-size:12px; }
.editor-section-note { color:var(--qdd-muted); font-size:12px; line-height:1.8; margin:9px 0 15px; }
.step-editor { width:100%; }
.step-row { display:flex; align-items:flex-start; gap:10px; padding:12px; width:100%; margin-bottom:10px; border:1px solid var(--qdd-border); border-radius:9px; background:var(--qdd-bg); }
.editor-step-number { display:grid; place-items:center; flex:0 0 23px; height:25px; margin-top:4px; color:var(--qdd-muted); font-size:12px; }
.step-row > :deep(.el-textarea) { min-width:0; flex:1; }
.step-actions { display:flex; align-items:center; flex:0 0 auto; gap:1px; padding-top:2px; }
.step-actions :deep(.el-button) { margin:0; padding:7px; }
.move-down { transform:rotate(180deg); }
.add-step { width:100%; border-style:dashed; background:transparent; color:var(--qdd-muted); }
.editor-tools { margin-top:26px; padding-top:18px; border-top:1px solid var(--qdd-border); }
.editor-tools summary { display:flex; align-items:center; gap:9px; color:var(--qdd-text); font-size:13px; list-style:none; cursor:pointer; }
.editor-tools summary::-webkit-details-marker { display:none; }
.editor-tools summary::after { content:"+"; margin-left:3px; color:var(--qdd-muted); font-size:17px; }
.editor-tools[open] summary::after { content:"−"; }
.optional-label { margin-left:8px; color:var(--qdd-muted); font-size:11px; font-weight:400; }
.tools-selected { margin-left:auto; color:var(--qdd-muted); font-size:11px; }
.tool-picker { display:grid; gap:9px; max-height:230px; overflow:auto; width:100%; margin-bottom:20px; }
.tool-options { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px; }
.tool-options :deep(.el-checkbox) { min-width:0; height:auto; margin:0; padding:10px; align-items:flex-start; border:1px solid var(--qdd-border); border-radius:7px; white-space:normal; }
.tool-options :deep(.el-checkbox__input) { margin-top:3px; }
.tool-options :deep(.el-checkbox__label) { display:grid; min-width:0; font-size:12px; line-height:1.7; overflow-wrap:anywhere; }
.tool-options small { color:var(--qdd-muted); font-size:10px; }
.tool-note { font-size:12px; color:var(--qdd-muted); line-height:1.8; margin:0; }
.form-feedback { margin-bottom:20px; }
@media (prefers-reduced-motion: reduce) { .skill-select { transition:none; } }
@media (max-width:1280px) { .example-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .skill-detail { padding:23px; } }
@media (max-width:1050px) { .skills-layout { grid-template-columns:minmax(0,1fr); } .skill-list { display:flex; overflow-x:auto; padding:3px 3px 9px; margin:-3px -3px 0; scroll-snap-type:x proximity; } .skill-select { flex:0 0 min(280px, 85%); width:min(280px, 85%); scroll-snap-align:start; } .library-template-link { width:auto; border:0; margin:5px 0 0; padding:12px 0; } }
@media (max-width:760px) { .skills-toolbar { gap:12px; } .skills-toolbar > :deep(.el-input) { width:100%; } .skill-detail { padding:20px; } .skill-detail h2 { font-size:21px; } .example-grid { grid-template-columns:minmax(0,1fr); } .skills-tabs { gap:20px; } .skill-source-filters { max-width:100%; } .skills-state { min-height:320px; padding:30px 18px; } .skills-state h2 { font-size:16px; } .step-row { gap:6px; padding:9px; flex-wrap:wrap; } .step-actions { width:100%; justify-content:flex-end; padding:0; } .step-actions :deep(.el-button) { padding:7px 10px; } .tool-options { grid-template-columns:minmax(0,1fr); } }
@media (max-width:760px) { .skills-page :deep(.skill-editor-dialog) { max-height:calc(100vh - 32px); max-height:calc(100dvh - 32px); margin:16px auto; } .skills-page :deep(.skill-editor-dialog .el-dialog__header) { padding:19px 18px; } .skills-page :deep(.skill-editor-dialog .el-dialog__body) { padding:20px 18px; } .skills-page :deep(.skill-editor-dialog .el-dialog__footer) { padding:14px 18px 16px; } }
@media (max-width:460px) { .skill-source-filters button { padding:7px 9px; } .skill-detail-heading { gap:13px; } .detail-actions { width:100%; } .detail-actions :deep(.el-button--primary) { flex:1; } .template-card :deep(.el-card__body) { padding:20px; } }
</style>

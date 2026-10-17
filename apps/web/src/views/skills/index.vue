<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { ElAlert, ElButton, ElCard, ElCheckbox, ElCheckboxGroup, ElDialog, ElEmpty, ElForm, ElFormItem, ElInput, ElMessageBox, ElSkeleton, ElTag } from "element-plus";
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
const query = ref("");
const filteredSkills = computed(() => skills.value.filter((skill) =>
  `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
// Local examples are templates; they are never counted as saved skills.
const templates = [
  { name: "临期预警", description: "提前发现临期商品，整理优先处理建议。", steps: ["查询商品批次与保质期，找出未来 3 天内到期的商品。", "结合库存与货架情况列出优先处理的商品。", "给出处理建议；涉及改价或发布时先交给店长确认。"] },
  { name: "经营日报", description: "汇总销售表现，找出值得关注的变化。", steps: ["汇总昨日销售额、订单量和各品类表现。", "比较前一日及上周同期，标出明显变化。", "说明数据依据，整理今日经营关注事项。"] },
  { name: "损耗分析", description: "追踪高损耗商品，梳理变化原因。", steps: ["确认门店、时间范围与损耗口径。", "汇总商品和品类损耗，对照采购、销售与库存变化。", "给出可验证的原因线索和处理建议。"] },
  { name: "排班建议", description: "结合客流与员工安排，准备合适班次。", steps: ["确认营业时间、岗位与员工可出勤时间。", "结合客流高峰检查人手需求、休息时间及岗位覆盖。", "输出排班建议，将冲突交给店长确认。"] },
  { name: "补货建议", description: "结合销售与库存，规划下一次补货。", steps: ["确认补货周期、到货时间与安全库存要求。", "对照近期销量、当前库存及在途采购。", "列出建议补货量、估算依据与需要店长确认的采购。"] },
];
const editorOpen = ref(false);
const editingId = ref<string | null>(null);
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

watch(filteredSkills, (entries) => {
  if (!entries.some((skill) => skill.id === selectedId.value)) selectedId.value = entries[0]?.id ?? "";
}, { immediate: true });
function errorText(cause: unknown): string {
  return cause instanceof TypeError ? "暂时无法连接工作空间，请检查连接后重试。" : cause instanceof Error ? cause.message : "操作失败，请稍后重试。";
}
function toolTitle(tool: ToolInfo): string { return tool.description.split(/[：:。\r\n]/)[0]?.trim() || "数据工具"; }
function updateSelectedTools(value: unknown) {
  if (saving.value || !Array.isArray(value)) return;
  form.tools = value.filter((name): name is string => typeof name === "string");
}
function openEditor(skill?: Skill, template?: (typeof templates)[number]) {
  editorVersion++;
  editingId.value = skill?.id ?? null;
  const content = skill ?? template;
  Object.assign(form, {
    name: content?.name ?? "", description: content?.description ?? "", steps: content ? [...content.steps] : [""],
    tools: skill?.tools.filter((name) => availableTools.value.some((tool) => tool.name === name)) ?? [],
    extraTools: skill?.tools.filter((name) => !availableTools.value.some((tool) => tool.name === name)).join("\n") ?? "",
  });
  formError.value = "";
  editorOpen.value = true;
}
function closeEditor() {
  editorVersion++;
  saveController?.abort();
  saving.value = false;
}
function resetOperations() {
  version++;
  for (const controller of controllers) controller.abort();
  controllers.clear();
  saving.value = false;
  busyId.value = "";
  runningId.value = "";
  editorOpen.value = false;
  formError.value = "";
  actionError.value = "";
}
watch([gatewayUrl, token, connected], resetOperations, { flush: "sync" });
onBeforeUnmount(resetOperations);
async function save() {
  if (!connected.value || saving.value) return;
  const steps = form.steps.map((step) => step.trim());
  if (!form.name.trim() || steps.length < 1 || steps.length > 12 || steps.some((step) => !step)) {
    formError.value = "请填写技能名称与 1–12 个完整步骤。";
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
  formError.value = "";
  try {
    const skill = editingId.value
      ? await updateSkill(gatewayUrl.value, token.value, editingId.value, input, controller.signal)
      : await createSkill(gatewayUrl.value, token.value, input, controller.signal);
    if (controller.signal.aborted || currentVersion !== version || currentEditor !== editorVersion) return;
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
      <div><span class="feature-eyebrow">技能</span><h1>把常做的事，整理成可复用的技能</h1><p>保存门店的做事方法，交给助手按步骤执行。</p></div>
      <ElButton type="primary" :disabled="!connected" @click="openEditor()"><AgentIcon name="plus" :size="16" />新建技能</ElButton>
    </header>
    <ElAlert v-if="error || actionError" :title="actionError || error" type="error" show-icon :closable="false" />
    <ElAlert v-if="!connected" title="连接工作空间后，管理并运行你的技能。" type="info" show-icon :closable="false" />
    <div class="skills-toolbar"><ElInput v-model="query" clearable placeholder="搜索已保存技能" aria-label="搜索已保存技能" /><span>{{ skills.length }} 个技能</span><ElButton :disabled="!connected" :loading="loading" @click="refresh">刷新</ElButton></div>
    <ElSkeleton v-if="loading && !data" :rows="6" animated />
    <div v-else-if="filteredSkills.length" class="skills-layout">
      <section class="skill-template-list" aria-label="已保存技能">
        <ElButton v-for="skill in filteredSkills" :key="skill.id" class="skill-template-select" :class="{ selected: selectedId === skill.id }" :aria-pressed="selectedId === skill.id" @click="selectedId = skill.id">
          <span class="skill-template-heading"><AgentIcon name="spark" :size="18" /><strong>{{ skill.name }}</strong></span><span class="skill-template-description">{{ skill.description || "打开查看做事步骤" }}</span><ElTag type="info" size="small" effect="plain">{{ skill.source === "agent" ? "对话提炼" : "你创建" }}</ElTag>
        </ElButton>
      </section>
      <ElCard v-if="selectedSkill" class="skill-detail" shadow="never">
        <div class="skill-detail-heading"><div><span class="detail-eyebrow">{{ selectedSkill.source === "agent" ? "来自助手对话" : "我的技能" }}</span><h2>{{ selectedSkill.name }}</h2></div><div class="detail-actions"><ElButton :disabled="!connected || !!busyId" @click="openEditor(selectedSkill)">编辑</ElButton><ElButton type="danger" plain :loading="busyId === selectedSkill.id" :disabled="!connected || !!busyId" @click="remove(selectedSkill)">删除</ElButton></div></div>
        <p class="skill-description">{{ selectedSkill.description }}</p>
        <div class="detail-section"><h3>做事步骤</h3><ol class="skill-instructions"><li v-for="(step, index) in selectedSkill.steps" :key="index">{{ step }}</li></ol></div>
        <div v-if="selectedSkill.tools.length" class="detail-section"><h3>需要的工具</h3><div class="skill-tool-tags"><ElTag v-for="name in selectedSkill.tools" :key="name" type="info" effect="plain" :title="name">{{ availableTools.find((tool) => tool.name === name) ? toolTitle(availableTools.find((tool) => tool.name === name)!) : name }}</ElTag></div></div>
        <div class="skill-detail-footer"><ElButton type="primary" :loading="runningId === selectedSkill.id" :disabled="!connected || !!runningId" @click="run(selectedSkill)"><AgentIcon name="arrow" :size="16" />运行技能</ElButton><ElButton v-if="selectedSkill.sessionId" link type="primary" @click="navigation.openSession(selectedSkill.sessionId)">查看来源对话</ElButton></div>
      </ElCard>
    </div>
    <ElCard v-else shadow="never"><ElEmpty :description="query ? '没有找到相关技能' : '还没有保存的技能'" :image-size="65"><ElButton :disabled="!connected" @click="openEditor()">创建第一个技能</ElButton></ElEmpty></ElCard>

    <section class="skill-examples"><div class="template-heading"><h2>从模板开始</h2><span>以下是做事方法示例，保存后才会加入技能库。</span></div><div class="example-grid"><ElCard v-for="template in templates" :key="template.name" shadow="never"><h3>{{ template.name }}<ElTag type="info" size="small" effect="plain">模板</ElTag></h3><p>{{ template.description }}</p><ElButton link type="primary" :disabled="!connected" @click="openEditor(undefined, template)">使用模板<AgentIcon name="chevron" :size="14" /></ElButton></ElCard></div></section>

    <ElDialog v-model="editorOpen" :title="editingId ? '编辑技能' : '新建技能'" width="min(700px, calc(100vw - 32px))" destroy-on-close :close-on-click-modal="!saving" @close="closeEditor">
      <ElForm :model="form" label-position="top" :disabled="saving" @submit.prevent="save">
        <ElAlert v-if="formError" :title="formError" type="error" show-icon :closable="false" class="form-feedback" />
        <ElFormItem label="技能名称" required><ElInput v-model="form.name" maxlength="30" placeholder="给做事方法起一个名字" /></ElFormItem>
        <ElFormItem label="简短说明"><ElInput v-model="form.description" maxlength="200" placeholder="这个技能可以帮你做什么" /></ElFormItem>
        <ElFormItem label="做事步骤" required><div class="step-editor"><div v-for="(_step, index) in form.steps" :key="index" class="step-row"><span>{{ index + 1 }}</span><ElInput v-model="form.steps[index]" type="textarea" :autosize="{ minRows: 1, maxRows: 4 }" maxlength="300" :aria-label="`第 ${index + 1} 个步骤`" /><ElButton text type="danger" :disabled="form.steps.length === 1" :aria-label="`移除第 ${index + 1} 个步骤`" @click="form.steps.splice(index, 1)"><AgentIcon name="close" :size="16" /></ElButton></div><ElButton :disabled="form.steps.length >= 12" @click="form.steps.push('')">添加步骤</ElButton></div></ElFormItem>
        <ElFormItem label="可用数据工具（可选）"><div class="tool-picker"><p v-if="toolsResource.error.value" class="tool-note">{{ toolsResource.error.value }}</p><ElCheckboxGroup class="tool-options" :model-value="form.tools" :disabled="saving" aria-label="可用数据工具" @update:model-value="updateSelectedTools"><ElCheckbox v-for="tool in availableTools" :key="tool.name" :title="tool.name" :value="tool.name">{{ toolTitle(tool) }}</ElCheckbox></ElCheckboxGroup><p v-if="!availableTools.length" class="tool-note">尚未加载数据工具，也可以先保存做事步骤。</p></div></ElFormItem>
        <ElFormItem label="其他工具标识（可选）"><ElInput v-model="form.extraTools" type="textarea" :rows="2" placeholder="每行一个准确的工具标识，例如 send_notification" /></ElFormItem>
      </ElForm>
      <template #footer><ElButton :disabled="saving" @click="editorOpen = false">取消</ElButton><ElButton type="primary" :loading="saving" :disabled="!connected" @click="save">保存技能</ElButton></template>
    </ElDialog>
  </div>
</template>

<style scoped>
.skills-toolbar { display:flex; align-items:center; gap:14px; margin:22px 0; }
.skills-toolbar > :deep(.el-input) { width:min(360px,100%); }
.skills-toolbar > span { color:var(--qdd-muted); font-size:12px; white-space:nowrap; }
.skills-toolbar > :deep(.el-button) { margin-left:auto; }
.skills-layout { display:grid; grid-template-columns:260px minmax(0,1fr); align-items:start; gap:22px; }
.skill-template-list { display:grid; gap:10px; min-width:0; }
.skill-template-select { display:block; width:100%; min-width:0; height:auto; margin:0; border:1px solid var(--qdd-border)!important; border-radius:var(--qdd-radius); padding:18px; background:var(--qdd-surface); text-align:left; color:var(--qdd-text); white-space:normal; line-height:normal; }
.skill-template-select :deep(> span) { display:block; width:100%; }
.skill-template-select.selected { border-color:var(--qdd-primary)!important; background:var(--qdd-primary-soft); }
.skill-template-heading { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.skill-template-select strong { font-size:14px; overflow-wrap:anywhere; }
.skill-template-description { display:block; color:var(--qdd-muted); font-size:12px; line-height:1.8; margin:10px 0; overflow-wrap:anywhere; }
.skill-detail { min-width:0; }
.skill-detail :deep(.el-card__body) { padding:26px; }
.skill-detail-heading { display:flex; align-items:flex-start; justify-content:space-between; flex-wrap:wrap; gap:16px; min-width:0; }
.skill-detail-heading > div { min-width:0; }
.detail-actions { display:flex; flex-wrap:wrap; gap:8px; }
.detail-actions :deep(.el-button + .el-button) { margin-left:0; }
.detail-eyebrow { color:var(--qdd-muted); font-size:12px; }
.skill-detail h2 { margin:7px 0 0; font-size:23px; overflow-wrap:anywhere; }
.skill-description { color:var(--qdd-muted); line-height:1.8; margin:16px 0 25px; overflow-wrap:anywhere; }
.detail-section { margin-top:24px; }
.detail-section h3 { margin:0 0 12px; color:var(--qdd-muted); font-size:12px; font-weight:500; }
.skill-instructions { padding:18px 22px 18px 38px; border:1px solid var(--qdd-border); border-radius:8px; background:var(--qdd-bg); font-size:13px; line-height:2; overflow-wrap:anywhere; }
.skill-instructions li + li { margin-top:10px; }
.skill-tool-tags { display:flex; flex-wrap:wrap; gap:8px; }
.skill-tool-tags :deep(.el-tag) { max-width:100%; height:auto; white-space:normal; line-height:1.8; }
.skill-detail-footer { display:flex; flex-wrap:wrap; gap:10px; margin-top:28px; padding-top:22px; border-top:1px solid var(--qdd-border); }
.skill-examples { margin-top:32px; }
.template-heading { display:flex; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:16px; }
.template-heading h2 { font-size:17px; margin:0; }
.template-heading span { font-size:12px; color:var(--qdd-muted); }
.example-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; }
.example-grid h3 { display:flex; align-items:center; flex-wrap:wrap; gap:9px; margin:0 0 10px; font-size:15px; }
.example-grid p { color:var(--qdd-muted); font-size:12px; line-height:1.8; margin:0 0 16px; }
.step-editor { width:100%; }
.step-row { display:flex; align-items:flex-start; gap:9px; width:100%; margin-bottom:10px; }
.step-row > span { color:var(--qdd-muted); font-size:12px; padding-top:6px; }
.step-row > :deep(.el-button) { margin:0; padding:6px; }
.tool-picker { display:grid; gap:9px; max-height:210px; overflow:auto; width:100%; }
.tool-options { display:grid; gap:9px; }
.tool-options :deep(.el-checkbox) { height:auto; min-width:0; margin:0; align-items:flex-start; white-space:normal; }
.tool-options :deep(.el-checkbox__input) { margin-top:3px; }
.tool-options :deep(.el-checkbox__label) { min-width:0; font-size:12px; line-height:1.7; overflow-wrap:anywhere; }
.tool-note { font-size:12px; color:var(--qdd-muted); margin:0; }
.form-feedback { margin-bottom:20px; }
@media(max-width:1024px) { .skills-layout { grid-template-columns:minmax(0,1fr); } .skill-template-list { grid-template-columns:repeat(2,minmax(0,1fr)); } .example-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media(max-width:760px) { .skills-toolbar { flex-wrap:wrap; } .skills-toolbar > :deep(.el-input) { width:100%; } .skill-detail :deep(.el-card__body) { padding:20px; } .example-grid { grid-template-columns:minmax(0,1fr); } }
@media(max-width:420px) { .skill-template-list { grid-template-columns:minmax(0,1fr); } }
</style>

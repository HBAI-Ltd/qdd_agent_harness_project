<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { ElAlert, ElButton, ElCard, ElDialog, ElForm, ElFormItem, ElInput, ElTag } from "element-plus";
import AgentIcon from "@/components/AgentIcon.vue";
import { useWorkspaceContext } from "@/composables/workspaceContext";

interface SkillTemplate {
  id: string;
  name: string;
  description: string;
  tools: string[];
  instructions: string;
}

const { draft, navigation } = useWorkspaceContext();
// TODO: Load the user's persisted skills and available templates from the skills catalog API when available.
const templates: SkillTemplate[] = [
  { id: "expiry", name: "临期预警", description: "提前发现临期商品，整理优先处理建议。", tools: ["库存查询", "货架识别", "消息通知"], instructions: "1. 查询商品批次与保质期，找出未来 3 天内到期的商品。\n2. 结合实际库存和货架情况，列出需要优先处理的商品。\n3. 给出补货、促销或陈列建议，并整理为一份提醒。\n4. 涉及改价或对外发布时，先交给店长确认。" },
  { id: "daily", name: "经营日报", description: "汇总销售表现，找出今天值得关注的变化。", tools: ["销售查询", "订单分析", "消息通知"], instructions: "1. 汇总昨日销售额、订单量和各品类表现。\n2. 与前一日及上周同期比较，标出明显变化。\n3. 结合可用数据解释变化，区分事实与待核实线索。\n4. 整理成简短的经营日报，并列出今天的关注事项。" },
  { id: "loss", name: "损耗分析", description: "梳理损耗变化，追踪高损耗商品与原因。", tools: ["库存查询", "商品明细", "销售查询"], instructions: "1. 确认需要分析的门店、时间范围与损耗口径。\n2. 汇总各商品和品类的损耗数量与金额。\n3. 对照采购、销售和库存变化，找出异常集中点。\n4. 给出可验证的原因线索与下一步处理建议。" },
  { id: "staffing", name: "排班建议", description: "结合客流与工作安排，准备更合适的班次。", tools: ["客流查询", "排班信息"], instructions: "1. 确认营业时间、岗位需求和员工可出勤时间。\n2. 根据历史客流和高峰时段，估算各时段的人手需求。\n3. 检查休息时间、连续班次和岗位覆盖。\n4. 输出排班建议，并将需要协调的冲突交给店长确认。" },
  { id: "restock", name: "补货建议", description: "结合销售与现有库存，规划下一次补货。", tools: ["库存查询", "销售趋势", "采购信息"], instructions: "1. 确认补货周期、到货时间和安全库存要求。\n2. 对照近期销量、当前库存与在途采购。\n3. 考虑保质期、季节和异常销售变化，给出建议补货量。\n4. 标出缺少的数据和估算依据，采购执行前由店长确认。" },
];
const selectedId = ref(templates[0]!.id);
const selectedSkill = computed(() => templates.find((template) => template.id === selectedId.value) ?? templates[0]!);
const editorOpen = ref(false);
const creating = ref(false);
const editForm = reactive({ name: "", description: "", instructions: "" });
const preparingConversation = ref(false);

function editTemplate(template?: SkillTemplate) {
  creating.value = !template;
  Object.assign(editForm, template
    ? { name: template.name, description: template.description, instructions: template.instructions }
    : { name: "", description: "", instructions: "" });
  editorOpen.value = true;
}
function saveSkill() {
  // TODO: Persist skill definitions through the skills API when it becomes available.
}
function runSkill() {
  // TODO: Execute saved skills through the skills API when it becomes available.
}
async function discussTemplate() {
  if (preparingConversation.value) return;
  preparingConversation.value = true;
  try {
    const template = selectedSkill.value;
    const opening = navigation.newConversation();
    draft.value = `我想梳理一个“${template.name}”的做事方法，请先和我确认所需数据与规则：\n${template.instructions}`;
    await opening;
  } finally {
    preparingConversation.value = false;
  }
}
</script>

<template>
  <div class="feature-page skills-page">
    <header class="feature-header">
      <div><span class="feature-eyebrow">技能</span><h1>把常做的事，整理成可复用的技能</h1><p>从一个做事方法开始，让门店助手逐步了解你的经营习惯。</p></div>
      <ElButton type="primary" @click="editTemplate()"><AgentIcon name="plus" :size="16" />新建技能</ElButton>
    </header>
    <ElAlert title="先看看技能模板；技能保存与运行即将开放。" type="info" show-icon :closable="false" />

    <div class="skills-layout">
      <section class="skill-template-list" aria-label="技能模板">
        <button v-for="template in templates" :key="template.id" class="skill-template-select" :class="{ selected: selectedId === template.id }" :aria-pressed="selectedId === template.id" @click="selectedId = template.id">
          <div><span class="skill-icon"><AgentIcon :name="template.id === 'staffing' ? 'plan' : template.id === 'daily' ? 'shop' : 'spark'" :size="18" /></span><strong>{{ template.name }}</strong><ElTag type="info" size="small" effect="plain">模板</ElTag></div>
          <p>{{ template.description }}</p>
        </button>
      </section>

      <ElCard class="skill-detail" shadow="never">
        <div class="skill-detail-heading"><div><span class="detail-eyebrow">技能模板</span><h2>{{ selectedSkill.name }}</h2></div><ElButton @click="editTemplate(selectedSkill)"><AgentIcon name="edit" :size="15" />编辑预览</ElButton></div>
        <p class="skill-description">{{ selectedSkill.description }}</p>
        <div class="detail-section"><h3>做事步骤</h3><div class="skill-instructions">{{ selectedSkill.instructions }}</div></div>
        <div class="detail-section"><h3>需要的能力</h3><div class="skill-tool-tags"><ElTag v-for="tool in selectedSkill.tools" :key="tool" type="info" effect="plain" round>{{ tool }}</ElTag></div><p class="tool-note">实际可用能力取决于工作空间已接入的工具。</p></div>
        <div class="skill-detail-footer"><ElButton type="primary" :loading="preparingConversation" @click="discussTemplate"><AgentIcon name="chat" :size="16" />带到对话中完善</ElButton><ElButton disabled @click="runSkill">运行技能 · 即将开放</ElButton></div>
      </ElCard>
    </div>

    <ElDialog v-model="editorOpen" :title="creating ? '新建技能 · 预览' : '编辑技能模板 · 预览'" width="min(660px, calc(100vw - 32px))" destroy-on-close>
      <div class="skill-editor-content"><ElAlert title="这里可以预览技能内容，暂时不会保存到技能库。" type="info" show-icon :closable="false" /><ElForm :model="editForm" label-position="top" class="skill-editor-form" @submit.prevent>
        <ElFormItem label="技能名称"><ElInput v-model="editForm.name" maxlength="60" placeholder="给这个做事方法起一个名字" /></ElFormItem>
        <ElFormItem label="简短说明"><ElInput v-model="editForm.description" maxlength="200" placeholder="这个技能可以帮你做什么" /></ElFormItem>
        <ElFormItem label="做事步骤"><ElInput v-model="editForm.instructions" type="textarea" :autosize="{ minRows: 8, maxRows: 14 }" placeholder="描述需要的数据、处理步骤和需要你确认的操作" /></ElFormItem>
      </ElForm></div>
      <template #footer><ElButton @click="editorOpen = false">关闭预览</ElButton><ElButton type="primary" disabled @click="saveSkill">保存技能 · 即将开放</ElButton></template>
    </ElDialog>
  </div>
</template>

<style scoped>
.skills-page > :deep(.el-alert) { margin-bottom: 24px; }
.feature-header > :deep(.el-button > span), .skill-detail :deep(.el-button > span) { display: inline-flex; align-items: center; gap: 7px; }
.skills-layout { display: grid; grid-template-columns: 270px minmax(0, 1fr); align-items: start; gap: 22px; }
.skill-template-list { display: grid; gap: 10px; }
.skill-template-select { display: block; width: 100%; border: 1px solid var(--qdd-border) !important; border-radius: var(--qdd-radius); padding: 18px; background: var(--qdd-surface); text-align: left; }
.skill-template-select.selected { border-color: var(--qdd-primary) !important; background: var(--qdd-primary-soft); }
.skill-template-select:hover { border-color: var(--qdd-primary) !important; }
.skill-template-select > div { display: flex; align-items: center; gap: 9px; }
.skill-template-select strong { font-size: 14px; font-weight: 600; }
.skill-template-select :deep(.el-tag) { margin-left: auto; }
.skill-icon { color: var(--qdd-muted); display: inline-flex; }
.selected .skill-icon, .selected strong { color: var(--qdd-primary); }
.skill-template-select p { margin: 10px 0 0; color: var(--qdd-muted); font-size: 12px; line-height: 1.8; }
.skill-detail { border-radius: var(--qdd-radius); }
.skill-detail :deep(.el-card__body) { padding: 28px; }
.skill-detail-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.detail-eyebrow { color: var(--qdd-muted); font-size: 12px; }
.skill-detail h2 { margin: 7px 0 0; font-size: 23px; font-weight: 600; }
.skill-description { color: var(--qdd-muted); line-height: 1.8; margin: 16px 0 27px; }
.detail-section { margin-top: 25px; }
.detail-section h3 { margin: 0 0 12px; color: var(--qdd-muted); font-size: 12px; font-weight: 500; }
.skill-instructions { padding: 20px; background: var(--qdd-bg); border: 1px solid var(--qdd-border); border-radius: 8px; white-space: pre-line; font-size: 13px; line-height: 2.3; }
.skill-tool-tags { display: flex; gap: 8px; flex-wrap: wrap; }
.tool-note { color: var(--qdd-muted); font-size: 12px; margin: 12px 0 0; }
.skill-detail-footer { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 30px; padding-top: 23px; border-top: 1px solid var(--qdd-border); }
.skill-detail-footer :deep(.el-button + .el-button) { margin-left: 0; }
.skill-editor-form { margin-top: 24px; }
@media (max-width: 1080px) { .skills-layout { grid-template-columns: 230px minmax(0, 1fr); gap: 16px; } .skill-detail :deep(.el-card__body) { padding: 22px; } }
@media (max-width: 760px) { .skills-layout { grid-template-columns: minmax(0, 1fr); } .skill-template-list { grid-template-columns: repeat(2, minmax(0, 1fr)); } .skill-template-select { padding: 14px; } .skill-template-select > div { flex-wrap: wrap; gap: 6px; } .skill-template-select :deep(.el-tag) { margin-left: 0; } .skill-template-select p { font-size: 11px; } .skill-detail-heading { align-items: flex-start; } .skill-detail h2 { font-size: 21px; } .skill-instructions { padding: 16px; } }
@media (max-width: 420px) { .skill-template-list { grid-template-columns: minmax(0, 1fr); } }
</style>

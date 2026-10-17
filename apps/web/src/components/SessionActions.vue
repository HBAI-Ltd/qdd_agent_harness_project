<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElButton, ElCard, ElCheckboxButton, ElCheckboxGroup, ElCollapse, ElCollapseItem, ElInput, ElRadioButton, ElRadioGroup } from "element-plus";
import type { ClarifyAnswers, ClarifyQuestion, SessionEvent, SessionStatus } from "@qdd/shared";
import AgentIcon from "@/components/AgentIcon.vue";

const props = defineProps<{
  sessionId?: string;
  events: SessionEvent[];
  busy?: boolean;
  status?: SessionStatus;
}>();
const emit = defineEmits<{
  answer: [requestId: string, answers: ClarifyAnswers];
  approve: [requestId: string, approved: boolean];
}>();
type QuestionEvent = Extract<SessionEvent, { type: "question_required" }>;
type ApprovalEvent = Extract<SessionEvent, { type: "approval_required" }>;

const activeEvents = computed(() => {
  if (props.status === "idle" || props.status === "error") return [];
  const lastTerminal = props.events.findLastIndex(
    (event) => event.type === "status" && (event.status === "idle" || event.status === "error"),
  );
  return props.events.slice(lastTerminal + 1);
});
const pendingQuestion = computed(() => {
  const answered = new Set(props.events.filter((event) => event.type === "question_answered").map((event) => event.requestId));
  return activeEvents.value.findLast(
    (event): event is QuestionEvent => event.type === "question_required" && !answered.has(event.requestId),
  );
});
const pendingApprovals = computed(() => {
  const resolved = new Set(props.events.filter((event) => event.type === "approval_resolved").map((event) => event.requestId));
  const pending = new Map<string, ApprovalEvent>();
  for (const event of activeEvents.value) {
    if (event.type === "approval_required" && !resolved.has(event.requestId)) pending.set(event.requestId, event);
  }
  return [...pending.values()];
});
const selections = ref<ClarifyAnswers>({});
const otherSelected = ref<Record<string, boolean>>({});
const otherText = ref<Record<string, string>>({});
const validationError = ref("");

watch([() => props.sessionId, () => pendingQuestion.value?.requestId], () => {
  selections.value = {};
  otherSelected.value = {};
  otherText.value = {};
  validationError.value = "";
  for (const question of pendingQuestion.value?.questions ?? []) {
    selections.value[question.id] = question.options[0] ? [question.options[0].label] : [];
    otherSelected.value[question.id] = false;
    otherText.value[question.id] = "";
  }
}, { immediate: true });

function singleChoice(question: ClarifyQuestion): string {
  if (otherSelected.value[question.id]) return "other";
  const index = question.options.findIndex((option) => selections.value[question.id]?.includes(option.label));
  return index === -1 ? "" : String(index);
}
function multipleChoices(question: ClarifyQuestion): string[] {
  const selected = question.options.flatMap((option, index) => selections.value[question.id]?.includes(option.label) ? [String(index)] : []);
  return otherSelected.value[question.id] ? [...selected, "other"] : selected;
}
function selectSingle(question: ClarifyQuestion, value: unknown) {
  if (props.busy || typeof value !== "string") return;
  const other = question.allowOther && value === "other";
  const option = question.options.find((_, index) => String(index) === value);
  if (!other && !option) return;
  selections.value[question.id] = option ? [option.label] : [];
  otherSelected.value[question.id] = other;
  validationError.value = "";
}
function selectMultiple(question: ClarifyQuestion, values: unknown) {
  if (props.busy || !Array.isArray(values)) return;
  selections.value[question.id] = question.options.filter((_, index) => values.includes(String(index))).map((option) => option.label);
  otherSelected.value[question.id] = question.allowOther && values.includes("other");
  validationError.value = "";
}
const answerSummary = computed(() => (pendingQuestion.value?.questions ?? []).map((question) => {
  const selected = [...(selections.value[question.id] ?? [])];
  if (question.allowOther && otherSelected.value[question.id]) selected.push(otherText.value[question.id]?.trim() || "其他（待填写）");
  return `${question.header}：${selected.join("、") || "待选择"}`;
}).join(" · "));

function submitAnswers() {
  const request = pendingQuestion.value;
  if (!request || props.busy) return;
  const answers: ClarifyAnswers = {};
  for (const question of request.questions) {
    const selected = selections.value[question.id] ?? [];
    const hasOther = question.allowOther && otherSelected.value[question.id];
    const custom = (otherText.value[question.id] ?? "").trim();
    if (hasOther && !custom) {
      validationError.value = `请填写「${question.header}」的其他内容。`;
      return;
    }
    const values = hasOther ? question.multiSelect ? [...selected, custom] : [custom] : [...selected];
    const unique = [...new Set(values)];
    if (!unique.length || (!question.multiSelect && unique.length !== 1)) {
      validationError.value = `请${question.multiSelect ? "至少选择一项" : "选择一项"}回答「${question.header}」。`;
      return;
    }
    answers[question.id] = unique;
  }
  validationError.value = "";
  emit("answer", request.requestId, answers);
}
function approve(requestId: string, approved: boolean) {
  if (!props.busy) emit("approve", requestId, approved);
}
function skillPreview(request: ApprovalEvent) {
  if (request.tool !== "save_skill") return undefined;
  const { name, description, steps, tools } = request.args;
  if (typeof name !== "string" || typeof description !== "string" || !Array.isArray(steps)
    || !steps.every((step): step is string => typeof step === "string")
    || (tools !== undefined && (!Array.isArray(tools) || !tools.every((tool): tool is string => typeof tool === "string")))) return undefined;
  return { name, description, steps, tools: (tools ?? []) as string[] };
}
</script>

<template>
  <div v-if="pendingQuestion || pendingApprovals.length" class="session-actions">
    <div v-if="pendingQuestion" class="action-message">
      <span class="action-avatar"><AgentIcon name="spark" :size="18" /></span>
      <ElCard class="action-card question-card" shadow="never">
        <form @submit.prevent="submitAnswers">
          <header class="action-heading"><strong>门店助手</strong><span>确认需求<template v-if="pendingQuestion.round > 0"> · 第 {{ pendingQuestion.round }} 轮</template></span></header>
          <p class="action-description">先确认{{ pendingQuestion.questions.length > 1 ? "几件事" : "一件事" }}，再继续执行。已默认选择推荐项。</p>
          <div class="question-list">
            <section
              v-for="question in pendingQuestion.questions"
              :key="question.id"
              class="question-row"
              role="group"
              :aria-labelledby="`question-${pendingQuestion.requestId}-${question.id}`">
              <div class="question-label"><span>{{ question.header }}</span><small v-if="question.multiSelect">可多选</small></div>
              <div class="question-content">
                <p :id="`question-${pendingQuestion.requestId}-${question.id}`" class="question-prompt">{{ question.question }}</p>
                <ElCheckboxGroup
                  v-if="question.multiSelect"
                  class="question-options"
                  :model-value="multipleChoices(question)"
                  :disabled="busy"
                  :aria-label="question.question"
                  @update:model-value="selectMultiple(question, $event)">
                  <ElCheckboxButton v-for="(option, index) in question.options" :key="index" :value="String(index)" :title="option.description">{{ option.label }}</ElCheckboxButton>
                  <ElCheckboxButton v-if="question.allowOther" value="other">其他</ElCheckboxButton>
                </ElCheckboxGroup>
                <ElRadioGroup
                  v-else
                  class="question-options"
                  :model-value="singleChoice(question)"
                  :disabled="busy"
                  :aria-label="question.question"
                  @update:model-value="selectSingle(question, $event)">
                  <ElRadioButton v-for="(option, index) in question.options" :key="index" :value="String(index)" :title="option.description">{{ option.label }}</ElRadioButton>
                  <ElRadioButton v-if="question.allowOther" value="other">其他</ElRadioButton>
                </ElRadioGroup>
                <ElInput
                  v-if="question.allowOther && otherSelected[question.id]"
                  v-model="otherText[question.id]"
                  class="question-other"
                  size="small"
                  :maxlength="300"
                  :disabled="busy"
                  :aria-label="`${question.header}的其他内容`"
                  placeholder="填写你的想法"
                  @input="validationError = ''" />
              </div>
            </section>
          </div>
          <p class="answer-summary">{{ answerSummary }}</p>
          <p v-if="validationError" class="action-error" role="alert">{{ validationError }}</p>
          <footer class="action-footer"><ElButton type="primary" native-type="submit" :loading="busy">确认并继续<AgentIcon name="chevron" :size="14" /></ElButton></footer>
        </form>
      </ElCard>
    </div>

    <div v-for="request in pendingApprovals" :key="request.requestId" class="action-message">
      <span class="action-avatar"><AgentIcon name="spark" :size="18" /></span>
      <ElCard class="action-card approval-card" shadow="never">
        <header class="action-heading"><strong>{{ request.tool === "save_skill" ? "把这套做法保存为技能" : "需要你的授权" }}</strong><span>{{ request.tool === "save_skill" ? "保存前确认" : "写入操作" }}</span></header>
        <p class="action-description">{{ request.tool === "save_skill" ? "助手整理了以下步骤，确认后可以在其他对话和定时任务中复用。" : "助手申请执行以下操作，请确认后继续。" }}</p>
        <template v-if="skillPreview(request)">
          <div class="skill-preview">
            <h3>{{ skillPreview(request)?.name }}</h3>
            <p>{{ skillPreview(request)?.description }}</p>
            <ol><li v-for="(step, index) in skillPreview(request)?.steps" :key="index">{{ step }}</li></ol>
            <div v-if="skillPreview(request)?.tools.length" class="skill-preview-tools"><span>会用到的工具</span><div><span v-for="tool in skillPreview(request)?.tools" :key="tool">{{ tool }}</span></div></div>
          </div>
        </template>
        <dl class="approval-details"><div><dt>工具</dt><dd>{{ request.tool }}</dd></div><div><dt>来源</dt><dd>{{ request.source }}</dd></div></dl>
        <ElCollapse class="approval-arguments">
          <ElCollapseItem :name="request.requestId" title="查看操作参数">
            <pre>{{ JSON.stringify(request.args, null, 2) }}</pre>
          </ElCollapseItem>
        </ElCollapse>
        <footer class="action-footer">
          <ElButton :disabled="busy" @click="approve(request.requestId, false)">{{ request.tool === "save_skill" ? "再改改" : "拒绝" }}</ElButton>
          <ElButton type="warning" :disabled="busy" @click="approve(request.requestId, true)">{{ request.tool === "save_skill" ? "就这样，保存为技能" : "允许执行" }}</ElButton>
        </footer>
      </ElCard>
    </div>
  </div>
</template>

<style scoped>
.session-actions { display: grid; gap: 22px; min-width: 0; }
.action-message { display: flex; align-items: flex-start; gap: 13px; min-width: 0; }
.action-avatar { display: grid; flex: 0 0 36px; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: var(--qdd-primary-soft); color: var(--qdd-primary); }
.action-card { flex: 1; min-width: 0; border-radius: 12px; }
.action-card :deep(.el-card__body) { padding: 17px 20px; }
.action-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.action-heading strong { color: var(--qdd-text); font-size: 13px; font-weight: 600; }
.action-heading > span { color: var(--qdd-muted); font-size: 11px; }
.action-description { margin: 8px 0 16px; color: var(--qdd-muted); font-size: 13px; line-height: 1.8; }
.question-list { display: grid; gap: 16px; }
.question-row { display: grid; grid-template-columns: 106px minmax(0, 1fr); gap: 12px; align-items: start; min-width: 0; }
.question-label { padding-top: 3px; color: var(--qdd-muted); font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; }
.question-label small { display: block; font-size: 11px; }
.question-content { min-width: 0; }
.question-prompt { margin: 0 0 7px; color: var(--qdd-text); font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; }
.question-options { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px; }
.question-options :deep(.el-radio-button), .question-options :deep(.el-checkbox-button) { margin: 0; }
.question-options :deep(.el-radio-button__inner), .question-options :deep(.el-checkbox-button__inner) { max-width: 100%; padding: 7px 10px; border: 1px solid var(--qdd-border); border-radius: 6px !important; background: var(--qdd-surface); color: var(--qdd-text); box-shadow: none !important; font-size: 12px; line-height: 1.5; white-space: normal; text-align: left; }
.question-options :deep(.el-radio-button.is-active .el-radio-button__inner), .question-options :deep(.el-checkbox-button.is-checked .el-checkbox-button__inner) { border-color: var(--qdd-primary); background: var(--qdd-primary-soft); color: var(--qdd-primary); }
.question-options :deep(.el-radio-button.is-disabled .el-radio-button__inner), .question-options :deep(.el-checkbox-button.is-disabled .el-checkbox-button__inner) { opacity: .6; }
.question-other { display: block; width: min(100%, 400px); margin-top: 9px; }
.answer-summary { margin: 18px 0 0; padding-top: 12px; border-top: 1px solid var(--qdd-border); color: var(--qdd-muted); font-size: 12px; line-height: 1.9; overflow-wrap: anywhere; }
.action-error { margin: 10px 0 0; color: var(--qdd-bad); font-size: 12px; line-height: 1.8; }
.action-footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 9px; margin-top: 14px; }
.action-footer :deep(.el-button) { margin: 0; font-size: 12px; }
.action-footer :deep(.el-button > span) { gap: 5px; }
.approval-card { border-color: color-mix(in srgb, var(--qdd-warn) 40%, var(--qdd-border)); background: color-mix(in srgb, var(--qdd-warn) 5%, var(--qdd-surface)); }
.approval-card .action-heading strong { color: var(--qdd-warn); }
.skill-preview { margin-bottom: 18px; padding-bottom: 16px; border-bottom: 1px solid var(--qdd-border); }
.skill-preview h3 { margin: 0 0 5px; color: var(--qdd-text); font-size: 20px; font-weight: 600; }
.skill-preview > p { margin: 0 0 12px; color: var(--qdd-muted); font-size: 13px; line-height: 1.8; }
.skill-preview ol { margin: 0 0 14px; padding-left: 22px; color: var(--qdd-text); font-size: 13px; line-height: 1.9; }
.skill-preview-tools > span { color: var(--qdd-muted); font-size: 12px; }
.skill-preview-tools > div { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 7px; }
.skill-preview-tools > div > span { padding: 3px 8px; border: 1px solid var(--qdd-border); border-radius: 5px; background: var(--qdd-surface); font-size: 12px; }
.approval-details { display: grid; gap: 7px; margin: 0 0 12px; font-size: 13px; }
.approval-details > div { display: flex; gap: 16px; }
.approval-details dt { flex: 0 0 auto; color: var(--qdd-muted); }
.approval-details dd { min-width: 0; margin: 0; color: var(--qdd-text); overflow-wrap: anywhere; }
.approval-arguments { --el-collapse-header-height: 28px; --el-collapse-header-bg-color: transparent; --el-collapse-header-text-color: var(--qdd-muted); --el-collapse-header-font-size: 12px; --el-collapse-content-bg-color: transparent; border: 0; }
.approval-arguments :deep(.el-collapse-item__header), .approval-arguments :deep(.el-collapse-item__wrap) { border: 0; }
.approval-arguments :deep(.el-collapse-item__content) { padding-bottom: 0; }
.approval-arguments pre { max-height: 220px; overflow: auto; margin: 10px 0 0; padding: 12px; border: 1px solid var(--qdd-border); border-radius: 6px; background: var(--qdd-surface); color: var(--qdd-text); font: 12px/1.7 Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 760px) {
  .question-row { grid-template-columns: 88px minmax(0, 1fr); gap: 9px; }
  .action-card :deep(.el-card__body) { padding: 15px; }
}
@media (max-width: 460px) {
  .action-message { gap: 9px; }
  .action-avatar { flex-basis: 30px; width: 30px; height: 30px; }
  .question-row { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  .question-label small { display: inline; margin-left: 7px; }
}
</style>

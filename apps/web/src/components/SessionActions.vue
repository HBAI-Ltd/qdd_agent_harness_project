<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ClarifyAnswers, ClarifyQuestion, SessionEvent, SessionStatus } from "@qdd/shared";

const props = defineProps<{
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
  // A failed/interrupted run may finish without resolving every pending request.
  if (props.status === "idle" || props.status === "error") return [];
  const lastTerminal = props.events.findLastIndex(
    (event) => event.type === "status" && (event.status === "idle" || event.status === "error"),
  );
  return props.events.slice(lastTerminal + 1);
});

const pendingQuestion = computed(() => {
  const answered = new Set(
    props.events.filter((event) => event.type === "question_answered")
      .map((event) => event.requestId),
  );
  return activeEvents.value.findLast(
    (event): event is QuestionEvent => event.type === "question_required" && !answered.has(event.requestId),
  );
});

const pendingApprovals = computed(() => {
  const resolved = new Set(
    props.events.filter((event) => event.type === "approval_resolved")
      .map((event) => event.requestId),
  );
  const pending = new Map<string, ApprovalEvent>();
  for (const event of activeEvents.value) {
    if (event.type === "approval_required" && !resolved.has(event.requestId)) {
      pending.set(event.requestId, event);
    }
  }
  return [...pending.values()];
});

const selections = ref<ClarifyAnswers>({});
const otherSelected = ref<Record<string, boolean>>({});
const otherText = ref<Record<string, string>>({});
const validationError = ref("");

watch(
  () => pendingQuestion.value?.requestId,
  () => {
    selections.value = {};
    otherSelected.value = {};
    otherText.value = {};
    validationError.value = "";
    for (const question of pendingQuestion.value?.questions ?? []) {
      selections.value[question.id] = question.options[0] ? [question.options[0].label] : [];
      otherSelected.value[question.id] = false;
      otherText.value[question.id] = "";
    }
  },
  { immediate: true },
);

function selectOption(question: ClarifyQuestion, label: string, checked: boolean) {
  validationError.value = "";
  if (!question.multiSelect) {
    selections.value[question.id] = [label];
    otherSelected.value[question.id] = false;
    return;
  }
  const selected = selections.value[question.id] ?? [];
  selections.value[question.id] = checked
    ? [...new Set([...selected, label])]
    : selected.filter((value) => value !== label);
}

function selectOther(question: ClarifyQuestion, checked: boolean) {
  validationError.value = "";
  otherSelected.value[question.id] = checked;
  if (!question.multiSelect && checked) selections.value[question.id] = [];
}

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
    const values = hasOther
      ? question.multiSelect ? [...selected, custom] : [custom]
      : [...selected];
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
</script>

<template>
  <div v-if="pendingQuestion || pendingApprovals.length" class="session-actions">
    <form v-if="pendingQuestion" class="action-card" @submit.prevent="submitAnswers">
      <header class="action-heading">
        <strong>确认需求</strong>
        <span>第 {{ pendingQuestion.round }} 轮</span>
      </header>
      <p class="action-description">已默认选择推荐项，请确认后提交。</p>
      <fieldset
        v-for="question in pendingQuestion.questions"
        :key="question.id"
        :disabled="busy"
        class="question-field"
      >
        <legend><span>{{ question.header }}</span>{{ question.question }}</legend>
        <p class="selection-hint">{{ question.multiSelect ? "可多选" : "单选" }}</p>
        <label v-for="option in question.options" :key="option.label" class="answer-option">
          <input
            :type="question.multiSelect ? 'checkbox' : 'radio'"
            :name="`${pendingQuestion.requestId}-${question.id}`"
            :checked="selections[question.id]?.includes(option.label)"
            @change="selectOption(question, option.label, ($event.target as HTMLInputElement).checked)"
          />
          <span><strong>{{ option.label }}</strong><small v-if="option.description">{{ option.description }}</small></span>
        </label>
        <label v-if="question.allowOther" class="answer-option">
          <input
            :type="question.multiSelect ? 'checkbox' : 'radio'"
            :name="`${pendingQuestion.requestId}-${question.id}`"
            :checked="otherSelected[question.id]"
            @change="selectOther(question, ($event.target as HTMLInputElement).checked)"
          />
          <span><strong>其他</strong></span>
        </label>
        <input
          v-if="question.allowOther && otherSelected[question.id]"
          v-model="otherText[question.id]"
          class="other-input"
          type="text"
          :aria-label="`${question.header}的其他内容`"
          placeholder="填写你的想法"
        />
      </fieldset>
      <p v-if="validationError" class="validation-error" role="alert">{{ validationError }}</p>
      <footer class="action-footer">
        <button class="primary-action" type="submit" :disabled="busy">{{ busy ? "提交中…" : "确认并继续" }}</button>
      </footer>
    </form>

    <section v-for="request in pendingApprovals" :key="request.requestId" class="action-card">
      <header class="action-heading"><strong>需要你的授权</strong><span>写入操作</span></header>
      <p class="action-description">确认以下操作后，Agent 才会继续执行。</p>
      <dl class="approval-details">
        <div><dt>工具</dt><dd>{{ request.tool }}</dd></div>
        <div><dt>来源</dt><dd>{{ request.source }}</dd></div>
      </dl>
      <pre class="approval-args">{{ JSON.stringify(request.args, null, 2) }}</pre>
      <footer class="action-footer">
        <button class="secondary-action" type="button" :disabled="busy" @click="approve(request.requestId, false)">拒绝</button>
        <button class="primary-action" type="button" :disabled="busy" @click="approve(request.requestId, true)">允许执行</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.session-actions { display: grid; gap: 16px; margin: 0 0 28px 45px; }
.action-card { min-width: 0; padding: 20px; border: 1px solid var(--qdd-border); border-radius: var(--qdd-radius); background: var(--qdd-surface); }
.action-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.action-heading strong { font-size: 13px; font-weight: 600; }
.action-heading > span, .selection-hint { color: var(--qdd-muted); font-size: 10px; }
.action-description { color: var(--qdd-muted); font-size: 11px; line-height: 1.8; margin: 8px 0 18px; }
.question-field { min-width: 0; margin: 0; padding: 0 0 18px; border: 0; }
.question-field + .question-field { padding-top: 16px; border-top: 1px solid var(--qdd-border); }
.question-field legend { display: contents; font-size: 12px; font-weight: 500; line-height: 1.8; overflow-wrap: anywhere; }
.question-field legend > span { display: block; margin-bottom: 4px; color: var(--qdd-muted); font-size: 10px; font-weight: 400; }
.selection-hint { margin: 6px 0 9px; }
.answer-option { display: flex; align-items: flex-start; gap: 9px; padding: 9px 10px; margin: 6px 0; border: 1px solid var(--qdd-border); border-radius: 6px; cursor: pointer; }
.answer-option:has(input:checked) { background: var(--qdd-primary-soft); border-color: var(--qdd-muted); }
.answer-option input { flex-shrink: 0; margin: 3px 0 0; accent-color: var(--qdd-primary); }
.answer-option strong { font-size: 11px; font-weight: 500; }
.answer-option small { display: block; margin-top: 3px; color: var(--qdd-muted); font-size: 10px; line-height: 1.7; }
.answer-option > span { min-width: 0; overflow-wrap: anywhere; }
.other-input { width: 100%; box-sizing: border-box; padding: 9px 10px; border: 1px solid var(--qdd-border); border-radius: 6px; background: var(--qdd-bg); font-size: 12px !important; }
.action-footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 9px; padding-top: 5px; }
.action-footer button { padding: 8px 14px; border-radius: 6px; font-size: 11px; }
.primary-action { background: var(--qdd-primary); color: var(--qdd-on-primary) !important; }
.primary-action:hover { background: var(--qdd-primary-hover); }
.secondary-action { border: 1px solid var(--qdd-border) !important; background: var(--qdd-bg); }
.secondary-action:hover { background: var(--qdd-hover); }
.action-footer button:disabled, .question-field:disabled { opacity: .55; }
.validation-error { margin: 0 0 12px; color: var(--qdd-text); font-size: 11px; line-height: 1.8; }
.approval-details { display: grid; gap: 6px; margin: 0 0 14px; font-size: 11px; }
.approval-details > div { display: flex; gap: 12px; }
.approval-details dt { color: var(--qdd-muted); flex-shrink: 0; }
.approval-details dd { margin: 0; overflow-wrap: anywhere; }
.approval-args { max-height: 240px; overflow: auto; padding: 12px; border-radius: 6px; background: var(--qdd-bg); color: var(--qdd-text); font: 11px/1.7 Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0 0 16px; }
@media (max-width: 760px) { .session-actions { margin-left: 0; } .action-card { padding: 16px; } }
</style>

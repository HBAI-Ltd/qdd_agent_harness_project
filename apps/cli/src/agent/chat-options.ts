import type { ChatModelConfig, ChatOptions, ChatSelection, HarnessConfig, ReasoningEffort } from "@qdd/shared";

const REASONING_EFFORTS: ReasoningEffort[] = ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export class ChatSelectionError extends Error {
  readonly status = 400;
}

export function isDeepSeek(llm: HarnessConfig["llm"]): boolean {
  try {
    return new URL(llm.baseUrl).hostname === "api.deepseek.com";
  } catch {
    return false;
  }
}

/** 模型只来自本地配置；未知服务商的强度必须由配置显式声明。 */
export function chatOptions(llm: HarnessConfig["llm"]): ChatOptions {
  if (typeof llm.model !== "string" || !llm.model.trim()) throw new Error("llm.model 不能为空。");
  if (llm.models !== undefined && !Array.isArray(llm.models)) throw new Error("llm.models 必须是模型数组。");
  const configured = llm.models ?? [];
  const ids = new Set<string>();
  for (const model of configured) {
    if (!model || typeof model.id !== "string" || !model.id.trim() || model.id !== model.id.trim()) throw new Error("llm.models 的模型 id 必须是非空字符串，且不能包含首尾空格。");
    if (ids.has(model.id)) throw new Error(`llm.models 的模型 ${model.id} 重复。`);
    ids.add(model.id);
    if (model.label !== undefined && (typeof model.label !== "string" || !model.label.trim())) throw new Error(`模型 ${model.id} 的 label 必须是非空字符串。`);
  }
  const fallback: ChatModelConfig = { id: llm.model };
  const configs = [configured.find((model) => model.id === llm.model) ?? fallback, ...configured.filter((model) => model.id !== llm.model)];
  const defaultEffort = llm.reasoningEffort ?? (llm.thinking === "disabled" ? "none" : "default");
  if (!REASONING_EFFORTS.includes(defaultEffort)) throw new Error("llm.reasoningEffort 不是支持的思考强度。");
  const models = configs.map((model) => {
    const efforts = model.reasoningEfforts ?? (isDeepSeek(llm) ? ["default", "none", "low", "high", "max"] : ["default"]);
    if (!Array.isArray(efforts) || !efforts.length || efforts.some((effort) => !REASONING_EFFORTS.includes(effort))) throw new Error(`模型 ${model.id} 的 reasoningEfforts 必须是支持的思考强度数组。`);
    const reasoningEfforts = [...new Set(efforts)] as ReasoningEffort[];
    const preferred = model.defaultReasoningEffort ?? defaultEffort;
    if (model.defaultReasoningEffort !== undefined && !reasoningEfforts.includes(model.defaultReasoningEffort)) throw new Error(`模型 ${model.id} 的默认思考强度必须在 reasoningEfforts 中。`);
    return {
      id: model.id,
      label: model.label ?? model.id,
      reasoningEfforts,
      defaultReasoningEffort: reasoningEfforts.includes(preferred) ? preferred : reasoningEfforts[0]!,
    };
  });
  return { models, defaults: { model: llm.model, reasoningEffort: models[0]!.defaultReasoningEffort } };
}

/** 续聊保留该会话设置；只切换模型时，优先保留兼容的强度，否则使用该模型默认值。 */
export function resolveChatSelection(llm: HarnessConfig["llm"], input: Partial<ChatSelection>, previous?: Partial<ChatSelection>): ChatSelection {
  const options = chatOptions(llm);
  if (input.model !== undefined && (typeof input.model !== "string" || !input.model.trim())) throw new ChatSelectionError("model 必须是非空字符串");
  const requested = input.model ?? previous?.model ?? options.defaults.model;
  const model = options.models.find((candidate) => candidate.id === requested);
  if (!model) throw new ChatSelectionError(`模型 ${requested} 未配置，请从可选模型中选择`);
  if (input.reasoningEffort !== undefined && !model.reasoningEfforts.includes(input.reasoningEffort)) throw new ChatSelectionError(`模型 ${model.id} 不支持思考强度 ${String(input.reasoningEffort)}`);
  const retained = previous?.reasoningEffort;
  const reasoningEffort = input.reasoningEffort ?? (retained && model.reasoningEfforts.includes(retained) ? retained : model.defaultReasoningEffort);
  return { model: model.id, reasoningEffort };
}

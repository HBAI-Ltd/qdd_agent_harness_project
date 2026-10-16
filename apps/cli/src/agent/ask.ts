import type { JsonObject } from "@qdd/shared";
import type { DataSources } from "../datasource/registry.js";
import { formatDate } from "../datasource/store.js";
import type { ChatFn, ChatMessage, LlmTool } from "./llm.js";

const MAX_STEPS = 10;
const RESULT_LIMIT = 12_000;

/** 页面运行时调用的 agent：只能用只读数据工具，不能写文件或执行写入操作。 */
export async function runAsk(
  sources: DataSources,
  chat: ChatFn,
  question: string,
  context: unknown,
  onTool: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const readOnly = sources.tools.filter((t) => !t.mutating);
  const tools: LlmTool[] = readOnly.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `你是「钱多多」门店的经营分析助手，今天是 ${formatDate(new Date())}。用只读数据工具核实后回答，不得编造数字。用简体中文，结论先行，简洁。`,
    },
    {
      role: "user",
      content: context === undefined ? question : `${question}\n\n页面提供的上下文：\n${JSON.stringify(context).slice(0, 20_000)}`,
    },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    const reply = await chat(messages, tools, signal);
    messages.push(reply);
    if (!reply.tool_calls?.length) return reply.content?.trim() ?? "";
    for (const call of reply.tool_calls) {
      let output: string;
      try {
        const tool = readOnly.find((t) => t.name === call.function.name);
        if (!tool) throw new Error(`不可用的工具 ${call.function.name}`);
        onTool(call.function.name);
        const args = call.function.arguments ? (JSON.parse(call.function.arguments) as JsonObject) : {};
        output = JSON.stringify(await tool.call(args)).slice(0, RESULT_LIMIT);
      } catch (error) {
        output = `错误：${(error as Error).message}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: output });
    }
  }
  throw new Error("问题过于复杂，未能在限定步数内回答");
}

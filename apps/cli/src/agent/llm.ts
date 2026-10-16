import type { HarnessConfig, JsonObject } from "@qdd/shared";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** DeepSeek 思考模式：同一轮工具调用中需要原样回传。 */
  reasoning_content?: string;
}

export interface LlmTool {
  type: "function";
  function: { name: string; description: string; parameters: JsonObject };
}

export type ChatFn = (messages: ChatMessage[], tools: LlmTool[], signal?: AbortSignal) => Promise<ChatMessage>;

/** OpenAI 兼容的 Chat Completions 客户端（默认 DeepSeek）。 */
export function createChat(llm: HarnessConfig["llm"]): ChatFn {
  const apiKey = process.env[llm.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`缺少环境变量 ${llm.apiKeyEnv}：请在 .env 中填写 DeepSeek API Key。`);
  }
  const endpoint = `${llm.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return async (messages, tools, signal) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: llm.model, messages, tools, tool_choice: "auto", temperature: 0.2 }),
        signal: signal ?? null,
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`LLM 请求失败 ${res.status}：${(await res.text()).slice(0, 500)}`);
      const body = (await res.json()) as { choices: { message: ChatMessage }[] };
      const message = body.choices[0]?.message;
      if (!message) throw new Error("LLM 未返回内容");
      return { ...message, role: "assistant" };
    }
  };
}

import type { AskImage, HarnessConfig, JsonObject } from "@qdd/shared";
import { isDeepSeek } from "./chat-options.js";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** User images become image_url content blocks in the provider request. */
  images?: AskImage[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** DeepSeek 思考模式：同一轮工具调用中需要原样回传。 */
  reasoning_content?: string;
}

export interface LlmTool {
  type: "function";
  function: { name: string; description: string; parameters: JsonObject };
}

/** 流式增量：思考、正文与工具调用按到达顺序推送，index 为该块在本条回复 parts 中的位置。 */
export type ChatDelta =
  | { type: "thinking" | "text"; index: number; delta: string }
  | { type: "tool"; index: number; id: string; name: string };

export type ChatFn = (messages: ChatMessage[], tools: LlmTool[], signal?: AbortSignal, onDelta?: (delta: ChatDelta) => void) => Promise<ChatMessage>;

interface StreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  error?: { message?: string };
}

/** 回复内容块的顺序：思考、正文、工具调用各自占一个 index，与 Toonflow 的 contentIndex 对齐。 */
export function replyParts(message: ChatMessage): ("thinking" | "text" | ToolCall)[] {
  return [
    ...(message.reasoning_content ? ["thinking" as const] : []),
    ...(message.content ? ["text" as const] : []),
    ...(message.tool_calls ?? []),
  ];
}

/** OpenAI 兼容的 Chat Completions 流式客户端（默认 DeepSeek）。 */
export function createChat(llm: HarnessConfig["llm"]): ChatFn {
  const apiKey = process.env[llm.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`缺少环境变量 ${llm.apiKeyEnv}：请在 .env 中填写模型服务的 API Key。`);
  }
  const endpoint = `${llm.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const effort = llm.reasoningEffort ?? "default";
  const thinking = effort === "none" ? "disabled" : effort === "default" ? llm.thinking : "enabled";
  const reasoning = {
    ...(isDeepSeek(llm) ? { thinking: { type: thinking } } : {}),
    ...(effort !== "default" ? { reasoning_effort: effort } : {}),
  };

  return async (messages, tools, signal, onDelta) => {
    const wireMessages = messages.map(({ images, ...message }) => {
      if (!images?.length) return message;
      if (message.role !== "user") throw new Error("图片只能附加到 user 消息");
      return {
        ...message,
        content: [
          { type: "text", text: message.content ?? "" },
          ...images.map((image) => ({ type: "image_url", image_url: image })),
        ],
      };
    });
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: llm.model,
          messages: wireMessages,
          tools,
          tool_choice: "auto",
          temperature: 0.2,
          max_tokens: llm.maxTokens,
          stream: true,
          ...reasoning,
        }),
        signal: signal ?? null,
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`LLM 请求失败 ${res.status}：${(await res.text()).slice(0, 500)}`);
      if (!res.body) throw new Error("LLM 未返回内容");
      return readStream(res.body, onDelta);
    }
  };
}

async function readStream(body: ReadableStream<Uint8Array>, onDelta?: (delta: ChatDelta) => void): Promise<ChatMessage> {
  let reasoning = "";
  let content = "";
  const calls: ToolCall[] = [];
  // 块的顺序按首次到达确定：思考通常先于正文，工具调用在最后。
  const order: string[] = [];
  const indexOf = (key: string) => {
    if (!order.includes(key)) order.push(key);
    return order.indexOf(key);
  };

  const handle = (data: string) => {
    if (data === "[DONE]") return;
    const chunk = JSON.parse(data) as StreamChunk;
    if (chunk.error) throw new Error(`LLM 请求失败：${chunk.error.message ?? data.slice(0, 500)}`);
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      onDelta?.({ type: "thinking", index: indexOf("thinking"), delta: delta.reasoning_content });
    }
    if (delta.content) {
      content += delta.content;
      onDelta?.({ type: "text", index: indexOf("text"), delta: delta.content });
    }
    for (const part of delta.tool_calls ?? []) {
      let call = calls[part.index];
      if (!call) {
        call = calls[part.index] = { id: part.id ?? "", type: "function", function: { name: "", arguments: "" } };
      }
      if (part.id) call.id = part.id;
      if (part.function?.name) call.function.name += part.function.name;
      if (part.function?.arguments) call.function.arguments += part.function.arguments;
      const key = `tool:${part.index}`;
      if (!order.includes(key) && call.id && call.function.name) onDelta?.({ type: "tool", index: indexOf(key), id: call.id, name: call.function.name });
    }
  };

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const line = (value: string) => {
    if (!value) {
      if (data.length) handle(data.join("\n"));
      data = [];
    } else if (value.startsWith("data:")) {
      data.push(value.slice(5).replace(/^ /, ""));
    }
  };
  for (;;) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value, { stream: !chunk.done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    lines.forEach(line);
    if (chunk.done) break;
  }
  if (buffer) line(buffer);
  line("");

  const message: ChatMessage = { role: "assistant", content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  const toolCalls = calls.filter(Boolean);
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (!content && !reasoning && !toolCalls.length) throw new Error("LLM 未返回内容");
  return message;
}

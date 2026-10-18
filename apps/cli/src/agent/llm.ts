import type { AskImage, HarnessConfig, JsonObject } from "@qdd/shared";
import { setTimeout as delay } from "node:timers/promises";
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
  /** 本地响应元数据，不发送给模型。 */
  finishReason?: string;
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
    finish_reason?: string | null;
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

export function assertCompleteResponse(message: ChatMessage): void {
  if (message.finishReason === "length") {
    throw new Error("模型输出达到 token 上限（finish_reason=length），本轮工具未执行。请缩短输出，将页面拆为较小的 HTML、JS、CSS 文件，分多轮调用 write_file；不要原样重试大文件。必要时在模型支持范围内提高 llm.maxTokens。");
  }
  if (message.finishReason === "content_filter") {
    throw new Error("模型输出被内容过滤器中断（finish_reason=content_filter），本轮工具未执行。");
  }
}

export function parseToolArguments(call: ToolCall, reply: ChatMessage): JsonObject {
  assertCompleteResponse(reply);
  let args: unknown;
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const advice = call.function.name === "write_file"
      ? "请缩短 content，将 HTML、JS、CSS 拆成较小文件分多轮写入，并正确转义引号、反斜杠和换行；不要原样重试大文件。"
      : "请重新生成完整、正确转义的 JSON 对象。";
    throw new Error(`${call.function.name} 参数不是完整有效的 JSON，工具未执行（${error.message}）。${advice}`, { cause: error });
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`${call.function.name} 参数必须是 JSON 对象，工具未执行。`);
  }
  return args as JsonObject;
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
      signal?.throwIfAborted();
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: llm.model,
          // 兼容旧会话中误存的纯思考响应；reasoning_content 不能替代正文或工具调用。
          messages: messages
            .filter((message) => message.role !== "assistant" || !!message.content?.trim() || !!message.tool_calls?.length)
            .map(({ finishReason: _finishReason, ...message }) => message),
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
        await res.body?.cancel();
        await delay(1000 * 2 ** attempt, undefined, { signal });
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
  let finishReason: string | undefined;
  let done = false;
  const calls = new Map<number, ToolCall>();
  // 块的顺序按首次到达确定：思考通常先于正文，工具调用在最后。
  const order: string[] = [];
  const indexOf = (key: string) => {
    if (!order.includes(key)) order.push(key);
    return order.indexOf(key);
  };

  const handle = (data: string) => {
    if (done) return;
    if (data === "[DONE]") {
      done = true;
      return;
    }
    const chunk = JSON.parse(data) as StreamChunk;
    if (chunk.error) throw new Error(`LLM 请求失败：${chunk.error.message ?? data.slice(0, 500)}`);
    if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
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
      if (!Number.isSafeInteger(part.index) || part.index < 0) {
        throw new Error("LLM 工具调用 index 必须是非负安全整数，工具未执行。");
      }
      let call = calls.get(part.index);
      if (!call) {
        call = { id: part.id ?? "", type: "function", function: { name: "", arguments: "" } };
        calls.set(part.index, call);
      }
      if (part.id) call.id = part.id;
      if (part.function?.name) call.function.name += part.function.name;
      if (part.function?.arguments) call.function.arguments += part.function.arguments;
      const key = `tool:${part.index}`;
      if (!order.includes(key) && call.id && call.function.name) onDelta?.({ type: "tool", index: indexOf(key), id: call.id, name: call.function.name });
    }
  };

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
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    lines.forEach(line);
    if (done) break;
  }
  buffer += decoder.decode();
  if (buffer) line(buffer);
  line("");
  if (!done && !finishReason) throw new Error("LLM 响应流提前结束，未收到 finish_reason 或 [DONE]，工具未执行。请重试。");

  const message: ChatMessage = { role: "assistant", content: content || null };
  if (finishReason) message.finishReason = finishReason;
  if (reasoning) message.reasoning_content = reasoning;
  const toolCalls = [...calls].sort(([left], [right]) => left - right).map(([, call]) => call);
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (!toolCalls.length) assertCompleteResponse(message);
  if (!content.trim() && !toolCalls.length) {
    throw new Error(reasoning
      ? "LLM 仅返回思考内容，未返回正文或工具调用，本轮响应未加入对话。请重试；若反复出现，可降低思考强度或在模型支持范围内提高 llm.maxTokens。"
      : "LLM 未返回正文或工具调用，请重试。");
  }
  return message;
}

/**
 * LLM Provider 抽象
 *
 * 设计原则:不被任何一家 LLM 厂商锁死。
 * 所有 provider(DeepSeek / Anthropic / OpenAI ...)实现同一接口,Settings 里可切。
 *
 * 高层 API(parseTask / generateBriefing)在 index.ts 里调底层 chat,
 * UI 不直接接触 provider。
 */

export interface ToolCall {
  /** 工具调用 id（回传 tool 结果时要带上） */
  id: string;
  /** 工具名 */
  name: string;
  /** 参数（JSON 字符串） */
  arguments: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** assistant 发起的工具调用（function calling） */
  toolCalls?: ToolCall[];
  /** tool 消息：对应的工具调用 id */
  toolCallId?: string;
}

export interface ChatOptions {
  /** 0-2,越高越发散,默认 0.3(解析任务要稳) */
  temperature?: number;
  /** 限制输出长度 */
  maxTokens?: number;
  /** "json":强制 JSON 输出(deepseek/openai 都支持);"text":自由文本 */
  responseFormat?: "json" | "text";
  /** 覆盖默认 model(比如 chat 强制走 deepseek-reasoner) */
  model?: string;
  /** function calling 工具列表（OpenAI tools 格式）；deepseek-chat 支持，reasoner 不支持 */
  tools?: unknown[];
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Provider / 模型的能力位
 *
 * 上层据此「降级适配」:不支持工具就别传 tools、不支持推理就别期待 reasoning。
 * 关键:能力随「当前生效的 model」变化(同一 provider 换 model 能力不同),
 * 所以由 provider 据「实际 model」据实声明,而不是写死在调用点。
 *
 * 设计意图(Task 0.2 解 reasoner/工具互斥):
 *   旧代码在调用点散落 `model.includes("reasoner")` 来硬 block 工具/JSON。
 *   改成「provider 暴露能力位 + 调用层按能力位降级」,这样 DeepSeek V4 这种
 *   「工具+推理合一」的模型只要 model 名配上,能力位自然全开,无需改调用点。
 */
export interface LLMCapabilities {
  /** 是否支持 function calling(工具) */
  supportsTools: boolean;
  /** 是否支持推理链(reasoning_content / 思考过程) */
  supportsReasoning: boolean;
  /** 是否支持 SSE 流式 */
  supportsStreaming: boolean;
}

export interface ChatResult {
  content: string;
  /** 推理模型的思考过程(deepseek-reasoner / o1 系列才有) */
  reasoning?: string;
  usage?: LLMUsage;
  /** 实际使用的 model(用于 usage 记录) */
  model?: string;
  /** 模型发起的工具调用（function calling）；非空时表示要先执行工具再继续 */
  toolCalls?: ToolCall[];
}

export interface StreamHandlers {
  /** 最终回答的 token */
  onToken: (token: string) => void;
  /** 思考过程的 token(推理模型才会触发) */
  onReasoningToken?: (token: string) => void;
  onDone?: (result: ChatResult) => void;
  onError?: (err: Error) => void;
  signal?: AbortSignal;
}

export interface LLMProvider {
  /** Provider 标识(用于日志、Settings 显示) */
  readonly name: string;
  /** 当前 model(用于 usage 记录) */
  readonly model: string;
  /** 一次性返回完整响应(适合解析、JSON 任务) */
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
  /** 流式响应(适合 Chat 对话);返回最终完整内容 */
  chatStream(
    messages: ChatMessage[],
    opts: ChatOptions,
    handlers: StreamHandlers
  ): Promise<ChatResult>;
  /**
   * 声明能力位。可传入「将要使用的 model」以得到针对该 model 的能力
   * (不传则按 provider 默认 model)。Phase 4 抽统一适配器时,降级逻辑都读这里。
   */
  capabilities(model?: string): LLMCapabilities;
}

/* ---------- 高层 API 的输出类型 ---------- */

import type { Priority } from "../store";

export interface ParseTaskResult {
  title: string;
  reason?: string;
  deadline?: string;
  priority: Priority;
  tags: string[];
  estTime?: string;
  scheduledTime?: string;
  /** LLM 是否成功解析(失败时 fallback 用原文做 title) */
  parsed: boolean;
}

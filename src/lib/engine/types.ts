/**
 * EngineAdapter — 统一引擎适配器接口(Phase 4 的共同接口)
 *
 * 背景:
 *   Phase 0-3 把所有「大脑调用」收口到 llm/index.ts 的 callBrain / callBrainStream,
 *   底层是单一 LLMProvider(现只接 DeepSeek/API 一条引擎)。Phase 4 要接 Claude Code、
 *   Codex 两条本地 CLI 引擎,它们不是「OpenAI 协议的 HTTP provider」,而是无状态的本地
 *   进程适配器。LLMProvider 这个抽象对 HTTP 模型够用,但名字/语义偏「provider」,而
 *   CLI 引擎更适合叫「adapter」。
 *
 *   本文件定义 EngineAdapter:CC / Codex / API 三类引擎的共同接口。API 引擎用
 *   apiAdapter.ts 把现有 LLMProvider 路径包成 EngineAdapter;CC / Codex 后续各自实现。
 *
 * 设计铁律(贯穿 Phase 4):
 *   ① 适配器无状态:每轮由 app 注入〔人设 + 记忆 + 历史〕(都在 messages 里),适配器
 *      不持有任何会话状态、不依赖引擎自身 session/resume。EngineAdapter 的方法签名
 *      据此设计——只接收「完整 messages + opts」,不暴露 sessionId / resume 这类概念。
 *   ② 能力位据「实际 model」声明:同一引擎换 model 能力可能不同,降级逻辑统一读
 *      capabilities(),不在调用点散落字符串判断。
 *
 * 类型复用:
 *   ChatMessage / EngineOptions / EngineResult / StreamHandlers / EngineCapabilities
 *   全部复用 llm/types.ts 的既有定义,这里只做语义化别名 + 重导出,保证「消息/选项/
 *   结果」全应用单一真相源,不产生平行类型。
 */

import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  LLMCapabilities,
  StreamHandlers,
  ToolCall,
} from "../llm/types";

// ─── 语义化别名(单一真相源:全部来自 llm/types) ──────────────────────────────
//
// 为什么用别名而不是新类型:engine 层和 llm 层处理的是同一种「消息/选项/结果」,
// 两套平行类型只会带来转换成本和漂移风险。这里用 type 别名把 llm/types 的定义
// 在 engine 命名空间下重新命名,语义对齐 Phase 4 的「引擎」叙事,底层零拷贝。

/** 一条对话消息(system / user / assistant / tool)。复用 llm/types.ChatMessage。 */
export type EngineMessage = ChatMessage;

/** 单次引擎调用的可选参数(temperature / maxTokens / model / tools 等)。 */
export type EngineOptions = ChatOptions;

/** 引擎调用结果(content / reasoning / toolCalls / usage / model)。 */
export type EngineResult = ChatResult;

/** 流式回调集合(onToken / onReasoningToken / onDone / onError / signal)。 */
export type EngineStreamHandlers = StreamHandlers;

/** 工具调用(function calling)。 */
export type EngineToolCall = ToolCall;

/**
 * 引擎能力位(据「实际 model」声明)。
 *
 * 字段对齐需求里的「supportsTools / supportsReasoning / supportsStreaming」:
 *   - supportsTools:是否支持 function calling(工具)。
 *   - supportsReasoning:是否支持推理链(思考过程)。
 *   - supportsStreaming:是否支持流式输出。
 *
 * 复用 llm/types.LLMCapabilities,字段名与之一致,不另起炉灶。
 */
export type EngineCapabilities = LLMCapabilities;

// 把复用的底层类型也重导出,方便 engine 层调用方一处 import 拿全套,
// 不必同时 from "../llm/types" 和 "./types"。
export type { ChatMessage, ChatOptions, ChatResult, StreamHandlers, ToolCall };

// ─── EngineAdapter 接口 ──────────────────────────────────────────────────────

/**
 * 统一引擎适配器。
 *
 * CC(claude.rs 侧的 TS 适配器)、Codex、API 三类引擎实现同一接口,上层(收口层 /
 * 主动引擎 / 试一句)只面向 EngineAdapter,不关心底下是 HTTP 模型还是本地 CLI 进程。
 *
 * 无状态约束(铁律①):
 *   generate / generateStream 都接收「完整 messages」(含 system 提示词、记忆、历史),
 *   适配器据此一轮算一轮,不在适配器内部累积会话。app 是唯一的状态持有者。
 */
export interface EngineAdapter {
  /**
   * 引擎标识(用于日志、Settings 显示、usage 记录的 provider 字段)。
   * 例:"deepseek" / "claude-code" / "codex"。
   */
  readonly name: string;

  /**
   * 当前默认 model 名(用于 usage 记录与能力位兜底)。
   * 单次调用可由 EngineOptions.model 覆盖。
   */
  readonly model: string;

  /**
   * 非流式生成:输入〔系统提示词 + 消息 + 工具(在 opts.tools)〕→ 输出〔文本 + 可选工具调用〕。
   *
   * 适合结构化任务(解析、JSON、生成简报)和 agent loop 的单轮(模型返回 toolCalls 后,
   * 由上层执行工具、回灌结果、再调一次)。
   *
   * @param messages 完整上下文(含 system),调用方拼好整段传入(无状态)
   * @param opts     temperature / maxTokens / responseFormat / model / tools
   */
  generate(messages: EngineMessage[], opts?: EngineOptions): Promise<EngineResult>;

  /**
   * 流式生成:输入同 generate,通过 handlers 推送文本流 / 思考链流,返回最终完整结果。
   *
   * @param messages 完整上下文(含 system)
   * @param opts     单次调用参数
   * @param handlers 流式回调(onToken / onReasoningToken / onDone / onError / signal)
   */
  generateStream(
    messages: EngineMessage[],
    opts: EngineOptions,
    handlers: EngineStreamHandlers
  ): Promise<EngineResult>;

  /**
   * 声明能力位(据「将要使用的 model」)。
   *
   * @param model 不传则按引擎默认 model。降级逻辑(不支持工具就别传 tools、不支持推理
   *              就别等思考链)统一读这里,不在调用点散落字符串判断。
   */
  capabilities(model?: string): EngineCapabilities;
}

import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  LLMProvider,
  StreamHandlers,
  LLMCapabilities
} from "./types";

/**
 * Mock Provider — 没配 API key 时的降级实现
 *
 * 行为:接到任何 chat 都返回一个"假"的 JSON 或文字,UI 不崩。
 * 用户能看到 mock 数据,但显然不准 — 提醒他在 Settings 里配 key。
 */
export class MockProvider implements LLMProvider {
  readonly name = "mock";
  readonly model = "mock";

  capabilities(): LLMCapabilities {
    // mock 不真正调工具(永远不返回 toolCalls),但会发假的流式 + 假思考链
    return { supportsTools: false, supportsReasoning: true, supportsStreaming: true };
  }

  async chat(messages: ChatMessage[]): Promise<ChatResult> {
    const userMsg = [...messages].reverse().find((m) => m.role === "user");
    const original = userMsg?.content ?? "";
    return {
      content: JSON.stringify({
        title: original.slice(0, 80),
        priority: "none",
        tags: [],
        _mock: true
      })
    };
  }

  async chatStream(
    _messages: ChatMessage[],
    _opts: ChatOptions,
    handlers: StreamHandlers
  ): Promise<ChatResult> {
    const reasoning =
      "(mock 思考)用户没配 LLM key,我应当礼貌提示他去 Settings 填一下,这样后续就能用真模型了。";
    const reply = "未配置 LLM API key,这是 mock 回复。请在 Settings 里填入 DeepSeek key 以启用真实对话。";

    for (const ch of reasoning) {
      if (handlers.signal?.aborted) break;
      await sleep(10);
      handlers.onReasoningToken?.(ch);
    }
    for (const ch of reply) {
      if (handlers.signal?.aborted) break;
      await sleep(15);
      handlers.onToken(ch);
    }

    const result: ChatResult = {
      content: reply,
      reasoning,
      model: this.model
    };
    handlers.onDone?.(result);
    return result;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

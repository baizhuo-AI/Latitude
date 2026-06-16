/**
 * apiAdapter.ts — 把现有 LLMProvider(DeepSeek/API)路径包成 EngineAdapter
 *
 * 这是 Phase 4「统一引擎适配器」三条引擎里的 API 条。它不重写任何网络/SSE 逻辑,
 * 只是把 llm 层既有的 LLMProvider(name/model/chat/chatStream/capabilities)
 * 映射到 EngineAdapter(name/model/generate/generateStream/capabilities):
 *
 *   EngineAdapter.generate        →  LLMProvider.chat
 *   EngineAdapter.generateStream  →  LLMProvider.chatStream
 *   EngineAdapter.capabilities    →  LLMProvider.capabilities
 *   name / model                  →  原样透传
 *
 * 为什么包一层而不是直接让 index.ts 用 LLMProvider:
 *   CC / Codex 引擎不是 HTTP provider,无法实现 LLMProvider 的 chat/chatStream 语义边界,
 *   但都能实现 EngineAdapter。把 API 路径也收进 EngineAdapter 后,收口层(callBrain)
 *   就能面向「统一接口 + 多引擎」编程,后续切到 CC/Codex 只是换一个 EngineAdapter 实现,
 *   收口层不动。
 *
 * 无状态(铁律①):本适配器不持有任何会话状态;它持有的 LLMProvider 也只是无状态的
 *   HTTP 客户端。每次 generate/generateStream 都接收完整 messages,据此一轮算一轮。
 *
 * 真相源(铁律②):provider 实例由 llm/index.ts 的 getProvider() 提供——后者直读
 *   localStorage 配置、settings 变更时失效缓存。本适配器不另缓存 provider,每次方法调用
 *   都现取 getProvider(),从而始终跟随用户在 Settings 里切换的 provider/key/model。
 */

import type { LLMProvider } from "../llm/types";
import { getProvider } from "../llm";
import type {
  EngineAdapter,
  EngineCapabilities,
  EngineMessage,
  EngineOptions,
  EngineResult,
  EngineStreamHandlers,
} from "./types";

/**
 * 把一个 LLMProvider 实例包成 EngineAdapter。
 *
 * 默认不传 provider:每次方法调用现取 getProvider()(跟随 Settings 切换);
 * 传入固定 provider:用于测试或需要钉死某个 provider 的场景。
 *
 * @param provider 可选。不传则方法内部调 getProvider() 取当前生效 provider。
 */
export function makeApiAdapter(provider?: LLMProvider): EngineAdapter {
  // 取本次操作要用的 provider:钉死优先,否则现取(跟随 Settings 真相源)。
  const resolve = (): LLMProvider => provider ?? getProvider();

  return {
    // name/model 是「读时」属性:不钉死 provider 时,反映当前生效 provider 的标识/默认 model。
    get name(): string {
      return resolve().name;
    },
    get model(): string {
      return resolve().model;
    },

    generate(messages: EngineMessage[], opts?: EngineOptions): Promise<EngineResult> {
      return resolve().chat(messages, opts);
    },

    generateStream(
      messages: EngineMessage[],
      opts: EngineOptions,
      handlers: EngineStreamHandlers
    ): Promise<EngineResult> {
      return resolve().chatStream(messages, opts, handlers);
    },

    capabilities(model?: string): EngineCapabilities {
      return resolve().capabilities(model);
    },
  };
}

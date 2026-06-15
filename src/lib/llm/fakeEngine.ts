/**
 * fakeEngine.ts — 共享测试夹具:可编排的假 LLM Provider
 *
 * 仅用于测试,不被任何生产代码 import,不进生产打包。
 *
 * 用法示例(index.test.ts 的接法):
 *
 *   import { FakeEngine, installFakeEngine } from "./fakeEngine";
 *
 *   // 1. 文件顶层:注入 mock(内部调 vi.mock,会被 Vitest 提升到文件顶部)
 *   const { setEngine } = installFakeEngine();
 *
 *   // 2. beforeEach 里替换引擎实例,拿到新一轮干净的 FakeEngine
 *   let engine: FakeEngine;
 *   beforeEach(() => {
 *     engine = setEngine(new FakeEngine());
 *   });
 *
 *   // 3. 用例里配置脚本并断言
 *   it("should call tool once", async () => {
 *     engine.script = [
 *       { content: "", toolCalls: [{ id: "t1", name: "my_tool", arguments: "{}" }], model: "deepseek-chat" },
 *       { content: "done", model: "deepseek-chat" },
 *     ];
 *     await chatAgentCall([{ role: "user", content: "go" }]);
 *     expect(engine.received).toHaveLength(2);            // 两轮调用
 *     expect(engine.received[0].messages[0].role).toBe("system");
 *   });
 *
 * 设计要点:
 *   Vitest 会把 vi.mock() 调用「提升」到调用文件的顶部执行,在模块初始化之前运行
 *   mock 工厂。因此 mock 工厂的闭包只能捕获「模块级变量」,不能捕获函数局部变量。
 *   这里把活跃引擎的引用存在 _activeEngine(模块级),代理类的每次方法调用都读它,
 *   setEngine() 替换这个引用即可让每个用例拿到自己的脚本 / 记录。
 */

import { vi } from "vitest";
import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  LLMCapabilities,
  StreamHandlers,
} from "./types";
import { deepseekCapabilities } from "./deepseek";

// ─── 公开类型 ────────────────────────────────────────────────────────────────

/** 每次 chat() 调用记录下来的入参快照 */
export interface ChatCallRecord {
  messages: ChatMessage[];
  opts: ChatOptions;
}

/** makeFakeEngine / FakeEngine 的配置项 */
export interface FakeEngineConfig {
  /** 预设的逐轮返回值;用尽后返回「脚本耗尽」兜底答复 */
  script?: ChatResult[];
  /**
   * 能力位覆盖。不传则按 engine.model 走生产 deepseekCapabilities 逻辑。
   * 传入则合并覆盖对应字段(适合测试降级逻辑)。
   */
  capabilities?: Partial<LLMCapabilities>;
  /** 默认 model 名,影响能力位推断,默认 "deepseek-chat" */
  model?: string;
}

// ─── FakeEngine 类 ──────────────────────────────────────────────────────────

/**
 * 可编排的假引擎。
 *
 * - `script`:按顺序返回预设结果,驱动多轮 agent loop。
 * - `received`:记录每次 chat() 的完整入参快照,供断言。
 * - 能力位默认复用 deepseekCapabilities(同生产逻辑),可通过 capabilitiesOverride 覆盖。
 */
export class FakeEngine {
  readonly name = "deepseek"; // 冒充 deepseek,让 getProvider 走真 provider 分支

  /** 当前 model 名(影响 capabilities 推断,可在用例里直接赋值) */
  model: string;

  /** 预设的逐轮返回值;用尽后返回兜底 */
  script: ChatResult[] = [];

  /** 每次 chat() 调用的入参快照(深拷贝,不受后续 loop 影响) */
  received: ChatCallRecord[] = [];

  private capabilitiesOverride?: Partial<LLMCapabilities>;

  constructor(config: FakeEngineConfig = {}) {
    this.model = config.model ?? "deepseek-chat";
    this.script = config.script ? [...config.script] : [];
    this.capabilitiesOverride = config.capabilities;
  }

  /**
   * 据「当前 model」推断能力位,复用生产 deepseekCapabilities 逻辑。
   * 若构造时传入了 capabilitiesOverride,则合并覆盖对应字段。
   */
  capabilities(model?: string): LLMCapabilities {
    const base = deepseekCapabilities(model ?? this.model);
    if (!this.capabilitiesOverride) return base;
    return { ...base, ...this.capabilitiesOverride };
  }

  /**
   * 非流式调用:返回 script 中下一条结果,并记录入参快照。
   * script 用尽后返回兜底答复(保证 agent loop 能正常终止)。
   */
  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    // 深拷贝快照,防止后续 loop push 进同一数组而污染历史断言
    this.received.push({ messages: JSON.parse(JSON.stringify(messages)), opts });
    const next = this.script.shift();
    if (next) return next;
    return { content: "(脚本耗尽,最终答复)", model: opts.model };
  }

  /**
   * 流式调用:立即 onToken + onDone,不实际流式,满足接口约定即可。
   * 测试流式路径时可按需 override 这个方法。
   */
  async chatStream(
    _messages: ChatMessage[],
    _opts: ChatOptions,
    handlers: StreamHandlers
  ): Promise<ChatResult> {
    const result: ChatResult = { content: "stream-done", model: _opts.model };
    handlers.onToken("stream-done");
    handlers.onDone?.(result);
    return result;
  }

  /** 重置脚本和调用记录(也可直接在 beforeEach 里 new 新实例) */
  reset(): void {
    this.script = [];
    this.received = [];
  }
}

// ─── 工厂辅助 ───────────────────────────────────────────────────────────────

/**
 * 创建一个 FakeEngine 实例,可选择覆盖默认能力位 / 脚本 / model。
 *
 * @example
 *   const engine = makeFakeEngine({ script: [...], capabilities: { supportsTools: false } });
 */
export function makeFakeEngine(config: FakeEngineConfig = {}): FakeEngine {
  return new FakeEngine(config);
}

// ─── 模块级活跃引擎引用 ──────────────────────────────────────────────────────
//
// 关键设计:vi.mock() 工厂被 Vitest 提升到调用文件的顶部执行,
// 此时 installFakeEngine() 函数体还未运行,局部变量还不存在。
// 把活跃引擎的引用放在模块级,工厂里的代理类就能安全捕获它。
// setEngine() 替换这个引用,beforeEach 换引擎时代理自动跟到新实例。

let _activeEngine: FakeEngine = new FakeEngine();

// ─── 模块级 mock 注入(绕开 getProvider 单例缓存) ────────────────────────────

/**
 * 在测试文件顶层调用,把 `./deepseek` 的 DeepSeekProvider 替换为
 * 「每次方法调用都转发到当前 _activeEngine」的代理。
 *
 * 绕开 getProvider 模块单例缓存的原理:
 *   getProvider() 只 new 一次 provider 并缓存。若代理 constructor 直接返回
 *   引擎实例,beforeEach 换了引擎后缓存里仍是旧实例。
 *   用代理让每次方法调用都读 _activeEngine(模块级引用),setEngine()
 *   替换该引用即可让各用例拿到自己的脚本 / 记录,无需清模块缓存。
 *
 * @returns
 *   - `getEngine()`:读取当前活跃 FakeEngine 实例
 *   - `setEngine(e)`:替换活跃引擎并返回新实例
 *
 * @example
 *   // 文件顶层
 *   const { setEngine } = installFakeEngine();
 *   let engine: FakeEngine;
 *   beforeEach(() => { engine = setEngine(new FakeEngine()); });
 */
export function installFakeEngine(): {
  getEngine: () => FakeEngine;
  setEngine: (e: FakeEngine) => FakeEngine;
} {
  vi.mock("./deepseek", async () => {
    const actual = await vi.importActual<typeof import("./deepseek")>("./deepseek");
    return {
      ...actual, // 保留 deepseekCapabilities 等真实导出
      DeepSeekProvider: class {
        get name() {
          return _activeEngine.name;
        }
        get model() {
          return _activeEngine.model;
        }
        capabilities(model?: string) {
          return _activeEngine.capabilities(model);
        }
        chat(messages: ChatMessage[], opts?: ChatOptions) {
          return _activeEngine.chat(messages, opts);
        }
        chatStream(messages: ChatMessage[], opts: ChatOptions, handlers: StreamHandlers) {
          return _activeEngine.chatStream(messages, opts, handlers);
        }
      },
    };
  });

  return {
    getEngine: () => _activeEngine,
    setEngine: (e: FakeEngine) => {
      _activeEngine = e;
      return _activeEngine;
    },
  };
}

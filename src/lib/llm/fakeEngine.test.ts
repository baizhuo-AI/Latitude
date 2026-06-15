/**
 * fakeEngine.test.ts — 共享测试夹具的最小自测
 *
 * 证明:
 *   1. 脚本化返回按顺序消费,用尽后返回兜底
 *   2. received 正确记录每次 chat() 入参
 *   3. capabilitiesOverride 生效
 */

import { describe, it, expect } from "vitest";
import { FakeEngine, makeFakeEngine } from "./fakeEngine";

describe("FakeEngine — 脚本化 & 捕获", () => {
  it("script 按顺序消费,用尽后返回兜底", async () => {
    const engine = new FakeEngine({
      script: [
        { content: "第一条", model: "deepseek-chat" },
        { content: "第二条", model: "deepseek-chat" },
      ],
    });

    const r1 = await engine.chat([{ role: "user", content: "a" }]);
    const r2 = await engine.chat([{ role: "user", content: "b" }]);
    const r3 = await engine.chat([{ role: "user", content: "c" }]); // 脚本已空

    expect(r1.content).toBe("第一条");
    expect(r2.content).toBe("第二条");
    expect(r3.content).toContain("脚本耗尽");
  });

  it("received 记录每次 chat() 的 messages 快照与 opts", async () => {
    const engine = makeFakeEngine();

    await engine.chat([{ role: "system", content: "sys" }, { role: "user", content: "hi" }], {
      temperature: 0.1,
    });
    await engine.chat([{ role: "user", content: "second" }]);

    expect(engine.received).toHaveLength(2);
    expect(engine.received[0].messages[0]).toEqual({ role: "system", content: "sys" });
    expect(engine.received[0].opts.temperature).toBe(0.1);
    expect(engine.received[1].messages[0].content).toBe("second");
  });

  it("received 是深拷贝快照,后续 push 不污染已记录的 messages", async () => {
    const engine = makeFakeEngine();
    const msgs: import("./types").ChatMessage[] = [{ role: "user", content: "original" }];

    await engine.chat(msgs);
    // 模拟 agent loop 往同一数组追加消息
    msgs.push({ role: "assistant", content: "reply" });

    // 已记录的快照不应受影响
    expect(engine.received[0].messages).toHaveLength(1);
    expect(engine.received[0].messages[0].content).toBe("original");
  });
});

describe("FakeEngine — 能力位", () => {
  it("默认复用生产 deepseekCapabilities(deepseek-chat)", () => {
    const engine = new FakeEngine({ model: "deepseek-chat" });
    const caps = engine.capabilities();
    expect(caps.supportsTools).toBe(true);
    expect(caps.supportsReasoning).toBe(false);
    expect(caps.supportsStreaming).toBe(true);
  });

  it("capabilitiesOverride 覆盖指定字段", () => {
    const engine = new FakeEngine({
      model: "deepseek-chat",
      capabilities: { supportsTools: false },
    });
    const caps = engine.capabilities();
    // 覆盖生效
    expect(caps.supportsTools).toBe(false);
    // 未覆盖的字段保持原值
    expect(caps.supportsStreaming).toBe(true);
  });

  it("capabilities(model) 传参覆盖 engine.model 进行推断", () => {
    const engine = new FakeEngine({ model: "deepseek-chat" });
    // 按 reasoner model 推断
    const caps = engine.capabilities("deepseek-reasoner");
    expect(caps.supportsTools).toBe(false);
    expect(caps.supportsReasoning).toBe(true);
  });
});

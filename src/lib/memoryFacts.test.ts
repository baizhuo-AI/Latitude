/**
 * memoryFacts.test.ts — Task 2.1 记忆事实表的纯逻辑单测
 *
 * 这里只测【不碰 IO】的纯函数 isMemoryFactActive：
 *   给定一条 fact + "现在"，判断它是否还有效(active)。
 *   active 语义(与 dbListMemoryFacts 的 SQL 过滤一一对应):
 *     - pinned = 1 → 永远 active(用户钉住的,不因过期淘汰)
 *     - expires_at 为空 → 永远 active(durable 事实没有有效期)
 *     - expires_at 有值 → 仅当 now < expires_at 才 active(到点即失效)
 *
 * 用时间注入(传入 now),不依赖真实时钟,照 reminder.ts 的 shouldFireReminder 范式。
 * SQL 层的过滤行为靠这个纯函数对齐,实现改了这里先红。
 */

import { describe, it, expect } from "vitest";
import { isMemoryFactActive, type MemoryFact } from "./db";

// 造一条基线 fact,测试里按需覆盖字段
function fact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: "mf_test",
    category: "preference",
    content: "测试事实",
    source: "told",
    durability: "durable",
    pinned: false,
    createdAt: "2026-06-01T00:00:00.000Z",
    expiresAt: undefined,
    ...overrides,
  };
}

const NOW = Date.parse("2026-06-16T12:00:00.000Z");

describe("isMemoryFactActive — 记忆事实有效性纯函数", () => {
  it("无 expires_at 的 durable 事实:永远 active", () => {
    expect(isMemoryFactActive(fact({ expiresAt: undefined }), NOW)).toBe(true);
  });

  it("expires_at 在未来:active", () => {
    expect(
      isMemoryFactActive(fact({ expiresAt: "2026-06-20T00:00:00.000Z" }), NOW)
    ).toBe(true);
  });

  it("expires_at 已过去:失效(非 active)", () => {
    expect(
      isMemoryFactActive(fact({ expiresAt: "2026-06-10T00:00:00.000Z" }), NOW)
    ).toBe(false);
  });

  it("pinned 的事实即使已过期也保持 active(用户钉住优先)", () => {
    expect(
      isMemoryFactActive(
        fact({ expiresAt: "2026-06-10T00:00:00.000Z", pinned: true }),
        NOW
      )
    ).toBe(true);
  });

  it("expires_at 恰好等于 now:视为已失效(到点即过期,边界取闭)", () => {
    expect(
      isMemoryFactActive(fact({ expiresAt: "2026-06-16T12:00:00.000Z" }), NOW)
    ).toBe(false);
  });

  it("expires_at 是无法解析的脏值:按【无有效期】处理,保持 active(不误删)", () => {
    expect(isMemoryFactActive(fact({ expiresAt: "not-a-date" }), NOW)).toBe(true);
  });
});

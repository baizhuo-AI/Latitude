/**
 * memorySection.test.ts — Task 2.2 记忆事实注入段的纯逻辑单测
 *
 * 这里只测【不碰 IO】的纯函数 buildMemorySection：
 *   给定一组(已 active、已 pinned 优先排序的)记忆事实 + lang + 字符预算,
 *   拼出注入到 system prompt 的「记忆段」字符串。
 *
 * 关键不变量(改实现先红):
 *   1. 空列表 → 返回空字符串(不注入任何头部/噪声)。
 *   2. inferred 来源的事实带试探标注(zh "(推断)" / en "(inferred)");
 *      told 来源不带。
 *   3. 超过 maxChars 预算 → 截断但不报错;且 pinned 事实必须优先保留,
 *      被牺牲的只能是非 pinned 事实。
 *   4. lang 影响段头(zh/en)。
 *
 * 时间无关、IO 无关:纯输入输出,照 personaSpec/composePersonaPrompt 的纯函数范式。
 */

import { describe, it, expect } from "vitest";
import { buildMemorySection } from "./memorySection";
import type { MemoryFact } from "./db";

// 造一条基线 fact,测试里按需覆盖字段
function fact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: "mf_" + Math.random().toString(36).slice(2, 8),
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

describe("buildMemorySection — 记忆注入段(纯函数)", () => {
  it("空列表 → 返回空字符串(不注入任何头部)", () => {
    expect(buildMemorySection([], "zh", 1000)).toBe("");
    expect(buildMemorySection([], "en", 1000)).toBe("");
  });

  it("told 事实:正常注入,不带推断标注", () => {
    const out = buildMemorySection(
      [fact({ content: "用户是产品经理", source: "told" })],
      "zh",
      1000
    );
    expect(out).toContain("用户是产品经理");
    expect(out).not.toContain("推断");
  });

  it("inferred 事实:带「(推断)」试探标注(zh)", () => {
    const out = buildMemorySection(
      [fact({ content: "用户偏好早上工作", source: "inferred" })],
      "zh",
      1000
    );
    expect(out).toContain("用户偏好早上工作");
    expect(out).toContain("(推断)");
  });

  it("inferred 事实:英文带「(inferred)」标注", () => {
    const out = buildMemorySection(
      [fact({ content: "user prefers mornings", source: "inferred" })],
      "en",
      1000
    );
    expect(out).toContain("user prefers mornings");
    expect(out).toContain("(inferred)");
  });

  it("段头随 lang 切换", () => {
    const zh = buildMemorySection([fact()], "zh", 1000);
    const en = buildMemorySection([fact()], "en", 1000);
    // zh 头部含「记忆」语义;en 头部含 "Memory"
    expect(zh).toContain("记忆");
    expect(en).toContain("Memory");
  });

  it("整体不超 maxChars 时:全部注入", () => {
    const facts = [
      fact({ content: "事实A" }),
      fact({ content: "事实B" }),
      fact({ content: "事实C" }),
    ];
    const out = buildMemorySection(facts, "zh", 1000);
    expect(out).toContain("事实A");
    expect(out).toContain("事实B");
    expect(out).toContain("事实C");
    expect(out.length).toBeLessThanOrEqual(1000);
  });

  it("超预算:截断不报错,且产物不超过 maxChars", () => {
    // 造 50 条长事实,预算很小,必然截断
    const facts = Array.from({ length: 50 }, (_, i) =>
      fact({ content: `这是一条比较长的记忆事实编号${i},用来撑爆字符预算占位占位占位占位` })
    );
    const out = buildMemorySection(facts, "zh", 300);
    // 不抛错 + 受预算约束
    expect(out.length).toBeLessThanOrEqual(300);
    // 至少注入了头部(没整段被吞)
    expect(out).toContain("记忆");
  });

  it("超预算:pinned 事实优先保留,被截断的只能是非 pinned", () => {
    // 1 条 pinned(放在数组靠后,模拟若按顺序截会被砍掉的位置)
    // + 一堆非 pinned 长事实把预算撑爆。
    // 注意:dbListMemoryFacts 已保证 pinned 在前,但纯函数自身也必须
    // 以「pinned 不被牺牲」为准则保留,不能依赖入参顺序碰运气。
    const pinned = fact({
      content: "关键钉住事实:用户对截止时间极度敏感",
      pinned: true,
    });
    const fillers = Array.from({ length: 30 }, (_, i) =>
      fact({
        content: `非钉住填充事实${i},内容很长很长很长很长很长很长很长很长`,
        pinned: false,
      })
    );
    // 把 pinned 放最后,故意为难「按顺序截断」的朴素实现
    const out = buildMemorySection([...fillers, pinned], "zh", 200);

    expect(out.length).toBeLessThanOrEqual(200);
    // pinned 事实必须在(哪怕预算紧张)
    expect(out).toContain("关键钉住事实:用户对截止时间极度敏感");
  });

  it("pinned 事实自身就超预算:尽力而为不报错(不抛异常)", () => {
    // 极端:单条 pinned 内容就比预算还长
    const huge = fact({
      content: "超长".repeat(500),
      pinned: true,
    });
    expect(() => buildMemorySection([huge], "zh", 50)).not.toThrow();
  });
});

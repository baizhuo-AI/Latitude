/**
 * dismissDowngrade.test.ts — Task 3.5 part(b):dismiss 降频纯函数测试
 *
 * 铁律2:f(输入, now) 纯函数,确定性 + 时间注入 + 边界 ±。
 * 测的是「连续 N 次不互动 → 自动降一档」这条 R1 命门规格。
 */

import { describe, it, expect } from "vitest";
import {
  evaluateDismissDowngrade,
  countTrailingIgnored,
  outcomeKindFromRow,
  CONSECUTIVE_IGNORE_THRESHOLD,
  DOWNGRADE_LOOKBACK_MS,
  type ProactiveOutcome,
} from "./dismissDowngrade";
import type { ProactiveMode } from "./proactiveConfig";

// ─── 测试工具:构造结局序列(按时间升序,旧→新) ──────────────────────────────
function outcome(
  kind: ProactiveOutcome["kind"],
  sentAtMs: number
): ProactiveOutcome {
  return { kind, sentAtMs };
}

const T0 = Date.parse("2026-06-16T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;

describe("outcomeKindFromRow —— proactive_log 行 → 结局类型(优先级映射)", () => {
  it("replied_at 有值 → replied(回复优先,即便 dismissed 也算回复)", () => {
    expect(outcomeKindFromRow("2026-06-16T11:00:00Z", null)).toBe("replied");
    expect(outcomeKindFromRow("2026-06-16T11:00:00Z", "2026-06-16T10:00:00Z")).toBe("replied");
  });

  it("无 replied 但 dismissed_at 有值 → dismissed", () => {
    expect(outcomeKindFromRow(null, "2026-06-16T10:00:00Z")).toBe("dismissed");
  });

  it("两者都空 → ignored", () => {
    expect(outcomeKindFromRow(null, null)).toBe("ignored");
  });

  it("空串等价于无值(SQLite NULL 兜底)", () => {
    expect(outcomeKindFromRow("", "")).toBe("ignored");
    expect(outcomeKindFromRow("", "2026-06-16T10:00:00Z")).toBe("dismissed");
  });
});

describe("countTrailingIgnored —— 末尾连续未互动计数", () => {
  it("空序列 → 0", () => {
    expect(countTrailingIgnored([], T0)).toBe(0);
  });

  it("全是 ignored/dismissed → 全计入", () => {
    const seq = [
      outcome("ignored", T0),
      outcome("dismissed", T0 + HOUR),
      outcome("ignored", T0 + 2 * HOUR),
    ];
    expect(countTrailingIgnored(seq, T0 + 3 * HOUR)).toBe(3);
  });

  it("中间有 replied → 只从最后一次 replied 之后开始数", () => {
    const seq = [
      outcome("ignored", T0),
      outcome("ignored", T0 + HOUR),
      outcome("replied", T0 + 2 * HOUR), // 互动重置
      outcome("ignored", T0 + 3 * HOUR),
      outcome("dismissed", T0 + 4 * HOUR),
    ];
    expect(countTrailingIgnored(seq, T0 + 5 * HOUR)).toBe(2);
  });

  it("末尾是 replied → 计数归零", () => {
    const seq = [
      outcome("ignored", T0),
      outcome("ignored", T0 + HOUR),
      outcome("replied", T0 + 2 * HOUR),
    ];
    expect(countTrailingIgnored(seq, T0 + 3 * HOUR)).toBe(0);
  });

  it("dismissed 与 ignored 等价(都算未互动)", () => {
    const seq = [outcome("dismissed", T0), outcome("dismissed", T0 + HOUR)];
    expect(countTrailingIgnored(seq, T0 + 2 * HOUR)).toBe(2);
  });

  it("超出回看窗口的旧结局不参与计数(时间注入边界)", () => {
    // 第一条恰好早于 now - DOWNGRADE_LOOKBACK_MS → 应被排除
    const now = T0 + DOWNGRADE_LOOKBACK_MS + 10 * HOUR;
    const seq = [
      outcome("ignored", now - DOWNGRADE_LOOKBACK_MS - 1), // 窗外 1ms
      outcome("ignored", now - DOWNGRADE_LOOKBACK_MS), // 窗内边界(>=)
      outcome("ignored", now - HOUR),
    ];
    expect(countTrailingIgnored(seq, now)).toBe(2);
  });

  it("回看窗口边界 ±1ms:恰好等于 cutoff 计入,早 1ms 不计入", () => {
    const now = T0 + DOWNGRADE_LOOKBACK_MS + 5 * HOUR;
    const cutoff = now - DOWNGRADE_LOOKBACK_MS;
    expect(countTrailingIgnored([outcome("ignored", cutoff)], now)).toBe(1);
    expect(countTrailingIgnored([outcome("ignored", cutoff - 1)], now)).toBe(0);
  });
});

describe("evaluateDismissDowngrade —— 降档评估纯函数", () => {
  const now = T0 + 10 * HOUR;

  function nIgnored(n: number): ProactiveOutcome[] {
    const seq: ProactiveOutcome[] = [];
    for (let i = 0; i < n; i++) seq.push(outcome("ignored", now - (n - i) * HOUR));
    return seq;
  }

  it("未达阈值 → 不降档(suggestedMode 与当前一致,downgraded=false)", () => {
    const r = evaluateDismissDowngrade(
      nIgnored(CONSECUTIVE_IGNORE_THRESHOLD - 1),
      "active",
      now
    );
    expect(r.downgraded).toBe(false);
    expect(r.suggestedMode).toBe<ProactiveMode>("active");
  });

  it("恰好达阈值(边界 ==)→ active 降到 gentle", () => {
    const r = evaluateDismissDowngrade(
      nIgnored(CONSECUTIVE_IGNORE_THRESHOLD),
      "active",
      now
    );
    expect(r.downgraded).toBe(true);
    expect(r.suggestedMode).toBe<ProactiveMode>("gentle");
  });

  it("超过阈值 → gentle 降到 off", () => {
    const r = evaluateDismissDowngrade(
      nIgnored(CONSECUTIVE_IGNORE_THRESHOLD + 2),
      "gentle",
      now
    );
    expect(r.downgraded).toBe(true);
    expect(r.suggestedMode).toBe<ProactiveMode>("off");
  });

  it("已是 off → 无可再降,downgraded=false 且保持 off", () => {
    const r = evaluateDismissDowngrade(nIgnored(CONSECUTIVE_IGNORE_THRESHOLD), "off", now);
    expect(r.downgraded).toBe(false);
    expect(r.suggestedMode).toBe<ProactiveMode>("off");
  });

  it("一次只降一档(active 即便连忽略很多次也只到 gentle)", () => {
    const r = evaluateDismissDowngrade(nIgnored(CONSECUTIVE_IGNORE_THRESHOLD * 3), "active", now);
    expect(r.suggestedMode).toBe<ProactiveMode>("gentle");
  });

  it("末尾有 replied → 不降档(用户仍在互动)", () => {
    const seq = nIgnored(CONSECUTIVE_IGNORE_THRESHOLD);
    seq.push(outcome("replied", now - 1));
    const r = evaluateDismissDowngrade(seq, "active", now);
    expect(r.downgraded).toBe(false);
    expect(r.suggestedMode).toBe<ProactiveMode>("active");
  });

  it("返回 trailingIgnored 供接线层打日志/判定", () => {
    const r = evaluateDismissDowngrade(nIgnored(CONSECUTIVE_IGNORE_THRESHOLD), "active", now);
    expect(r.trailingIgnored).toBe(CONSECUTIVE_IGNORE_THRESHOLD);
  });

  it("纯函数:同输入多次调用结果一致(无随机/无读时钟)", () => {
    const seq = nIgnored(CONSECUTIVE_IGNORE_THRESHOLD);
    const a = evaluateDismissDowngrade(seq, "active", now);
    const b = evaluateDismissDowngrade(seq, "active", now);
    expect(a).toEqual(b);
  });
});

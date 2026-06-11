import { describe, it, expect } from "vitest";
import { normalizeEventTiming } from "./calendar";
import { parseScheduledTime } from "./calendar";

/** Date.UTC 给的是 ms，飞书时间戳是秒，这里统一转秒。 */
function utcSec(y: number, mo: number, d: number, h: number, mi: number): number {
  return Math.floor(Date.UTC(y, mo - 1, d, h, mi) / 1000);
}

describe("normalizeEventTiming", () => {
  it("全天事件零时区偏移——startDate 原样落 scheduledDate，不转时区", () => {
    const r = normalizeEventTiming({ isAllDay: true, startDate: "2026-05-29" });
    expect(r.scheduledDate).toBe("2026-05-29");
    expect(r.scheduledTime).toBeUndefined();
  });

  it("定时事件按 Asia/Shanghai 折算本地钟点", () => {
    // UTC 01:30 → 上海 +8 = 09:30；UTC 03:00 → 11:00
    const r = normalizeEventTiming({
      isAllDay: false,
      startTs: utcSec(2026, 5, 29, 1, 30),
      endTs: utcSec(2026, 5, 29, 3, 0),
      timezone: "Asia/Shanghai"
    });
    expect(r.scheduledDate).toBe("2026-05-29");
    expect(r.scheduledTime).toBe("09:30-11:00");
  });

  it("同一 UTC 时刻、不同时区 → 不同本地日期与钟点（证明时区真的生效）", () => {
    // 同样 UTC 01:30，纽约 5 月是 EDT(-4) → 前一天 21:30
    const r = normalizeEventTiming({
      isAllDay: false,
      startTs: utcSec(2026, 5, 29, 1, 30),
      endTs: utcSec(2026, 5, 29, 3, 0),
      timezone: "America/New_York"
    });
    expect(r.scheduledDate).toBe("2026-05-28");
    expect(r.scheduledTime).toBe("21:30-23:00");
  });

  it("跨天定时事件 → 落起始日，end 截到 23:59（parseScheduledTime 无法表达跨天）", () => {
    // 上海 23:00 (UTC 15:00) 到次日 01:00 (UTC 17:00)
    const r = normalizeEventTiming({
      isAllDay: false,
      startTs: utcSec(2026, 5, 29, 15, 0),
      endTs: utcSec(2026, 5, 29, 17, 0),
      timezone: "Asia/Shanghai"
    });
    expect(r.scheduledDate).toBe("2026-05-29");
    expect(r.scheduledTime).toBe("23:00-23:59");
  });

  it("定时归一产物能被 parseScheduledTime 往返解析回相同 startMin/endMin", () => {
    const r = normalizeEventTiming({
      isAllDay: false,
      startTs: utcSec(2026, 5, 29, 1, 30),
      endTs: utcSec(2026, 5, 29, 3, 0),
      timezone: "Asia/Shanghai"
    });
    const parsed = parseScheduledTime(r.scheduledTime);
    expect(parsed).toEqual({ startMin: 9 * 60 + 30, endMin: 11 * 60 });
  });

  it("全天缺 startDate → 返回空（不崩）", () => {
    expect(normalizeEventTiming({ isAllDay: true })).toEqual({});
  });
});

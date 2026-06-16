/**
 * ProactiveSettings.test.tsx — 「别烦我」snooze 不误触 reminder 主题 (修复 3.5)
 *
 * 背景(R1 防骚扰命门):
 *   "reminder" 这个 SyncTopic 的既定语义是「间歇式时间日志提醒刚触发」——
 *   reminder.ts:fireReminder() 在提醒真正 fire 时 emitSync("reminder"),
 *   TodoFloat.tsx 订阅它后无条件 setReminderActive(true) 并抢焦点(弹出"记一句刚才在做什么")。
 *
 *   早期实现的 snoozeUntil() 误复用了这个主题去通知「pausedUntil 已改」,结果是:
 *   用户点「别烦我 / 静音 1h / 静音到今晚 / 立即恢复」任一按钮 → 若 todo 浮窗开着 →
 *   浮窗立刻弹出活动记录提示并抢焦点。点『别烦我』反而被烦。
 *
 *   修复:snooze 改 pausedUntil 不需要跨窗广播(闸门消费侧走 readSettingsSnapshot 直读
 *   localStorage,setReminder 已落库即生效;唯一监听 "reminder" 的 TodoFloat 做的是错误的事)。
 *
 * 本测试锁死:
 *   1. 点四个 snooze 入口都写 reminder.pausedUntil(setReminder 被正确调用)
 *   2. 任何 snooze 入口都【不】emitSync("reminder")(特征化,防回归)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProactiveSettings } from "./ProactiveSettings";

// ─── mock i18n(useTranslation 直接返回 key,带简单插值) ──────────────────────
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => {
      if (!opts) return key;
      return Object.entries(opts).reduce(
        (acc, [k, v]) => acc.replace(`{{${k}}}`, String(v)),
        key
      );
    },
    i18n: { language: "zh" },
  }),
}));

// ─── mock syncBus:断言不 emit "reminder" ─────────────────────────────────────
const emitSyncSpy = vi.fn();
vi.mock("../../lib/syncBus", () => ({
  emitSync: (...args: unknown[]) => emitSyncSpy(...args),
}));

// ─── mock settings store ─────────────────────────────────────────────────────
const setReminderSpy = vi.fn();
const setProactiveSpy = vi.fn();

// 可动态替换的 store 状态(reminder.pausedUntil 控制 paused 分支)
let _reminder: {
  workStart: number;
  workEnd: number;
  pausedUntil?: number;
};

const _proactive = {
  mode: "gentle" as const,
  heartbeatMin: 90,
  morningHour: 7,
  budgetPerHalfDay: 3,
  channel: "chat" as const,
  events: {
    meetingSoon: true,
    deadlineNear: true,
    taskStuck: true,
    justCompleted: true,
  },
};

vi.mock("../../lib/settings", () => ({
  useSettingsStore: (selector?: (s: unknown) => unknown) => {
    const state = {
      proactive: _proactive,
      reminder: _reminder,
      setProactive: setProactiveSpy,
      setReminder: setReminderSpy,
    };
    return selector ? selector(state) : state;
  },
}));

describe("ProactiveSettings — 别烦我 snooze", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 默认未暂停:显示「静音 1h / 静音到今晚」两个按钮
    _reminder = { workStart: 9, workEnd: 18, pausedUntil: undefined };
  });

  // ── 写真相源:四个入口都落 reminder.pausedUntil ──────────────────────────────

  it("点「静音 1h」→ 调 setReminder 写 pausedUntil(未来时间戳)", () => {
    render(<ProactiveSettings />);
    fireEvent.click(screen.getByText("proactive.snooze1h"));

    expect(setReminderSpy).toHaveBeenCalledTimes(1);
    const arg = setReminderSpy.mock.calls[0][0] as { pausedUntil?: number };
    expect(typeof arg.pausedUntil).toBe("number");
    expect(arg.pausedUntil!).toBeGreaterThan(Date.now());
  });

  it("点「静音到今晚」→ 调 setReminder 写 pausedUntil(今晚的时间戳)", () => {
    render(<ProactiveSettings />);
    fireEvent.click(screen.getByText("proactive.snoozeToday"));

    expect(setReminderSpy).toHaveBeenCalledTimes(1);
    const arg = setReminderSpy.mock.calls[0][0] as { pausedUntil?: number };
    expect(typeof arg.pausedUntil).toBe("number");
  });

  it("暂停态点「立即恢复」→ 调 setReminder 清空 pausedUntil(undefined)", () => {
    // 进入暂停态:显示「立即恢复」按钮
    _reminder = { workStart: 9, workEnd: 18, pausedUntil: Date.now() + 60 * 60 * 1000 };
    render(<ProactiveSettings />);
    fireEvent.click(screen.getByText("proactive.snoozeResume"));

    expect(setReminderSpy).toHaveBeenCalledTimes(1);
    expect(setReminderSpy.mock.calls[0][0]).toEqual({ pausedUntil: undefined });
  });

  // ── 命门:任何 snooze 入口都不得 emit "reminder"(防 TodoFloat 误弹活动输入) ──

  it("点「静音 1h」不 emitSync(\"reminder\")", () => {
    render(<ProactiveSettings />);
    fireEvent.click(screen.getByText("proactive.snooze1h"));

    expect(emitSyncSpy).not.toHaveBeenCalledWith("reminder");
  });

  it("点「静音到今晚」不 emitSync(\"reminder\")", () => {
    render(<ProactiveSettings />);
    fireEvent.click(screen.getByText("proactive.snoozeToday"));

    expect(emitSyncSpy).not.toHaveBeenCalledWith("reminder");
  });

  it("暂停态点「立即恢复」不 emitSync(\"reminder\")", () => {
    _reminder = { workStart: 9, workEnd: 18, pausedUntil: Date.now() + 60 * 60 * 1000 };
    render(<ProactiveSettings />);
    fireEvent.click(screen.getByText("proactive.snoozeResume"));

    expect(emitSyncSpy).not.toHaveBeenCalledWith("reminder");
  });

  it("切换主动姿态档位也不 emitSync(\"reminder\")", () => {
    // 顺带覆盖:改 proactive.mode 走 setProactive,同样不该误触 reminder 主题
    render(<ProactiveSettings />);
    fireEvent.click(screen.getByText("proactive.modeActive"));

    expect(setProactiveSpy).toHaveBeenCalledWith({ mode: "active" });
    expect(emitSyncSpy).not.toHaveBeenCalledWith("reminder");
  });
});

/**
 * ProactiveSettings.tsx — AI 秘书「主动姿态」配置面板 (Task 3.4)
 *
 * 挂在设置页(参考 PersonaPanel / AboutYouPanel)。两层:
 *   - 懒人三档:关 / 温和 / 积极(SegmentControl + 当前档说明)。默认温和。
 *   - 高玩展开:心跳频率 / 晨报时间 / 打扰预算 / 静默时段(指向 reminder)/ 事件开关 / 渠道。
 *
 * 真相源:settings.proactive(ProactiveConfig)。改动经 setProactive 持久化 + 触发同步。
 *
 * 静默时段:不在 proactive 里存——沿用 reminder.workStart/workEnd 这一唯一真相源
 * (铁律:工作时段只有一处)。这里只读展示 + 引导用户去「定时提醒」改,避免两套漂移。
 *
 * 注意:mode="off" 时高级设置仍可展开调整(改完不丢),但主动总闸关着不生效。
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useSettingsStore } from "../../lib/settings";
import type {
  ProactiveMode,
  ProactiveChannel,
  ProactiveEvents,
  ActivityCaptureMode,
} from "../../lib/secretary/proactiveConfig";
import { cn } from "../../lib/utils";

/** 今晚 23:59:59.999 的时间戳(ms),供「静音到今晚」用。 */
function endOfTodayTs(): number {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/** 把暂停截止时间戳格式化成 HH:MM(本地时区),用于「已静音至 …」展示。 */
function formatPausedUntil(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ─── 公共样式 ────────────────────────────────────────────────────────────────
const numInputCls = cn(
  "w-16 px-2 py-1 rounded-md text-sm text-center outline-none transition-colors tabular-nums",
  "bg-zinc-50 dark:bg-zinc-950",
  "border border-zinc-200 dark:border-zinc-700",
  "focus:border-indigo-500",
  "text-zinc-900 dark:text-zinc-100"
);

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ─── 小 SegmentControl(自包含,样式同设置页) ─────────────────────────────────
function Segment<V extends string>({
  value,
  onChange,
  options,
}: {
  value: V;
  onChange: (v: V) => void;
  options: Array<{ value: V; label: string }>;
}) {
  return (
    <div className="inline-flex bg-zinc-100 dark:bg-zinc-800 rounded-lg p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            "px-3 py-1 text-xs font-medium rounded-md transition-colors",
            value === opt.value
              ? "bg-white dark:bg-zinc-950 shadow-sm text-zinc-900 dark:text-zinc-100"
              : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ─── 行容器(label + 控件,样式同设置页 Field) ───────────────────────────────
function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-4">
        <label className="text-sm text-zinc-700 dark:text-zinc-300 flex-shrink-0">{label}</label>
        <div className="min-w-0">{children}</div>
      </div>
      {hint && <p className="text-[11px] text-zinc-400 dark:text-zinc-500 leading-relaxed">{hint}</p>}
    </div>
  );
}

// ─── 事件开关 toggle chip ─────────────────────────────────────────────────────
function ToggleChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "px-3 py-1 rounded-full text-xs font-medium transition-colors",
        active
          ? "bg-indigo-600 text-white"
          : "bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700"
      )}
    >
      {label}
    </button>
  );
}

// ─── 主组件 ──────────────────────────────────────────────────────────────────

export function ProactiveSettings() {
  const { t } = useTranslation();
  const proactive = useSettingsStore((s) => s.proactive);
  const setProactive = useSettingsStore((s) => s.setProactive);
  // 静默时段沿用 reminder 工作时段(只读展示,引导去 reminder 改)
  const reminder = useSettingsStore((s) => s.reminder);
  // 「别烦我」复用 reminder.pausedUntil 这一唯一真相源(铁律:不另造字段)
  const setReminder = useSettingsStore((s) => s.setReminder);

  const [showAdvanced, setShowAdvanced] = useState(false);

  // 当前是否处于「别烦我」静音中(读 store 内存态即可,本面板在主窗,改也在主窗)
  const paused = reminder.pausedUntil != null && Date.now() < reminder.pausedUntil;

  /**
   * 写「别烦我」截止时间到 reminder.pausedUntil(唯一真相源)。
   *
   * 不跨窗广播:主动逻辑闸门走 readSettingsSnapshot 直读 localStorage,setReminder 已落库即生效;
   * 本面板与闸门同在主窗、读同一个 store,不需要同步事件。
   * ⚠️ 切忌 emitSync("reminder")——该主题语义是「提醒刚触发」(reminder.ts:fireReminder),
   * 唯一订阅方 TodoFloat 收到后会弹「记一句刚才在做什么」并抢焦点;在此 emit 会让用户
   * 点『别烦我』反被烦(R1 防骚扰命门)。若日后确需让其它窗口感知暂停态,另起独立 SyncTopic。
   */
  function snoozeUntil(ms: number | undefined) {
    setReminder({ pausedUntil: ms });
  }

  // 当前档说明
  const modeHint =
    proactive.mode === "off"
      ? t("proactive.modeOffHint")
      : proactive.mode === "active"
        ? t("proactive.modeActiveHint")
        : t("proactive.modeGentleHint");

  function toggleEvent(key: keyof ProactiveEvents) {
    setProactive({ events: { [key]: !proactive.events[key] } });
  }

  // 活动记录子项(定时×主动全合 M4):退役老 reminder 定时器后,活动记录改由
  // 主动引擎的 activity_capture 触发类型接手。这里是它唯一的设置入口(开关 / 间隔 / 策略档)。
  const activityCapture = proactive.activityCapture;

  const off = proactive.mode === "off";

  return (
    <div className="space-y-5">
      {/* 懒人三档 */}
      <Row label={t("proactive.mode")} hint={modeHint}>
        <Segment<ProactiveMode>
          value={proactive.mode}
          onChange={(v) => setProactive({ mode: v })}
          options={[
            { value: "off", label: t("proactive.modeOff") },
            { value: "gentle", label: t("proactive.modeGentle") },
            { value: "active", label: t("proactive.modeActive") },
          ]}
        />
      </Row>

      {/* 别烦我(临时静音,复用 reminder.pausedUntil 唯一真相源) */}
      <Row label={t("proactive.snooze")} hint={t("proactive.snoozeHint")}>
        {paused ? (
          <div className="flex items-center gap-2">
            <span className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
              {t("proactive.snoozedUntil", { time: formatPausedUntil(reminder.pausedUntil!) })}
            </span>
            <button
              type="button"
              onClick={() => snoozeUntil(undefined)}
              className="px-2.5 py-1 rounded-md text-xs font-medium text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-500/10 hover:bg-indigo-100 dark:hover:bg-indigo-500/20 transition-colors"
            >
              {t("proactive.snoozeResume")}
            </button>
          </div>
        ) : (
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => snoozeUntil(Date.now() + 60 * 60 * 1000)}
              className="px-2.5 py-1 rounded-md text-xs font-medium text-zinc-600 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
            >
              {t("proactive.snooze1h")}
            </button>
            <button
              type="button"
              onClick={() => snoozeUntil(endOfTodayTs())}
              className="px-2.5 py-1 rounded-md text-xs font-medium text-zinc-600 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
            >
              {t("proactive.snoozeToday")}
            </button>
          </div>
        )}
      </Row>

      {/* 高级设置展开 */}
      <div className="pt-1 border-t border-zinc-200 dark:border-zinc-800">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="inline-flex items-center gap-1 text-xs font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
        >
          {showAdvanced ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          {showAdvanced ? t("proactive.advancedHide") : t("proactive.advancedShow")}
        </button>
      </div>

      {showAdvanced && (
        <div
          className={cn(
            "space-y-5 rounded-lg p-4 bg-zinc-50 dark:bg-zinc-950/60 border border-zinc-200 dark:border-zinc-800",
            off && "opacity-60"
          )}
        >
          {/* 巡检频率 */}
          <Row label={t("proactive.heartbeat")} hint={t("proactive.heartbeatHint")}>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={15}
                max={480}
                value={proactive.heartbeatMin}
                onChange={(e) => setProactive({ heartbeatMin: clampInt(e.target.value, 15, 480, 90) })}
                className={numInputCls}
              />
              <span className="text-xs text-zinc-400 dark:text-zinc-500">{t("proactive.minutesUnit")}</span>
            </div>
          </Row>

          {/* 晨报时间 */}
          <Row label={t("proactive.morningHour")} hint={t("proactive.morningHourHint")}>
            <input
              type="number"
              min={0}
              max={23}
              value={proactive.morningHour}
              onChange={(e) => setProactive({ morningHour: clampInt(e.target.value, 0, 23, 7) })}
              className={numInputCls}
            />
          </Row>

          {/* 打扰预算 */}
          <Row label={t("proactive.budget")} hint={t("proactive.budgetHint")}>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                max={20}
                value={proactive.budgetPerHalfDay}
                onChange={(e) => setProactive({ budgetPerHalfDay: clampInt(e.target.value, 1, 20, 3) })}
                className={numInputCls}
              />
              <span className="text-xs text-zinc-400 dark:text-zinc-500">{t("proactive.times")}</span>
            </div>
          </Row>

          {/* 静默时段 = 工作时段(唯一真相源 reminder.workStart/workEnd)。
              M4 起这里可直接编辑——老「定时提醒」设置区已随活动提醒退役一并移除,
              工作时段的唯一编辑入口收敛到此(整个主动引擎 + 活动记录都读它)。 */}
          <Row label={t("proactive.quietHours")} hint={t("proactive.quietHoursHint")}>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={0}
                max={23}
                value={reminder.workStart}
                onChange={(e) => setReminder({ workStart: clampInt(e.target.value, 0, 23, 9) })}
                className={numInputCls}
                aria-label={t("proactive.quietHoursStart")}
              />
              <span className="text-xs text-zinc-400 dark:text-zinc-500">–</span>
              <input
                type="number"
                min={0}
                max={23}
                value={reminder.workEnd}
                onChange={(e) => setReminder({ workEnd: clampInt(e.target.value, 0, 23, 22) })}
                className={numInputCls}
                aria-label={t("proactive.quietHoursEnd")}
              />
            </div>
          </Row>

          {/* 活动记录(M4:由 activity_capture 接手老 reminder 的定时提醒) */}
          <div className="space-y-3 pt-1 border-t border-zinc-200 dark:border-zinc-800">
            <Row label={t("proactive.activityCapture")} hint={t("proactive.activityCaptureHint")}>
              <Segment<"on" | "off">
                value={activityCapture.enabled ? "on" : "off"}
                onChange={(v) => setProactive({ activityCapture: { enabled: v === "on" } })}
                options={[
                  { value: "off", label: t("proactive.activityCaptureOff") },
                  { value: "on", label: t("proactive.activityCaptureOn") },
                ]}
              />
            </Row>

            {activityCapture.enabled && (
              <>
                {/* 间隔 */}
                <Row
                  label={t("proactive.activityCaptureInterval")}
                  hint={t("proactive.activityCaptureIntervalHint")}
                >
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      min={5}
                      max={480}
                      value={activityCapture.intervalMin}
                      onChange={(e) =>
                        setProactive({
                          activityCapture: { intervalMin: clampInt(e.target.value, 5, 480, 120) },
                        })
                      }
                      className={numInputCls}
                    />
                    <span className="text-xs text-zinc-400 dark:text-zinc-500">
                      {t("proactive.minutesUnit")}
                    </span>
                  </div>
                </Row>

                {/* 策略档:随秘书克制(gentle)/ 按时硬提醒(scheduled) */}
                <Row
                  label={t("proactive.activityCaptureMode")}
                  hint={t("proactive.activityCaptureModeHint")}
                >
                  <Segment<ActivityCaptureMode>
                    value={activityCapture.activityCaptureMode}
                    onChange={(v) => setProactive({ activityCapture: { activityCaptureMode: v } })}
                    options={[
                      { value: "gentle", label: t("proactive.activityCaptureModeGentle") },
                      { value: "scheduled", label: t("proactive.activityCaptureModeScheduled") },
                    ]}
                  />
                </Row>
              </>
            )}
          </div>

          {/* 事件开关 */}
          <div className="space-y-2">
            <p className="text-sm text-zinc-700 dark:text-zinc-300">{t("proactive.events")}</p>
            <div className="flex flex-wrap gap-2">
              <ToggleChip
                active={proactive.events.meetingSoon}
                label={t("proactive.eventMeetingSoon")}
                onClick={() => toggleEvent("meetingSoon")}
              />
              <ToggleChip
                active={proactive.events.deadlineNear}
                label={t("proactive.eventDeadlineNear")}
                onClick={() => toggleEvent("deadlineNear")}
              />
              <ToggleChip
                active={proactive.events.taskStuck}
                label={t("proactive.eventTaskStuck")}
                onClick={() => toggleEvent("taskStuck")}
              />
              <ToggleChip
                active={proactive.events.justCompleted}
                label={t("proactive.eventJustCompleted")}
                onClick={() => toggleEvent("justCompleted")}
              />
            </div>
          </div>

          {/* 渠道 */}
          <Row label={t("proactive.channel")} hint={t("proactive.channelHint")}>
            <Segment<ProactiveChannel>
              value={proactive.channel}
              onChange={(v) => setProactive({ channel: v })}
              options={[
                { value: "chat", label: t("proactive.channelChat") },
                { value: "notification", label: t("proactive.channelNotification") },
                { value: "float", label: t("proactive.channelFloat") },
                { value: "all", label: t("proactive.channelAll") },
              ]}
            />
          </Row>
        </div>
      )}
    </div>
  );
}

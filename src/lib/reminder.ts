import { useSettingsStore, type ReminderConfig } from "./settings";
import { emitSync } from "./syncBus";
import { openTodoFloat } from "./windowLayout";
import i18n from "./i18n";

/**
 * 间歇式时间日志 — 提醒调度
 *
 * ⚠️ 只在工作台窗(label "main")启动(对话窗不启动),否则两窗各跑一个定时器会重复提醒。
 *    挂载点见 src/App.tsx 的 MainWindow。
 *
 * 机制:每分钟 tick,满足全部条件才触发:
 *   - reminder.enabled
 *   - 当前在工作时段 [workStart, workEnd)
 *   - 未暂停(Date.now() >= pausedUntil)
 *   - 距上次提醒 >= intervalMin
 * 触发动作:
 *   - channel 含 "floating":弹出/聚焦 todo 悬浮窗 + emitSync("reminder") 让它浮现"记一句刚才在做什么"
 *   - channel 含 "notification":额外发 macOS 系统通知(plugin-notification)
 *
 * lastFired 存 localStorage,重启 app 不会立刻又弹。
 */

const LAST_FIRED_KEY = "daybreak.reminder.lastFired";

function getLastFired(): number {
  const raw = localStorage.getItem(LAST_FIRED_KEY);
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isNaN(n) ? 0 : n;
}

function setLastFired(ts: number): void {
  localStorage.setItem(LAST_FIRED_KEY, String(ts));
}

/**
 * 发 macOS 系统通知。首次会向系统申请通知权限(弹授权框)。
 * 动态 import:无 Tauri runtime 的环境(单测/Ladle)不要求插件能 resolve。
 */
async function sendSystemNotification(): Promise<void> {
  try {
    const mod = await import("@tauri-apps/plugin-notification");
    let granted = await mod.isPermissionGranted();
    if (!granted) {
      const perm = await mod.requestPermission();
      granted = perm === "granted";
    }
    if (!granted) return;
    mod.sendNotification({
      title: "Daybreak",
      body: i18n.t("floating.activityPrompt")
    });
  } catch (err) {
    console.error("[reminder] notification failed:", err);
  }
}

function fireReminder(): void {
  const { channel } = useSettingsStore.getState().reminder;
  // channel 含 "floating":弹出/聚焦 todo 悬浮窗(TodoFloat 监听 "reminder" 浮现"记一句"输入)
  if (channel === "floating" || channel === "both") void openTodoFloat();
  emitSync("reminder");
  if (channel === "notification" || channel === "both") {
    void sendSystemNotification();
  }
}

/**
 * 纯判断:此刻是否该触发提醒。抽成纯函数便于单测(见 reminder.test.ts)。
 * 条件:enabled && 在工作时段 [workStart, workEnd) && 未暂停 && 距上次提醒 >= 间隔。
 */
export function shouldFireReminder(
  reminder: ReminderConfig,
  now: Date,
  nowMs: number,
  lastFired: number
): boolean {
  if (!reminder.enabled) return false;
  const hour = now.getHours();
  if (hour < reminder.workStart || hour >= reminder.workEnd) return false; // 非工作时段
  if (reminder.pausedUntil != null && nowMs < reminder.pausedUntil) return false; // 暂停中
  if (nowMs - lastFired < reminder.intervalMin * 60 * 1000) return false; // 间隔未到
  return true;
}

let _timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  const { reminder } = useSettingsStore.getState();
  const now = new Date();
  if (!shouldFireReminder(reminder, now, now.getTime(), getLastFired())) return;
  setLastFired(now.getTime());
  fireReminder();
}

/**
 * 启动提醒调度,返回停止函数。仅主窗口调用。
 * 启动时若没有 lastFired 记录,先写入当前时间——避免一开 app 就立刻弹(从 0 算间隔会瞬间满足)。
 */
export function startReminderScheduler(): () => void {
  if (_timer) return stopReminderScheduler;
  if (getLastFired() === 0) setLastFired(Date.now());
  _timer = setInterval(tick, 60 * 1000);
  return stopReminderScheduler;
}

export function stopReminderScheduler(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

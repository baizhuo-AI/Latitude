import { useEffect, useState } from "react";
import { BoardShell } from "./components/BoardShell";
import { ChatBar } from "./components/ChatBar";
import { Launcher } from "./components/Launcher";
import { TodoFloat } from "./pages/TodoFloat";
import { useTodoStore } from "./lib/store";
import { useGoalsStore } from "./lib/goalsStore";
import { useActivityStore } from "./lib/activityStore";
import { useCalendarEventsStore } from "./lib/calendarEventsStore";
import { onSync, type SyncTopic } from "./lib/syncBus";
import { setupOnlineReplay } from "./lib/calendarSync";
import { startReminderScheduler } from "./lib/reminder";
import { windowRole } from "./lib/windowLayout";
import { useSettingsStore } from "./lib/settings";
import { ConfirmDialogProvider } from "./components/ConfirmDialog";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Toaster } from "./components/Toaster";

/**
 * App 主壳:按「窗口角色」分发三种窗口。
 *
 *  - main    → 工作台主窗:今日/待办/日历/目标/设置 + 应用级单例副作用(提醒/在线回放/全量同步)
 *  - chatbar → 对话悬浮条:Hermes 式细长输入条,回车在条上方就地展开
 *  - todo    → todo 悬浮窗:今日待办 + 速记 + 间歇提醒落点
 *
 * 三个 Tauri 窗口共用同一份代码,通过 URL hash 区分入口(沿用原浮窗的同源多窗方案,test-safe)。
 * 共享:SQLite db(同文件)+ Tauri Event 跨窗口同步(syncBus / daybreak://data-changed)。
 */
export default function App() {
  const [role] = useState(() => windowRole());
  if (role === "chatbar") return <ChatBarWindow />;
  if (role === "todo") return <TodoWindow />;
  if (role === "launcher") return <Launcher />;
  return <MainWindow />;
}

/**
 * 按需把若干数据域 hydrate 进本窗口,并订阅跨窗同步(前端 syncBus + 后端 daybreak://data-changed)。
 * 单例副作用(提醒/在线回放)不在这里,见各窗口自身。
 */
function useDataSync(topics: SyncTopic[]) {
  useEffect(() => {
    const hydrators: Partial<Record<SyncTopic, () => void>> = {
      todos: () => void useTodoStore.getState().hydrate(),
      goals: () => void useGoalsStore.getState().hydrate(),
      activities: () => void useActivityStore.getState().hydrate(),
      calendar_events: () => void useCalendarEventsStore.getState().hydrate()
    };
    topics.forEach((tp) => hydrators[tp]?.());
    const offs = topics.map((tp) => onSync(tp, () => hydrators[tp]?.()));
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<string>("daybreak://data-changed", (e) => {
        const tp = e.payload as SyncTopic;
        if (topics.includes(tp)) hydrators[tp]?.();
      });
    })();
    return () => {
      offs.forEach((o) => o());
      unlisten?.();
    };
    // topics 在各调用点是字面量常量,仅需挂载时绑定一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** 工作台主窗:承载现有视图 + 应用级单例副作用(只在此窗起一份,避免悬浮窗重复)。 */
function MainWindow() {
  useDataSync(["todos", "goals", "activities", "calendar_events"]);

  // 离线期间入队的本地日历变更:联网恢复时自动 flush 回写飞书。
  useEffect(() => setupOnlineReplay(), []);

  // 间歇式时间日志:提醒调度只在工作台主窗起一份(悬浮窗不起)。
  useEffect(() => {
    const stop = startReminderScheduler();
    return stop;
  }, []);

  // 全局快捷键:启动时按设置里保存的 accelerator 注册一次(用户改时由设置页重新注册)。
  useEffect(() => {
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const sc = useSettingsStore.getState().shortcuts;
        await invoke("set_global_shortcuts", {
          chatbar: sc.toggleChatbar,
          todo: sc.toggleTodo,
          workbench: sc.showWorkbench
        });
      } catch (e) {
        console.error("[App] register global shortcut failed:", e);
      }
    })();
  }, []);

  return (
    <ErrorBoundary>
      <ConfirmDialogProvider>
        <BoardShell />
        <Toaster />
      </ConfirmDialogProvider>
    </ErrorBoundary>
  );
}

/** 对话悬浮条窗口:对话上下文(buildChatSystemPrompt)要 todos + goals,这里 hydrate 并随同步刷新。 */
function ChatBarWindow() {
  useDataSync(["todos", "goals"]);
  return (
    <ErrorBoundary>
      <ConfirmDialogProvider>
        <ChatBar />
        <Toaster />
      </ConfirmDialogProvider>
    </ErrorBoundary>
  );
}

/** todo 悬浮窗:TodoFloat 自己管 todos/activities 的 hydrate 与同步(含 reminder 落点),这里只包壳。 */
function TodoWindow() {
  return (
    <ErrorBoundary>
      <ConfirmDialogProvider>
        <TodoFloat />
        <Toaster />
      </ConfirmDialogProvider>
    </ErrorBoundary>
  );
}

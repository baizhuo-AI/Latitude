import { useEffect, useState } from "react";
import { BoardShell } from "./components/BoardShell";
import { ChatBar } from "./components/ChatBar";
import { Launcher } from "./components/Launcher";
import { TodoFloat } from "./pages/TodoFloat";
import { useTodoStore } from "./lib/store";
import { useGoalsStore } from "./lib/goalsStore";
import { useActivityStore } from "./lib/activityStore";
import { useCalendarEventsStore } from "./lib/calendarEventsStore";
import { useFieldStore } from "./lib/fieldStore";
import { useChatStore } from "./lib/chatStore";
import { onSync, bridgeDataChangedToSync, type SyncTopic } from "./lib/syncBus";
import { setupOnlineReplay } from "./lib/calendarSync";
import { startSecretaryScheduler, runStartupBackfill } from "./lib/secretary/wiring";
import { setupFeishuChatBridge } from "./lib/feishuChat";
import { windowRole } from "./lib/windowLayout";
import { useSettingsStore, pushProactiveConfig } from "./lib/settings";
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
 * 共享:SQLite db(同文件)+ Tauri Event 跨窗口同步(syncBus / latitude://data-changed)。
 */
export default function App() {
  const [role] = useState(() => windowRole());
  if (role === "chatbar") return <ChatBarWindow />;
  if (role === "todo") return <TodoWindow />;
  if (role === "launcher") return <Launcher />;
  return <MainWindow />;
}

/**
 * 按需把若干数据域 hydrate 进本窗口,并订阅跨窗同步(前端 syncBus + 后端 latitude://data-changed)。
 * 单例副作用(提醒/在线回放)不在这里,见各窗口自身。
 */
function useDataSync(topics: SyncTopic[]) {
  useEffect(() => {
    const hydrators: Partial<Record<SyncTopic, () => void>> = {
      todos: () => { void useTodoStore.getState().hydrate(); void useFieldStore.getState().hydrate(); },
      goals: () => void useGoalsStore.getState().hydrate(),
      activities: () => void useActivityStore.getState().hydrate(),
      calendar_events: () => void useCalendarEventsStore.getState().hydrate(),
      // 对话列表:秘书投递简报后跨窗口刷新(目前只 ChatBarWindow 订阅)
      conversations: () => void useChatStore.getState().hydrate()
    };
    topics.forEach((tp) => hydrators[tp]?.());
    const offs = topics.map((tp) => onSync(tp, () => hydrators[tp]?.()));
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<string>("latitude://data-changed", (e) => {
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

  // 后端事件 → 前端 syncBus 的桥接(只在主窗起一份)。
  // MCP(CC/Codex)经 latitude://data-changed 发的 "memory" 不在 useDataSync 列表里,
  // 这里转嫁成 syncBus 的 emitSync("memory"),让 AboutYouPanel 的 onSync("memory") 实时刷新。
  useEffect(() => bridgeDataChangedToSync(), []);

  // 离线期间入队的本地日历变更:联网恢复时自动 flush 回写飞书。
  useEffect(() => setupOnlineReplay(), []);

  // AI 秘书调度器(日终纪要 + 晨间简报 + 主动巡检,含活动捕获 activity_capture)。
  // 只在工作台主窗起一份(单 owner)。卸载时 stop(),停 tick 并释放 owner 锁。
  //
  // 注:老的"间歇式时间日志"独立提醒定时器(reminder.ts 的 setInterval)已于"定时×主动全合 M4"
  //     退役——活动记录改由主动引擎的 activity_capture 触发类型接手(尊重别烦我/静默/忙时档),
  //     不再单起一个不看忙闲的裸定时器,避免与秘书消息双重打扰。
  useEffect(() => {
    const stop = startSecretaryScheduler();
    return stop;
  }, []);

  // 启动时把「主动配置」推给 Rust 后台引擎(活动记录原生调度需要;之后每次改设置由 settings.persist 重推)。
  useEffect(() => {
    pushProactiveConfig();
  }, []);

  // 启动补发:若今早错过晨间简报且用户尚未活跃,补发一条(只在主窗起一次)。
  // 不阻塞渲染、不抛错——内部已吞异常并保守降级。
  useEffect(() => {
    void runStartupBackfill();
  }, []);

  // 飞书对话入口:监听 Rust 入站消费端的 "feishu://incoming" → 跑秘书核心 → 回复发回飞书。
  // 只在工作台主窗起一份(主窗"关闭=隐藏"始终存活,是可靠的执行器;settings 在此为真相源)。
  useEffect(() => setupFeishuChatBridge(), []);

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

/**
 * 对话悬浮条窗口:对话上下文(buildChatSystemPrompt)要 todos + goals,这里 hydrate 并随同步刷新。
 * 另订阅 conversations:AI 秘书投递晨间简报(新建对话)后 emitSync("conversations"),
 * 让悬浮条自动 hydrate 出这条新简报对话,无需用户手动刷新。
 */
function ChatBarWindow() {
  useDataSync(["todos", "goals", "conversations"]);
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

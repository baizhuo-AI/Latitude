import { HashRouter, Route, Routes } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { BriefingPage } from "../pages/BriefingPage";
import { TodosPage } from "../pages/TodosPage";
import { CalendarPage } from "../pages/CalendarPage";
import { ChatHistoryPage } from "../pages/ChatHistoryPage";
import { TelosPage } from "../pages/TelosPage";
import { ActivitiesPage } from "../pages/ActivitiesPage";
import { SettingsPage } from "../pages/SettingsPage";

/**
 * 工作台壳 — 工作台窗(label "main")的内容容器。
 *
 * 承载:今日(Briefing) / 待办 / 日历 / 目标(Telos) / 设置,内部用 HashRouter 导航。
 * 对话条与 todo 都在各自的悬浮窗(chatbar / todo 窗口),不在这里。
 */
export function BoardShell() {
  return (
    <HashRouter>
      <div className="flex h-screen overflow-hidden bg-bg text-text">
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <TopBar />
          <main className="flex-1 overflow-y-auto scrollbar-thin">
            <Routes>
              <Route path="/" element={<BriefingPage />} />
              <Route path="/todos" element={<TodosPage />} />
              <Route path="/calendar" element={<CalendarPage />} />
              <Route path="/activities" element={<ActivitiesPage />} />
              <Route path="/history" element={<ChatHistoryPage />} />
              <Route path="/telos" element={<TelosPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </main>
        </div>
      </div>
    </HashRouter>
  );
}

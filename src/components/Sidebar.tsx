import { NavLink, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import {
  Sun,
  ListTodo,
  CalendarDays,
  MessageSquare,
  Target,
  Settings,
  PanelTopOpen,
  History,
  NotebookPen
} from "lucide-react";
import { cn } from "../lib/utils";
import { useTodoStore } from "../lib/store";
import { openChatBar, openTodoFloat } from "../lib/windowLayout";

/**
 * 主导航
 * 路由:Briefing(早安) / Todos / Calendar / Chat / Telos
 *
 * 颜色 class 一律 light 默认 + dark: 前缀,用 Tailwind darkMode: "class" 切换。
 */
const NAV_ITEMS = [
  { href: "/", icon: Sun, key: "briefing" },
  { href: "/todos", icon: ListTodo, key: "todos" },
  { href: "/calendar", icon: CalendarDays, key: "calendar" },
  { href: "/activities", icon: NotebookPen, key: "activities" },
  { href: "/history", icon: History, key: "history" },
  { href: "/telos", icon: Target, key: "telos" }
] as const;

const NAV_BTN_CLASS =
  "w-full group flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-100";

export function Sidebar() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const todos = useTodoStore((s) => s.todos);

  // 完成度只看"今天"的(按 scheduledDate,fallback createdAt 的日期)
  const todayKey = dateKeyToday();
  const todayTodos = todos.filter((todo) => {
    const key = todo.scheduledDate ?? dateKeyOf(todo.createdAt);
    return key === todayKey;
  });
  const total = todayTodos.length;
  const done = todayTodos.filter((todo) => todo.status === "done").length;

  return (
    <aside className="w-60 flex-shrink-0 flex flex-col h-full border-r border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50">
      {/* Logo */}
      <div className="h-14 px-4 flex items-center gap-2 border-b border-zinc-200/60 dark:border-zinc-800/60">
        <div className="w-6 h-6 rounded-md bg-zinc-900 dark:bg-zinc-100 flex items-center justify-center">
          <Sun className="w-4 h-4 text-zinc-50 dark:text-zinc-900" />
        </div>
        <span className="font-semibold text-sm tracking-tight text-zinc-900 dark:text-zinc-100">
          {t("app.name")}
        </span>
      </div>

      {/* 导航 */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href;
          return (
            <NavLink
              key={item.href}
              to={item.href}
              className={cn(
                "group relative flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
                isActive
                  ? "text-zinc-900 dark:text-zinc-100"
                  : "text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-100"
              )}
            >
              {isActive && (
                <motion.div
                  layoutId="sidebar-active"
                  className="absolute inset-0 bg-zinc-200/60 dark:bg-zinc-800/60 rounded-lg -z-10"
                  transition={{ type: "spring", stiffness: 350, damping: 30 }}
                />
              )}
              <item.icon className="w-4 h-4 stroke-[2px]" />
              <span className="font-medium">{t(`nav.${item.key}`)}</span>
            </NavLink>
          );
        })}
      </nav>

      {/* 底部:悬浮窗入口 + Settings + 完成度 */}
      <div className="px-3 pb-4 mt-auto space-y-1">
        <button
          type="button"
          onClick={() => void openChatBar()}
          title={t("nav.openChatBar")}
          className={NAV_BTN_CLASS}
        >
          <MessageSquare className="w-4 h-4 stroke-[2px]" />
          <span className="font-medium">{t("nav.openChatBar")}</span>
        </button>
        <button
          type="button"
          onClick={() => void openTodoFloat()}
          title={t("nav.openTodo")}
          className={NAV_BTN_CLASS}
        >
          <PanelTopOpen className="w-4 h-4 stroke-[2px]" />
          <span className="font-medium">{t("nav.openTodo")}</span>
        </button>
        <NavLink
          to="/settings"
          className={cn(
            "group relative flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
            pathname === "/settings"
              ? "text-zinc-900 dark:text-zinc-100 bg-zinc-200/60 dark:bg-zinc-800/60"
              : "text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-100"
          )}
        >
          <Settings className="w-4 h-4 stroke-[2px]" />
          <span className="font-medium">{t("nav.settings")}</span>
        </NavLink>
        <div className="px-3 py-1 flex items-center justify-between text-xs font-medium text-zinc-500 dark:text-zinc-400">
          <span>{t("common.completed", { done, total })}</span>
          <span
            className={cn(
              "w-2 h-2 rounded-full",
              done > 0
                ? "bg-emerald-500"
                : "bg-zinc-300 dark:bg-zinc-600"
            )}
          />
        </div>
      </div>
    </aside>
  );
}

/** 今天 YYYY-MM-DD(本地时区) */
function dateKeyToday(): string {
  return dateKeyOf(new Date());
}

function dateKeyOf(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

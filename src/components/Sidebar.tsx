import { NavLink, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useState } from "react";
import type { ComponentType } from "react";
import { motion } from "motion/react";
import {
  Sun,
  ListTodo,
  CalendarDays,
  MessageSquare,
  Target,
  Settings,
  PanelTopOpen,
  PanelTopClose,
  PanelBottomClose,
  History,
  NotebookPen,
  UserCircle2,
  Plug
} from "lucide-react";
import { cn } from "../lib/utils";
import { useTodoStore } from "../lib/store";
import { useSettingsStore } from "../lib/settings";
import {
  toggleChatBar,
  toggleTodoFloat,
  isFloaterVisible,
  WIN_CHATBAR,
  WIN_TODO
} from "../lib/windowLayout";

/**
 * 主导航
 *
 * 颜色 class 一律 light 默认 + dark: 前缀,用 Tailwind darkMode: "class" 切换。
 */

export interface SidebarNavItem {
  href: string;
  icon: ComponentType<{ className?: string }>;
  /** i18n key:t(`nav.${key}`);同时作为 settings.sidebarHidden 里的标识 */
  key: string;
}

/**
 * 主导航项 —— 不含「设置」(它在底部固定、不可隐藏,是「侧栏管理」的回路入口)。
 * 导出供设置页「侧栏管理」(需求 4)列举可显隐的项,保证两处定义不漂移。
 */
export const SIDEBAR_NAV_ITEMS: readonly SidebarNavItem[] = [
  { href: "/", icon: Sun, key: "briefing" },
  { href: "/todos", icon: ListTodo, key: "todos" },
  { href: "/calendar", icon: CalendarDays, key: "calendar" },
  { href: "/activities", icon: NotebookPen, key: "activities" },
  { href: "/history", icon: History, key: "history" },
  { href: "/telos", icon: Target, key: "telos" },
  { href: "/about-you", icon: UserCircle2, key: "aboutYou" },
  { href: "/connections", icon: Plug, key: "connections" }
];

const NAV_BTN_CLASS =
  "w-full group flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-100";

/**
 * 需求 1:悬浮窗(对话条 / todo)可见性 —— 让底部按钮在「打开 ↔ 收起」间切换。
 *
 * 真相源是 Tauri 窗口的 is_visible():
 *  - 点击按钮走 toggle_*(可见则收、隐藏则开)后立即 refresh,即时反馈;
 *  - 轮询(1.5s)+ 窗口聚焦兜底:覆盖「全局快捷键 / 托盘菜单 / 悬浮窗自身关闭」等
 *    不经此按钮的外部路径,避免按钮态与真实窗口漂移(刻意不自维护本地 flag)。
 * 无 Tauri runtime(jsdom 单测 / Ladle)时 isFloaterVisible 返回 false → 一律显示「打开」,点击仍安全。
 */
function useFloaterVisibility() {
  const [vis, setVis] = useState({ chatbar: false, todo: false });

  const refresh = useCallback(async () => {
    const [chatbar, todo] = await Promise.all([
      isFloaterVisible(WIN_CHATBAR),
      isFloaterVisible(WIN_TODO)
    ]);
    setVis((prev) =>
      prev.chatbar === chatbar && prev.todo === todo ? prev : { chatbar, todo }
    );
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (alive) void refresh();
    };
    tick();
    const id = window.setInterval(tick, 1500);
    window.addEventListener("focus", tick);
    return () => {
      alive = false;
      window.clearInterval(id);
      window.removeEventListener("focus", tick);
    };
  }, [refresh]);

  return { vis, refresh };
}

export function Sidebar() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const todos = useTodoStore((s) => s.todos);
  const sidebarHidden = useSettingsStore((s) => s.sidebarHidden);
  const { vis, refresh } = useFloaterVisibility();

  // 完成度只看"今天"的(按 scheduledDate,fallback createdAt 的日期)
  const todayKey = dateKeyToday();
  const todayTodos = todos.filter((todo) => {
    const key = todo.scheduledDate ?? dateKeyOf(todo.createdAt);
    return key === todayKey;
  });
  const total = todayTodos.length;
  const done = todayTodos.filter((todo) => todo.status === "done").length;

  // 需求 4:按 sidebarHidden 过滤(「设置」不在 SIDEBAR_NAV_ITEMS 里,天然不会被藏)
  const visibleNav = SIDEBAR_NAV_ITEMS.filter((item) => !sidebarHidden.includes(item.key));

  // 需求 1:点击 = toggle 窗口 + 立即校正按钮态(外部路径靠轮询兜底)
  async function onToggleChat() {
    await toggleChatBar();
    await refresh();
  }
  async function onToggleTodo() {
    await toggleTodoFloat();
    await refresh();
  }

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
        {visibleNav.map((item) => {
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
        {sidebarHidden.length > 0 && (
          <NavLink
            to="/settings"
            className="block px-3 pt-2 text-[11px] text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
          >
            {t("nav.moreInSettings")}
          </NavLink>
        )}
      </nav>

      {/* 底部:悬浮窗入口(开 / 收联动)+ Settings + 完成度 */}
      <div className="px-3 pb-4 mt-auto space-y-1">
        <button
          type="button"
          onClick={() => void onToggleChat()}
          title={vis.chatbar ? t("nav.closeChatBar") : t("nav.openChatBar")}
          className={NAV_BTN_CLASS}
        >
          {vis.chatbar ? (
            <PanelBottomClose className="w-4 h-4 stroke-[2px]" />
          ) : (
            <MessageSquare className="w-4 h-4 stroke-[2px]" />
          )}
          <span className="font-medium">
            {vis.chatbar ? t("nav.closeChatBar") : t("nav.openChatBar")}
          </span>
        </button>
        <button
          type="button"
          onClick={() => void onToggleTodo()}
          title={vis.todo ? t("nav.closeTodo") : t("nav.openTodo")}
          className={NAV_BTN_CLASS}
        >
          {vis.todo ? (
            <PanelTopClose className="w-4 h-4 stroke-[2px]" />
          ) : (
            <PanelTopOpen className="w-4 h-4 stroke-[2px]" />
          )}
          <span className="font-medium">
            {vis.todo ? t("nav.closeTodo") : t("nav.openTodo")}
          </span>
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

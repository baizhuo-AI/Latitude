import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import {
  Sparkles,
  Loader2,
  X,
  CheckCircle2,
  Clock,
  ChevronDown
} from "lucide-react";
import { newTodoId, useTodoStore, type Todo } from "../lib/store";
import { useActivityStore } from "../lib/activityStore";
import { NewTaskModal } from "../components/NewTaskModal";
import { parseTask } from "../lib/llm";
import { onSync } from "../lib/syncBus";
import { dateKey, parseScheduledTime } from "../lib/calendar";
import { cn } from "../lib/utils";
import { toast } from "../lib/toast";

/**
 * 浮窗模式 — 260×420 常驻置顶(尺寸以 src-tauri/tauri.conf.json 的 floating 窗口为准)
 *
 * 视觉:窗口开了 transparent + decorations:false,根容器是一张圆角卡片,四角外透出桌面。
 *
 * 内容:
 *  - 顶部:拖动抓手 + 标题 + 关闭按钮;Cmd+K 风格自然语言输入(记待办)
 *  - 提醒记录态:收到主窗口 emitSync("reminder") 时浮现"刚才在做什么?"输入,走 addActivity
 *  - 中间:今日 active 任务列表
 *  - 今日活动流水:可折叠,看当日记的活动
 *  - 底部:进度统计
 *
 * 数据同步:订阅 BroadcastChannel 的 "todos" / "activities" / "reminder" topic。
 */

type Scope = "today" | "week" | "all";

function todayKeyOf(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 本周一 ~ 本周日的 YYYY-MM-DD(字符串可直接按字典序比较) */
function weekRange(): { weekStartKey: string; weekEndKey: string } {
  const now = new Date();
  const start = new Date(now);
  const dow = (start.getDay() + 6) % 7; // 0 = 周一
  start.setDate(start.getDate() - dow);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return { weekStartKey: dateKey(start), weekEndKey: dateKey(end) };
}

/** ISO → "14:30"(本地时区) */
function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return "";
  }
}

export function TodoFloat() {
  const { t } = useTranslation();
  const todos = useTodoStore((s) => s.todos);
  const hydrate = useTodoStore((s) => s.hydrate);
  const addTodo = useTodoStore((s) => s.addTodo);
  const toggleComplete = useTodoStore((s) => s.toggleComplete);
  const activities = useActivityStore((s) => s.activities);
  const hydrateActivities = useActivityStore((s) => s.hydrate);
  const addActivity = useActivityStore((s) => s.addActivity);

  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [reminderActive, setReminderActive] = useState(false);
  const [activityValue, setActivityValue] = useState("");
  const [activitySubmitting, setActivitySubmitting] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [scope, setScope] = useState<Scope>("today");
  const [editingTodo, setEditingTodo] = useState<Todo | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activityInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void hydrate();
    const off = onSync("todos", () => void hydrate());
    return off;
  }, [hydrate]);

  // 活动记录:hydrate + 跨窗口同步
  useEffect(() => {
    void hydrateActivities();
    const off = onSync("activities", () => void hydrateActivities());
    return off;
  }, [hydrateActivities]);

  // 收到主窗口的提醒信号 → 进记录态 + 聚焦
  useEffect(() => {
    const off = onSync("reminder", () => {
      setReminderActive(true);
      setTimeout(() => activityInputRef.current?.focus(), 60);
    });
    return off;
  }, []);

  // 浮窗 transparent(见 tauri.conf.json):给 <html> 挂 .is-floating 让背景透明,圆角才透出桌面
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add("is-floating");
    return () => html.classList.remove("is-floating");
  }, []);

  const todayKey = todayKeyOf();
  const { weekStartKey, weekEndKey } = weekRange();

  const keyOf = (t: Todo) => t.scheduledDate ?? dateKey(new Date(t.createdAt));
  const inScope = (t: Todo) => {
    const k = keyOf(t);
    if (scope === "today") return k === todayKey;
    if (scope === "week") return k >= weekStartKey && k <= weekEndKey;
    return true; // 全部
  };

  // 排除 dropped(软删除):否则"全部"范围会把以前删掉的旧待办翻出来
  const scoped = todos.filter((t) => t.status !== "dropped" && inScope(t));
  const visible = scoped
    .filter((t) => t.status !== "done")
    .sort(sortByDateThenTime);
  const total = scoped.length;
  const done = scoped.filter((t) => t.status === "done").length;

  const todayActivities = activities.filter(
    (a) => dateKey(new Date(a.createdAt)) === todayKey
  );

  async function handleSubmit() {
    if (!value.trim() || submitting) return;
    setSubmitting(true);
    try {
      const parsed = await parseTask(value.trim());
      await addTodo({
        id: newTodoId(),
        title: parsed.title,
        reason: parsed.reason,
        deadline: parsed.deadline,
        priority: parsed.priority,
        tags: parsed.tags,
        estTime: parsed.estTime,
        scheduledTime: parsed.scheduledTime,
        scheduledDate: todayKey,
        status: "todo",
        createdAt: new Date().toISOString()
      });
      setValue("");
      if (parsed.parsed) {
        toast.success(t("floating.added"));
      } else {
        toast.warning(t("floating.addedNoParse"));
      }
    } catch (err) {
      console.error("[Floating] submit failed:", err);
      toast.error(t("floating.addFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  // 记录态:提交"刚才做了什么",走 addActivity(纯文本,不调 AI),与记待办分开
  async function handleActivitySubmit() {
    const v = activityValue.trim();
    if (!v || activitySubmitting) return;
    setActivitySubmitting(true);
    try {
      await addActivity(v);
      setActivityValue("");
      setReminderActive(false);
      toast.success(t("floating.activityLogged"));
    } catch (err) {
      console.error("[Floating] log activity failed:", err);
      toast.error(t("floating.activityFailed"));
    } finally {
      setActivitySubmitting(false);
    }
  }

  return (
    // 根容器 = 圆角浮窗卡片(窗口已 transparent,四角外透出桌面 = 真圆角)
    <div className="h-screen w-screen flex flex-col overflow-hidden rounded-xl border border-border/70 bg-bg-elevated text-text">
      {/* 顶部:抓手 + 标题 + 关闭 + 记待办输入 */}
      <header
        data-tauri-drag-region
        className="flex-shrink-0 border-b border-border/50 px-3.5 pt-2 pb-3"
      >
        <div
          data-tauri-drag-region
          className="flex cursor-grab justify-center pb-2.5 pt-0.5 active:cursor-grabbing"
        >
          <div className="h-1 w-9 rounded-full bg-border-strong/80" />
        </div>
        <div data-tauri-drag-region className="flex items-center justify-between">
          <div
            data-tauri-drag-region
            className="select-none text-[11px] font-semibold uppercase tracking-wider text-text-faint"
          >
            {t("floating.title")}
          </div>
          <button
            type="button"
            data-tauri-drag-region="false"
            onClick={() => void hideSelf()}
            aria-label={t("floating.close")}
            title={t("floating.close")}
            className="-mr-1 rounded-md p-1 text-text-faint transition-colors hover:bg-bg-muted hover:text-text"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="relative mt-2.5">
          <Sparkles
            className={cn(
              "absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 transition-colors",
              value ? "text-accent" : "text-text-faint"
            )}
          />
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !submitting) {
                e.preventDefault();
                void handleSubmit();
              }
            }}
            disabled={submitting}
            placeholder={t("floating.placeholder")}
            className={cn(
              "w-full rounded-lg py-2 pl-7 pr-7 text-sm outline-none transition-colors",
              "border border-transparent bg-bg-muted",
              "focus:border-accent focus:bg-bg-elevated",
              "text-text placeholder:text-text-faint"
            )}
          />
          {submitting && (
            <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-accent" />
          )}
        </div>

        {/* 范围切换:今日 / 本周 / 全部 */}
        <div className="mt-2 flex rounded-lg bg-bg-muted p-0.5 text-[11px]">
          {(["today", "week", "all"] as Scope[]).map((s) => (
            <button
              key={s}
              type="button"
              data-tauri-drag-region="false"
              onClick={() => setScope(s)}
              className={cn(
                "flex-1 rounded-md py-1 font-medium transition-colors",
                scope === s
                  ? "bg-bg-elevated text-text shadow-sm"
                  : "text-text-faint hover:text-text"
              )}
            >
              {t(`floating.scope.${s}`)}
            </button>
          ))}
        </div>
      </header>

      {/* 列表区(提醒记录态卡片在顶) */}
      <div className="scrollbar-thin flex-1 overflow-y-auto">
        {reminderActive && (
          <div className="m-2 rounded-lg border border-accent/40 bg-accent/5 p-2.5">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-accent">
              <Clock className="h-3 w-3" />
              {t("floating.activityPrompt")}
            </div>
            <input
              ref={activityInputRef}
              value={activityValue}
              onChange={(e) => setActivityValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !activitySubmitting) {
                  e.preventDefault();
                  void handleActivitySubmit();
                }
              }}
              disabled={activitySubmitting}
              placeholder={t("floating.activityPlaceholder")}
              className={cn(
                "w-full rounded-md px-2 py-1.5 text-sm outline-none transition-colors",
                "border border-transparent bg-bg-elevated focus:border-accent",
                "text-text placeholder:text-text-faint"
              )}
            />
            <div className="mt-1.5 flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setReminderActive(false)}
                className="rounded px-2 py-0.5 text-[11px] text-text-faint transition-colors hover:text-text"
              >
                {t("floating.activitySkip")}
              </button>
              <button
                type="button"
                onClick={() => void handleActivitySubmit()}
                disabled={activitySubmitting}
                className="rounded bg-accent px-2 py-0.5 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {t("floating.activityLog")}
              </button>
            </div>
          </div>
        )}

        <div className="space-y-0.5 px-2.5 py-2.5">
          {visible.length === 0 ? (
            <div className="px-3 py-12 text-center text-xs text-text-faint">
              {scope === "today" ? t("floating.empty") : t("floating.emptyScope")}
            </div>
          ) : (
            visible.map((todo) => (
              <TodoLine
                key={todo.id}
                todo={todo}
                showDate={scope !== "today"}
                dateLabel={fmtDateShort(keyOf(todo))}
                onToggle={() => void toggleComplete(todo.id)}
                onEdit={() => setEditingTodo(todo)}
              />
            ))
          )}
        </div>
      </div>

      {/* 今日活动流水(可折叠) */}
      {todayActivities.length > 0 && (
        <div className="flex-shrink-0 border-t border-border/50">
          <button
            type="button"
            onClick={() => setShowLog((v) => !v)}
            className="flex w-full items-center justify-between px-3.5 py-1.5 text-[11px] font-medium text-text-muted transition-colors hover:bg-bg-muted/50"
          >
            <span>{t("floating.todayLog", { count: todayActivities.length })}</span>
            <ChevronDown
              className={cn("h-3 w-3 transition-transform", showLog && "rotate-180")}
            />
          </button>
          {showLog && (
            <div className="scrollbar-thin max-h-32 space-y-1 overflow-y-auto px-3.5 pb-2">
              {todayActivities.map((a) => (
                <div key={a.id} className="flex gap-2 text-[11px] leading-relaxed">
                  <span className="flex-shrink-0 font-mono text-text-faint">
                    {fmtTime(a.createdAt)}
                  </span>
                  <span className="text-text-muted">{a.content}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 底部:进度 */}
      <footer className="flex flex-shrink-0 items-center justify-between border-t border-border/50 px-3.5 py-2.5 text-[11px] font-medium text-text-muted">
        <span>{t("floating.progress", { done, total })}</span>
        {done > 0 && <CheckCircle2 className="h-3.5 w-3.5 text-success" />}
      </footer>

      {/* 编辑 modal（双击任务行触发；空间小但 modal 自带滚动） */}
      <NewTaskModal
        open={!!editingTodo}
        initial={editingTodo}
        onClose={() => setEditingTodo(null)}
      />
    </div>
  );
}

function sortByScheduledTime(a: Todo, b: Todo): number {
  const ra = parseScheduledTime(a.scheduledTime);
  const rb = parseScheduledTime(b.scheduledTime);
  if (ra && rb) return ra.startMin - rb.startMin;
  if (ra) return -1;
  if (rb) return 1;
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

/** 跨天范围(本周 / 全部)排序:先按日期,再按时段。 */
function sortByDateThenTime(a: Todo, b: Todo): number {
  const ka = a.scheduledDate ?? dateKey(new Date(a.createdAt));
  const kb = b.scheduledDate ?? dateKey(new Date(b.createdAt));
  if (ka !== kb) return ka < kb ? -1 : 1;
  return sortByScheduledTime(a, b);
}

/** YYYY-MM-DD → "MM-DD"(跨天列表里给每条标个日期) */
function fmtDateShort(key: string): string {
  return key.length >= 10 ? key.slice(5) : key;
}

/**
 * 隐藏当前浮窗(hide 不是 close):close 会销毁窗口、释放 "floating" label,
 * 下次 openFloating 的 getByLabel 拿不到就走没测过的兜底新建路径。hide 只是藏起来,再 show 还是同一个。
 * 动态 import:无 Tauri runtime 的环境(jsdom 单测、Ladle)不要求 @tauri-apps/api 必须能 resolve。
 */
async function hideSelf(): Promise<void> {
  try {
    const mod = await import("@tauri-apps/api/webviewWindow");
    const win = mod.getCurrentWebviewWindow();
    await win.hide();
  } catch (err) {
    console.error("[Floating] hide failed:", err);
  }
}

function TodoLine({
  todo,
  onToggle,
  onEdit,
  showDate,
  dateLabel
}: {
  todo: Todo;
  onToggle: () => void;
  onEdit: () => void;
  showDate?: boolean;
  dateLabel?: string;
}) {
  return (
    <motion.div
      layout
      onDoubleClick={onEdit}
      className={cn(
        "group flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors cursor-default",
        "hover:bg-bg-muted"
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 rounded-full border border-border-strong transition-colors hover:border-success hover:bg-success/10"
        aria-label="complete"
      />
      <div className="min-w-0 flex-1">
        {(showDate && dateLabel) || todo.scheduledTime ? (
          <div className="mb-0.5 flex items-center gap-1">
            {showDate && dateLabel && (
              <span className="inline-block rounded bg-bg-muted px-1 py-0.5 font-mono text-[10px] text-text-faint">
                {dateLabel}
              </span>
            )}
            {todo.scheduledTime && (
              <span className="inline-block rounded bg-accent/10 px-1 py-0.5 font-mono text-[10px] text-accent">
                {todo.scheduledTime}
              </span>
            )}
          </div>
        ) : null}
        <div className="text-xs leading-snug text-text line-clamp-2">
          {todo.title}
        </div>
      </div>
    </motion.div>
  );
}

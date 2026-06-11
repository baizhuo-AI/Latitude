import { useEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import { useTranslation } from "react-i18next";
import {
  X,
  Lock,
  MapPin,
  Clock,
  CalendarDays,
  Repeat,
  AlignLeft
} from "lucide-react";
import { cn } from "../lib/utils";
import type { CalendarEvent } from "../lib/db";

/**
 * 日历事件详情弹窗(只读 peek)。
 *
 * 网格里的事件卡只做一眼速览(标题+时间,短块会截断);点击任意事件卡弹出本窗看全文:
 * 完整标题、日期/时段、来源日历、地点、描述,以及只读/草稿/全天/重复等状态。
 *
 * 设计:
 *  - 复用 ConfirmDialog 同款范式:createPortal(body) + motion backdrop + 点外/Esc 关闭。
 *  - event=null 时不渲染内容(AnimatePresence 负责淡出)。
 *  - 纯展示,不触发任何同步/写回——改时段仍走拖拽。
 */

/** "2026-05-27" → "5月27日 周三"(失败回退原串)。 */
function fmtDate(iso?: string): string {
  if (!iso) return "";
  const parts = iso.split("-").map(Number);
  const [y, m, d] = parts;
  if (!y || !m || !d) return iso;
  const date = new Date(y, m - 1, d);
  const wd = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
  return `${m}月${d}日 ${wd}`;
}

/** "11:00-12:00" → "11:00 – 12:00";单值原样返回。 */
function fmtTimeRange(scheduledTime?: string): string {
  if (!scheduledTime) return "";
  const [a, b] = scheduledTime.split("-");
  return b ? `${a.trim()} – ${b.trim()}` : a.trim();
}

function Badge({
  children,
  tone
}: {
  children: React.ReactNode;
  tone: "gray" | "amber" | "blue" | "indigo";
}) {
  const tones = {
    gray: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
    amber: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
    blue: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
    indigo: "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300"
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
        tones[tone]
      )}
    >
      {children}
    </span>
  );
}

/** 详情里一行 meta(图标 + 文本)。value 为空时不渲染。 */
function MetaRow({
  icon,
  children
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5 text-sm text-zinc-700 dark:text-zinc-300">
      <span className="mt-0.5 flex-shrink-0 text-zinc-400 dark:text-zinc-500">
        {icon}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export default function EventDetailModal({
  event,
  onClose
}: {
  event: CalendarEvent | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!event) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [event, onClose]);

  if (typeof document === "undefined") return null;

  const locked = event ? !event.isWritable : false;
  const dateLabel = event ? fmtDate(event.scheduledDate) : "";
  const timeLabel = event?.isAllDay
    ? t("calendar.allDay", { defaultValue: "全天" })
    : fmtTimeRange(event?.scheduledTime);

  return createPortal(
    <AnimatePresence>
      {event && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/45 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 8 }}
            transition={{ duration: 0.15 }}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "w-full max-w-md rounded-2xl shadow-lg overflow-hidden",
              "bg-white dark:bg-zinc-900",
              "border border-zinc-200 dark:border-zinc-800"
            )}
            role="dialog"
            aria-modal="true"
          >
            {/* 头部:完整标题 + 关闭 */}
            <div className="flex items-start gap-3 p-5 pb-3">
              <h2 className="min-w-0 flex-1 text-base font-semibold leading-snug text-zinc-900 dark:text-zinc-100 break-words">
                {event.title || t("calendar.allDay", { defaultValue: "(无标题)" })}
              </h2>
              <button
                type="button"
                onClick={onClose}
                className="-mr-1 -mt-1 flex-shrink-0 rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 transition-colors"
                aria-label="关闭"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* 状态徽标 */}
            <div className="flex flex-wrap gap-1.5 px-5 pb-3">
              {locked ? (
                <Badge tone="gray">
                  <Lock className="h-3 w-3" />
                  {t("calendar.readonly", { defaultValue: "只读" })}
                </Badge>
              ) : (
                <Badge tone="indigo">可写</Badge>
              )}
              {event.localDraft && <Badge tone="amber">⚠ 冲突·草稿</Badge>}
              {event.isAllDay && <Badge tone="blue">全天</Badge>}
              {event.isRecurringInstance && (
                <Badge tone="gray">
                  <Repeat className="h-3 w-3" />
                  重复
                </Badge>
              )}
              <Badge tone="gray">
                {event.region === "lark" ? "Lark" : "飞书"}
              </Badge>
            </div>

            {/* meta 行 */}
            <div className="space-y-3 px-5 pb-5">
              <MetaRow icon={<CalendarDays className="h-4 w-4" />}>
                <span className="font-medium">{dateLabel}</span>
              </MetaRow>
              {timeLabel && (
                <MetaRow icon={<Clock className="h-4 w-4" />}>
                  <span className="tabular-nums">{timeLabel}</span>
                </MetaRow>
              )}
              {event.calendarName && (
                <MetaRow icon={<span className="text-base leading-none">📁</span>}>
                  <span className="text-zinc-500 dark:text-zinc-400">
                    {event.calendarName}
                  </span>
                </MetaRow>
              )}
              {event.location && (
                <MetaRow icon={<MapPin className="h-4 w-4" />}>
                  <span>{event.location}</span>
                </MetaRow>
              )}
              {event.description && (
                <MetaRow icon={<AlignLeft className="h-4 w-4" />}>
                  <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-zinc-600 dark:text-zinc-400 leading-relaxed">
                    {event.description}
                  </p>
                </MetaRow>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import { useTranslation } from "react-i18next";
import { X, Plus } from "lucide-react";
import { useTodoStore, newTodoId, type Priority, type Todo } from "../lib/store";
import { useFieldStore } from "../lib/fieldStore";
import { cn } from "../lib/utils";
import { DatePicker } from "./DatePicker";
import {
  parseScheduledTime,
  quickDeadline,
  type QuickDeadlineKind
} from "../lib/calendar";

/**
 * 新建待办 Modal — 纯手填,不调 LLM
 *
 * 想用 AI 解析请走顶栏 ⌘K(那条路径会调 DeepSeek)
 *
 * 字段:title(必填)/ reason / deadline / priority / tags / estTime / scheduledTime
 * 校验:title 不能空白;scheduledTime 结束须晚于开始
 * 快捷:Esc 关闭,⌘+Enter 提交
 *
 * 日期/时间均为选择器(2026-05 改):
 *  - deadline:原生日历(type=date)+ 快捷词(今天/明天/本周五/下周一),存 "YYYY-MM-DD"
 *  - scheduledTime:开始/结束两个 type=time,提交时拼成 "HH:MM-HH:MM"
 *    (日历/早安/浮窗都靠 calendar.ts 的 parseScheduledTime 解析这个格式,所以提交前自校验)
 */

interface Props {
  open: boolean;
  onClose: () => void;
  /** 传入则进入"编辑"模式：表单预填，提交走 updateTodo（全字段覆盖） */
  initial?: Todo | null;
}

const PRIORITIES: Priority[] = ["high", "medium", "low", "none"];
const QUICK_DEADLINES: QuickDeadlineKind[] = [
  "today",
  "tomorrow",
  "thisFri",
  "nextMon"
];

export function NewTaskModal({ open, onClose, initial }: Props) {
  const { t } = useTranslation();
  const addTodo = useTodoStore((s) => s.addTodo);
  const updateTodo = useTodoStore((s) => s.updateTodo);
  const isEditing = !!initial;

  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [deadline, setDeadline] = useState("");
  const [priority, setPriority] = useState<Priority>("none");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [estTime, setEstTime] = useState("");
  const [schedStart, setSchedStart] = useState("");
  const [schedEnd, setSchedEnd] = useState("");
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, string | string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fieldDefs = useFieldStore((s) => s.fields);

  const titleRef = useRef<HTMLInputElement>(null);

  // 打开时:从 initial 预填(编辑模式)或清空(新建模式),聚焦标题
  useEffect(() => {
    if (open) {
      // scheduledTime "HH:MM-HH:MM" 拆回两个 time input 预填
      let sStart = "";
      let sEnd = "";
      if (initial?.scheduledTime) {
        const m = initial.scheduledTime.match(/^(\d{2}:\d{2})-(\d{2}:\d{2})$/);
        if (m) {
          sStart = m[1];
          sEnd = m[2];
        }
      }
      setTitle(initial?.title ?? "");
      setReason(initial?.reason ?? "");
      setDeadline(initial?.deadline ?? "");
      setPriority(initial?.priority ?? "none");
      setTags(initial?.tags ?? []);
      setTagInput("");
      setEstTime(initial?.estTime ?? "");
      setSchedStart(sStart);
      setSchedEnd(sEnd);
      setCustomFieldValues(initial?.customFields ?? {});
      setError(null);
      setSubmitting(false);
      const id = setTimeout(() => titleRef.current?.focus(), 100);
      return () => clearTimeout(id);
    }
  }, [open, initial]);

  // Esc 关闭(在 modal 打开时挂)
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSubmit();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function addTag() {
    const v = tagInput.trim();
    if (!v) return;
    if (tags.includes(v)) {
      setTagInput("");
      return;
    }
    if (tags.length >= 3) return;
    setTags([...tags, v]);
    setTagInput("");
  }

  function removeTag(tag: string) {
    setTags(tags.filter((x) => x !== tag));
  }

  async function handleSubmit() {
    if (submitting) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError(t("newTask.errors.titleRequired"));
      titleRef.current?.focus();
      return;
    }
    // 时段:两个 time 选择拼成 "HH:MM-HH:MM",自校验(结束须晚于开始且格式合法)
    let scheduledTime: string | undefined;
    if (schedStart && schedEnd) {
      const candidate = `${schedStart}-${schedEnd}`;
      if (!parseScheduledTime(candidate)) {
        setError(t("newTask.errors.invalidTimeRange"));
        return;
      }
      scheduledTime = candidate;
    }
    setSubmitting(true);
    setError(null);
    try {
      const now = new Date();
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      if (isEditing && initial) {
        const cf = Object.keys(customFieldValues).length > 0 ? customFieldValues : undefined;
        await updateTodo({
          ...initial,
          title: trimmedTitle,
          reason: reason.trim() || undefined,
          deadline: deadline || undefined,
          priority,
          tags,
          estTime: estTime.trim() || undefined,
          scheduledTime,
          customFields: cf,
        });
      } else {
        const cf = Object.keys(customFieldValues).length > 0 ? customFieldValues : undefined;
        await addTodo({
          id: newTodoId(),
          title: trimmedTitle,
          reason: reason.trim() || undefined,
          deadline: deadline || undefined,
          priority,
          tags,
          estTime: estTime.trim() || undefined,
          scheduledTime,
          scheduledDate: todayKey,
          status: "todo",
          createdAt: now.toISOString(),
          customFields: cf,
        });
      }
      onClose();
    } catch (err) {
      console.error("[NewTaskModal] create failed:", err);
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.96, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 8 }}
            transition={{ duration: 0.18 }}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "w-full max-w-lg rounded-2xl shadow-lg overflow-hidden",
              "bg-white dark:bg-zinc-900",
              "border border-zinc-200 dark:border-zinc-800"
            )}
          >
            {/* 头 */}
            <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
                  {isEditing ? "编辑待办" : t("newTask.title")}
                </h2>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  {isEditing ? "修改后回车保存（⌘+Enter）" : t("newTask.subtitle")}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="close"
                className="p-1 -m-1 rounded text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 表单 */}
            <div className="px-5 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
              {/* title */}
              <Field label={t("newTask.fields.title")} required>
                <input
                  ref={titleRef}
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    if (error) setError(null);
                  }}
                  placeholder={t("newTask.fields.titlePlaceholder")}
                  className={cn(inputCls, error && "border-red-500")}
                />
                {error && (
                  <p className="mt-1 text-xs text-red-500">{error}</p>
                )}
              </Field>

              {/* reason */}
              <Field label={t("newTask.fields.reason")}>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={t("newTask.fields.reasonPlaceholder")}
                  rows={2}
                  className={cn(inputCls, "resize-none leading-relaxed")}
                />
              </Field>

              {/* deadline:日历选择 + 快捷词 */}
              <Field label={t("newTask.fields.deadline")}>
                <div className="space-y-2">
                  <DatePicker
                    value={deadline}
                    onChange={setDeadline}
                    placeholder={t("common.pickDate")}
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {QUICK_DEADLINES.map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setDeadline(quickDeadline(k))}
                        className={cn(
                          "px-2 py-1 rounded-md text-xs font-medium transition-colors",
                          deadline === quickDeadline(k)
                            ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300"
                            : "text-zinc-600 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700"
                        )}
                      >
                        {t(`newTask.deadlineQuick.${k}`)}
                      </button>
                    ))}
                    {deadline && (
                      <button
                        type="button"
                        onClick={() => setDeadline("")}
                        className="px-2 py-1 rounded-md text-xs font-medium text-zinc-400 hover:text-red-500 transition-colors"
                      >
                        {t("newTask.deadlineQuick.clear")}
                      </button>
                    )}
                  </div>
                </div>
              </Field>

              {/* estTime */}
              <Field label={t("newTask.fields.estTime")}>
                <input
                  value={estTime}
                  onChange={(e) => setEstTime(e.target.value)}
                  placeholder={t("newTask.fields.estTimePlaceholder")}
                  className={inputCls}
                />
              </Field>

              {/* scheduledTime:开始 - 结束两个时间选择器,提交时拼成 "HH:MM-HH:MM" */}
              <Field label={t("newTask.fields.scheduledTime")}>
                <div className="flex items-center gap-2">
                  <input
                    type="time"
                    value={schedStart}
                    onChange={(e) => setSchedStart(e.target.value)}
                    className={inputCls}
                  />
                  <span className="flex-shrink-0 text-sm text-zinc-400">–</span>
                  <input
                    type="time"
                    value={schedEnd}
                    onChange={(e) => setSchedEnd(e.target.value)}
                    className={inputCls}
                  />
                </div>
              </Field>

              {/* priority */}
              <Field label={t("newTask.fields.priority")}>
                <div className="flex gap-1.5">
                  {PRIORITIES.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPriority(p)}
                      className={cn(
                        "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                        priority === p
                          ? priorityActiveCls(p)
                          : "text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700"
                      )}
                    >
                      {t(`newTask.priority.${p}`)}
                    </button>
                  ))}
                </div>
              </Field>

              {/* tags */}
              <Field label={t("newTask.fields.tags")}>
                <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 focus-within:border-indigo-500 transition-colors">
                  {tags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 text-xs bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300 px-1.5 py-0.5 rounded"
                    >
                      {tag}
                      <button
                        type="button"
                        onClick={() => removeTag(tag)}
                        className="hover:text-indigo-900 dark:hover:text-indigo-100"
                        aria-label="remove tag"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                  {tags.length < 3 && (
                    <input
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addTag();
                        } else if (
                          e.key === "Backspace" &&
                          tagInput === "" &&
                          tags.length > 0
                        ) {
                          removeTag(tags[tags.length - 1]);
                        }
                      }}
                      placeholder={t("newTask.fields.tagsPlaceholder")}
                      className="flex-1 min-w-[120px] bg-transparent outline-none text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
                    />
                  )}
                </div>
              </Field>

              {/* 自定义字段 */}
              {fieldDefs.length > 0 && (
                <>
                  <div className="border-t border-zinc-200 dark:border-zinc-700 pt-4">
                    {fieldDefs.map((fd) => (
                      <div key={fd.id} className="mb-3 last:mb-0">
                        <Field label={fd.name}>
                          {fd.type === "single_select" ? (
                            <select
                              value={(customFieldValues[fd.id] as string) ?? ""}
                              onChange={(e) => {
                                const v = e.target.value;
                                setCustomFieldValues((prev) => {
                                  const next = { ...prev };
                                  if (v) next[fd.id] = v;
                                  else delete next[fd.id];
                                  return next;
                                });
                              }}
                              className={inputCls}
                            >
                              <option value="">—</option>
                              {fd.options.map((opt) => (
                                <option key={opt.id} value={opt.id}>{opt.label}</option>
                              ))}
                            </select>
                          ) : (
                            <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950">
                              {((customFieldValues[fd.id] as string[]) ?? []).map((optId) => {
                                const opt = fd.options.find((o) => o.id === optId);
                                if (!opt) return null;
                                return (
                                  <span
                                    key={optId}
                                    className="inline-flex items-center gap-1 text-xs text-white px-1.5 py-0.5 rounded-full"
                                    style={{ backgroundColor: opt.color }}
                                  >
                                    {opt.label}
                                    <button
                                      type="button"
                                      onClick={() => setCustomFieldValues((prev) => {
                                        const arr = ((prev[fd.id] as string[]) ?? []).filter((v) => v !== optId);
                                        const next = { ...prev };
                                        if (arr.length > 0) next[fd.id] = arr;
                                        else delete next[fd.id];
                                        return next;
                                      })}
                                      className="hover:text-white/70"
                                    >
                                      <X className="w-2.5 h-2.5" />
                                    </button>
                                  </span>
                                );
                              })}
                              <select
                                value=""
                                onChange={(e) => {
                                  const v = e.target.value;
                                  if (!v) return;
                                  setCustomFieldValues((prev) => {
                                    const arr = (prev[fd.id] as string[]) ?? [];
                                    if (arr.includes(v)) return prev;
                                    return { ...prev, [fd.id]: [...arr, v] };
                                  });
                                }}
                                className="bg-transparent outline-none text-xs text-zinc-500 cursor-pointer"
                              >
                                <option value="">+</option>
                                {fd.options
                                  .filter((o) => !((customFieldValues[fd.id] as string[]) ?? []).includes(o.id))
                                  .map((opt) => (
                                    <option key={opt.id} value={opt.id}>{opt.label}</option>
                                  ))}
                              </select>
                            </div>
                          )}
                        </Field>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* 操作 */}
            <div className="px-5 py-3 bg-zinc-50 dark:bg-zinc-950/50 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="px-3 py-1.5 text-sm font-medium text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors disabled:opacity-50"
              >
                {t("newTask.actions.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={submitting}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-indigo-500 hover:bg-indigo-600 rounded-md transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <Plus className="w-3.5 h-3.5" />
                {isEditing ? "保存" : t("newTask.actions.create")}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

/* ---------- 子组件 ---------- */

function Field({
  label,
  required,
  children
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

const inputCls = cn(
  "w-full px-3 py-1.5 rounded-lg text-sm outline-none transition-colors",
  "bg-zinc-50 dark:bg-zinc-950",
  "border border-zinc-200 dark:border-zinc-700",
  "focus:border-indigo-500",
  "text-zinc-900 dark:text-zinc-100",
  "placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
);

function priorityActiveCls(p: Priority): string {
  switch (p) {
    case "high":
      return "bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400 border border-red-200 dark:border-red-900/50";
    case "medium":
      return "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400 border border-amber-200 dark:border-amber-900/50";
    case "low":
      return "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-900/50";
    case "none":
    default:
      return "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200";
  }
}

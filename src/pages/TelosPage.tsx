import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "motion/react";
import { Target, Plus, Check, X, Calendar } from "lucide-react";
import {
  useGoalsStore,
  newGoalId,
  type Goal,
  type GoalPeriod,
  type GoalStatus
} from "../lib/goalsStore";
import { cn } from "../lib/utils";
import { DatePicker } from "../components/DatePicker";
import { useConfirm } from "../components/ConfirmDialog";

/**
 * Telos · 长期目标
 *
 * 按 period 分三组(年/季/月)展示。
 * 这些 goal 会被注入 Briefing 的 system prompt 和 Chat 上下文,
 * 让 AI 排今日 / 早安生成都基于"用户的长期方向",这是 Latitude 的产品差异化。
 */

const PERIODS: GoalPeriod[] = ["year", "quarter", "month"];

export function TelosPage() {
  const { t } = useTranslation();
  const goals = useGoalsStore((s) => s.goals);
  const loaded = useGoalsStore((s) => s.loaded);
  const hydrate = useGoalsStore((s) => s.hydrate);
  const removeGoal = useGoalsStore((s) => s.removeGoal);
  const setStatus = useGoalsStore((s) => s.setStatus);
  const confirm = useConfirm();
  const [composeFor, setComposeFor] = useState<GoalPeriod | null>(null);

  useEffect(() => {
    if (!loaded) void hydrate();
  }, [loaded, hydrate]);

  const byPeriod = useMemo(() => {
    const map: Record<GoalPeriod, Goal[]> = {
      year: [],
      quarter: [],
      month: []
    };
    for (const g of goals) {
      if (g.period in map) map[g.period].push(g);
    }
    return map;
  }, [goals]);

  async function handleDelete(goal: Goal) {
    const ok = await confirm({
      title: t("telos.delete"),
      message: t("common.deleteConfirm", { title: goal.title }),
      destructive: true,
      confirmLabel: t("telos.delete")
    });
    if (ok) void removeGoal(goal.id);
  }

  return (
    <div className="h-full flex flex-col">
      <header className="h-14 px-6 flex items-center border-b border-zinc-200 dark:border-zinc-800 flex-shrink-0 gap-3">
        <Target className="w-4 h-4 text-zinc-400 dark:text-zinc-500" />
        <div className="min-w-0">
          <h1 className="text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            {t("telos.title")}
          </h1>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
            {t("telos.subtitle")}
          </p>
        </div>
      </header>

      <div className="flex-1 overflow-auto scrollbar-thin">
        <div className="max-w-3xl mx-auto px-6 py-8 space-y-8">
          {PERIODS.map((period) => (
            <PeriodSection
              key={period}
              period={period}
              goals={byPeriod[period]}
              onAddClick={() => setComposeFor(period)}
              onToggleStatus={(goal) => {
                const next: GoalStatus =
                  goal.status === "achieved" ? "active" : "achieved";
                void setStatus(goal.id, next);
              }}
              onDelete={handleDelete}
            />
          ))}
        </div>
      </div>

      <AnimatePresence>
        {composeFor && (
          <ComposeModal
            period={composeFor}
            onClose={() => setComposeFor(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------- 子组件 ---------- */

function PeriodSection({
  period,
  goals,
  onAddClick,
  onToggleStatus,
  onDelete
}: {
  period: GoalPeriod;
  goals: Goal[];
  onAddClick: () => void;
  onToggleStatus: (g: Goal) => void;
  onDelete: (g: Goal) => void;
}) {
  const { t } = useTranslation();
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          {t(`telos.period.${period}`)}
        </h2>
        <button
          type="button"
          onClick={onAddClick}
          className="flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-indigo-500 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          {t("telos.addGoal")}
        </button>
      </div>

      {goals.length === 0 ? (
        <div className="border border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl p-4 text-center text-xs text-zinc-400 dark:text-zinc-500">
          {t("telos.empty")}
        </div>
      ) : (
        <div className="space-y-2">
          {goals.map((goal) => (
            <GoalRow
              key={goal.id}
              goal={goal}
              onToggleStatus={() => onToggleStatus(goal)}
              onDelete={() => onDelete(goal)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function GoalRow({
  goal,
  onToggleStatus,
  onDelete
}: {
  goal: Goal;
  onToggleStatus: () => void;
  onDelete: () => void;
}) {
  const achieved = goal.status === "achieved";
  return (
    <div
      className={cn(
        "group relative rounded-xl p-3 flex gap-3 transition-colors",
        "bg-white dark:bg-zinc-900",
        "border border-zinc-200 dark:border-zinc-800",
        "hover:bg-zinc-50 dark:hover:bg-zinc-800/50",
        achieved && "opacity-60"
      )}
    >
      <button
        type="button"
        onClick={onToggleStatus}
        className={cn(
          "w-5 h-5 mt-0.5 rounded-full border flex-shrink-0 flex items-center justify-center transition-colors",
          achieved
            ? "bg-emerald-500 border-emerald-500 text-white"
            : "border-zinc-300 dark:border-zinc-700 hover:border-emerald-500 hover:bg-emerald-500/10"
        )}
        aria-label="achieved"
      >
        {achieved && <Check className="w-3 h-3" />}
      </button>

      <div className="flex-1 min-w-0">
        <h3
          className={cn(
            "text-sm font-medium leading-tight",
            achieved
              ? "text-zinc-400 dark:text-zinc-500 line-through"
              : "text-zinc-900 dark:text-zinc-100"
          )}
        >
          {goal.title}
        </h3>
        {goal.description && (
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
            {goal.description}
          </p>
        )}
        {goal.targetDate && (
          <p className="mt-1.5 flex items-center gap-1 text-[11px] text-zinc-400 dark:text-zinc-500">
            <Calendar className="w-3 h-3" />
            {goal.targetDate}
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={onDelete}
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 p-1 rounded text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 transition-all"
        aria-label="delete"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

/* ---------- 新建 Goal Modal ---------- */

function ComposeModal({
  period,
  onClose
}: {
  period: GoalPeriod;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const addGoal = useGoalsStore((s) => s.addGoal);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError(t("telos.errors.titleRequired"));
      return;
    }
    await addGoal({
      id: newGoalId(),
      title: trimmedTitle,
      description: description.trim() || undefined,
      period,
      targetDate: targetDate.trim() || undefined,
      status: "active",
      createdAt: new Date().toISOString()
    });
    onClose();
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 8 }}
        transition={{ duration: 0.15 }}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "w-full max-w-md rounded-2xl shadow-lg overflow-hidden",
          "bg-white dark:bg-zinc-900",
          "border border-zinc-200 dark:border-zinc-800"
        )}
      >
        <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {t(`telos.new.${period}`)}
          </h2>
        </div>

        <div className="px-5 py-4 space-y-4">
          <FieldLabel label={t("telos.fields.title")} required>
            <input
              autoFocus
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                if (error) setError(null);
              }}
              placeholder={t("telos.fields.titlePlaceholder")}
              className={cn(inputCls, error && "border-red-500")}
            />
            {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
          </FieldLabel>

          <FieldLabel label={t("telos.fields.description")}>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("telos.fields.descriptionPlaceholder")}
              rows={2}
              className={cn(inputCls, "resize-none leading-relaxed")}
            />
          </FieldLabel>

          <FieldLabel label={t("telos.fields.targetDate")}>
            <DatePicker
              value={targetDate}
              onChange={setTargetDate}
              placeholder={t("common.pickDate")}
            />
          </FieldLabel>
        </div>

        <div className="px-5 py-3 bg-zinc-50 dark:bg-zinc-950/50 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm font-medium text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void handleCreate()}
            className="px-3 py-1.5 text-sm font-medium text-white bg-indigo-500 hover:bg-indigo-600 rounded-md transition-colors"
          >
            {t("telos.create")}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function FieldLabel({
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

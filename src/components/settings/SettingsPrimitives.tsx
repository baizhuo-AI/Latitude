import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * 设置类页面的共享 UI 原语 —— 从 SettingsPage 提取,供「设置 / 关于你 / 连接」三页共用。
 * 纯展示组件,无业务逻辑;改动前请确认三页都能接受(它们共享同一套视觉)。
 */

/** 一个带图标标题 + 可选描述的卡片区块。 */
export function Section({
  icon,
  title,
  description,
  children
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-zinc-400 dark:text-zinc-500">{icon}</span>
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {title}
        </h2>
      </div>
      {description && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3 ml-6">
          {description}
        </p>
      )}
      <div
        className={cn(
          "rounded-xl p-4 space-y-4",
          "bg-white dark:bg-zinc-900",
          "border border-zinc-200 dark:border-zinc-800"
        )}
      >
        {children}
      </div>
    </section>
  );
}

/** 左标签、右控件的一行。 */
export function Field({
  label,
  children
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <label className="text-sm text-zinc-700 dark:text-zinc-300 flex-shrink-0">
        {label}
      </label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export interface SegmentOption<V extends string> {
  value: V;
  label: string;
}

/** 分段单选控件(语言 / 主题 / 飞书区域 / 开关 等)。 */
export function SegmentControl<V extends string>({
  value,
  onChange,
  options
}: {
  value: V;
  onChange: (v: V) => void;
  options: SegmentOption<V>[];
}) {
  return (
    <div className="inline-flex bg-zinc-100 dark:bg-zinc-800 rounded-lg p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            "px-3 py-1 text-xs font-medium rounded-md transition-colors",
            value === opt.value
              ? "bg-white dark:bg-zinc-950 shadow-sm text-zinc-900 dark:text-zinc-100"
              : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

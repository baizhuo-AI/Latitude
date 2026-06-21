import { useState, useRef, useEffect, useMemo, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X, Check } from "lucide-react";
import type { FieldDefinition } from "../lib/db";
import { findOptionByLabel, normalizeLabel } from "../lib/fieldMatch";
import { cn } from "../lib/utils";

type Opt = { id: string; label: string; color: string };

interface Props {
  field: FieldDefinition;
  /** 单选：optId 或 ""；多选：optId[] */
  value: string | string[];
  onChange: (value: string | string[]) => void;
  /** 新建一个选项，返回新 optId（已存在则复用）；字段不存在返回 null */
  onCreateOption: (label: string) => Promise<string | null>;
}

// 可输入下拉：输入匹配不到现有选项时给「+ 新建」入口（点击/回车才建 = 轻确认），单选/多选共用。
export function FieldValueSelect({ field, value, onChange, onCreateOption }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isMulti = field.type === "multi_select";
  const selectedIds: string[] = isMulti
    ? Array.isArray(value)
      ? value
      : []
    : typeof value === "string" && value
      ? [value]
      : [];

  const byId = useMemo(() => {
    const m = new Map<string, Opt>();
    field.options.forEach((o) => m.set(o.id, o));
    return m;
  }, [field.options]);

  // 候选：按 query 归一化过滤；多选排除已选。
  const candidates = useMemo(() => {
    const nq = normalizeLabel(query);
    return field.options.filter((o) => {
      if (isMulti && selectedIds.includes(o.id)) return false;
      if (!nq) return true;
      return normalizeLabel(o.label).includes(nq);
    });
  }, [field.options, query, isMulti, selectedIds]);

  // 输入命中已有选项（归一化）时不给「新建」，避免重复项。
  const canCreate = query.trim().length > 0 && !findOptionByLabel(field.options, query);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (optId: string) => {
    if (isMulti) {
      if (!selectedIds.includes(optId)) onChange([...selectedIds, optId]);
      setQuery("");
      inputRef.current?.focus();
    } else {
      onChange(optId);
      setQuery("");
      setOpen(false);
    }
  };

  const handleCreate = async () => {
    if (!canCreate || creating) return;
    setCreating(true);
    try {
      const newId = await onCreateOption(query.trim());
      if (newId) pick(newId);
    } finally {
      setCreating(false);
    }
  };

  const removeChip = (optId: string) => onChange(selectedIds.filter((id) => id !== optId));

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (candidates.length === 1) pick(candidates[0].id);
      else if (canCreate) void handleCreate();
    } else if (e.key === "Backspace" && !query && isMulti && selectedIds.length) {
      removeChip(selectedIds[selectedIds.length - 1]);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  };

  const singleSelected = !isMulti && selectedIds[0] ? byId.get(selectedIds[0]) : undefined;
  const showPlaceholder = !((!isMulti && singleSelected && !open) || (isMulti && selectedIds.length));

  return (
    <div ref={containerRef} className="relative">
      <div
        data-testid="fvs-trigger"
        onClick={() => {
          setOpen(true);
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
        className={cn(
          "flex flex-wrap items-center gap-1.5 px-2 py-1.5 rounded-lg border min-h-[34px] cursor-text",
          "bg-zinc-50 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700",
          "focus-within:border-indigo-500 dark:focus-within:border-indigo-400",
        )}
      >
        {isMulti &&
          selectedIds.map((id) => {
            const o = byId.get(id);
            if (!o) return null;
            return (
              <span
                key={id}
                data-testid={`fvs-chip-${id}`}
                className="inline-flex items-center gap-1 text-xs text-white px-1.5 py-0.5 rounded-full"
                style={{ backgroundColor: o.color }}
              >
                {o.label}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeChip(id);
                  }}
                  className="hover:text-white/70"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </span>
            );
          })}
        {!isMulti && singleSelected && !open && (
          <span
            className="inline-flex items-center gap-1 text-xs text-white px-1.5 py-0.5 rounded-full"
            style={{ backgroundColor: singleSelected.color }}
          >
            {singleSelected.label}
          </span>
        )}
        <input
          ref={inputRef}
          data-testid="fvs-input"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(true)}
          placeholder={showPlaceholder ? t("customFields.valuePlaceholder") : ""}
          className="flex-1 min-w-[60px] bg-transparent outline-none text-xs text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400"
        />
        {!isMulti && singleSelected && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChange("");
              setQuery("");
            }}
            className="text-zinc-400 hover:text-red-500"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      {open && (candidates.length > 0 || canCreate) && (
        <div
          data-testid="fvs-panel"
          className="absolute z-30 left-0 right-0 mt-1 max-h-48 overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg py-1"
        >
          {candidates.map((o) => (
            <button
              key={o.id}
              type="button"
              data-testid={`fvs-option-${o.id}`}
              onClick={() => pick(o.id)}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: o.color }} />
              <span className="flex-1 truncate text-zinc-900 dark:text-zinc-100">{o.label}</span>
              {!isMulti && singleSelected?.id === o.id && <Check className="w-3 h-3 text-indigo-500" />}
            </button>
          ))}
          {canCreate && (
            <button
              type="button"
              data-testid="fvs-create"
              onClick={() => void handleCreate()}
              disabled={creating}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 disabled:opacity-50"
            >
              <Plus className="w-3 h-3 flex-shrink-0" />
              <span className="truncate">{t("customFields.createOption", { label: query.trim() })}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

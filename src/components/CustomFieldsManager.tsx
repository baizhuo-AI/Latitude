import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X, GripVertical, CircleDot, LayoutGrid } from "lucide-react";
import { useFieldStore } from "../lib/fieldStore";
import { cn } from "../lib/utils";
import type { FieldDefinition } from "../lib/db";
import { useConfirm } from "./ConfirmDialog";

const PRESET_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4",
  "#3b82f6", "#8b5cf6", "#ec4899", "#6b7280", "#18181b",
];

function genId() {
  return `fld_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}
function genOptId() {
  return `opt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function CustomFieldsManager() {
  const { t } = useTranslation();
  const { fields, loaded, hydrate, addField, updateField, removeField } = useFieldStore();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<FieldDefinition | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!loaded) void hydrate();
  }, [loaded, hydrate]);

  const startCreate = () => {
    setEditing({
      id: genId(),
      name: "",
      type: "single_select",
      options: [{ id: genOptId(), label: "", color: PRESET_COLORS[0] }],
      sortOrder: fields.length,
      createdAt: new Date().toISOString(),
    });
    setCreating(true);
  };

  const startEdit = (field: FieldDefinition) => {
    setEditing({ ...field, options: field.options.map((o) => ({ ...o })) });
    setCreating(false);
  };

  const handleSave = async () => {
    if (!editing || !editing.name.trim()) return;
    const cleaned = {
      ...editing,
      name: editing.name.trim(),
      options: editing.options.filter((o) => o.label.trim()),
    };
    if (creating) {
      await addField(cleaned);
    } else {
      await updateField(cleaned);
    }
    setEditing(null);
    setCreating(false);
  };

  const handleDelete = async (field: FieldDefinition) => {
    const ok = await confirm({
      title: t("customFields.deleteField"),
      message: t("customFields.deleteFieldConfirm", { name: field.name }),
    });
    if (!ok) return;
    await removeField(field.id);
  };

  if (editing) {
    return <FieldEditor field={editing} onChange={setEditing} onSave={handleSave} onCancel={() => { setEditing(null); setCreating(false); }} />;
  }

  return (
    <div className="space-y-3">
      {fields.length === 0 && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400 text-center py-4">
          {t("customFields.empty")}
        </p>
      )}
      {fields.map((field) => (
        <div
          key={field.id}
          className={cn(
            "flex items-center gap-3 px-3 py-2.5 rounded-lg",
            "bg-zinc-50 dark:bg-zinc-800/50",
            "border border-zinc-200 dark:border-zinc-700"
          )}
        >
          <GripVertical className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
          <span className="text-zinc-400 flex-shrink-0">
            {field.type === "single_select" ? <CircleDot className="w-3.5 h-3.5" /> : <LayoutGrid className="w-3.5 h-3.5" />}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">{field.name}</div>
            <div className="flex items-center gap-1 mt-0.5">
              {field.options.slice(0, 5).map((opt) => (
                <span
                  key={opt.id}
                  className="text-[10px] px-1.5 py-0.5 rounded-full text-white truncate max-w-[80px]"
                  style={{ backgroundColor: opt.color }}
                >
                  {opt.label}
                </span>
              ))}
              {field.options.length > 5 && (
                <span className="text-[10px] text-zinc-400">+{field.options.length - 5}</span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => startEdit(field)}
            className="text-xs text-zinc-500 hover:text-indigo-500 transition-colors px-2 py-1"
          >
            {t("customFields.editField")}
          </button>
          <button
            type="button"
            onClick={() => void handleDelete(field)}
            className="text-zinc-400 hover:text-red-500 transition-colors p-1"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={startCreate}
        className={cn(
          "w-full flex items-center justify-center gap-2 py-3 rounded-lg",
          "border-2 border-dashed border-zinc-200 dark:border-zinc-700",
          "text-sm text-zinc-500 dark:text-zinc-400",
          "hover:border-zinc-300 dark:hover:border-zinc-600 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
        )}
      >
        <Plus className="w-4 h-4" />
        {t("customFields.addField")}
      </button>
    </div>
  );
}

function FieldEditor({
  field,
  onChange,
  onSave,
  onCancel,
}: {
  field: FieldDefinition;
  onChange: (f: FieldDefinition) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();

  const setName = (name: string) => onChange({ ...field, name });
  const setType = (type: FieldDefinition["type"]) => onChange({ ...field, type });

  const updateOption = (idx: number, label: string) => {
    const opts = [...field.options];
    opts[idx] = { ...opts[idx], label };
    onChange({ ...field, options: opts });
  };

  const setOptionColor = (idx: number, color: string) => {
    const opts = [...field.options];
    opts[idx] = { ...opts[idx], color };
    onChange({ ...field, options: opts });
  };

  const removeOption = (idx: number) => {
    onChange({ ...field, options: field.options.filter((_, i) => i !== idx) });
  };

  const addOption = () => {
    const colorIdx = field.options.length % PRESET_COLORS.length;
    onChange({
      ...field,
      options: [...field.options, { id: genOptId(), label: "", color: PRESET_COLORS[colorIdx] }],
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1 block">
          {t("customFields.fieldName")}
        </label>
        <input
          value={field.name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("customFields.fieldNamePlaceholder")}
          className={cn(
            "w-full px-3 py-1.5 rounded-lg text-sm outline-none",
            "bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700",
            "focus:border-indigo-500 dark:focus:border-indigo-400",
            "text-zinc-900 dark:text-zinc-100"
          )}
          autoFocus
        />
      </div>

      <div>
        <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1 block">
          {t("customFields.fieldType")}
        </label>
        <div className="inline-flex bg-zinc-100 dark:bg-zinc-800 rounded-lg p-0.5">
          {(["single_select", "multi_select"] as const).map((typ) => (
            <button
              key={typ}
              type="button"
              onClick={() => setType(typ)}
              className={cn(
                "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                field.type === typ
                  ? "bg-white dark:bg-zinc-950 shadow-sm text-zinc-900 dark:text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-700"
              )}
            >
              {t(`customFields.${typ === "single_select" ? "singleSelect" : "multiSelect"}`)}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1 block">
          {t("customFields.options")}
        </label>
        <div className="space-y-2">
          {field.options.map((opt, idx) => (
            <div key={opt.id} className="flex items-center gap-2">
              <ColorPicker color={opt.color} onChange={(c) => setOptionColor(idx, c)} />
              <input
                value={opt.label}
                onChange={(e) => updateOption(idx, e.target.value)}
                placeholder={t("customFields.optionPlaceholder")}
                className={cn(
                  "flex-1 px-2 py-1 rounded text-sm outline-none",
                  "bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700",
                  "focus:border-indigo-500",
                  "text-zinc-900 dark:text-zinc-100"
                )}
              />
              <button type="button" onClick={() => removeOption(idx)} className="text-zinc-400 hover:text-red-500 p-0.5">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addOption}
            className="text-xs text-zinc-500 hover:text-indigo-500 transition-colors flex items-center gap-1"
          >
            <Plus className="w-3 h-3" /> {t("customFields.addOption")}
          </button>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!field.name.trim()}
          className={cn(
            "px-4 py-1.5 text-xs font-medium rounded-lg transition-colors",
            "bg-zinc-900 text-white hover:bg-zinc-800",
            "dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white",
            "disabled:opacity-40 disabled:cursor-not-allowed"
          )}
        >
          {t("customFields.save")}
        </button>
      </div>
    </div>
  );
}

function ColorPicker({ color, onChange }: { color: string; onChange: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-5 h-5 rounded-full border-2 border-white dark:border-zinc-700 shadow-sm flex-shrink-0"
        style={{ backgroundColor: color }}
      />
      {open && (
        <div className="absolute left-0 top-7 z-20 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg p-2 grid grid-cols-5 gap-1.5 shadow-lg">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => { onChange(c); setOpen(false); }}
              className={cn(
                "w-5 h-5 rounded-full transition-transform hover:scale-110",
                c === color && "ring-2 ring-offset-1 ring-indigo-500"
              )}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// 自定义字段的共享纯函数：归一化匹配 + label↔id 翻译 + id/颜色生成。
// 能力一（AI 工具）与能力二（输入即建表单）都依赖这层，保证两条入口行为一致。
import type { FieldDefinition } from "./db";

// 10 色预设盘（与 Rust server.rs 的 PRESET_COLORS 镜像，改一处改两处）。
export const PRESET_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4",
  "#3b82f6", "#8b5cf6", "#ec4899", "#6b7280", "#18181b",
];

// 归一化：去除所有空白（含全角空格 U+3000，JS 的 \s 已涵盖）+ 转小写。
// 目的：让 "项目A" ≡ "项目 A" ≡ "项目　A" 视为同一项，防手滑空格建出重复选项。
export function normalizeLabel(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

export function genFieldId(): string {
  return `fld_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}
export function genOptId(): string {
  return `opt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function colorForIndex(i: number): string {
  return PRESET_COLORS[i % PRESET_COLORS.length];
}

type Opt = { id: string; label: string; color: string };

// 按归一化后的 label 找选项（防重复的核心）。
export function findOptionByLabel(options: Opt[], label: string): Opt | undefined {
  const n = normalizeLabel(label);
  return options.find((o) => normalizeLabel(o.label) === n);
}

export interface CreatedOption {
  fieldId: string;
  optId: string;
  label: string;
  color: string;
}

// 把 AI 给的 {字段名: 选项名 | 选项名[]} 翻译成存库格式 {fieldId: optId | optId[]}。
// - 字段名归一化匹配 field.name，匹配不到 → 抛错（调用方决定怎么回报）。
// - 选项名归一化匹配 option.label，匹配不到 → 产出 createdOptions（由调用方落库），并分配新 optId/颜色。
// 注意：本函数纯计算，不写库；createdOptions 需调用方落到 field_definitions。
export function resolveCustomFieldsInput(
  fields: FieldDefinition[],
  input: Record<string, string | string[]>,
): { customFields: Record<string, string | string[]>; createdOptions: CreatedOption[] } {
  const customFields: Record<string, string | string[]> = {};
  const createdOptions: CreatedOption[] = [];
  for (const [fname, raw] of Object.entries(input)) {
    const nf = normalizeLabel(fname);
    const fd = fields.find((f) => normalizeLabel(f.name) === nf);
    if (!fd) throw new Error(`字段不存在: ${fname}`);
    const labels = Array.isArray(raw) ? raw : [raw];
    const ids: string[] = [];
    // 工作副本：支持同一次输入里多个新选项各自按递增下标分配颜色。
    const working: Opt[] = [...fd.options];
    for (const lab of labels) {
      const hit = findOptionByLabel(working, lab);
      if (hit) {
        ids.push(hit.id);
        continue;
      }
      const opt: Opt = { id: genOptId(), label: lab.trim(), color: colorForIndex(working.length) };
      working.push(opt);
      createdOptions.push({ fieldId: fd.id, optId: opt.id, label: opt.label, color: opt.color });
      ids.push(opt.id);
    }
    customFields[fd.id] = fd.type === "single_select" ? ids[0] : ids;
  }
  return { customFields, createdOptions };
}

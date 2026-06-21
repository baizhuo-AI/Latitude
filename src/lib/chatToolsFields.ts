/**
 * AI 字段工具：让大脑在对话里增删改自定义字段、给任务填字段值。
 *
 * 多窗口 store 陷阱：对话窗口的 useFieldStore 内存态是陈旧快照（多窗口各自独立 store），
 * 所以这里所有读写都直接走 db 层（dbListFields / dbInsertField / ...）+ emitSync("todos") 广播，
 * 不读 store.fields。各窗口收到 sync 后自行 rehydrate。
 *
 * 与后端 MCP（src-tauri/src/mcp/server.rs）的同名工具镜像：改一处改两处。
 */
import {
  dbListFields,
  dbInsertField,
  dbUpdateField,
  dbDeleteField,
  dbClearFieldFromTodos,
  dbClearOptionFromTodos,
  dbListTodos,
  type FieldDefinition,
} from "./db";
import { emitSync } from "./syncBus";
import { normalizeLabel, findOptionByLabel, genFieldId, genOptId, colorForIndex } from "./fieldMatch";
import type { ChatTool } from "./chatTools"; // type-only：编译后擦除，不构成运行时循环依赖

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

type Opt = { id: string; label: string; color: string };

/**
 * 把 AI 给的 {字段名: 选项名 | 选项名[]} 翻译成存库格式 {fieldId: optId | optId[]}，
 * 顺手把不存在的选项落库到 field_definitions（多窗口 db 直写版，区别于 fieldMatch 的纯函数版）。
 * - 字段名归一化匹配 field.name，匹配不到 → 记入 skipped（不抛错，对 AI 友好）。
 * - 选项名归一化匹配 option.label，匹配不到 → 自动新建并写回字段，记入 created。
 */
export async function persistCustomFieldsInput(
  input: Record<string, unknown>,
): Promise<{ customFields: Record<string, string | string[]>; created: string[]; skipped: string[] }> {
  const fields = await dbListFields();
  const customFields: Record<string, string | string[]> = {};
  const created: string[] = [];
  const skipped: string[] = [];
  for (const [fname, raw] of Object.entries(input)) {
    const nf = normalizeLabel(fname);
    const fd = fields.find((f) => normalizeLabel(f.name) === nf);
    if (!fd) {
      skipped.push(fname);
      continue;
    }
    const labels = Array.isArray(raw) ? raw.map((x) => String(x)) : [String(raw)];
    const ids: string[] = [];
    let working: Opt[] = [...fd.options];
    let changed = false;
    for (const lab of labels) {
      if (!lab.trim()) continue;
      const hit = findOptionByLabel(working, lab);
      if (hit) {
        ids.push(hit.id);
        continue;
      }
      const opt: Opt = { id: genOptId(), label: lab.trim(), color: colorForIndex(working.length) };
      working = [...working, opt];
      ids.push(opt.id);
      created.push(`${fd.name}:${opt.label}`);
      changed = true;
    }
    if (changed) {
      await dbUpdateField({ ...fd, options: working });
      emitSync("todos");
    }
    if (ids.length) customFields[fd.id] = fd.type === "single_select" ? ids[0] : ids;
  }
  return { customFields, created, skipped };
}

export const FIELD_TOOLS: ChatTool[] = [
  {
    name: "list_fields",
    description:
      "列出所有自定义字段及其选项。在建字段/改字段/填字段值之前先调它了解现状，避免重复创建。",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const fields = await dbListFields();
      return JSON.stringify({
        count: fields.length,
        fields: fields.map((f) => ({
          id: f.id,
          name: f.name,
          type: f.type,
          options: f.options.map((o) => o.label),
        })),
      });
    },
  },
  {
    name: "create_field",
    description:
      "新建一个自定义字段。type 仅支持 single_select（单选）/ multi_select（多选）；日期/数字/文本等其它类型暂不支持。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "字段名（必填），如 项目、客户、负责人" },
        type: { type: "string", description: "single_select 或 multi_select" },
        options: { type: "array", items: { type: "string" }, description: "初始选项名列表（可选）" },
      },
      required: ["name", "type"],
    },
    execute: async (a) => {
      const name = str(a.name);
      if (!name) return JSON.stringify({ error: "name 必填" });
      const type = str(a.type);
      if (type !== "single_select" && type !== "multi_select")
        return JSON.stringify({ error: "暂不支持的字段类型，仅支持 single_select / multi_select" });
      const fields = await dbListFields();
      if (fields.some((f) => normalizeLabel(f.name) === normalizeLabel(name)))
        return JSON.stringify({ error: `字段「${name}」已存在` });
      const rawOptions = Array.isArray(a.options) ? (a.options as unknown[]).map((x) => String(x)) : [];
      const options: Opt[] = [];
      for (const lab of rawOptions) {
        if (!lab.trim() || findOptionByLabel(options, lab)) continue; // 空/重复跳过
        options.push({ id: genOptId(), label: lab.trim(), color: colorForIndex(options.length) });
      }
      const field: FieldDefinition = {
        id: genFieldId(),
        name: name.trim(),
        type,
        options,
        sortOrder: fields.length,
        createdAt: new Date().toISOString(),
      };
      await dbInsertField(field);
      emitSync("todos");
      return JSON.stringify({
        created: { id: field.id, name: field.name, type, options: options.map((o) => o.label) },
      });
    },
  },
  {
    name: "update_field",
    description:
      "修改字段：改名 和/或 追加新选项。不支持删选项 / 改选项颜色（请用户在设置页操作）。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "字段 id（必填）" },
        name: { type: "string", description: "新字段名（可选）" },
        add_options: { type: "array", items: { type: "string" }, description: "要追加的选项名（可选，已存在的自动跳过）" },
      },
      required: ["id"],
    },
    execute: async (a) => {
      const id = str(a.id);
      if (!id) return JSON.stringify({ error: "id 必填" });
      const fields = await dbListFields();
      const fd = fields.find((f) => f.id === id);
      if (!fd) return JSON.stringify({ error: "没找到该字段 id" });
      let options: Opt[] = [...fd.options];
      const added: string[] = [];
      const rawAdd = Array.isArray(a.add_options) ? (a.add_options as unknown[]).map((x) => String(x)) : [];
      for (const lab of rawAdd) {
        if (!lab.trim() || findOptionByLabel(options, lab)) continue;
        const opt: Opt = { id: genOptId(), label: lab.trim(), color: colorForIndex(options.length) };
        options = [...options, opt];
        added.push(opt.label);
      }
      const newName = str(a.name);
      const updated: FieldDefinition = { ...fd, name: newName ?? fd.name, options };
      await dbUpdateField(updated);
      emitSync("todos");
      return JSON.stringify({ updated: true, id, name: updated.name, added_options: added });
    },
  },
  {
    name: "delete_field",
    description:
      "删除一个字段。⚠️会清除所有任务上该字段的值，不可恢复。安全协议：先不带 confirm 调用拿到影响范围、转述给用户，得到同意后再带 confirm:true 真正删除。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "字段 id（必填）" },
        confirm: { type: "boolean", description: "true 才真正删除；缺省/false 只返回影响范围预览" },
      },
      required: ["id"],
    },
    execute: async (a) => {
      const id = str(a.id);
      if (!id) return JSON.stringify({ error: "id 必填" });
      const fields = await dbListFields();
      const fd = fields.find((f) => f.id === id);
      if (!fd) return JSON.stringify({ error: "没找到该字段 id" });
      const affected = (await dbListTodos()).filter((t) => t.customFields && id in t.customFields).length;
      if (a.confirm !== true) {
        return JSON.stringify({
          pending: true,
          field: fd.name,
          affected_todos: affected,
          message: `删除字段「${fd.name}」将清除 ${affected} 个任务上的该字段值。确认请再次调用并带 confirm:true。`,
        });
      }
      await dbDeleteField(id);
      await dbClearFieldFromTodos(id);
      emitSync("todos");
      return JSON.stringify({ deleted: true, id, name: fd.name, cleared_todos: affected });
    },
  },
  {
    name: "delete_field_option",
    description:
      "删除某字段下的一个选项。⚠️会清除所有任务上对该选项的引用。同样走 confirm 两段确认。",
    parameters: {
      type: "object",
      properties: {
        field_id: { type: "string", description: "字段 id（必填）" },
        option_label: { type: "string", description: "选项名（必填）" },
        confirm: { type: "boolean", description: "true 才真正删除；缺省只返回影响范围预览" },
      },
      required: ["field_id", "option_label"],
    },
    execute: async (a) => {
      const fieldId = str(a.field_id);
      const label = str(a.option_label);
      if (!fieldId || !label) return JSON.stringify({ error: "field_id 和 option_label 必填" });
      const fields = await dbListFields();
      const fd = fields.find((f) => f.id === fieldId);
      if (!fd) return JSON.stringify({ error: "没找到该字段 id" });
      const opt = findOptionByLabel(fd.options, label);
      if (!opt) return JSON.stringify({ error: `字段「${fd.name}」下没有选项「${label}」` });
      const affected = (await dbListTodos()).filter((t) => {
        const v = t.customFields?.[fieldId];
        return v === opt.id || (Array.isArray(v) && v.includes(opt.id));
      }).length;
      if (a.confirm !== true) {
        return JSON.stringify({
          pending: true,
          field: fd.name,
          option: opt.label,
          affected_todos: affected,
          message: `删除选项「${opt.label}」将影响 ${affected} 个任务。确认请再次调用并带 confirm:true。`,
        });
      }
      await dbUpdateField({ ...fd, options: fd.options.filter((o) => o.id !== opt.id) });
      await dbClearOptionFromTodos(fieldId, opt.id);
      emitSync("todos");
      return JSON.stringify({ deleted: true, field: fd.name, option: opt.label, cleared_todos: affected });
    },
  },
];

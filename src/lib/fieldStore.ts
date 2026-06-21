import { create } from "zustand";
import {
  dbListFields,
  dbInsertField,
  dbUpdateField,
  dbDeleteField,
  dbClearFieldFromTodos,
  dbClearOptionFromTodos,
  type FieldDefinition,
} from "./db";
import { emitSync } from "./syncBus";
import { findOptionByLabel, genOptId, colorForIndex } from "./fieldMatch";

interface FieldStore {
  fields: FieldDefinition[];
  loaded: boolean;
  hydrate: () => Promise<void>;
  addField: (field: FieldDefinition) => Promise<void>;
  updateField: (field: FieldDefinition) => Promise<void>;
  removeField: (id: string) => Promise<void>;
  removeOption: (fieldId: string, optionId: string) => Promise<void>;
  /** 给字段加一个新选项（label 已存在则归一化复用，不新增）；返回 optId，字段不存在返回 null。能力一/二共用 */
  addOption: (fieldId: string, label: string) => Promise<string | null>;
}

export const useFieldStore = create<FieldStore>((set, get) => ({
  fields: [],
  loaded: false,

  hydrate: async () => {
    try {
      const fields = await dbListFields();
      set({ fields, loaded: true });
    } catch (err) {
      console.error("[fieldStore] hydrate failed:", err);
      set({ fields: [], loaded: true });
    }
  },

  addField: async (field) => {
    await dbInsertField(field);
    set((s) => ({ fields: [...s.fields, field] }));
    emitSync("todos");
  },

  updateField: async (field) => {
    await dbUpdateField(field);
    set((s) => ({
      fields: s.fields.map((f) => (f.id === field.id ? field : f)),
    }));
    emitSync("todos");
  },

  removeField: async (id) => {
    await dbDeleteField(id);
    await dbClearFieldFromTodos(id);
    set((s) => ({ fields: s.fields.filter((f) => f.id !== id) }));
    emitSync("todos");
  },

  removeOption: async (fieldId, optionId) => {
    await dbClearOptionFromTodos(fieldId, optionId);
    emitSync("todos");
  },

  addOption: async (fieldId, label) => {
    const f = get().fields.find((x) => x.id === fieldId);
    if (!f) return null;
    const existing = findOptionByLabel(f.options, label);
    if (existing) return existing.id; // 已存在直接复用，防重复
    const opt = { id: genOptId(), label: label.trim(), color: colorForIndex(f.options.length) };
    await get().updateField({ ...f, options: [...f.options, opt] }); // 复用 updateField：含 dbUpdateField + emitSync
    return opt.id;
  },
}));

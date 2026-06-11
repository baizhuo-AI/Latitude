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

interface FieldStore {
  fields: FieldDefinition[];
  loaded: boolean;
  hydrate: () => Promise<void>;
  addField: (field: FieldDefinition) => Promise<void>;
  updateField: (field: FieldDefinition) => Promise<void>;
  removeField: (id: string) => Promise<void>;
  removeOption: (fieldId: string, optionId: string) => Promise<void>;
}

export const useFieldStore = create<FieldStore>((set) => ({
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
}));

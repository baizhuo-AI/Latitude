import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db", () => ({
  dbListFields: vi.fn(async () => []),
  dbInsertField: vi.fn(async () => {}),
  dbUpdateField: vi.fn(async () => {}),
  dbDeleteField: vi.fn(async () => {}),
  dbClearFieldFromTodos: vi.fn(async () => {}),
  dbClearOptionFromTodos: vi.fn(async () => {}),
}));
vi.mock("./syncBus", () => ({ emitSync: vi.fn() }));

import { useFieldStore } from "./fieldStore";
import { dbUpdateField } from "./db";
import type { FieldDefinition } from "./db";

const field = (): FieldDefinition => ({
  id: "fld_p",
  name: "项目",
  type: "single_select",
  options: [{ id: "opt_a", label: "项目A", color: "#ef4444" }],
  sortOrder: 0,
  createdAt: "",
});

beforeEach(() => {
  useFieldStore.setState({ fields: [field()], loaded: true });
  vi.clearAllMocks();
});

describe("fieldStore.addOption", () => {
  it("新 label：建选项、写库、返回新 optId、options 增长", async () => {
    const id = await useFieldStore.getState().addOption("fld_p", "项目B");
    expect(id).toBeTruthy();
    expect(id).not.toBe("opt_a");
    const f = useFieldStore.getState().fields.find((x) => x.id === "fld_p")!;
    expect(f.options).toHaveLength(2);
    expect(f.options[1].label).toBe("项目B");
    expect(f.options[1].color).toBe("#f97316"); // index 1
    expect(dbUpdateField).toHaveBeenCalledOnce();
  });

  it("已有 label（含空格变体）：复用、不新增、不写库", async () => {
    const id = await useFieldStore.getState().addOption("fld_p", "项目 A");
    expect(id).toBe("opt_a");
    const f = useFieldStore.getState().fields.find((x) => x.id === "fld_p")!;
    expect(f.options).toHaveLength(1);
    expect(dbUpdateField).not.toHaveBeenCalled();
  });

  it("字段不存在：返回 null", async () => {
    const id = await useFieldStore.getState().addOption("fld_x", "x");
    expect(id).toBeNull();
  });
});

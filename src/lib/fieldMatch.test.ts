import { describe, it, expect } from "vitest";
import {
  normalizeLabel,
  findOptionByLabel,
  resolveCustomFieldsInput,
} from "./fieldMatch";
import type { FieldDefinition } from "./db";

const field = (over: Partial<FieldDefinition> = {}): FieldDefinition => ({
  id: "fld_p",
  name: "项目",
  type: "single_select",
  options: [{ id: "opt_a", label: "项目A", color: "#ef4444" }],
  sortOrder: 0,
  createdAt: "",
  ...over,
});

describe("normalizeLabel", () => {
  it("去除所有空白（含全角）后比较：项目A ≡ 项目 A ≡ 项目　A", () => {
    expect(normalizeLabel("项目A")).toBe(normalizeLabel("项目 A"));
    expect(normalizeLabel("项目A")).toBe(normalizeLabel("项目　A")); // 全角空格 U+3000
    expect(normalizeLabel("  项目A  ")).toBe(normalizeLabel("项目A"));
  });
  it("大小写归一", () => {
    expect(normalizeLabel("FooBar")).toBe("foobar");
  });
});

describe("findOptionByLabel", () => {
  it("空格差异视为同一项（防重复）", () => {
    const f = field();
    expect(findOptionByLabel(f.options, "项目 A")?.id).toBe("opt_a");
  });
  it("大小写/前后空格差异视为同一项", () => {
    const f = field({ options: [{ id: "opt_x", label: "Backend", color: "#000" }] });
    expect(findOptionByLabel(f.options, "  backend ")?.id).toBe("opt_x");
  });
  it("真不存在的返回 undefined", () => {
    expect(findOptionByLabel(field().options, "项目C")).toBeUndefined();
  });
});

describe("resolveCustomFieldsInput", () => {
  it("单选：已有选项名→optId，无新建", () => {
    const { customFields, createdOptions } = resolveCustomFieldsInput([field()], {
      项目: "项目A",
    });
    expect(customFields).toEqual({ fld_p: "opt_a" });
    expect(createdOptions).toEqual([]);
  });

  it("单选：选项名带空格变体仍命中已有，不新建", () => {
    const { customFields, createdOptions } = resolveCustomFieldsInput([field()], {
      项目: "项目 A",
    });
    expect(customFields).toEqual({ fld_p: "opt_a" });
    expect(createdOptions).toEqual([]);
  });

  it("选项名不存在→产出 createdOptions（含 fieldId/label/分配 color）", () => {
    const { customFields, createdOptions } = resolveCustomFieldsInput([field()], {
      项目: "项目B",
    });
    expect(createdOptions).toHaveLength(1);
    expect(createdOptions[0]).toMatchObject({ fieldId: "fld_p", label: "项目B" });
    // 已有 1 个选项，新选项颜色取 index 1
    expect(createdOptions[0].color).toBe("#f97316");
    // customFields 引用新建选项的 id
    expect(customFields.fld_p).toBe(createdOptions[0].optId);
  });

  it("多选：混合已有与新建", () => {
    const f = field({
      type: "multi_select",
      options: [
        { id: "opt_a", label: "前端", color: "#ef4444" },
        { id: "opt_b", label: "后端", color: "#f97316" },
      ],
    });
    const { customFields, createdOptions } = resolveCustomFieldsInput([f], {
      项目: ["前端", "测试"],
    });
    expect(Array.isArray(customFields.fld_p)).toBe(true);
    expect((customFields.fld_p as string[])[0]).toBe("opt_a");
    expect(createdOptions).toHaveLength(1);
    expect(createdOptions[0].label).toBe("测试");
  });

  it("字段名不存在→抛错", () => {
    expect(() => resolveCustomFieldsInput([field()], { 不存在: "x" })).toThrow();
  });

  it("字段名空格/大小写变体仍命中", () => {
    const { customFields } = resolveCustomFieldsInput([field()], { " 项目 ": "项目A" });
    expect(customFields).toEqual({ fld_p: "opt_a" });
  });
});

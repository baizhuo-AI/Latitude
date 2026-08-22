import { describe, it, expect } from "vitest";
import { buildSyncPlan, extractCellText } from "./bitableSync";
import type { Todo } from "./store";
import type { FieldDefinition } from "./db";
import type { BitableRecordRow, BitableFieldMeta } from "./feishuBitable";

/* ---------- 构造 helper ---------- */

function makeTodo(title: string, projectOptionId?: string, projectFieldId = "fldProj"): Todo {
  return {
    id: `t_${title}`,
    title,
    priority: "none",
    tags: [],
    status: "done",
    createdAt: "2026-06-12T08:00:00.000Z",
    completedAt: "2026-06-12T10:00:00.000Z",
    customFields: projectOptionId ? { [projectFieldId]: projectOptionId } : undefined
  };
}

const PROJECT_FIELD: FieldDefinition = {
  id: "fldProj",
  name: "项目",
  type: "single_select",
  options: [
    { id: "opt_a", label: "Latitude 飞书插件", color: "#111" },
    { id: "opt_b", label: "日历同步", color: "#222" }
  ],
  sortOrder: 0,
  createdAt: "2026-01-01T00:00:00.000Z"
};

const TABLE_FIELDS: BitableFieldMeta[] = [
  { field_id: "f1", field_name: "项目", ui_type: "Text", is_primary: true },
  { field_id: "f2", field_name: "最近进展", ui_type: "Text", is_primary: false }
];

function row(recordId: string, projectName: string): BitableRecordRow {
  return { record_id: recordId, fields: { 项目: projectName } };
}

/* ---------- extractCellText ---------- */

describe("extractCellText", () => {
  it("读纯字符串", () => {
    expect(extractCellText("hello")).toBe("hello");
  });
  it("读富文本数组 [{text}]", () => {
    expect(extractCellText([{ type: "text", text: "ab" }, { text: "cd" }])).toBe("abcd");
  });
  it("空/未知返回空串", () => {
    expect(extractCellText(null)).toBe("");
    expect(extractCellText(undefined)).toBe("");
  });
});

/* ---------- buildSyncPlan ---------- */

describe("buildSyncPlan", () => {
  it("缺项目字段 → needProjectField，全部进 unassigned", () => {
    const plan = buildSyncPlan({
      todos: [makeTodo("做了 A")],
      fieldDefs: [], // 没有名为"项目"的字段
      existingRows: [],
      tableFields: TABLE_FIELDS
    });
    expect(plan.needProjectField).toBe(true);
    expect(plan.unassigned).toHaveLength(1);
    expect(plan.groups).toHaveLength(0);
  });

  it("项目命中现有行 → op=update + recordId", () => {
    const plan = buildSyncPlan({
      todos: [makeTodo("推进解析", "opt_a")],
      fieldDefs: [PROJECT_FIELD],
      existingRows: [row("rec_existing", "Latitude 飞书插件")],
      tableFields: TABLE_FIELDS
    });
    expect(plan.needProjectField).toBe(false);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].op).toBe("update");
    expect(plan.groups[0].recordId).toBe("rec_existing");
    expect(plan.groups[0].project).toBe("Latitude 飞书插件");
    expect(plan.groups[0].items[0].title).toBe("推进解析");
  });

  it("项目未命中 → op=create", () => {
    const plan = buildSyncPlan({
      todos: [makeTodo("起草", "opt_b")],
      fieldDefs: [PROJECT_FIELD],
      existingRows: [row("rec_x", "别的项目")],
      tableFields: TABLE_FIELDS
    });
    expect(plan.groups[0].op).toBe("create");
    expect(plan.groups[0].recordId).toBeUndefined();
    expect(plan.groups[0].suspectNew).toBe(false);
  });

  it("项目名相近(子串) → suspectNew=true 但仍 create", () => {
    const plan = buildSyncPlan({
      todos: [makeTodo("做点啥", "opt_a")], // label "Latitude 飞书插件"
      fieldDefs: [PROJECT_FIELD],
      existingRows: [row("rec_y", "Latitude")], // 现有"Latitude"是子串
      tableFields: TABLE_FIELDS
    });
    expect(plan.groups[0].op).toBe("create");
    expect(plan.groups[0].suspectNew).toBe(true);
  });

  it("空格/大小写差异视为命中(归一化匹配)", () => {
    const plan = buildSyncPlan({
      todos: [makeTodo("x", "opt_a")], // "Latitude 飞书插件"
      fieldDefs: [PROJECT_FIELD],
      existingRows: [row("rec_z", "Latitude飞书插件")], // 无空格
      tableFields: TABLE_FIELDS
    });
    expect(plan.groups[0].op).toBe("update");
    expect(plan.groups[0].recordId).toBe("rec_z");
  });

  it("无项目值的 todo → unassigned", () => {
    const plan = buildSyncPlan({
      todos: [makeTodo("没标项目")], // 无 customFields
      fieldDefs: [PROJECT_FIELD],
      existingRows: [],
      tableFields: TABLE_FIELDS
    });
    expect(plan.unassigned).toHaveLength(1);
    expect(plan.groups).toHaveLength(0);
  });

  it("同项目多条 todo 合并到一组", () => {
    const plan = buildSyncPlan({
      todos: [makeTodo("条目1", "opt_a"), makeTodo("条目2", "opt_a")],
      fieldDefs: [PROJECT_FIELD],
      existingRows: [],
      tableFields: TABLE_FIELDS
    });
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].items).toHaveLength(2);
  });
});

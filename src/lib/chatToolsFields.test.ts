import { describe, it, expect, vi, beforeEach } from "vitest";

// 用 vi.hoisted 让 mock factory 能引用可变内存状态（mock 模拟 db）
const state = vi.hoisted(() => ({ fields: [] as any[], todos: [] as any[] }));

vi.mock("./db", () => ({
  dbListFields: vi.fn(async () => state.fields),
  dbInsertField: vi.fn(async (f: any) => {
    state.fields.push(f);
  }),
  dbUpdateField: vi.fn(async (f: any) => {
    state.fields = state.fields.map((x: any) => (x.id === f.id ? f : x));
  }),
  dbDeleteField: vi.fn(async (id: string) => {
    state.fields = state.fields.filter((x: any) => x.id !== id);
  }),
  dbClearFieldFromTodos: vi.fn(async () => {}),
  dbClearOptionFromTodos: vi.fn(async () => {}),
  dbListTodos: vi.fn(async () => state.todos),
}));
vi.mock("./syncBus", () => ({ emitSync: vi.fn() }));

import { FIELD_TOOLS, persistCustomFieldsInput } from "./chatToolsFields";
import { dbDeleteField, dbClearFieldFromTodos } from "./db";

const tool = (n: string) => FIELD_TOOLS.find((t) => t.name === n)!;
const run = (n: string, a: Record<string, unknown> = {}) =>
  tool(n)
    .execute(a)
    .then((s) => JSON.parse(s));

beforeEach(() => {
  state.fields = [];
  state.todos = [];
  vi.clearAllMocks();
});

describe("create_field", () => {
  it("建单选字段，选项归一化去重", async () => {
    const r = await run("create_field", { name: "项目", type: "single_select", options: ["A", "B", "A "] });
    expect(r.created.name).toBe("项目");
    expect(state.fields).toHaveLength(1);
    expect(state.fields[0].options.map((o: any) => o.label)).toEqual(["A", "B"]);
  });
  it("非法 type 报错且不落库", async () => {
    const r = await run("create_field", { name: "日期", type: "date" });
    expect(r.error).toContain("暂不支持");
    expect(state.fields).toHaveLength(0);
  });
  it("重名（空格/大小写变体）报错", async () => {
    await run("create_field", { name: "项目", type: "single_select" });
    const r = await run("create_field", { name: " 项目 ", type: "single_select" });
    expect(r.error).toContain("已存在");
  });
});

describe("list_fields", () => {
  it("返回字段与选项名", async () => {
    await run("create_field", { name: "项目", type: "single_select", options: ["A"] });
    const r = await run("list_fields");
    expect(r.count).toBe(1);
    expect(r.fields[0]).toMatchObject({ name: "项目", type: "single_select", options: ["A"] });
  });
});

describe("update_field", () => {
  it("改名 + 追加选项（已存在的跳过）", async () => {
    await run("create_field", { name: "项目", type: "single_select", options: ["A"] });
    const id = state.fields[0].id;
    const r = await run("update_field", { id, name: "客户", add_options: ["B", "A"] });
    expect(r.added_options).toEqual(["B"]);
    expect(state.fields[0].name).toBe("客户");
    expect(state.fields[0].options.map((o: any) => o.label)).toEqual(["A", "B"]);
  });
});

describe("persistCustomFieldsInput", () => {
  beforeEach(async () => {
    await run("create_field", { name: "项目", type: "single_select", options: ["项目A"] });
  });
  it("已有选项（空格变体）命中，不新建", async () => {
    const fid = state.fields[0].id;
    const oid = state.fields[0].options[0].id;
    const r = await persistCustomFieldsInput({ 项目: "项目 A" });
    expect(r.customFields[fid]).toBe(oid);
    expect(r.created).toEqual([]);
  });
  it("新选项自动落库 + 记 created", async () => {
    const fid = state.fields[0].id;
    const r = await persistCustomFieldsInput({ 项目: "项目B" });
    expect(r.created).toEqual(["项目:项目B"]);
    expect(state.fields[0].options).toHaveLength(2);
    expect(r.customFields[fid]).toBe(state.fields[0].options[1].id);
  });
  it("字段不存在 → skipped，不抛错", async () => {
    const r = await persistCustomFieldsInput({ 不存在字段: "x" });
    expect(r.skipped).toEqual(["不存在字段"]);
    expect(r.customFields).toEqual({});
  });
});

describe("delete_field confirm 协议", () => {
  beforeEach(async () => {
    await run("create_field", { name: "项目", type: "single_select", options: ["A"] });
    const fid = state.fields[0].id;
    state.todos = [{ id: "t1", customFields: { [fid]: state.fields[0].options[0].id } }];
  });
  it("不带 confirm：返回 pending + affected，不删", async () => {
    const id = state.fields[0].id;
    const r = await run("delete_field", { id });
    expect(r.pending).toBe(true);
    expect(r.affected_todos).toBe(1);
    expect(dbDeleteField).not.toHaveBeenCalled();
    expect(state.fields).toHaveLength(1);
  });
  it("confirm:true：真删 + 清理 todos", async () => {
    const id = state.fields[0].id;
    const r = await run("delete_field", { id, confirm: true });
    expect(r.deleted).toBe(true);
    expect(r.cleared_todos).toBe(1);
    expect(dbDeleteField).toHaveBeenCalledWith(id);
    expect(dbClearFieldFromTodos).toHaveBeenCalledWith(id);
    expect(state.fields).toHaveLength(0);
  });
});

describe("delete_field_option confirm 协议", () => {
  beforeEach(async () => {
    await run("create_field", { name: "项目", type: "multi_select", options: ["A", "B"] });
  });
  it("不带 confirm pending；confirm:true 移除该选项", async () => {
    const fid = state.fields[0].id;
    const r1 = await run("delete_field_option", { field_id: fid, option_label: "A" });
    expect(r1.pending).toBe(true);
    expect(state.fields[0].options).toHaveLength(2);
    const r2 = await run("delete_field_option", { field_id: fid, option_label: "A", confirm: true });
    expect(r2.deleted).toBe(true);
    expect(state.fields[0].options.map((o: any) => o.label)).toEqual(["B"]);
  });
  it("选项不存在报错", async () => {
    const fid = state.fields[0].id;
    const r = await run("delete_field_option", { field_id: fid, option_label: "不存在" });
    expect(r.error).toContain("没有选项");
  });
});

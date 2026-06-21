# 自定义字段二期实现计划：AI 接管字段 + 输入即建

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 或 superpowers:executing-plans 逐 task 执行。步骤用 `- [ ]` 勾选。

**Goal:** 在已落地的自定义字段底座上加两条管理路径——① AI 在对话里增删改字段 / 填值（TS + Rust 双端工具）；② 手动建任务时输入新值当场建选项。

**Architecture:** 共享一层纯函数底座（归一化匹配 + label↔id 翻译），两个入口（AI 工具 / 表单组件）都调它。AI 工具按现有 memory 工具的"TS chatTools.ts + Rust server.rs 两处镜像"模式实现。删除走 `confirm` 两段协议。

**Tech Stack:** React 18 + Zustand + vitest（前端）；Tauri 2 / Rust + rmcp + sqlx（后端）；SQLite。

**对应 spec:** [2026-06-17-custom-fields-ai-control-design.md](../specs/2026-06-17-custom-fields-ai-control-design.md)

---

## 全局技术决策（所有 task 共用，先读）

**D1. 归一化规则（两端逐字一致）：** 去除所有空白字符（含全角空格 U+3000）+ 转小写。目的：让 "项目A" ≡ "项目 A" ≡ "项目　A" 视为同一选项，防手滑多打空格建出重复项（spec R2）。
- TS：`s.replace(/\s+/g, "").toLowerCase()`（JS 的 `\s` 已含全角空格 U+3000）
- Rust：`s.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_lowercase()`（`char::is_whitespace` 对 U+3000 为真）

**D2. 颜色分配（两端一致）：** 10 色预设盘 `PRESET_COLORS`（见 `CustomFieldsManager.tsx`）：`["#ef4444","#f97316","#eab308","#22c55e","#06b6d4","#3b82f6","#8b5cf6","#ec4899","#6b7280","#18181b"]`。新选项颜色 = `PRESET_COLORS[现有选项数 % 10]`。Rust 端镜像同一常量数组。

**D3. id 生成：** 字段 id 前缀 `fld_`、选项 id 前缀 `opt_`。TS 用 `CustomFieldsManager` 的 `genId()`/`genOptId()`（抽到共享处，见 Task 1）；Rust 用 `gen_id("fld")`/`gen_id("opt")`。格式不必跨端逐字一致，仅需前缀对、唯一。

**D4. 填值输入格式：** AI 填值用人类可读的 `{ "字段名": "选项名" | ["选项名", ...] }`。工具内部：字段名→fieldId（归一化匹配 field.name，匹配不到则报错）；选项名→optId（归一化匹配 option.label，**匹配不到则按权限自动新建该选项**，返回里标 `createdOptions`）。

**D5. 删除确认协议：** `delete_field` / `delete_field_option` 带 `confirm: bool`（默认 false）。
- `confirm=false` → 不删，返回 `{ pending: true, affected_todos: N, message: "将清除 N 个任务的该字段值，确认请再次调用并带 confirm:true" }`
- `confirm=true` → 真删 + 清理 todos + notify
AI 自然先不带 confirm 调一次、把影响转述用户、得同意后带 confirm 再调。

**D6. emitSync topic：** 沿用现状 `emitSync("todos")`（字段值属 todos 域，且不必新增 SyncTopic 枚举值）。新增需求：字段**定义**变化也要让其它窗口的 `useFieldStore` 重新 hydrate（见 Task 7）。

**D7. 本期 YAGNI 收窄：** `update_field` 只支持「改字段名 + 加选项」，不支持改选项 label/颜色/删单个选项中的 label 编辑（那些留给手动 `CustomFieldsManager`）。字段类型只有 single_select / multi_select，AI 请求其它类型→明确回"暂不支持"。

---

## 文件结构

**新建：**
- `src/lib/fieldMatch.ts` — 纯函数：`normalizeLabel`、`findOptionByLabel`、`genFieldId`/`genOptId`、`resolveCustomFieldsInput`（D1/D3/D4 的 TS 实现）。能力一、能力二共用。
- `src/lib/fieldMatch.test.ts` — 上述纯函数单测。
- `src/lib/chatToolsFields.ts` — 5 个字段工具的 TS 定义（`list_fields`/`create_field`/`update_field`/`delete_field`/`delete_field_option`），导出数组并入 `CHAT_TOOLS`。
- `src/lib/chatToolsFields.test.ts` — 字段工具行为测试（仿 `chatToolsMemory.test.ts`）。
- `src/components/FieldValueSelect.tsx` — 可输入下拉 + "新建 XXX" 轻确认组件，单选/多选共用（能力二核心 UI）。

**修改：**
- `src/lib/fieldStore.ts` — 加 `addOption(fieldId, label)` action（共享建选项，返回新 optionId），写后 `emitSync("todos")`。
- `src/components/NewTaskModal.tsx:404-471` — 单选/多选渲染换成 `FieldValueSelect`。
- `src/lib/chatTools.ts` — import 并 spread `chatToolsFields`；`create_todo`/`update_todo` 加 `custom_fields` 参数（D4 翻译）。
- `src-tauri/src/mcp/server.rs` — 镜像 5 个字段工具 + `create_todo`/`update_todo` 加 `custom_fields`；底部 `mod tests` 加字段工具测试。
- `src/components/CustomFieldsManager.tsx` — `genId`/`genOptId`/`PRESET_COLORS` 改为从 `fieldMatch.ts` 复用（消除重复定义）。
- 主窗挂载处（`src/App.tsx` 或 `TodoFloat.tsx`）— 加 `onSync("todos", () => useFieldStore.hydrate())` 让字段定义跨窗口刷新（Task 7）。

---

## Phase 1 — 共享纯函数底座（TS，TDD）

### Task 1: fieldMatch.ts 纯函数

**Files:** Create `src/lib/fieldMatch.ts` + `src/lib/fieldMatch.test.ts`

- [ ] **Step 1: 写失败测试** `src/lib/fieldMatch.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { normalizeLabel, findOptionByLabel, resolveCustomFieldsInput } from "./fieldMatch";
import type { FieldDefinition } from "./db";

const field = (over: Partial<FieldDefinition>): FieldDefinition => ({
  id: "fld_p", name: "项目", type: "single_select",
  options: [{ id: "opt_a", label: "项目A", color: "#ef4444" }],
  sortOrder: 0, createdAt: "", ...over,
});

describe("normalizeLabel", () => {
  it("折叠空白 + 全角空格 + 小写", () => {
    expect(normalizeLabel("  项目  A ")).toBe(normalizeLabel("项目　A"));
    expect(normalizeLabel("FooBar")).toBe("foobar");
  });
});

describe("findOptionByLabel", () => {
  it("归一化命中已有选项（'项目 A' 命中 '项目A'? 否——空格不同应区分）", () => {
    // 设计：'项目A' 与 '项目 A' 归一化后分别是 '项目a' / '项目 a'，不相等 → 不误并
    expect(findOptionByLabel(field({}).options, "项目 A")).toBeUndefined();
  });
  it("大小写/前后空格差异视为同一项", () => {
    const f = field({ options: [{ id: "opt_x", label: "Backend", color: "#000" }] });
    expect(findOptionByLabel(f.options, "  backend ")?.id).toBe("opt_x");
  });
});

describe("resolveCustomFieldsInput", () => {
  const fields = [field({})];
  it("单选：已有选项名→optId", () => {
    const { customFields, createdOptions } = resolveCustomFieldsInput(fields, { 项目: "项目A" });
    expect(customFields).toEqual({ fld_p: "opt_a" });
    expect(createdOptions).toEqual([]);
  });
  it("选项名不存在→标记需新建（含分配的 optId/color）", () => {
    const { createdOptions } = resolveCustomFieldsInput(fields, { 项目: "项目B" });
    expect(createdOptions).toHaveLength(1);
    expect(createdOptions[0]).toMatchObject({ fieldId: "fld_p", label: "项目B" });
  });
  it("字段名不存在→抛错", () => {
    expect(() => resolveCustomFieldsInput(fields, { 不存在字段: "x" })).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `cd /Users/apple/Documents/Daybreak && npx vitest run src/lib/fieldMatch.test.ts`，预期 FAIL（模块不存在）。

- [ ] **Step 3: 实现** `src/lib/fieldMatch.ts`

```ts
import type { FieldDefinition } from "./db";

export const PRESET_COLORS = ["#ef4444","#f97316","#eab308","#22c55e","#06b6d4","#3b82f6","#8b5cf6","#ec4899","#6b7280","#18181b"];

export function normalizeLabel(s: string): string {
  return s.trim().replace(/[\s　]+/g, " ").toLowerCase();
}
export function genFieldId() { return `fld_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`; }
export function genOptId() { return `opt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`; }

type Opt = { id: string; label: string; color: string };
export function findOptionByLabel(options: Opt[], label: string): Opt | undefined {
  const n = normalizeLabel(label);
  return options.find((o) => normalizeLabel(o.label) === n);
}
export function colorForIndex(i: number) { return PRESET_COLORS[i % PRESET_COLORS.length]; }

export interface CreatedOption { fieldId: string; optId: string; label: string; color: string; }
/** 把 {字段名: 选项名|选项名[]} 翻译成 {fieldId: optId|optId[]}；不存在的选项产出 createdOptions（待调用方落库） */
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
    // 工作副本，支持同一次输入里多个新选项各自分配递增颜色
    const working = [...fd.options];
    for (const lab of labels) {
      const hit = findOptionByLabel(working, lab);
      if (hit) { ids.push(hit.id); continue; }
      const opt = { id: genOptId(), label: lab.trim(), color: colorForIndex(working.length) };
      working.push(opt);
      createdOptions.push({ fieldId: fd.id, optId: opt.id, label: opt.label, color: opt.color });
      ids.push(opt.id);
    }
    customFields[fd.id] = fd.type === "single_select" ? ids[0] : ids;
  }
  return { customFields, createdOptions };
}
```

- [ ] **Step 4: 跑测试确认通过** — `npx vitest run src/lib/fieldMatch.test.ts`，预期 PASS。
- [ ] **Step 5:** 把 `CustomFieldsManager.tsx` 的 `genId`/`genOptId`/`PRESET_COLORS` 改为 `import { genFieldId as genId, genOptId, PRESET_COLORS } from "../lib/fieldMatch"`，删本地重复定义。跑 `npx vitest run` 确认无回归。

### Task 2: fieldStore.addOption（共享建选项）

**Files:** Modify `src/lib/fieldStore.ts`；Test `src/lib/fieldStore.test.ts`（新建或并入）

- [ ] **Step 1: 写失败测试** —— addOption 后字段 options 多一项且返回新 optId；并发安全（基于最新 options）。mock `dbUpdateField`。
- [ ] **Step 2:** 跑测试失败。
- [ ] **Step 3: 实现** —— 在 store 加：

```ts
addOption: async (fieldId: string, label: string): Promise<string | null> => {
  const f = get().fields.find((x) => x.id === fieldId);
  if (!f) return null;
  if (findOptionByLabel(f.options, label)) return findOptionByLabel(f.options, label)!.id; // 已存在直接复用
  const opt = { id: genOptId(), label: label.trim(), color: colorForIndex(f.options.length) };
  const updated = { ...f, options: [...f.options, opt] };
  await get().updateField(updated); // 复用既有 updateField（含 dbUpdateField + emitSync("todos")）
  return opt.id;
},
```

- [ ] **Step 4:** 跑测试通过。
- [ ] **Step 5:** Commit（见末尾"提交节奏"）。

---

## Phase 2 — 能力二：输入即建（前端 UI）

### Task 3: FieldValueSelect 组件

**Files:** Create `src/components/FieldValueSelect.tsx`；Test `src/components/FieldValueSelect.test.tsx`

行为：受控组件，props = `{ field: FieldDefinition; value: string | string[]; onChange; onCreateOption: (label)=>Promise<string|null> }`。
- 单选：可输入文本框 + 下拉候选（按输入过滤 option.label）；输入匹配不到时候选底部显示「+ 新建『XXX』」项，点击/回车 → 调 `onCreateOption(label)` 拿到 optId → `onChange(optId)`。
- 多选：已选项 chip（带色 + ×）+ 输入框；同样的"匹配不到→+新建"逻辑，建后追加进数组。
- 防重：输入命中已有选项（归一化 `findOptionByLabel`）时**不显示**"新建"项，只显示该已有项（避免建重复）。

- [ ] Step 1: 写失败测试（Testing Library）：输入新名字→出现"+新建"→点击触发 onCreateOption；输入已有名字→不出现"新建"。
- [ ] Step 2: 跑失败。
- [ ] Step 3: 实现组件（lucide 图标、tailwind 风格对齐现有 NewTaskModal）。
- [ ] Step 4: 跑通过。
- [ ] Step 5: 加 i18n key `fieldCreateOption`（"新建『{{label}}』"）到 zh/en 资源。

### Task 4: NewTaskModal 接入

**Files:** Modify `src/components/NewTaskModal.tsx:404-471`

- [ ] Step 1: 把单选 `<select>`(404-422) 和多选块(424-471) 替换为 `<FieldValueSelect field={fd} value={customFieldValues[fd.id] ...} onChange={...} onCreateOption={(l)=>useFieldStore.getState().addOption(fd.id, l)} />`。保留 `customFieldValues` 状态结构不变。
- [ ] Step 2: `npx vitest run src/components`（确认 NewTaskModal 相关测试若有不回归）。
- [ ] Step 3: 手动验收（见末尾验收清单 A）。
- [ ] Step 4: Commit。

---

## Phase 3 — 能力一 TS 侧：AI 工具（chatTools）

### Task 5: chatToolsFields.ts + create/update_todo 扩展

**Files:** Create `src/lib/chatToolsFields.ts` + `.test.ts`；Modify `src/lib/chatTools.ts`

工具（仿 `chatToolsMemory` 的 ChatTool 结构）：
- `list_fields` → 返回所有字段（id/name/type/options 的 label）。
- `create_field({ name, type, options? })` → 校验 type∈{single_select,multi_select}，否则报"暂不支持"；建字段（genFieldId + 每个 option genOptId + colorForIndex）→ `useFieldStore.addField`。
- `update_field({ id, name?, add_options? })` → 改名 / 追加选项（归一化去重）→ `updateField`。
- `delete_field({ id, confirm? })` → D5 协议：confirm=false 先数 `custom_fields LIKE %id%` 的 todo 数返回 pending；confirm=true → `removeField`（已含清理）。
- `delete_field_option({ field_id, option_label, confirm? })` → 归一化找 optId；confirm 协议；confirm=true → `removeOption`。
- `create_todo`/`update_todo`：加 `custom_fields` 参数（D4）。execute 里：`resolveCustomFieldsInput(useFieldStore.getState().fields, custom_fields)` → 对 createdOptions 逐个 `addOption` 落库 → 合进 todo.customFields → addTodo/updateTodo。返回里带 `createdOptions` 让 AI 据实告知用户。

- [ ] Step 1: 写失败测试 `chatToolsFields.test.ts`（仿 memory 测试，用真实 fieldStore + mock db 层或内存）：create_field 落库；填值自动建选项；delete_field 不带 confirm 返回 pending、带 confirm 真删并清理；非法 type 报错。
- [ ] Step 2: 跑失败。
- [ ] Step 3: 实现 `chatToolsFields.ts`；在 `chatTools.ts` 顶部 `import { FIELD_TOOLS } from "./chatToolsFields"` 并在 `CHAT_TOOLS` 数组 spread；改 create_todo/update_todo 的 parameters 加 `custom_fields: { type: "object", description: "{字段名: 选项名 或 选项名数组}；选项不存在会自动新建" }` 与 execute 翻译逻辑。
- [ ] Step 4: 跑通过（`npx vitest run src/lib/chatToolsFields.test.ts`）。
- [ ] Step 5: Commit。

---

## Phase 4 — 能力一 Rust 侧：MCP 镜像

### Task 6: server.rs 镜像字段工具

**Files:** Modify `src-tauri/src/mcp/server.rs`

镜像 Task 5 的 7 个工具点（参数结构 `#[derive(Deserialize, JsonSchema)]` + `#[tool]` 方法）。Rust 端自带 sqlx 直查，需自实现：
- 颜色常量 `PRESET_COLORS`、`normalize_label`（D1 Rust 版）、`color_for_index`。
- `field_definitions` 的读（SELECT options→serde_json 解析）、写（INSERT/UPDATE options JSON）。
- 填值：解析 todos 现有 `custom_fields`、归一化匹配/新建选项（回写 field options）、写 `custom_fields`。
- delete 的 confirm 协议：先 `SELECT COUNT(*) ... WHERE custom_fields LIKE '%' || ?1 || '%'` 数影响；confirm 才删 + 镜像 `dbClearFieldFromTodos`/`dbClearOptionFromTodos` 的清理 SQL。
- 每个写操作后 `(self.notify)("todos")`。

- [ ] Step 1: 在 `mod tests` 写失败测试（仿 memory 测试：内存库 + DDL 镜像 `field_definitions` 和 `todos` 表）：create_field 落库；填值自动建选项并写 custom_fields；delete_field confirm 协议；list_fields 返回。
- [ ] Step 2: 跑失败 — `cd src-tauri && cargo test mcp::server`，预期 FAIL（方法不存在）。
- [ ] Step 3: 实现工具 + helper。
- [ ] Step 4: 跑通过 — `cargo test mcp::server`。
- [ ] Step 5: `cargo build` 确认整体编译。Commit。

---

## Phase 5 — 跨窗口刷新 + 全量验收

### Task 7: 字段定义跨窗口 hydrate

**Files:** Modify 主窗挂载处（查 `src/App.tsx` 的 MainWindow / `TodoFloat.tsx` 现有 `onSync("todos")` 处）

- [ ] Step 1: 在已有 `onSync("todos", ...)` 的消费者旁，补 `useFieldStore.getState().hydrate()`（或新增订阅），确保 AI 在对话窗改字段后，主窗 NewTaskModal/列表的字段下拉刷新。
- [ ] Step 2: 手动验收（清单 B）。
- [ ] Step 3: Commit。

### 全量验收清单

- [ ] **A（能力二）：** `npm run tauri:dev`，新建任务 → 在"项目"单选字段输入一个新名字 → 出现"+新建" → 确认后该选项入库、再次新建任务能选到；输入已有名字的大小写/空格变体 → 不产生重复项。
- [ ] **B（能力一，默认 API 大脑）：** 对话里说"建个'客户'单选字段，选项 A/B/C" → 设置页出现该字段；"把任务 X 归到客户 D"（D 不存在）→ AI 回复说明新建了 D 并填上，库里 todo.custom_fields 正确；"删客户字段" → AI 先报"会清 N 个任务"、确认后才删；主窗下拉同步刷新。
- [ ] **C（能力一，CC/Codex 大脑）：** 经 MCP 调 create_field/list_fields/delete_field(confirm 两段) 行为与 B 一致。
- [ ] **D（回归）：** `npm test`（vitest 全绿）+ `cd src-tauri && cargo test`（全绿）+ `npm run build`（tsc 通过）。

---

## 提交节奏

每个 Task 的 Step 5 提交一次，message 形如：`feat(fields): <task 摘要>`。Phase 边界可加一个汇总 commit。**是否真的 `git commit` 由用户决定**（用户偏好：未明确要求不擅自提交）——执行时先攒改动，到验收节点问用户要不要提交。

---

## 自查（writing-plans Self-Review）

- **Spec 覆盖：** 能力一(§1.2)→Task5/6；能力二(§1.3)→Task3/4；共享底座(§1.1)→Task1/2；跨窗口(§1.4)→Task7；删除确认(规则3)→D5；label↔id(规则1)→D1/D4；防重(R2)→D1+Task3；工具双端(R4)→Task5+Task6。✅ 无遗漏。
- **占位扫描：** 无 TBD/TODO；模板化引用（memory 工具）给了明确文件位置，非占位。
- **类型一致：** `resolveCustomFieldsInput`/`findOptionByLabel`/`addOption`/`colorForIndex` 跨 Task 命名一致；Rust 镜像方法名与 TS 工具名逐字对齐（list_fields/create_field/update_field/delete_field/delete_field_option）。
- **YAGNI：** update_field 收窄到改名+加选项（D7）；不扩展字段类型；软删除不做（spec §4 可选项，本期硬删+清理）。

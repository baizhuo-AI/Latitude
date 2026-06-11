# 自定义字段系统 + 分组列表视图

> 日期：2026-06-12
> 状态：设计完成，待实施
> 依赖顺序：Spec 1（自定义字段）→ Spec 2（分组列表视图）

## 背景

Daybreak 待办管理页目前只有平铺列表视图。页面上已预留了视图切换按钮（`list` / `kanban`），但第二个视图从未实现。

用户需求不是看板（按状态分列），而是**飞书多维表格式的分组列表**：同一个表格结构，按用户选择的字段对行做分组归堆，支持多级嵌套、折叠、计数。

为了让分组有更丰富的维度可选，同时需要一个**自定义字段系统**，允许用户创建单选/多选属性字段。

---

## Spec 1：自定义字段系统

### 1.1 数据模型

#### field_definitions 表（新建）

```sql
CREATE TABLE IF NOT EXISTS field_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,            -- "single_select" | "multi_select"
  options TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
```

`options` 存 JSON 数组：

```json
[
  {"id": "opt_1", "label": "张三", "color": "#ef4444"},
  {"id": "opt_2", "label": "李四", "color": "#3b82f6"}
]
```

#### todos 表加列

```sql
ALTER TABLE todos ADD COLUMN custom_fields TEXT NOT NULL DEFAULT '{}';
```

存储格式：

```json
{
  "field_id_1": "opt_id",           // 单选：选项 ID 字符串
  "field_id_2": ["opt_a", "opt_b"]  // 多选：选项 ID 数组
}
```

#### Todo interface 扩展

```typescript
export interface Todo {
  // ... 现有字段不变
  customFields?: Record<string, string | string[]>;
}
```

#### 新增 useFieldStore

```typescript
interface FieldDefinition {
  id: string;
  name: string;
  type: "single_select" | "multi_select";
  options: { id: string; label: string; color: string }[];
  sortOrder: number;
  createdAt: string;
}

interface FieldStore {
  fields: FieldDefinition[];
  loaded: boolean;
  hydrate: () => Promise<void>;
  addField: (field: FieldDefinition) => Promise<void>;
  updateField: (field: FieldDefinition) => Promise<void>;
  removeField: (id: string) => Promise<void>;
}
```

### 1.2 字段管理 UI（设置页）

入口：SettingsPage 内新增"自定义字段"区块。

**字段列表**
- 卡片式展示，每张卡片显示：拖拽手柄、类型图标（单选 ◉ / 多选 ◫）、字段名、类型文案、选项 badge 预览
- 操作按钮：编辑、删除
- 拖拽调整 sort_order
- 底部"+ 新建字段"按钮（虚线卡片）

**新建/编辑字段（Modal 或内联表单）**
- 字段名输入框
- 类型选择：单选 / 多选（两个选项卡，互斥）
- 选项管理：
  - 每行：拖拽手柄 + 颜色色块 + 文案输入 + × 删除
  - 底部"+ 添加选项"
  - 颜色从 10 色预设盘选取（红、橙、黄、绿、青、蓝、紫、粉、灰、黑）
- 保存 / 取消

**删除字段**
- 确认弹窗提示"将同时清除所有待办上该字段的值"
- 确认后：删除 field_definitions 记录 + 遍历 todos 清除 custom_fields 中对应 key

**删除选项**
- 删除一个选项时，所有 todo 上使用该选项的值被静默清除（单选清空，多选从数组移除）

### 1.3 待办表单适配（NewTaskModal）

- 内置字段区（标题、截止时间、优先级、标签、预估耗时）不变
- 分割线后，动态渲染自定义字段区，按 sort_order 排列
- 单选字段：下拉选择器，选项带颜色 badge
- 多选字段：多选 tag 输入，已选项显示为带色 badge + × 可删除
- 新建和编辑待办复用同一套渲染

### 1.4 列表视图适配

- 表头动态扩展：内置 4 列 + 自定义字段列（按 sort_order）
- TodoRow grid 列数动态计算
- 单选字段：显示单个带色 badge
- 多选字段：显示多个带色 badge
- 自定义字段列名可用区分色标注（与内置列区分）
- 限制：最多显示前 3 个自定义字段列，超出折叠（避免横向溢出）

---

## Spec 2：分组列表视图

### 2.1 视图切换

- 两个按钮：左"平铺"（`List` 图标），右"分组"（`LayoutGrid` 图标）
- 状态类型：`"flat" | "grouped"`（替换原来的 `"list" | "kanban"`）
- i18n key 相应更新：`viewList` → `viewFlat`，`viewKanban` → `viewGrouped`
- 视图模式存 `localStorage`，刷新后保持

### 2.2 分组配置面板（Popover）

**触发**：点击分组按钮，toggle popover 显隐。

**面板内容**：
- 标题"设置分组条件"
- 每行一个分组层级：
  - 拖拽手柄 ⠿（调整层级顺序）
  - 字段下拉（可选项 = 内置字段 + 所有自定义字段）
  - 排序方向切换（A→Z / Z→A）
  - × 删除该层级
- 底部"+ 添加分组"按钮
- 同一字段不能重复选择（已选字段从下拉中排除）

**内置可分组字段**：
| 字段 | 分组值来源 | 组头显示 |
|------|-----------|---------|
| 优先级 | 固定枚举 high/medium/low/none | i18n 文案 + 彩色 badge |
| 状态 | 固定枚举 todo/doing/done/dropped | i18n 文案 |
| 标签 | 动态收集所有可见 todo 的唯一 tag 值 | tag 原文 |
| 截止时间 | 分桶：已过期 / 今天 / 明天 / 本周内 / 下周 / 更远 / 未设置 | 桶名 |

**自定义字段**：
- 单选：每个选项值一组，组头显示选项 label + color badge。未设置值的 todo 归入"未设置"兜底组
- 多选：每个选项值一组，有多个选项的 todo 出现在多个组中。未设置值归入"未设置"组

**状态持久化**：
- 分组配置（字段列表 + 各自排序方向）存 `localStorage`
- 全部层级删完后自动退回平铺模式

**默认值**：
- 首次进入分组模式时预填一行"优先级 A→Z"

### 2.3 分组渲染

**数据流**：搜索 → 优先级筛选 → 排序 → 分组（分组在最后一步，作用于已过滤排序后的数据）

**单级分组**：
- 组头行：折叠箭头 + 组名（badge/文案）+ 计数
- 组内：TodoRow 保持不变
- 空组不显示
- 已完成的 todo 不再单独折叠到底部"已完成"区，而是跟随分组逻辑归入各组

**多级分组**：
- 第 N 级组嵌套在第 N-1 级组内部，每级缩进 20px
- 第一级组头：大字号、加粗、badge
- 第二级及以下组头：小字号、弱化颜色
- 每级独立可折叠

**折叠状态**：
- 默认全部展开
- 折叠状态存内存（不持久化），切换分组字段时重置为全展开

### 2.4 交互细节

- 分组模式下，原有的排序下拉仍可用（控制组内排序）
- 分组模式下，搜索和优先级筛选仍可用（先过滤再分组）
- 切换回平铺模式时，分组配置保留（下次切回分组模式恢复）
- 新建待办按钮在两种模式下均可用

---

## 实施顺序

1. **Spec 1 — 自定义字段系统**
   - 1a. 数据层：field_definitions 表 + todos 加列 + useFieldStore + db 层 CRUD
   - 1b. 设置页字段管理 UI
   - 1c. NewTaskModal 表单适配
   - 1d. 列表视图列扩展

2. **Spec 2 — 分组列表视图**
   - 2a. 视图切换重构（flat/grouped，替换 list/kanban）
   - 2b. 分组配置面板 Popover
   - 2c. 分组计算逻辑（groupBy 函数，支持多级 + 多值字段）
   - 2d. 分组渲染组件（GroupHeader + 嵌套结构）
   - 2e. localStorage 持久化

---

## 设计 Mockup

可视化设计稿位于 `.superpowers/brainstorm/` 目录：
- `group-view-design.html` — 分组列表视图（工具栏、配置面板、单级/多级分组效果）
- `custom-fields-ui.html` — 自定义字段系统（设置页、字段编辑器、表单适配、列表视图）

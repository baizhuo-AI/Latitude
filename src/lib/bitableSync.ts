import type { Todo } from "./store";
import type { FieldDefinition } from "./db";
import type { BitableRecordRow, BitableFieldMeta } from "./feishuBitable";

/**
 * 多维表格同步的「聚合 + upsert 匹配」纯逻辑。
 *
 * 职责边界：只做**结构化分组与匹配**——把今天完成的 todo 按「项目」自定义字段归组、
 * 和飞书表现有行按主字段匹配出 create/update。**不写**「最近进展」摘要文字（那交给 AI），
 * 也不碰网络（输入是已读好的数据）。这样可纯函数单测。
 *
 * 数据落差处理（见设计 §5.5）：
 * - 项目来源 = 某个自定义字段（默认名为「项目」，或调用方指定 id）。找不到该字段 →
 *   needProjectField=true，让 AI 问用户用哪个字段。
 * - 某条 todo 在该字段无值 → 进 unassigned，让 AI 在对话里问归属。
 * - activity_log 无项目归属，不在本函数处理（由工具层单独把今日活动传给 AI 参考）。
 */

/** 一条今天完成的工作（喂 AI 写进展摘要的原料）。 */
export interface WorkItem {
  title: string;
  /** todo 的 reason（"为什么做"），可空。 */
  detail?: string;
}

/** 一个项目的同步计划。 */
export interface ProjectGroup {
  project: string;
  op: "create" | "update";
  /** op==='update' 时是要更新的飞书 record_id。 */
  recordId?: string;
  /** 项目名与某现有行相近但不完全相等（疑似重复）→ AI 在确认步提示用户。 */
  suspectNew: boolean;
  /** 该项目今天的工作条目（原始，AI 据此写进展摘要）。 */
  items: WorkItem[];
}

/** buildSyncPlan 的产物。 */
export interface SyncPlan {
  /** 没找到项目字段 → AI 应先问用户用哪个自定义字段标项目。 */
  needProjectField: boolean;
  /** 实际用的项目字段 id / 名（needProjectField=false 时有）。 */
  projectFieldId?: string;
  projectFieldName?: string;
  /** 表主字段名（upsert 匹配键，即"项目"列）。 */
  primaryFieldName?: string;
  /** 按项目分好的组。 */
  groups: ProjectGroup[];
  /** 没有项目归属的条目（AI 应问用户归属）。 */
  unassigned: WorkItem[];
}

/** 项目名归一化：去首尾与内部空白 + 小写，做匹配用（"Latitude 插件" ≈ "latitude插件"）。 */
function normalizeProjectName(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

/**
 * 从飞书 record 的字段值提取纯文本。
 * 兼容三种形态：纯字符串 / 数字 / 富文本数组 [{type:"text", text:"…"}]（飞书文本字段常见返回）。
 */
export function extractCellText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    return v
      .map((seg) => {
        if (typeof seg === "string") return seg;
        if (seg && typeof seg === "object" && "text" in seg) {
          return String((seg as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  }
  if (v && typeof v === "object" && "text" in v) {
    return String((v as { text?: unknown }).text ?? "");
  }
  return "";
}

/** 取某 todo 在项目字段上的 label（optionId → label）。单/多选都取首个有效 label。 */
function projectLabelOf(
  todo: Todo,
  fieldDef: FieldDefinition
): string | undefined {
  const raw = todo.customFields?.[fieldDef.id];
  if (!raw) return undefined;
  const ids = Array.isArray(raw) ? raw : [raw];
  for (const id of ids) {
    const opt = fieldDef.options.find((o) => o.id === id);
    if (opt?.label) return opt.label;
  }
  return undefined;
}

function toWorkItem(t: Todo): WorkItem {
  return { title: t.title, detail: t.reason };
}

/**
 * 把今天完成的 todo 聚合成「按项目的 upsert 计划」。
 *
 * @param todos        今天完成的 todo（dbListTodosCompletedOn 的产物）
 * @param fieldDefs    自定义字段定义（dbListFields）
 * @param existingRows 飞书表现有记录（describeBitable.records）
 * @param tableFields  飞书表字段（describeBitable.fields，含 is_primary）
 * @param projectFieldId 指定哪个自定义字段代表项目（空则找名为"项目"的）
 */
export function buildSyncPlan(args: {
  todos: Todo[];
  fieldDefs: FieldDefinition[];
  existingRows: BitableRecordRow[];
  tableFields: BitableFieldMeta[];
  projectFieldId?: string;
}): SyncPlan {
  const { todos, fieldDefs, existingRows, tableFields, projectFieldId } = args;

  // 1. 找项目字段：指定 id 优先，否则名为"项目"的字段。
  const projField =
    (projectFieldId
      ? fieldDefs.find((f) => f.id === projectFieldId)
      : undefined) ?? fieldDefs.find((f) => f.name === "项目");
  if (!projField) {
    return {
      needProjectField: true,
      groups: [],
      unassigned: todos.map(toWorkItem)
    };
  }

  // 2. 主字段（匹配键）：表里标 is_primary 的，兜底第一个字段。
  const primary = tableFields.find((f) => f.is_primary) ?? tableFields[0];
  const primaryFieldName = primary?.field_name;

  // 现有行：归一化项目名 → record_id；同时留一份原始名做"疑似重复"判断。
  const existingByName = new Map<string, string>();
  const existingNames: string[] = [];
  if (primaryFieldName) {
    for (const row of existingRows) {
      const name = extractCellText(row.fields[primaryFieldName]).trim();
      if (name) {
        existingByName.set(normalizeProjectName(name), row.record_id);
        existingNames.push(name);
      }
    }
  }

  // 3. 聚合 todos 到项目（无项目归属的进 unassigned）。
  const groupOrder: string[] = [];
  const groupMap = new Map<string, WorkItem[]>();
  const unassigned: WorkItem[] = [];
  for (const t of todos) {
    const proj = projectLabelOf(t, projField);
    if (!proj) {
      unassigned.push(toWorkItem(t));
      continue;
    }
    if (!groupMap.has(proj)) {
      groupMap.set(proj, []);
      groupOrder.push(proj);
    }
    groupMap.get(proj)!.push(toWorkItem(t));
  }

  // 4. 每个项目定 op + suspectNew。
  const groups: ProjectGroup[] = groupOrder.map((project) => {
    const items = groupMap.get(project)!;
    const norm = normalizeProjectName(project);
    const recordId = existingByName.get(norm);
    if (recordId) {
      return { project, op: "update", recordId, suspectNew: false, items };
    }
    // 没精确命中：若与某现有项目有子串包含关系，标"疑似新项目"让 AI 提示用户。
    const suspectNew = existingNames.some((n) => {
      const nn = normalizeProjectName(n);
      return nn.length > 0 && (nn.includes(norm) || norm.includes(nn));
    });
    return { project, op: "create", suspectNew, items };
  });

  return {
    needProjectField: false,
    projectFieldId: projField.id,
    projectFieldName: projField.name,
    primaryFieldName,
    groups,
    unassigned
  };
}

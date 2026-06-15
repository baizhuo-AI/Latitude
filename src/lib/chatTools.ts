/**
 * 内置 AI 对话的工具层（function calling）
 *
 * 定义给 LLM 看的工具 schema + 每个工具的执行逻辑。
 * 执行直接复用前端已有的 db.ts / store 函数（不绕后端 MCP），执行后刷新对应 store，
 * 这样在对话里改的数据，TodosPage / Briefing / 浮窗等界面会实时更新。
 *
 * 工具集与后端 MCP 对齐，保证"应用内对话"和"外部 Claude Code"能力一致。
 */

import {
  dbListTodos,
  dbListTodosCompletedOn,
  dbListFields,
  dbUpdateTodoStatus,
  dbUpdateTodoSchedule,
  dbListActivities,
  dbListCalendarEvents,
} from "./db";
import { useTodoStore, newTodoId, type Todo, type Priority, type TodoStatus } from "./store";
import { useGoalsStore, newGoalId, type Goal } from "./goalsStore";
import { useActivityStore } from "./activityStore";
import { readFeishuPrefs, patchFeishuPrefsInStorage } from "./settings";
import { buildSyncPlan } from "./bitableSync";
import {
  describeBitable,
  createBitableRecords,
  updateBitableRecords,
  type BitableRecordUpdate,
  type BitableFieldMeta,
} from "./feishuBitable";
import { emitSync } from "./syncBus";

export interface ChatTool {
  name: string;
  description: string;
  /** JSON schema（OpenAI function parameters 格式） */
  parameters: Record<string, unknown>;
  /** 执行，返回给模型的结果文本 */
  execute: (args: Record<string, unknown>) => Promise<string>;
}

/* ---------- helpers ---------- */

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** todos 写操作后统一刷新主窗口 + 通知其它窗口 */
async function refreshTodos() {
  await useTodoStore.getState().hydrate();
  emitSync("todos");
}

/**
 * 把 AI 传入的 CellValue 按字段类型收敛：DateTime 字段的日期字符串 → 毫秒时间戳
 * （飞书 DateTime 字段写入要毫秒数）。其它类型原样透传。让 AI 只需填 "YYYY-MM-DD" 即可。
 */
function coerceFields(
  fields: Record<string, unknown>,
  metaByName: Map<string, BitableFieldMeta>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    const meta = metaByName.get(k);
    if (meta?.ui_type === "DateTime" && typeof v === "string") {
      const ts = Date.parse(v);
      out[k] = Number.isNaN(ts) ? v : ts;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/* ---------- 工具定义 ---------- */

export const CHAT_TOOLS: ChatTool[] = [
  {
    name: "list_todos",
    description: "列出待办任务，可按状态过滤",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", description: "todo / doing / done / dropped；留空返回全部" },
        limit: { type: "number", description: "最多返回多少条，默认 50" },
      },
    },
    execute: async (a) => {
      const all = await dbListTodos();
      const status = str(a.status);
      const filtered = status ? all.filter((t) => t.status === status) : all;
      const limit = typeof a.limit === "number" ? a.limit : 50;
      const items = filtered.slice(0, limit).map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        scheduledDate: t.scheduledDate,
        scheduledTime: t.scheduledTime,
        deadline: t.deadline,
      }));
      return JSON.stringify({ count: items.length, todos: items });
    },
  },
  {
    name: "create_todo",
    description: "创建一个新待办任务",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "任务标题（必填）" },
        priority: { type: "string", description: "high / medium / low / none，默认 none" },
        deadline: { type: "string", description: "截止日期 YYYY-MM-DD" },
        scheduled_date: { type: "string", description: "排期到哪天 YYYY-MM-DD" },
        scheduled_time: { type: "string", description: "排期时段，如 09:30-11:00" },
        est_time: { type: "string", description: "预估耗时，如 1.5h" },
        reason: { type: "string", description: "为什么做（可选）" },
      },
      required: ["title"],
    },
    execute: async (a) => {
      const title = str(a.title);
      if (!title) return JSON.stringify({ error: "title 必填" });
      const todo: Todo = {
        id: newTodoId(),
        title,
        reason: str(a.reason),
        deadline: str(a.deadline),
        priority: (str(a.priority) as Priority) ?? "none",
        tags: [],
        estTime: str(a.est_time),
        status: "todo",
        scheduledTime: str(a.scheduled_time),
        scheduledDate: str(a.scheduled_date),
        createdAt: new Date().toISOString(),
      };
      await useTodoStore.getState().addTodo(todo); // 内含 db 写入 + state 更新 + emitSync
      return JSON.stringify({ created: { id: todo.id, title: todo.title } });
    },
  },
  {
    name: "set_todo_status",
    description: "更新任务状态。状态：todo / doing / done / dropped",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", description: "todo / doing / done / dropped" },
      },
      required: ["id", "status"],
    },
    execute: async (a) => {
      const id = str(a.id);
      const status = str(a.status);
      if (!id || !status) return JSON.stringify({ error: "id 和 status 必填" });
      await dbUpdateTodoStatus(id, status as TodoStatus);
      await refreshTodos();
      return JSON.stringify({ updated: true, id, status });
    },
  },
  {
    name: "schedule_todo",
    description: "给任务排期（归属日期和/或时段）",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        scheduled_date: { type: "string", description: "YYYY-MM-DD；留空清除" },
        scheduled_time: { type: "string", description: "如 09:30-11:00；留空清除" },
      },
      required: ["id"],
    },
    execute: async (a) => {
      const id = str(a.id);
      if (!id) return JSON.stringify({ error: "id 必填" });
      await dbUpdateTodoSchedule(id, str(a.scheduled_date) ?? null, str(a.scheduled_time) ?? null);
      await refreshTodos();
      return JSON.stringify({ updated: true, id });
    },
  },
  {
    name: "update_todo",
    description: "编辑已有任务的字段（标题/原因/优先级/deadline/标签/预估时间）。只填想改的字段；状态/排期请用 set_todo_status / schedule_todo",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "目标任务的 id" },
        title: { type: "string" },
        reason: { type: "string" },
        deadline: { type: "string", description: "YYYY-MM-DD；空字符串则清除" },
        priority: { type: "string", description: "high / medium / low / none" },
        tags: { type: "array", items: { type: "string" } },
        est_time: { type: "string", description: "如 1.5h / 30m" },
      },
      required: ["id"],
    },
    execute: async (a) => {
      const id = str(a.id);
      if (!id) return JSON.stringify({ error: "id 必填" });
      const all = await dbListTodos();
      const cur = all.find((t) => t.id === id);
      if (!cur) return JSON.stringify({ error: "没找到该 id" });
      const merged: Todo = {
        ...cur,
        title: typeof a.title === "string" && a.title.trim() ? a.title.trim() : cur.title,
        reason: typeof a.reason === "string" ? (a.reason || undefined) : cur.reason,
        deadline: typeof a.deadline === "string" ? (a.deadline || undefined) : cur.deadline,
        priority: (str(a.priority) as Priority) ?? cur.priority,
        tags: Array.isArray(a.tags)
          ? (a.tags as unknown[]).filter((x): x is string => typeof x === "string")
          : cur.tags,
        estTime: typeof a.est_time === "string" ? (a.est_time || undefined) : cur.estTime,
      };
      await useTodoStore.getState().updateTodo(merged);
      return JSON.stringify({
        updated: true,
        id,
        fieldsChanged: Object.keys(a).filter((k) => k !== "id"),
      });
    },
  },
  {
    name: "today_overview",
    description: "查看某一天的任务概览（默认今天）",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD；留空默认今天" },
      },
    },
    execute: async (a) => {
      const date = str(a.date) ?? todayKey();
      const all = await dbListTodos();
      const items = all
        .filter((t) => (t.scheduledDate ?? "") === date)
        .map((t) => ({ id: t.id, title: t.title, status: t.status, scheduledTime: t.scheduledTime }));
      return JSON.stringify({ date, count: items.length, todos: items });
    },
  },
  {
    name: "delete_todo",
    description: "删除（放弃）任务——标记为 dropped，可用 recover_todo 恢复，不真删数据",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    execute: async (a) => {
      const id = str(a.id);
      if (!id) return JSON.stringify({ error: "id 必填" });
      await dbUpdateTodoStatus(id, "dropped");
      await refreshTodos();
      return JSON.stringify({ deleted: true, id, note: "已标记 dropped，可恢复" });
    },
  },
  {
    name: "recover_todo",
    description: "恢复被删除（dropped）的任务，状态改回 todo",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    execute: async (a) => {
      const id = str(a.id);
      if (!id) return JSON.stringify({ error: "id 必填" });
      await dbUpdateTodoStatus(id, "todo");
      await refreshTodos();
      return JSON.stringify({ recovered: true, id });
    },
  },
  {
    name: "list_goals",
    description: "列出目标，可按周期/状态过滤",
    parameters: {
      type: "object",
      properties: {
        period: { type: "string", description: "year / quarter / month" },
        status: { type: "string", description: "active / achieved / abandoned" },
      },
    },
    execute: async (a) => {
      let goals = useGoalsStore.getState().goals;
      if (goals.length === 0) {
        await useGoalsStore.getState().hydrate();
        goals = useGoalsStore.getState().goals;
      }
      const period = str(a.period);
      const status = str(a.status);
      const items = goals
        .filter((g) => (!period || g.period === period) && (!status || g.status === status))
        .map((g) => ({ id: g.id, title: g.title, period: g.period, status: g.status, targetDate: g.targetDate }));
      return JSON.stringify({ count: items.length, goals: items });
    },
  },
  {
    name: "create_goal",
    description: "创建目标。period：year / quarter / month",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        period: { type: "string", description: "year / quarter / month（必填）" },
        description: { type: "string" },
        target_date: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["title", "period"],
    },
    execute: async (a) => {
      const title = str(a.title);
      const period = str(a.period);
      if (!title || !period) return JSON.stringify({ error: "title 和 period 必填" });
      const goal: Goal = {
        id: newGoalId(),
        title,
        description: str(a.description),
        period: period as Goal["period"],
        targetDate: str(a.target_date),
        status: "active",
        createdAt: new Date().toISOString(),
      };
      await useGoalsStore.getState().addGoal(goal);
      emitSync("goals");
      return JSON.stringify({ created: { id: goal.id, title: goal.title } });
    },
  },
  {
    name: "set_goal_status",
    description: "更新目标状态：active / achieved / abandoned",
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, status: { type: "string" } },
      required: ["id", "status"],
    },
    execute: async (a) => {
      const id = str(a.id);
      const status = str(a.status);
      if (!id || !status) return JSON.stringify({ error: "id 和 status 必填" });
      await useGoalsStore.getState().setStatus(id, status as Goal["status"]);
      emitSync("goals");
      return JSON.stringify({ updated: true, id, status });
    },
  },
  {
    name: "delete_goal",
    description: "删除（放弃）目标——标记 abandoned，可用 recover_goal 恢复",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    execute: async (a) => {
      const id = str(a.id);
      if (!id) return JSON.stringify({ error: "id 必填" });
      await useGoalsStore.getState().setStatus(id, "abandoned");
      emitSync("goals");
      return JSON.stringify({ deleted: true, id, note: "已标记 abandoned，可恢复" });
    },
  },
  {
    name: "recover_goal",
    description: "恢复被删除（abandoned）的目标，状态改回 active",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    execute: async (a) => {
      const id = str(a.id);
      if (!id) return JSON.stringify({ error: "id 必填" });
      await useGoalsStore.getState().setStatus(id, "active");
      emitSync("goals");
      return JSON.stringify({ recovered: true, id });
    },
  },
  {
    name: "list_activities",
    description: "列出时间日志,可按日期/日期范围过滤。不传日期默认返回最近记录",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "单日 YYYY-MM-DD（与 start_date/end_date 互斥）" },
        start_date: { type: "string", description: "范围起始 YYYY-MM-DD（含）" },
        end_date: { type: "string", description: "范围结束 YYYY-MM-DD（含）" },
        limit: { type: "number", description: "最多返回多少条，默认 100" },
      },
    },
    execute: async (a) => {
      const limit = typeof a.limit === "number" ? a.limit : 100;
      const date = str(a.date);
      const startDate = str(a.start_date);
      const endDate = str(a.end_date);
      const opts = date
        ? { startDate: date, endDate: date }
        : (startDate || endDate) ? { startDate, endDate } : undefined;
      const rows = await dbListActivities(limit, opts);
      return JSON.stringify({ count: rows.length, activities: rows.map((r) => ({ id: r.id, content: r.content, createdAt: r.createdAt })) });
    },
  },
  {
    name: "log_activity",
    description: "记一条时间日志（你现在/刚才在做什么）",
    parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
    execute: async (a) => {
      const content = str(a.content);
      if (!content) return JSON.stringify({ error: "content 必填" });
      await useActivityStore.getState().addActivity(content); // 内含 db 写入 + emitSync
      return JSON.stringify({ logged: { content } });
    },
  },
  {
    name: "list_calendar_events",
    description: "查询日历事件。可按单日或日期范围查，不传日期默认查今天",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "单日 YYYY-MM-DD（与 start_date/end_date 互斥）" },
        start_date: { type: "string", description: "范围起始 YYYY-MM-DD（含）" },
        end_date: { type: "string", description: "范围结束 YYYY-MM-DD（含）" },
        calendar_id: { type: "string", description: "只看某个日历（留空返回所有日历）" },
        limit: { type: "number", description: "最多返回多少条，默认 30" },
      },
    },
    execute: async (a) => {
      const all = await dbListCalendarEvents(
        a.calendar_id ? { calendarId: String(a.calendar_id) } : {}
      );
      const date = str(a.date);
      const startDate = str(a.start_date);
      const endDate = str(a.end_date);
      let filtered = all;
      if (date) {
        filtered = all.filter((e) => e.scheduledDate === date);
      } else if (startDate || endDate) {
        filtered = all.filter((e) => {
          const d = e.scheduledDate ?? "";
          return (!startDate || d >= startDate) && (!endDate || d <= endDate);
        });
      } else {
        const today = todayKey();
        filtered = all.filter((e) => e.scheduledDate === today);
      }
      const limit = typeof a.limit === "number" ? a.limit : 30;
      const items = filtered.slice(0, limit).map((e) => ({
        title: e.title,
        date: e.scheduledDate,
        time: e.scheduledTime,
        location: e.location,
        calendar: e.calendarName,
        allDay: e.isAllDay,
        description: e.description?.slice(0, 100),
      }));
      return JSON.stringify({ count: items.length, events: items });
    },
  },
  {
    name: "search_calendar_events",
    description: "按关键词搜索日历事件（标题或描述包含关键词）",
    parameters: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "搜索关键词（必填）" },
        limit: { type: "number", description: "最多返回多少条，默认 10" },
      },
      required: ["keyword"],
    },
    execute: async (a) => {
      const keyword = str(a.keyword);
      if (!keyword) return JSON.stringify({ error: "keyword 必填" });
      const all = await dbListCalendarEvents();
      const kw = keyword.toLowerCase();
      const matched = all.filter(
        (e) =>
          e.title.toLowerCase().includes(kw) ||
          (e.description ?? "").toLowerCase().includes(kw)
      );
      const limit = typeof a.limit === "number" ? a.limit : 10;
      const items = matched.slice(0, limit).map((e) => ({
        title: e.title,
        date: e.scheduledDate,
        time: e.scheduledTime,
        location: e.location,
        calendar: e.calendarName,
        allDay: e.isAllDay,
      }));
      return JSON.stringify({ count: items.length, events: items });
    },
  },
  {
    name: "preview_feishu_table_sync",
    description:
      "预览『把今天完成的项目进展同步到飞书表格』：拉取今天完成的任务，按『项目』自定义字段聚合、与表中现有行匹配出要新建/更新的计划，但不写入。必须先调它、把计划讲给用户确认后，再调 write_feishu_table_sync。",
    parameters: {
      type: "object",
      properties: {
        project_field_id: {
          type: "string",
          description:
            "指定哪个自定义字段代表『项目』。首次若返回 needProjectField=true，问清用户后带上它重新预览。",
        },
      },
    },
    execute: async (a) => {
      // 直读 localStorage（跨窗口实时），不读窗口本地 store 内存态——对话悬浮窗的 store 可能是陈旧快照
      const f = readFeishuPrefs();
      if (!f.bitableEnabled)
        return JSON.stringify({ error: "飞书表格插件未开启。请到设置→飞书多维表格开启并粘贴表格链接。" });
      const region = f.activeRegion;
      const link = f.bitableLink;
      if (!region || !link)
        return JSON.stringify({ error: "尚未配置飞书表格链接。请到设置→飞书多维表格粘贴链接。" });

      const today = todayKey();
      const [todos, activities, fieldDefs] = await Promise.all([
        dbListTodosCompletedOn(today),
        dbListActivities(200, { startDate: today, endDate: today }),
        dbListFields(),
      ]);

      let info;
      try {
        info = await describeBitable(region, link);
      } catch (e) {
        return JSON.stringify({
          error: `读取飞书表失败：${String(e)}（若提示 access_token 失效，请到设置里重新连接飞书）。`,
        });
      }

      const overrideFieldId = str(a.project_field_id);
      const plan = buildSyncPlan({
        todos,
        fieldDefs,
        existingRows: info.records,
        tableFields: info.fields,
        projectFieldId: overrideFieldId ?? f.bitableProjectFieldId,
      });
      // 记住用户指定的项目字段（直写 localStorage，跨窗口生效）
      if (overrideFieldId) patchFeishuPrefsInStorage({ bitableProjectFieldId: overrideFieldId });

      return JSON.stringify({
        needProjectField: plan.needProjectField,
        availableCustomFields: fieldDefs.map((x) => ({ id: x.id, name: x.name })),
        projectFieldName: plan.projectFieldName,
        primaryFieldName: plan.primaryFieldName,
        tableFields: info.fields.map((x) => ({
          name: x.field_name,
          type: x.ui_type,
          isPrimary: x.is_primary,
        })),
        groups: plan.groups,
        unassigned: plan.unassigned,
        todayActivities: activities.map((x) => x.content),
        todayCompletedCount: todos.length,
        guidance:
          "若 needProjectField=true，先问用户用哪个自定义字段标项目（见 availableCustomFields），再带 project_field_id 重新预览。" +
          "unassigned 非空时问用户这些条目算哪个项目。把每个项目的 items 整理成『进展摘要』而非任务清单流水。" +
          "suspectNew=true 的项目要提示用户『疑似新项目，确认新建？』。最后把计划渲染成表格请用户确认，确认后才调 write_feishu_table_sync。",
      });
    },
  },
  {
    name: "write_feishu_table_sync",
    description:
      "把确认好的项目进展写入飞书表格。creates=新建的项目行，updates=更新已有行（带 record_id）。必须先 preview 且经用户确认后再调。fields 用『字段名→值』；更新时间这类日期字段填 YYYY-MM-DD 即可（会自动转换为飞书格式）。",
    parameters: {
      type: "object",
      properties: {
        creates: {
          type: "array",
          description: "新建的行，每项形如 { fields: { 字段名: 值 } }",
          items: { type: "object" },
        },
        updates: {
          type: "array",
          description: "更新的行，每项形如 { record_id: string, fields: { 字段名: 值 } }",
          items: { type: "object" },
        },
      },
    },
    execute: async (a) => {
      // 直读 localStorage（跨窗口实时）
      const f = readFeishuPrefs();
      const region = f.activeRegion;
      const link = f.bitableLink;
      if (!region || !link)
        return JSON.stringify({ error: "缺少表格配置，请先到设置→飞书多维表格配置并开启，再 preview。" });

      const creates = Array.isArray(a.creates)
        ? (a.creates as Array<{ fields?: Record<string, unknown> }>)
        : [];
      const updates = Array.isArray(a.updates)
        ? (a.updates as Array<{ record_id?: unknown; fields?: Record<string, unknown> }>)
        : [];
      if (creates.length === 0 && updates.length === 0)
        return JSON.stringify({ error: "creates 和 updates 都为空，没有要写入的内容。" });

      // describe 一次：拿 app_token/table_id（不依赖缓存，避免读到陈旧值）+ 字段类型（DateTime 转换）
      let info;
      try {
        info = await describeBitable(region, link);
      } catch (e) {
        return JSON.stringify({ error: `读取表结构失败：${String(e)}` });
      }
      const appToken = info.app_token;
      const tableId = info.table_id;
      const metaByName = new Map<string, BitableFieldMeta>(
        info.fields.map((x) => [x.field_name, x])
      );

      const createRows = creates.map((c) => coerceFields(c.fields ?? {}, metaByName));
      const updateRows: BitableRecordUpdate[] = updates
        .filter((u) => str(u.record_id))
        .map((u) => ({
          record_id: String(u.record_id),
          fields: coerceFields(u.fields ?? {}, metaByName),
        }));

      try {
        const createdIds = await createBitableRecords(region, appToken, tableId, createRows);
        await updateBitableRecords(region, appToken, tableId, updateRows);
        return JSON.stringify({ ok: true, created: createdIds.length, updated: updateRows.length });
      } catch (e) {
        return JSON.stringify({ error: `写入飞书表失败：${String(e)}` });
      }
    },
  },
];

/** name → tool 映射 */
const TOOL_MAP: Record<string, ChatTool> = Object.fromEntries(
  CHAT_TOOLS.map((t) => [t.name, t])
);

/** 执行一个工具调用，返回给模型的结果文本（出错也返回 JSON，不抛） */
export async function runChatTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = TOOL_MAP[name];
  if (!tool) return JSON.stringify({ error: `未知工具: ${name}` });
  try {
    return await tool.execute(args ?? {});
  } catch (e) {
    return JSON.stringify({ error: `工具 ${name} 执行失败: ${String(e)}` });
  }
}

/** 转成 OpenAI / DeepSeek 的 tools 参数格式 */
export function toolsForLLM() {
  return CHAT_TOOLS.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

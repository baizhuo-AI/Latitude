import {
  dbDeleteTodo,
  dbInsertGoal,
  dbInsertTodo,
  dbListGoals,
  dbListTodos
} from "./db";
import { useGoalsStore } from "./goalsStore";
import { useTodoStore, type Todo } from "./store";
import type { Goal } from "./goalsStore";

/**
 * 数据导入导出
 *
 * 当前覆盖范围:todos + goals(P3.4 范围)
 * 没覆盖:conversations / messages / reflections / llm_usage
 *   - chat 历史一般不需要导,数据敏感(系统 prompt 里有 todos),保留本地
 *   - reflections / usage 是衍生数据,丢了可以重新生成
 *
 * 格式:
 *   {
 *     "$schema": "latitude.v1",
 *     "exportedAt": "...ISO...",
 *     "todos": [...],
 *     "goals": [...]
 *   }
 *
 * 导入策略:**merge by id**(id 已存在的跳过,新 id 追加)。
 * 不覆盖现有 todo,避免误操作丢数据。要全量替换,先 "重置数据" 再导入。
 */

const SCHEMA_VERSION = "latitude.v1";

interface ExportPayload {
  $schema: string;
  exportedAt: string;
  todos: Todo[];
  goals: Goal[];
}

export async function exportAll(): Promise<string> {
  const [todos, goals] = await Promise.all([dbListTodos(), dbListGoals()]);
  const payload: ExportPayload = {
    $schema: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    todos,
    goals
  };
  return JSON.stringify(payload, null, 2);
}

/** 触发浏览器下载 */
export async function downloadExport(): Promise<{
  filename: string;
  size: number;
}> {
  const json = await exportAll();
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const filename = `latitude-${new Date().toISOString().slice(0, 10)}.json`;
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { filename, size: blob.size };
}

export interface ImportSummary {
  todosImported: number;
  todosSkipped: number;
  goalsImported: number;
  goalsSkipped: number;
}

/** 从 JSON 字符串导入,merge by id */
export async function importFromJson(json: string): Promise<ImportSummary> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("文件不是合法的 JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("JSON 根节点必须是对象");
  }
  const p = parsed as Partial<ExportPayload>;
  if (p.$schema !== SCHEMA_VERSION) {
    console.warn(
      `[dataIO] schema mismatch: expect ${SCHEMA_VERSION}, got ${String(p.$schema)}`
    );
  }

  const existingTodos = await dbListTodos();
  const existingTodoIds = new Set(existingTodos.map((t) => t.id));
  const existingGoals = await dbListGoals();
  const existingGoalIds = new Set(existingGoals.map((g) => g.id));

  const incomingTodos: Todo[] = Array.isArray(p.todos) ? p.todos : [];
  const incomingGoals: Goal[] = Array.isArray(p.goals) ? p.goals : [];

  let todosImported = 0;
  let todosSkipped = 0;
  for (const t of incomingTodos) {
    if (!t.id || existingTodoIds.has(t.id)) {
      todosSkipped++;
      continue;
    }
    await dbInsertTodo(t);
    todosImported++;
  }

  let goalsImported = 0;
  let goalsSkipped = 0;
  for (const g of incomingGoals) {
    if (!g.id || existingGoalIds.has(g.id)) {
      goalsSkipped++;
      continue;
    }
    await dbInsertGoal(g);
    goalsImported++;
  }

  // 刷新 store
  await useTodoStore.getState().hydrate();
  await useGoalsStore.getState().hydrate();

  return { todosImported, todosSkipped, goalsImported, goalsSkipped };
}

/** 清空所有 todos(危险操作,Settings 里用) */
export async function deleteAllTodos(): Promise<number> {
  const all = await dbListTodos();
  for (const t of all) {
    await dbDeleteTodo(t.id);
  }
  await useTodoStore.getState().hydrate();
  return all.length;
}

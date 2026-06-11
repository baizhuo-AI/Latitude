import { create } from "zustand";
import {
  dbDeleteTodo,
  dbInsertTodo,
  dbListTodos,
  dbSeedIfEmpty,
  dbUpdateTodo,
  dbUpdateTodoStatus,
  dbUpdateTodoSchedule
} from "./db";
import { emitSync } from "./syncBus";

/** 今天的 YYYY-MM-DD(本地时区)。store 自带,避免依赖 calendar.ts(防循环引用)。 */
function dateKeyToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 数据模型 + zustand store
 *
 * P1 mock 数据现在作为**种子**写入 SQLite(只在数据库为空时塞一次),不再是内存假数据。
 * 主 App 和 P3 浮窗共享同一个 SQLite 库,通过 hydrate 同步。
 *
 * 字段语义:
 * - reason:AI 给出的"为什么今天/这个时段做"理由,Briefing 页核心
 * - scheduledTime:AI 排好的执行时段(如 "09:30-11:00")
 * - estTime:预估耗时(如 "1.5h")
 * - isProcrastinated:已拖延,Briefing 单独区块展示
 * - isPushBackSuggestion:AI 建议本周不做,Briefing 灰色弱化展示
 */

export type TodoStatus = "todo" | "doing" | "done" | "dropped";
export type Priority = "high" | "medium" | "low" | "none";

export interface Todo {
  id: string;
  title: string;
  reason?: string;
  deadline?: string;
  priority: Priority;
  tags: string[];
  estTime?: string;
  status: TodoStatus;
  /** 时段:"09:30-11:00",决定周视图卡片位置 */
  scheduledTime?: string;
  /** 任务归属日期:"YYYY-MM-DD",决定月/周视图日列。
   *  缺省时 fallback 到 createdAt 的日期(老数据兜底)。 */
  scheduledDate?: string;
  createdAt: string;
  isPushBackSuggestion?: boolean;
  isProcrastinated?: boolean;
}

/**
 * 种子数据:首次启动时塞进 SQLite(让用户立刻有内容可看),后续从 db 读。
 * 这些"任务标题/理由"的中文是用户产生内容,不走 i18n。
 */
export const SEED_TODOS: Todo[] = [
  {
    id: "t1",
    title: "给客户 A 准备 Q3 营销方案初稿",
    reason: "周五下午前需要发出版本,今天先成稿留出修改窗口。",
    deadline: "周五下午",
    priority: "high",
    tags: ["客户 A", "方案"],
    estTime: "1.5h",
    status: "todo",
    scheduledTime: "09:30-11:00",
    scheduledDate: dateKeyToday(),
    createdAt: new Date().toISOString()
  },
  {
    id: "t2",
    title: "参加产品周会(主讲)",
    reason: "你是主讲,提前 10 分钟到会议室确认投屏。",
    deadline: "今天 14:00",
    priority: "high",
    tags: ["会议"],
    estTime: "1h",
    status: "todo",
    scheduledTime: "14:00-15:00",
    scheduledDate: dateKeyToday(),
    createdAt: new Date().toISOString()
  },
  {
    id: "t3",
    title: "阅读新架构设计文档",
    reason: "11:00-11:45 是你和会议之间的最长空档,适合啃长文档。",
    deadline: "下周一",
    priority: "medium",
    tags: ["阅读"],
    estTime: "45m",
    status: "todo",
    scheduledTime: "11:00-11:45",
    scheduledDate: dateKeyToday(),
    createdAt: new Date().toISOString()
  },
  {
    id: "t4",
    title: "报销上月差旅费",
    reason: "已经拖了 3 天,今天财务截止走单。",
    deadline: "今天 18:00",
    priority: "low",
    tags: ["行政"],
    estTime: "15m",
    status: "todo",
    scheduledTime: "17:30-17:45",
    isProcrastinated: true,
    scheduledDate: dateKeyToday(), // 拖延任务今天仍要被看见
    createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString()
  },
  {
    id: "t5",
    title: "审核实习生提交的代码",
    reason: "非阻断性需求,今天日程已满,可以推到明天。",
    priority: "low",
    tags: ["代码 Review"],
    estTime: "30m",
    status: "todo",
    isPushBackSuggestion: true,
    scheduledDate: dateKeyToday(),
    createdAt: new Date().toISOString()
  }
];

/* ---------- store ---------- */

/** AI 排今日 / 后续拖拽改时段 用的批量更新 */
export interface ScheduleUpdate {
  id: string;
  scheduledTime?: string;
  scheduledDate?: string;
}

interface TodoStore {
  todos: Todo[];
  /** 是否已从 SQLite 加载完毕 */
  loaded: boolean;
  /** 启动时调:种子(if empty)+ 读全表 */
  hydrate: () => Promise<void>;
  /** 增 */
  addTodo: (todo: Todo) => Promise<void>;
  /** 切换完成态 */
  toggleComplete: (id: string) => Promise<void>;
  /** 删 */
  removeTodo: (id: string) => Promise<void>;
  /** 编辑（全字段覆盖；id / createdAt 保持不变） */
  updateTodo: (todo: Todo) => Promise<void>;
  /** 批量更新 schedule(AI 排今日、拖拽改时段) */
  applySchedules: (updates: ScheduleUpdate[]) => Promise<void>;
}

export const useTodoStore = create<TodoStore>((set, get) => ({
  todos: [],
  loaded: false,

  hydrate: async () => {
    try {
      // 注意：不再调用 dbSeedIfEmpty。
      // 之前每次 hydrate 都跑 seed-if-empty，导致"用户删光所有任务后，
      // emitSync 触发 hydrate 看到表空就把 SEED 又塞回来"的 bug。
      // 现在删了就是删了，空就是空。SEED_TODOS 保留供未来的"重置示例"按钮复用。
      const todos = await dbListTodos();
      set({ todos, loaded: true });
    } catch (err) {
      console.error("[store] hydrate failed:", err);
      // 兜底：db 出错时显示空，而不是强塞 SEED（避免上面那个回填 bug）
      set({ todos: [], loaded: true });
    }
  },

  addTodo: async (todo) => {
    await dbInsertTodo(todo);
    set((state) => ({ todos: [todo, ...state.todos] }));
    emitSync("todos");
  },

  toggleComplete: async (id) => {
    const current = get().todos.find((t) => t.id === id);
    if (!current) return;
    const next: TodoStatus = current.status === "done" ? "todo" : "done";
    await dbUpdateTodoStatus(id, next);
    set((state) => ({
      todos: state.todos.map((t) => (t.id === id ? { ...t, status: next } : t))
    }));
    emitSync("todos");
  },

  removeTodo: async (id) => {
    await dbDeleteTodo(id);
    set((state) => ({ todos: state.todos.filter((t) => t.id !== id) }));
    emitSync("todos");
  },

  updateTodo: async (todo) => {
    await dbUpdateTodo(todo);
    set((state) => ({
      todos: state.todos.map((t) => (t.id === todo.id ? todo : t))
    }));
    emitSync("todos");
  },

  applySchedules: async (updates) => {
    const todos = get().todos;
    // 先落 db
    await Promise.all(
      updates.map((u) => {
        const cur = todos.find((t) => t.id === u.id);
        return dbUpdateTodoSchedule(
          u.id,
          u.scheduledDate ?? cur?.scheduledDate ?? null,
          u.scheduledTime ?? cur?.scheduledTime ?? null
        );
      })
    );
    // 再 update state
    set((state) => ({
      todos: state.todos.map((todo) => {
        const u = updates.find((x) => x.id === todo.id);
        if (!u) return todo;
        return {
          ...todo,
          scheduledTime: u.scheduledTime ?? todo.scheduledTime,
          scheduledDate: u.scheduledDate ?? todo.scheduledDate
        };
      })
    }));
    emitSync("todos");
  }
}));

/**
 * 工具:生成新 todo 的 id(简化版,UUID 太长了对人不友好)
 * 用 timestamp + 短随机后缀,够用。
 */
export function newTodoId(): string {
  return `t${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

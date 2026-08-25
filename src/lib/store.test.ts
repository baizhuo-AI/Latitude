import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
  dbDeleteTodo: vi.fn(async () => undefined),
  dbInsertTodo: vi.fn(async () => undefined),
  dbListTodos: vi.fn(async () => []),
  dbSeedIfEmpty: vi.fn(async () => undefined),
  dbUpdateTodo: vi.fn(async () => undefined),
  dbUpdateTodoStatus: vi.fn(async () => undefined),
  dbUpdateTodoSchedule: vi.fn(async () => undefined),
  getDb: vi.fn()
}));

vi.mock("./syncBus", () => ({ emitSync: vi.fn() }));

import { dbUpdateTodo, dbUpdateTodoStatus, getDb } from "./db";
import { emitSync } from "./syncBus";
import { useTodoStore, type Todo } from "./store";

const execute = vi.fn(async () => ({ rowsAffected: 1 }));

function todo(overrides: Partial<Todo> = {}): Todo {
  return {
    id: "todo-1",
    title: "原标题",
    reason: "保留原因",
    deadline: "周五",
    priority: "high",
    tags: ["客户 A"],
    status: "doing",
    scheduledDate: "2026-08-24",
    scheduledTime: "10:00-11:00",
    createdAt: "2026-08-20T08:00:00.000Z",
    customFields: { owner: "我" },
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-24T12:34:56.789Z"));
  vi.mocked(getDb).mockResolvedValue({ execute } as never);
  useTodoStore.setState({ todos: [todo()], loaded: true, error: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useTodoStore 窄写回", () => {
  it("completeTodo 幂等完成并立即同步 completedAt", async () => {
    await useTodoStore.getState().completeTodo("todo-1");

    const completed = useTodoStore.getState().todos[0];
    expect(dbUpdateTodoStatus).toHaveBeenCalledWith("todo-1", "done");
    expect(completed).toMatchObject({
      status: "done",
      completedAt: "2026-08-24T12:34:56.789Z",
      reason: "保留原因",
      tags: ["客户 A"]
    });
    expect(emitSync).toHaveBeenCalledWith("todos");

    await useTodoStore.getState().completeTodo("todo-1");
    expect(dbUpdateTodoStatus).toHaveBeenCalledTimes(1);
    expect(emitSync).toHaveBeenCalledTimes(1);
  });

  it("completeTodo 和 renameTodo 在 id 不存在时抛错且不写入", async () => {
    useTodoStore.setState({ todos: [] });

    await expect(
      useTodoStore.getState().completeTodo("missing")
    ).rejects.toThrow("Todo not found: missing");
    await expect(
      useTodoStore.getState().renameTodo("missing", "新标题")
    ).rejects.toThrow("Todo not found: missing");

    expect(dbUpdateTodoStatus).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
    expect(emitSync).not.toHaveBeenCalled();
  });

  it("renameTodo 只更新标题，不覆盖 Todo 的其它字段", async () => {
    await useTodoStore.getState().renameTodo("todo-1", "  新标题  ");

    const renamed = useTodoStore.getState().todos[0];
    expect(execute).toHaveBeenCalledWith(
      "UPDATE todos SET title = $1, updated_at = $2 WHERE id = $3",
      ["新标题", "2026-08-24T12:34:56.789Z", "todo-1"]
    );
    expect(dbUpdateTodo).not.toHaveBeenCalled();
    expect(renamed).toEqual({ ...todo(), title: "新标题" });
    expect(emitSync).toHaveBeenCalledWith("todos");
  });
});

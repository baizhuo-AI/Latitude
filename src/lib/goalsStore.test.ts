import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
  dbDeleteGoal: vi.fn(),
  dbInsertGoal: vi.fn(),
  dbListGoals: vi.fn(),
  dbUpdateGoalStatus: vi.fn()
}));

vi.mock("./syncBus", () => ({ emitSync: vi.fn() }));

import {
  dbDeleteGoal,
  dbInsertGoal,
  dbListGoals,
  dbUpdateGoalStatus,
  type Goal
} from "./db";
import { useGoalsStore } from "./goalsStore";
import { emitSync } from "./syncBus";

const goal: Goal = {
  id: "goal-1",
  title: "跑通真实闭环",
  period: "year",
  status: "active",
  createdAt: "2026-08-24T08:00:00.000Z"
};

beforeEach(() => {
  vi.clearAllMocks();
  useGoalsStore.setState({ goals: [], loaded: false, error: null });
});

describe("goalsStore", () => {
  it("hydrate 成功与失败可区分，不把断库伪装成正常空数据", async () => {
    vi.mocked(dbListGoals).mockResolvedValueOnce([goal]);
    await useGoalsStore.getState().hydrate();
    expect(useGoalsStore.getState()).toMatchObject({
      goals: [goal],
      loaded: true,
      error: null
    });

    vi.mocked(dbListGoals).mockRejectedValueOnce(new Error("db unavailable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await useGoalsStore.getState().hydrate();
    expect(useGoalsStore.getState()).toMatchObject({
      goals: [],
      loaded: true
    });
    expect(useGoalsStore.getState().error).toContain("db unavailable");
    errorSpy.mockRestore();
  });

  it("新增、改状态和删除都广播 goals 同步", async () => {
    vi.mocked(dbInsertGoal).mockResolvedValue(undefined);
    vi.mocked(dbUpdateGoalStatus).mockResolvedValue(undefined);
    vi.mocked(dbDeleteGoal).mockResolvedValue(undefined);

    await useGoalsStore.getState().addGoal(goal);
    await useGoalsStore.getState().setStatus(goal.id, "achieved");
    expect(useGoalsStore.getState().goals[0].status).toBe("achieved");
    await useGoalsStore.getState().removeGoal(goal.id);

    expect(useGoalsStore.getState().goals).toHaveLength(0);
    expect(emitSync).toHaveBeenCalledTimes(3);
    expect(vi.mocked(emitSync).mock.calls).toEqual([
      ["goals"],
      ["goals"],
      ["goals"]
    ]);
  });
});

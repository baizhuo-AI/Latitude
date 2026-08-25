import { create } from "zustand";
import {
  dbDeleteGoal,
  dbInsertGoal,
  dbListGoals,
  dbUpdateGoalStatus,
  type Goal,
  type GoalStatus
} from "./db";
import { emitSync } from "./syncBus";

export type { Goal, GoalPeriod, GoalStatus } from "./db";

/** 生成 goal id */
export function newGoalId(): string {
  return `g${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

interface GoalsStore {
  goals: Goal[];
  loaded: boolean;
  /** hydrate 失败时的错误；成功或尚未加载时为 null。 */
  error: string | null;
  hydrate: () => Promise<void>;
  addGoal: (goal: Goal) => Promise<void>;
  setStatus: (id: string, status: GoalStatus) => Promise<void>;
  removeGoal: (id: string) => Promise<void>;
}

export const useGoalsStore = create<GoalsStore>((set) => ({
  goals: [],
  loaded: false,
  error: null,

  hydrate: async () => {
    try {
      const goals = await dbListGoals();
      set({ goals, loaded: true, error: null });
    } catch (err) {
      console.error("[goalsStore] hydrate failed:", err);
      set({ goals: [], loaded: true, error: String(err) });
    }
  },

  addGoal: async (goal) => {
    await dbInsertGoal(goal);
    set((state) => ({ goals: [goal, ...state.goals] }));
    emitSync("goals");
  },

  setStatus: async (id, status) => {
    await dbUpdateGoalStatus(id, status);
    set((state) => ({
      goals: state.goals.map((g) =>
        g.id === id ? { ...g, status } : g
      )
    }));
    emitSync("goals");
  },

  removeGoal: async (id) => {
    await dbDeleteGoal(id);
    set((state) => ({ goals: state.goals.filter((g) => g.id !== id) }));
    emitSync("goals");
  }
}));

/**
 * chatToolsMemory.test.ts — Task 2.1 记忆工具(remember / update_memory / forget)
 *
 * 验收覆盖:
 *  1. remember:把一条事实写入(category/content/source/durability/pinned 正确落库),返回新 id
 *  2. remember:缺 content / 非法 category 时返回 error JSON(不抛、不写库)
 *  3. remember:durability='transient' 但没给 expires_at 时按默认 TTL 兜一个有效期
 *  4. update_memory:按 id 改字段(只改传入的),返回 updated;id 不存在返回 error
 *  5. forget:按 id 删除,返回 deleted;id 不存在返回 error
 *  6. 三个写操作后都 emitSync("memory") 通知其它窗口刷新
 *  7. runChatTool 包裹:db 抛错时返回 error JSON 而非崩溃
 *
 * 范式照 proactiveLog.test.ts:用内存 db mock 拦 ../db,断言工具调用形状与落库结果。
 * 重依赖(store / feishuBitable 等)全部 mock 成空壳,只为能 import chatTools。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── 内存 memory_facts 表 ─────────────────────────────────────────────────────
interface MemRow {
  id: string;
  category: string;
  content: string;
  source: string;
  durability: string;
  pinned: boolean;
  createdAt: string;
  expiresAt?: string;
}
const _facts = new Map<string, MemRow>();
let _idSeq = 0;

// ─── mock ../db ───────────────────────────────────────────────────────────────
vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dbInsertMemoryFact: vi.fn(async (input: Omit<MemRow, "id" | "createdAt">) => {
      const id = `mf_${++_idSeq}`;
      _facts.set(id, {
        id,
        createdAt: new Date().toISOString(),
        ...input,
      });
      return id;
    }),
    dbUpdateMemoryFact: vi.fn(async (id: string, patch: Partial<MemRow>) => {
      const cur = _facts.get(id);
      if (!cur) throw new Error("not found");
      _facts.set(id, { ...cur, ...patch });
    }),
    dbDeleteMemoryFact: vi.fn(async (id: string) => {
      if (!_facts.has(id)) throw new Error("not found");
      _facts.delete(id);
    }),
    dbListMemoryFacts: vi.fn(async () => Array.from(_facts.values())),
    // chatTools 顶部还 import 了这些,给空实现避免 import 期/执行期报错
    dbListTodos: vi.fn(async () => []),
    dbListTodosCompletedOn: vi.fn(async () => []),
    dbListFields: vi.fn(async () => []),
    dbUpdateTodoStatus: vi.fn(async () => undefined),
    dbUpdateTodoSchedule: vi.fn(async () => undefined),
    dbListActivities: vi.fn(async () => []),
    dbListCalendarEvents: vi.fn(async () => []),
  };
});

// ─── mock syncBus ─────────────────────────────────────────────────────────────
vi.mock("./syncBus", () => ({ emitSync: vi.fn() }));

// ─── mock 其余重依赖(只为能 import chatTools) ───────────────────────────────
vi.mock("./store", () => ({
  useTodoStore: { getState: () => ({ hydrate: async () => undefined, addTodo: async () => undefined, updateTodo: async () => undefined }) },
  newTodoId: () => "todo_x",
}));
vi.mock("./goalsStore", () => ({
  useGoalsStore: { getState: () => ({ goals: [], hydrate: async () => undefined, addGoal: async () => undefined, setStatus: async () => undefined }) },
  newGoalId: () => "goal_x",
}));
vi.mock("./activityStore", () => ({
  useActivityStore: { getState: () => ({ addActivity: async () => undefined }) },
}));
vi.mock("./settings", () => ({
  readFeishuPrefs: () => ({ bitableEnabled: false }),
  patchFeishuPrefsInStorage: () => undefined,
}));
vi.mock("./bitableSync", () => ({ buildSyncPlan: () => ({}) }));
vi.mock("./feishuBitable", () => ({
  describeBitable: async () => ({}),
  createBitableRecords: async () => [],
  updateBitableRecords: async () => undefined,
}));

// ─── import 被测(所有 mock 之后) ───────────────────────────────────────────
import { runChatTool, CHAT_TOOLS } from "./chatTools";
import { emitSync } from "./syncBus";
import {
  dbInsertMemoryFact,
  dbUpdateMemoryFact,
  dbDeleteMemoryFact,
} from "./db";

beforeEach(() => {
  _facts.clear();
  _idSeq = 0;
  vi.clearAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
// 工具注册:三个记忆工具都在 CHAT_TOOLS 里
// ════════════════════════════════════════════════════════════════════════════
describe("记忆工具已注册", () => {
  it("remember / update_memory / forget 都在 CHAT_TOOLS", () => {
    const names = CHAT_TOOLS.map((t) => t.name);
    expect(names).toContain("remember");
    expect(names).toContain("update_memory");
    expect(names).toContain("forget");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// remember
// ════════════════════════════════════════════════════════════════════════════
describe("remember — 写入一条事实", () => {
  it("正常写入:落库字段正确,返回新 id", async () => {
    const res = JSON.parse(
      await runChatTool("remember", {
        category: "preference",
        content: "喜欢用深色模式",
        source: "told",
        durability: "durable",
      })
    );
    expect(res.error).toBeUndefined();
    expect(res.id).toBeTruthy();
    expect(vi.mocked(dbInsertMemoryFact)).toHaveBeenCalledTimes(1);
    const saved = Array.from(_facts.values())[0];
    expect(saved.category).toBe("preference");
    expect(saved.content).toBe("喜欢用深色模式");
    expect(saved.source).toBe("told");
    expect(saved.durability).toBe("durable");
    expect(saved.pinned).toBe(false);
  });

  it("缺 content → error,不写库", async () => {
    const res = JSON.parse(await runChatTool("remember", { category: "preference" }));
    expect(res.error).toBeTruthy();
    expect(vi.mocked(dbInsertMemoryFact)).not.toHaveBeenCalled();
  });

  it("非法 category → error,不写库", async () => {
    const res = JSON.parse(
      await runChatTool("remember", { category: "garbage", content: "x" })
    );
    expect(res.error).toBeTruthy();
    expect(vi.mocked(dbInsertMemoryFact)).not.toHaveBeenCalled();
  });

  it("source / durability 缺省时给安全默认(inferred / durable)", async () => {
    await runChatTool("remember", { category: "habit", content: "每天晨跑" });
    const saved = Array.from(_facts.values())[0];
    expect(saved.source).toBe("inferred");
    expect(saved.durability).toBe("durable");
  });

  it("durability=transient 但未给 expires_at → 自动兜一个未来有效期", async () => {
    await runChatTool("remember", {
      category: "ongoing",
      content: "这周在赶 demo",
      durability: "transient",
    });
    const saved = Array.from(_facts.values())[0];
    expect(saved.expiresAt).toBeTruthy();
    expect(Date.parse(saved.expiresAt!)).toBeGreaterThan(Date.now());
  });

  it("写入后 emitSync('memory') 被调用(通知其它窗口刷新)", async () => {
    await runChatTool("remember", { category: "identity", content: "是产品经理" });
    expect(vi.mocked(emitSync)).toHaveBeenCalledWith("memory");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// update_memory
// ════════════════════════════════════════════════════════════════════════════
describe("update_memory — 改一条事实", () => {
  async function seed(): Promise<string> {
    const res = JSON.parse(
      await runChatTool("remember", {
        category: "preference",
        content: "原内容",
        source: "told",
        durability: "durable",
      })
    );
    vi.clearAllMocks();
    return res.id;
  }

  it("按 id 改 content,只改传入字段", async () => {
    const id = await seed();
    const res = JSON.parse(
      await runChatTool("update_memory", { id, content: "新内容" })
    );
    expect(res.updated).toBe(true);
    expect(vi.mocked(dbUpdateMemoryFact)).toHaveBeenCalledTimes(1);
    expect(_facts.get(id)!.content).toBe("新内容");
    expect(_facts.get(id)!.category).toBe("preference"); // 没动的字段保留
  });

  it("改 pinned/category 等枚举字段", async () => {
    const id = await seed();
    await runChatTool("update_memory", { id, pinned: true, category: "habit" });
    expect(_facts.get(id)!.pinned).toBe(true);
    expect(_facts.get(id)!.category).toBe("habit");
  });

  it("非法 category → error,不写库", async () => {
    const id = await seed();
    const res = JSON.parse(
      await runChatTool("update_memory", { id, category: "garbage" })
    );
    expect(res.error).toBeTruthy();
    expect(vi.mocked(dbUpdateMemoryFact)).not.toHaveBeenCalled();
  });

  it("缺 id → error", async () => {
    const res = JSON.parse(await runChatTool("update_memory", { content: "x" }));
    expect(res.error).toBeTruthy();
    expect(vi.mocked(dbUpdateMemoryFact)).not.toHaveBeenCalled();
  });

  it("id 不存在(db 抛错)→ error JSON,不崩", async () => {
    const res = JSON.parse(
      await runChatTool("update_memory", { id: "mf_nope", content: "x" })
    );
    expect(res.error).toBeTruthy();
  });

  it("成功后 emitSync('memory')", async () => {
    const id = await seed();
    await runChatTool("update_memory", { id, content: "y" });
    expect(vi.mocked(emitSync)).toHaveBeenCalledWith("memory");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// forget
// ════════════════════════════════════════════════════════════════════════════
describe("forget — 删一条事实", () => {
  async function seed(): Promise<string> {
    const res = JSON.parse(
      await runChatTool("remember", { category: "people", content: "同事小王" })
    );
    vi.clearAllMocks();
    return res.id;
  }

  it("按 id 删除,返回 deleted", async () => {
    const id = await seed();
    const res = JSON.parse(await runChatTool("forget", { id }));
    expect(res.deleted).toBe(true);
    expect(vi.mocked(dbDeleteMemoryFact)).toHaveBeenCalledWith(id);
    expect(_facts.has(id)).toBe(false);
  });

  it("缺 id → error", async () => {
    const res = JSON.parse(await runChatTool("forget", {}));
    expect(res.error).toBeTruthy();
    expect(vi.mocked(dbDeleteMemoryFact)).not.toHaveBeenCalled();
  });

  it("id 不存在(db 抛错)→ error JSON,不崩", async () => {
    const res = JSON.parse(await runChatTool("forget", { id: "mf_nope" }));
    expect(res.error).toBeTruthy();
  });

  it("成功后 emitSync('memory')", async () => {
    const id = await seed();
    await runChatTool("forget", { id });
    expect(vi.mocked(emitSync)).toHaveBeenCalledWith("memory");
  });
});

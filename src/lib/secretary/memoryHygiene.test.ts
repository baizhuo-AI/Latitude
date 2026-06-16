/**
 * memoryHygiene.test.ts — Task 2.4 记忆卫生
 *
 * 验收覆盖:
 *
 * A. resolveConflict 纯函数(规则层,确定性)
 *    1. 新的 created_at 更晚 → 取新值
 *    2. 旧的 created_at 更晚 → 取旧值(不被新值覆盖)
 *    3. created_at 相同 → 标 conflict
 *    4. created_at 完全非 ISO 脏值 → 标 conflict(保守)
 *    5. 返回形状:{ decision, winner, loser } — winner 是留下的那条
 *
 * B. runMemoryDedup 日终去重归并(语义层)
 *    1. 大脑返回"无需归并"→ 不写库
 *    2. 大脑返回"合并两条"→ 调 dbUpdateMemoryFact + dbDeleteMemoryFact,emitSync('memory')
 *    3. 大脑返回"仅删除重复"→ 只调 dbDeleteMemoryFact,emitSync('memory')
 *    4. 无事实时跳过(不调 generateOnce,不写库)
 *    5. 大脑返回格式非法 JSON → 降级静默(不崩,不写库)
 *    6. generateOnce 抛错 → 降级静默(不崩)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── 内存 memory_facts 表 ────────────────────────────────────────────────────
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

// ─── mock ../db ───────────────────────────────────────────────────────────────
vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dbListMemoryFacts: vi.fn(async () => Array.from(_facts.values()).map((r) => ({
      id: r.id,
      category: r.category,
      content: r.content,
      source: r.source,
      durability: r.durability,
      pinned: r.pinned,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
    }))),
    dbUpdateMemoryFact: vi.fn(async (id: string, patch: Partial<MemRow>) => {
      const cur = _facts.get(id);
      if (!cur) throw new Error("not found");
      _facts.set(id, { ...cur, ...patch });
    }),
    dbDeleteMemoryFact: vi.fn(async (id: string) => {
      if (!_facts.has(id)) throw new Error("not found");
      _facts.delete(id);
    }),
  };
});

// ─── mock generateOnce (via llm/index) ──────────────────────────────────────
// 每个用例通过 setGenerateOnceResult() 控制返回值
let _generateOnceResult: string = JSON.stringify({ actions: [] });
let _generateOnceThrow: boolean = false;

vi.mock("../llm/index", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    generateOnce: vi.fn(async () => {
      if (_generateOnceThrow) throw new Error("LLM error");
      return _generateOnceResult;
    }),
  };
});

// ─── mock syncBus ─────────────────────────────────────────────────────────────
vi.mock("../syncBus", () => ({ emitSync: vi.fn() }));

// ─── 被测模块(所有 mock 之后 import) ─────────────────────────────────────────
import { resolveConflict } from "./memoryHygiene";
import { runMemoryDedup } from "./memoryHygiene";
import { generateOnce } from "../llm/index";
import {
  dbUpdateMemoryFact,
  dbDeleteMemoryFact,
  dbListMemoryFacts,
} from "../db";
import { emitSync } from "../syncBus";
import type { MemoryFact } from "../db";

// ─── 辅助:创建测试用 MemoryFact ──────────────────────────────────────────────
function makeFact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: "mf_test",
    category: "preference",
    content: "喜欢深色模式",
    source: "told",
    durability: "durable",
    pinned: false,
    createdAt: "2026-06-01T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  _facts.clear();
  _generateOnceResult = JSON.stringify({ actions: [] });
  _generateOnceThrow = false;
  vi.clearAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
// A. resolveConflict 纯函数
// ════════════════════════════════════════════════════════════════════════════

describe("resolveConflict — 规则层(纯函数)", () => {
  it("newFact.createdAt 更晚 → decision='use_new',winner 是 newFact", () => {
    const oldFact = makeFact({
      id: "mf_old",
      content: "旧值",
      createdAt: "2026-06-01T08:00:00.000Z",
    });
    const newFact = makeFact({
      id: "mf_new",
      content: "新值",
      createdAt: "2026-06-10T08:00:00.000Z",
    });

    const result = resolveConflict(oldFact, newFact);

    expect(result.decision).toBe("use_new");
    expect(result.winner.id).toBe("mf_new");
    expect(result.loser.id).toBe("mf_old");
  });

  it("oldFact.createdAt 更晚 → decision='use_old',winner 是 oldFact", () => {
    const oldFact = makeFact({
      id: "mf_old",
      content: "旧值(时间更晚)",
      createdAt: "2026-06-10T08:00:00.000Z",
    });
    const newFact = makeFact({
      id: "mf_new",
      content: "新值(时间更早)",
      createdAt: "2026-06-01T08:00:00.000Z",
    });

    const result = resolveConflict(oldFact, newFact);

    expect(result.decision).toBe("use_old");
    expect(result.winner.id).toBe("mf_old");
    expect(result.loser.id).toBe("mf_new");
  });

  it("created_at 完全相同 → decision='conflict'", () => {
    const ts = "2026-06-05T12:00:00.000Z";
    const a = makeFact({ id: "mf_a", content: "A", createdAt: ts });
    const b = makeFact({ id: "mf_b", content: "B", createdAt: ts });

    const result = resolveConflict(a, b);

    expect(result.decision).toBe("conflict");
    // conflict 时两边都保留在结构里
    expect([result.winner.id, result.loser.id]).toContain("mf_a");
    expect([result.winner.id, result.loser.id]).toContain("mf_b");
  });

  it("oldFact.createdAt 是脏值(无法解析)→ decision='conflict'(保守,不误删)", () => {
    const oldFact = makeFact({ id: "mf_dirty", content: "脏", createdAt: "not-a-date" });
    const newFact = makeFact({ id: "mf_clean", content: "干净", createdAt: "2026-06-10T00:00:00.000Z" });

    const result = resolveConflict(oldFact, newFact);

    expect(result.decision).toBe("conflict");
  });

  it("newFact.createdAt 是脏值(无法解析)→ decision='conflict'(保守,不误删)", () => {
    const oldFact = makeFact({ id: "mf_clean", content: "干净", createdAt: "2026-06-01T00:00:00.000Z" });
    const newFact = makeFact({ id: "mf_dirty", content: "脏", createdAt: "not-a-date" });

    const result = resolveConflict(oldFact, newFact);

    expect(result.decision).toBe("conflict");
  });

  it("两边 createdAt 都是脏值 → decision='conflict'", () => {
    const a = makeFact({ id: "mf_a", createdAt: "bad" });
    const b = makeFact({ id: "mf_b", createdAt: "also-bad" });

    const result = resolveConflict(a, b);

    expect(result.decision).toBe("conflict");
  });

  it("是纯函数:同入参多次调用返回相同 decision", () => {
    const old = makeFact({ id: "o", createdAt: "2026-06-01T00:00:00.000Z" });
    const nw = makeFact({ id: "n", createdAt: "2026-06-10T00:00:00.000Z" });

    const r1 = resolveConflict(old, nw);
    const r2 = resolveConflict(old, nw);

    expect(r1.decision).toBe(r2.decision);
    expect(r1.winner.id).toBe(r2.winner.id);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B. runMemoryDedup 日终去重归并
// ════════════════════════════════════════════════════════════════════════════

describe("runMemoryDedup — 日终去重归并(语义层,假引擎测结构)", () => {
  /** 向内存 _facts 预置事实 */
  function seed(...rows: MemoryFact[]) {
    for (const f of rows) {
      _facts.set(f.id, {
        id: f.id,
        category: f.category,
        content: f.content,
        source: f.source,
        durability: f.durability,
        pinned: f.pinned,
        createdAt: f.createdAt,
        expiresAt: f.expiresAt,
      });
    }
  }

  it("无事实时:跳过 generateOnce,不写库", async () => {
    // _facts 为空,dbListMemoryFacts 返回 []
    await runMemoryDedup();

    expect(vi.mocked(generateOnce)).not.toHaveBeenCalled();
    expect(vi.mocked(dbUpdateMemoryFact)).not.toHaveBeenCalled();
    expect(vi.mocked(dbDeleteMemoryFact)).not.toHaveBeenCalled();
    expect(vi.mocked(emitSync)).not.toHaveBeenCalled();
  });

  it("大脑返回 actions=[] (无需归并)→ 不写库,不 emitSync", async () => {
    seed(
      makeFact({ id: "mf_1", content: "喜欢深色模式" }),
      makeFact({ id: "mf_2", content: "工作地点在北京" }),
    );
    _generateOnceResult = JSON.stringify({ actions: [] });

    await runMemoryDedup();

    expect(vi.mocked(generateOnce)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dbUpdateMemoryFact)).not.toHaveBeenCalled();
    expect(vi.mocked(dbDeleteMemoryFact)).not.toHaveBeenCalled();
    expect(vi.mocked(emitSync)).not.toHaveBeenCalled();
  });

  it("大脑返回合并动作:update(keepId, mergedContent) + delete(dropId) → 落库 + emitSync", async () => {
    const keepId = "mf_keep";
    const dropId = "mf_drop";
    seed(
      makeFact({ id: keepId, category: "habit", content: "早上7点起床", createdAt: "2026-06-10T00:00:00.000Z" }),
      makeFact({ id: dropId, category: "habit", content: "习惯早起,7点左右", createdAt: "2026-06-01T00:00:00.000Z" }),
    );

    _generateOnceResult = JSON.stringify({
      actions: [
        { type: "merge", keepId, dropId, mergedContent: "每天7点起床(早起习惯)" },
      ],
    });

    await runMemoryDedup();

    // update 被调:更新 keepId 的 content
    expect(vi.mocked(dbUpdateMemoryFact)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dbUpdateMemoryFact)).toHaveBeenCalledWith(
      keepId,
      expect.objectContaining({ content: "每天7点起床(早起习惯)" })
    );
    // delete 被调:删 dropId
    expect(vi.mocked(dbDeleteMemoryFact)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dbDeleteMemoryFact)).toHaveBeenCalledWith(dropId);
    // 通知其它窗口
    expect(vi.mocked(emitSync)).toHaveBeenCalledWith("memory");
  });

  it("大脑返回仅删除动作:delete(dropId)→ 只调 dbDeleteMemoryFact,emitSync", async () => {
    const keepId = "mf_keep";
    const dropId = "mf_dup";
    seed(
      makeFact({ id: keepId, category: "preference", content: "喜欢用 VS Code" }),
      makeFact({ id: dropId, category: "preference", content: "喜欢 VS Code" }),
    );

    _generateOnceResult = JSON.stringify({
      actions: [
        { type: "delete", dropId },
      ],
    });

    await runMemoryDedup();

    expect(vi.mocked(dbUpdateMemoryFact)).not.toHaveBeenCalled();
    expect(vi.mocked(dbDeleteMemoryFact)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dbDeleteMemoryFact)).toHaveBeenCalledWith(dropId);
    expect(vi.mocked(emitSync)).toHaveBeenCalledWith("memory");
  });

  it("大脑返回多个 action → 各自执行,emitSync 调一次", async () => {
    const ids = ["mf_a", "mf_b", "mf_c", "mf_d"];
    seed(
      makeFact({ id: ids[0], category: "habit", content: "A" }),
      makeFact({ id: ids[1], category: "habit", content: "B" }),
      makeFact({ id: ids[2], category: "preference", content: "C" }),
      makeFact({ id: ids[3], category: "preference", content: "D" }),
    );

    _generateOnceResult = JSON.stringify({
      actions: [
        { type: "merge", keepId: ids[0], dropId: ids[1], mergedContent: "合并AB" },
        { type: "delete", dropId: ids[2] },
      ],
    });

    await runMemoryDedup();

    expect(vi.mocked(dbUpdateMemoryFact)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dbDeleteMemoryFact)).toHaveBeenCalledTimes(2); // merge里的drop + 单独delete
    // emitSync 只调一次(批量完成后统一通知)
    expect(vi.mocked(emitSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(emitSync)).toHaveBeenCalledWith("memory");
  });

  it("大脑返回格式非法 JSON → 静默降级,不写库,不崩", async () => {
    seed(makeFact({ id: "mf_1", content: "any" }));
    _generateOnceResult = "这不是 JSON}}}";

    await expect(runMemoryDedup()).resolves.not.toThrow();

    expect(vi.mocked(dbUpdateMemoryFact)).not.toHaveBeenCalled();
    expect(vi.mocked(dbDeleteMemoryFact)).not.toHaveBeenCalled();
    expect(vi.mocked(emitSync)).not.toHaveBeenCalled();
  });

  it("generateOnce 抛错 → 静默降级,不写库,不崩", async () => {
    seed(makeFact({ id: "mf_1", content: "any" }));
    _generateOnceThrow = true;

    await expect(runMemoryDedup()).resolves.not.toThrow();

    expect(vi.mocked(dbUpdateMemoryFact)).not.toHaveBeenCalled();
    expect(vi.mocked(dbDeleteMemoryFact)).not.toHaveBeenCalled();
    expect(vi.mocked(emitSync)).not.toHaveBeenCalled();
  });

  it("大脑 prompt 包含现有事实内容(确保把记忆传入了 LLM)", async () => {
    seed(
      makeFact({ id: "mf_1", content: "喜欢深色模式" }),
      makeFact({ id: "mf_2", content: "习惯在下午3点喝咖啡" }),
    );
    _generateOnceResult = JSON.stringify({ actions: [] });

    await runMemoryDedup();

    expect(vi.mocked(generateOnce)).toHaveBeenCalledTimes(1);
    // 验证 generateOnce 被调时,用户消息里包含了现有事实内容
    const [_systemPrompt, messages] = vi.mocked(generateOnce).mock.calls[0];
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("喜欢深色模式");
    expect(userMsg?.content).toContain("习惯在下午3点喝咖啡");
  });

  it("action 里的 dropId 不存在于库(db 抛 not found) → 静默跳过该 action,不崩", async () => {
    seed(makeFact({ id: "mf_keep", content: "保留" }));
    _generateOnceResult = JSON.stringify({
      actions: [
        { type: "delete", dropId: "mf_ghost" }, // 不存在
      ],
    });
    // dbDeleteMemoryFact mock 对不存在的 id 会 throw
    // 注意:_facts 里没有 mf_ghost,所以 mock 会 throw

    // 整个 runMemoryDedup 不应崩
    await expect(runMemoryDedup()).resolves.not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C. 集成:dailyScan 日终扫描调用去重归并
// ════════════════════════════════════════════════════════════════════════════

describe("dailyScan 日终扫描触发去重归并", () => {
  // 这个 describe 只验证接线:runDailyScan 执行完后 runMemoryDedup 被调了一次。
  // 隔离 mock:mock runMemoryDedup 避免 dailyScan.test.ts 的 db mock 交叉污染

  it("runDailyScan 会触发 runMemoryDedup(接线已做)", async () => {
    // 直接 import memoryHygiene 并 spy runMemoryDedup
    const hygiene = await import("./memoryHygiene");
    const spy = vi.spyOn(hygiene, "runMemoryDedup").mockResolvedValue(undefined);

    // mock dailyScan 的 db 依赖(dbListMessagesOnDate / dbListTodosOnDate / dbUpsertDailyDigest)
    const dbModule = await import("../db");
    vi.spyOn(dbModule, "dbListMessagesOnDate" as never).mockResolvedValue([] as never);
    vi.spyOn(dbModule, "dbListTodosOnDate" as never).mockResolvedValue([] as never);
    vi.spyOn(dbModule, "dbUpsertDailyDigest" as never).mockResolvedValue(undefined as never);

    // mock generateOnce 返回纪要文本
    const llmModule = await import("../llm/index");
    vi.spyOn(llmModule, "generateOnce").mockResolvedValue("今日无活动");

    const { runDailyScan } = await import("./dailyScan");
    await runDailyScan("2026-06-16", "zh");

    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });
});

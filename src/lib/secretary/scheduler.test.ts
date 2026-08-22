/**
 * scheduler.test.ts — 调度基建单测
 *
 * 覆盖:
 *   1. shouldTakeOver 纯函数全边界
 *   2. 锁管理器(内存假 storage + 假时钟):抢占 / 续约 / 接管
 *   3. 注册任务只在 owner 跑、且只在到点时跑
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  shouldTakeOver,
  createScheduler,
  type LockState,
  type SchedulerStorage,
  type ScheduledJob,
} from "./scheduler";

// ─── 可控 storage mock 工具 ──────────────────────────────────────────────────
/**
 * 创建一个「写入后 getItem 可返回任意 id」的可控 storage。
 * overrideOwnerId 不为 null 时,读锁返回该 id(模拟另一个窗口后写覆盖)。
 */
function makeControllableStorage(overrideOwnerId: string | null = null): SchedulerStorage & {
  setOverrideOwnerId: (id: string | null) => void;
} {
  const store = new Map<string, string>();
  let _override = overrideOwnerId;
  const LOCK_KEY = "latitude.secretary.scheduler.lock";
  return {
    getItem: (k) => {
      if (k === LOCK_KEY && _override !== null) {
        return JSON.stringify({ ownerId: _override, lastHeartbeat: T0 });
      }
      return store.get(k) ?? null;
    },
    setItem: (k, v) => { store.set(k, v); },
    removeItem: (k) => { store.delete(k); },
    setOverrideOwnerId: (id) => { _override = id; },
  };
}

// ─── 时间常量 ────────────────────────────────────────────────────────────────
const SEC = 1000;
const TIMEOUT = 30 * SEC; // 锁过期阈值 30s(与实现保持一致)

// 基准"now":一个稳定的时间戳,不依赖真实 Date.now()
const T0 = 1_700_000_000_000;

// ─── shouldTakeOver 纯函数测试 ───────────────────────────────────────────────
describe("shouldTakeOver", () => {
  const myId = "win-A";

  it("无 owner(锁为空)→ 应该抢", () => {
    const lock: LockState = { ownerId: null, lastHeartbeat: 0, myId, timeoutMs: TIMEOUT };
    expect(shouldTakeOver(lock, T0)).toBe(true);
  });

  it("我就是 owner,心跳未过期 → 应该续(true)", () => {
    // 上次心跳在 20s 前,阈值 30s → 未过期
    const lock: LockState = {
      ownerId: myId,
      lastHeartbeat: T0 - 20 * SEC,
      myId,
      timeoutMs: TIMEOUT,
    };
    expect(shouldTakeOver(lock, T0)).toBe(true);
  });

  it("我就是 owner,心跳刚好在过期点前 1ms → 仍然续(true)", () => {
    const lock: LockState = {
      ownerId: myId,
      lastHeartbeat: T0 - TIMEOUT + 1,
      myId,
      timeoutMs: TIMEOUT,
    };
    expect(shouldTakeOver(lock, T0)).toBe(true);
  });

  it("别的活跃 owner,心跳未过期 → 不抢(false)", () => {
    // 上次心跳在 10s 前,阈值 30s → 活跃
    const lock: LockState = {
      ownerId: "win-B",
      lastHeartbeat: T0 - 10 * SEC,
      myId,
      timeoutMs: TIMEOUT,
    };
    expect(shouldTakeOver(lock, T0)).toBe(false);
  });

  it("别的 owner 心跳恰好 = 过期阈值(同时刻到期)→ 不抢(false),边界严格 <", () => {
    // elapsed === TIMEOUT 时尚未过期(过期条件是 elapsed > TIMEOUT)
    const lock: LockState = {
      ownerId: "win-B",
      lastHeartbeat: T0 - TIMEOUT,
      myId,
      timeoutMs: TIMEOUT,
    };
    expect(shouldTakeOver(lock, T0)).toBe(false);
  });

  it("别的 owner 心跳过期(超过阈值 1ms)→ 应该抢(true)", () => {
    const lock: LockState = {
      ownerId: "win-B",
      lastHeartbeat: T0 - TIMEOUT - 1,
      myId,
      timeoutMs: TIMEOUT,
    };
    expect(shouldTakeOver(lock, T0)).toBe(true);
  });

  it("lastHeartbeat = 0,ownerId 非空 → 视为过期,应该抢", () => {
    // lastHeartbeat = 0 表示从未刷新,elapsed 很大
    const lock: LockState = {
      ownerId: "win-B",
      lastHeartbeat: 0,
      myId,
      timeoutMs: TIMEOUT,
    };
    expect(shouldTakeOver(lock, T0)).toBe(true);
  });
});

// ─── 内存假 storage ──────────────────────────────────────────────────────────
function makeMemoryStorage(): SchedulerStorage {
  const store = new Map<string, string>();
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => { store.set(k, v); },
    removeItem: (k) => { store.delete(k); },
  };
}

// ─── 锁管理器:抢占 / 续约 / 接管 ──────────────────────────────────────────
describe("createScheduler — 锁管理器", () => {
  let storageA: SchedulerStorage;
  let storageB: SchedulerStorage;

  beforeEach(() => {
    // 两个窗口共享同一 storage 实例(模拟 localStorage 跨窗口真相)
    storageA = makeMemoryStorage();
    storageB = storageA; // 同一引用 = 同一"localStorage"
  });

  it("两窗口同开:只有一个成为 owner", () => {
    let nowMs = T0;
    const clock = () => nowMs;

    const schedA = createScheduler({ windowId: "win-A", storage: storageA, clock });
    const schedB = createScheduler({ windowId: "win-B", storage: storageB, clock });

    // 两个都执行一次 tick(模拟启动时争抢)
    schedA.tick();
    schedB.tick();

    // 只有一个是 owner
    const aIsOwner = schedA.isOwner();
    const bIsOwner = schedB.isOwner();
    expect(aIsOwner !== bIsOwner).toBe(true); // XOR:恰好一个
  });

  it("先抢到的是 owner,后来者不抢活跃 owner", () => {
    let nowMs = T0;
    const clock = () => nowMs;

    const schedA = createScheduler({ windowId: "win-A", storage: storageA, clock });
    const schedB = createScheduler({ windowId: "win-B", storage: storageB, clock });

    schedA.tick(); // A 先 tick → 成为 owner
    schedB.tick(); // B 后 tick → 发现 A 活跃,不抢

    expect(schedA.isOwner()).toBe(true);
    expect(schedB.isOwner()).toBe(false);
  });

  it("owner 持续 tick 续锁,非 owner 始终不抢", () => {
    let nowMs = T0;
    const clock = () => nowMs;

    const schedA = createScheduler({ windowId: "win-A", storage: storageA, clock });
    const schedB = createScheduler({ windowId: "win-B", storage: storageB, clock });

    schedA.tick();
    schedB.tick();

    // 推进 20s,A 持续续锁
    for (let i = 0; i < 4; i++) {
      nowMs += 5 * SEC;
      schedA.tick();
      schedB.tick();
    }

    expect(schedA.isOwner()).toBe(true);
    expect(schedB.isOwner()).toBe(false);
  });

  it("owner 退出(停止 tick)→ 超时后另一窗口接管", () => {
    let nowMs = T0;
    const clock = () => nowMs;

    const schedA = createScheduler({ windowId: "win-A", storage: storageA, clock });
    const schedB = createScheduler({ windowId: "win-B", storage: storageB, clock });

    schedA.tick(); // A 成为 owner
    schedB.tick(); // B 确认 A 活跃

    expect(schedA.isOwner()).toBe(true);
    expect(schedB.isOwner()).toBe(false);

    // A "挂掉"不再 tick;时间推进超过过期阈值
    nowMs += TIMEOUT + 1;

    // B 的下一次 tick 应该接管
    schedB.tick();

    expect(schedB.isOwner()).toBe(true);
    // A 此刻已不知道自己失去 owner(它不再 tick),但 storage 里记的是 B
    // 如果 A 再 tick,它会发现 B 是活跃 owner → A 不再是 owner
    schedA.tick();
    expect(schedA.isOwner()).toBe(false);
  });

  it("关掉非 owner 窗口(停止 tick)→ owner 不受影响", () => {
    let nowMs = T0;
    const clock = () => nowMs;

    const schedA = createScheduler({ windowId: "win-A", storage: storageA, clock });
    const schedB = createScheduler({ windowId: "win-B", storage: storageB, clock });

    schedA.tick(); // A 是 owner
    schedB.tick(); // B 不是 owner

    // B 停止 tick(非 owner 窗口关掉)
    nowMs += TIMEOUT + 1;
    schedA.tick(); // A 继续续锁

    // A 仍然是 owner
    expect(schedA.isOwner()).toBe(true);
  });

  it("storage 写入出错时不崩溃", () => {
    const brokenStorage: SchedulerStorage = {
      getItem: () => { throw new Error("quota exceeded"); },
      setItem: () => { throw new Error("quota exceeded"); },
      removeItem: () => { throw new Error("quota exceeded"); },
    };
    const sched = createScheduler({ windowId: "win-A", storage: brokenStorage, clock: () => T0 });
    // 不应抛异常
    expect(() => sched.tick()).not.toThrow();
  });
});

// ─── 注册任务:只在 owner 跑,且只在到点时跑 ─────────────────────────────────
describe("createScheduler — 注册任务执行", () => {
  it("owner 窗口:任务到点时执行", () => {
    let nowMs = T0;
    const clock = () => nowMs;
    const storage = makeMemoryStorage();
    const sched = createScheduler({ windowId: "win-A", storage, clock });

    const runs: number[] = [];
    const job: ScheduledJob = {
      id: "test-job",
      shouldRun: (now, ctx) => {
        // 每 10s 跑一次
        return now - (ctx.lastRan ?? 0) >= 10 * SEC;
      },
      run: () => { runs.push(nowMs); },
    };
    sched.registerJob(job);

    sched.tick(); // 第一次 tick:成为 owner + 任务 shouldRun(首次 lastRan=0,elapsed 很大)→ 跑
    expect(runs).toHaveLength(1);

    nowMs += 5 * SEC;
    sched.tick(); // 5s 后,间隔未到 → 不跑
    expect(runs).toHaveLength(1);

    nowMs += 5 * SEC;
    sched.tick(); // 再 5s,总共 10s → 到点
    expect(runs).toHaveLength(2);
  });

  it("非 owner 窗口:任务永不执行", () => {
    let nowMs = T0;
    const clock = () => nowMs;
    const storage = makeMemoryStorage();

    const schedA = createScheduler({ windowId: "win-A", storage, clock });
    const schedB = createScheduler({ windowId: "win-B", storage, clock });

    schedA.tick(); // A 成为 owner

    const runsB: number[] = [];
    schedB.registerJob({
      id: "b-job",
      shouldRun: () => true, // 随时都"应该跑"
      run: () => { runsB.push(nowMs); },
    });

    // B 连续 tick,但它不是 owner
    schedB.tick();
    nowMs += 5 * SEC;
    schedB.tick();
    nowMs += 5 * SEC;
    schedB.tick();

    expect(runsB).toHaveLength(0);
  });

  it("owner 接管后,任务开始在新 owner 执行", () => {
    let nowMs = T0;
    const clock = () => nowMs;
    const storage = makeMemoryStorage();

    const schedA = createScheduler({ windowId: "win-A", storage, clock });
    const schedB = createScheduler({ windowId: "win-B", storage, clock });

    schedA.tick(); // A 是 owner
    schedB.tick();

    const runsB: number[] = [];
    schedB.registerJob({
      id: "b-job",
      shouldRun: () => true,
      run: () => { runsB.push(nowMs); },
    });

    // A 挂掉;B 超时接管
    nowMs += TIMEOUT + 1;
    schedB.tick(); // B 接管并执行任务

    expect(schedB.isOwner()).toBe(true);
    expect(runsB).toHaveLength(1);
  });

  it("任务抛异常不影响其他任务和 tick 循环", () => {
    let nowMs = T0;
    const storage = makeMemoryStorage();
    const sched = createScheduler({ windowId: "win-A", storage, clock: () => nowMs });

    const runs: number[] = [];
    sched.registerJob({
      id: "bad-job",
      shouldRun: () => true,
      run: () => { throw new Error("boom"); },
    });
    sched.registerJob({
      id: "good-job",
      shouldRun: () => true,
      run: () => { runs.push(nowMs); },
    });

    sched.tick(); // bad-job 抛,good-job 仍应执行
    expect(runs).toHaveLength(1);
  });

  it("同步任务抛错:onError 被调用,携带正确 jobId 和 err", () => {
    const storage = makeMemoryStorage();
    const errors: Array<{ jobId: string; err: unknown }> = [];
    const onError = vi.fn((jobId: string, err: unknown) => {
      errors.push({ jobId, err });
    });

    const sched = createScheduler({
      windowId: "win-A",
      storage,
      clock: () => T0,
      onError,
    });

    const boom = new Error("sync-boom");
    sched.registerJob({
      id: "sync-bad-job",
      shouldRun: () => true,
      run: () => { throw boom; },
    });

    sched.tick();

    expect(onError).toHaveBeenCalledOnce();
    expect(errors[0].jobId).toBe("sync-bad-job");
    expect(errors[0].err).toBe(boom);
  });

  it("异步任务 reject:onError 被调用,携带正确 jobId 和 err", async () => {
    const storage = makeMemoryStorage();
    const errors: Array<{ jobId: string; err: unknown }> = [];
    const onError = vi.fn((jobId: string, err: unknown) => {
      errors.push({ jobId, err });
    });

    const sched = createScheduler({
      windowId: "win-A",
      storage,
      clock: () => T0,
      onError,
    });

    const boom = new Error("async-boom");
    sched.registerJob({
      id: "async-bad-job",
      shouldRun: () => true,
      run: () => Promise.reject(boom),
    });

    sched.tick();
    // 等 microtask queue 排空
    await Promise.resolve();

    expect(onError).toHaveBeenCalledOnce();
    expect(errors[0].jobId).toBe("async-bad-job");
    expect(errors[0].err).toBe(boom);
  });

  it("startScheduler / stopScheduler:stop 后任务不再执行(真实 setInterval)", () => {
    vi.useFakeTimers();
    const storage = makeMemoryStorage();
    let nowMs = T0;
    const clock = () => nowMs;

    const sched = createScheduler({ windowId: "win-A", storage, clock });
    const runs: number[] = [];
    sched.registerJob({
      id: "interval-job",
      shouldRun: () => true,
      run: () => { runs.push(nowMs); },
    });

    sched.start(5 * SEC);     // 每 5s tick 一次

    nowMs += 5 * SEC;
    vi.advanceTimersByTime(5 * SEC);
    expect(runs.length).toBeGreaterThan(0);

    const prevLen = runs.length;
    sched.stop();

    nowMs += 20 * SEC;
    vi.advanceTimersByTime(20 * SEC); // timer 已停,不应触发
    expect(runs).toHaveLength(prevLen);

    vi.useRealTimers();
  });
});

// ─── 写后回读:缓解双 owner 竞态 ─────────────────────────────────────────────
describe("createScheduler — 写后回读竞态防护", () => {
  it("写锁后回读发现是别人的 id → 本窗口认输,isOwner() 为 false", () => {
    // 模拟:本窗口写入锁后,storage 里实际保存的是另一个窗口的 id(后写者胜)
    const storage = makeControllableStorage("win-B"); // 读锁始终返回 win-B
    const sched = createScheduler({ windowId: "win-A", storage, clock: () => T0 });

    sched.tick();

    // 回读到的 ownerId 是 win-B,不是 win-A → 认输
    expect(sched.isOwner()).toBe(false);
  });

  it("写锁后回读发现是自己的 id → 成为 owner", () => {
    // 正常情况:没有竞争,读回来的就是自己
    const storage = makeControllableStorage(null); // 不覆盖 → 读回自己写的
    const sched = createScheduler({ windowId: "win-A", storage, clock: () => T0 });

    sched.tick();

    expect(sched.isOwner()).toBe(true);
  });
});

// ─── stop() 主动释放锁 ────────────────────────────────────────────────────────
describe("createScheduler — stop() 释锁行为", () => {
  it("本窗口是 owner 时 stop → 锁被清,另一窗口下一拍即可接管(不用等 30s)", () => {
    let nowMs = T0;
    const clock = () => nowMs;
    const storage = makeMemoryStorage();

    const schedA = createScheduler({ windowId: "win-A", storage, clock });
    const schedB = createScheduler({ windowId: "win-B", storage, clock });

    schedA.tick(); // A 成为 owner
    expect(schedA.isOwner()).toBe(true);

    schedA.stop(); // A 主动停,应清除锁

    // B 立刻 tick(时间没推进,30s 超时根本没到)
    schedB.tick();
    expect(schedB.isOwner()).toBe(true); // 不用等 30s,锁已清
  });

  it("本窗口不是 owner 时 stop → 不清除别人的锁", () => {
    let nowMs = T0;
    const clock = () => nowMs;
    const storage = makeMemoryStorage();

    const schedA = createScheduler({ windowId: "win-A", storage, clock });
    const schedB = createScheduler({ windowId: "win-B", storage, clock });

    schedA.tick(); // A 成为 owner
    schedB.tick(); // B 非 owner

    expect(schedA.isOwner()).toBe(true);
    expect(schedB.isOwner()).toBe(false);

    schedB.stop(); // B 停止 → 不应清除 A 的锁

    // A 继续 tick,锁仍在,A 依然是 owner
    schedA.tick();
    expect(schedA.isOwner()).toBe(true);
  });
});

// ─── isOwnerNow():实时读 storage ─────────────────────────────────────────────
describe("createScheduler — isOwnerNow() 实时性", () => {
  it("isOwnerNow() 直接反映 storage,isOwner() 反映上次 tick 的内存态", () => {
    let nowMs = T0;
    const clock = () => nowMs;
    const storage = makeMemoryStorage();

    const schedA = createScheduler({ windowId: "win-A", storage, clock });
    const schedB = createScheduler({ windowId: "win-B", storage, clock });

    schedA.tick(); // A 成为 owner
    schedB.tick(); // B 确认非 owner

    expect(schedA.isOwner()).toBe(true);     // 内存态:owner
    expect(schedA.isOwnerNow()).toBe(true);  // 实时:owner

    // 模拟 A 在外部被覆盖(B 超时接管写入了新锁),但 A 没有 tick 过
    nowMs += TIMEOUT + 1;
    schedB.tick(); // B 接管

    // A 的内存态还没更新(没有 tick)
    expect(schedA.isOwner()).toBe(true);      // 仍然是上次 tick 的滞后值
    // A 的实时读 storage 能发现自己已被 B 替换
    expect(schedA.isOwnerNow()).toBe(false);  // 实时:已不是 owner
  });
});

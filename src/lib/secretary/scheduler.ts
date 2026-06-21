/**
 * scheduler.ts — AI 秘书调度基建 (Task 0.1)
 *
 * 职责:保证「只有一个 owner 窗口跑 tick 循环」,并在 tick 时执行到点的已注册任务。
 *
 * 设计要点:
 *   - 归属/接管决策全部在纯函数 shouldTakeOver() 里完成(时间从参数注入,函数体内
 *     绝不读 Date.now() / Math.random()),便于确定性单测。
 *   - 锁的真相源是 localStorage(跨窗口共享),不存 Zustand/内存态。
 *     锁里存:ownerId + lastHeartbeat 时间戳;心跳超过阈值没刷新 → 视为过期,其他
 *     窗口可 compare-and-set 式抢占(先读锁,再 shouldTakeOver,再写锁)。
 *   - I/O 薄薄一层(readLock / writeLock),所有决策都在纯函数里。
 *   - 时钟和 storage 可注入(默认 Date.now / localStorage),测试时注入假的。
 *
 * 使用方:
 *   // 在某个窗口的入口(同 reminder 的挂法):
 *   const sched = createScheduler({ windowId: "win-main" });
 *   sched.registerJob({ id: "daily-scan", shouldRun, run });
 *   sched.start();
 *   // 组件卸载时:
 *   sched.stop();
 */

// ─── 类型 ─────────────────────────────────────────────────────────────────────

/**
 * 传给 shouldTakeOver 的锁状态快照。
 * ownerId: 当前锁记录的 owner 窗口 id,null 表示无 owner。
 * lastHeartbeat: owner 上次刷新锁的时间戳(ms),0 表示从未刷新。
 * myId: 本窗口的 id。
 * timeoutMs: 心跳超过多久视为 owner 死亡(可接管)。
 */
export interface LockState {
  ownerId: string | null;
  lastHeartbeat: number;
  myId: string;
  timeoutMs: number;
}

/**
 * 任务上下文:每次 shouldRun / run 调用时传入。
 * lastRan: 上次成功执行的时间戳(ms),从未跑过时为 undefined。
 */
export interface JobContext {
  lastRan: number | undefined;
}

/**
 * 可注册的定时任务。
 * id:唯一标识,用于存储 lastRan。
 * shouldRun(now, ctx): 纯判断——此刻是否该跑。
 * run():执行副作用。允许抛异常,scheduler 会捕获并隔离。
 *
 * ⚠️ run() 失败不会在本周期内重试,要到下个周期才会再次判断 shouldRun。
 *    原因:lastRan 在 run() 调用前已写入(防死循环),失败不会回滚。
 *    job 实现者若需要重试语义,请在 run() 内部自行实现重试逻辑。
 */
export interface ScheduledJob {
  id: string;
  shouldRun: (now: number, ctx: JobContext) => boolean;
  run: () => void | Promise<void>;
}

/** 可注入的 storage 接口(对齐 localStorage API 子集)。 */
export interface SchedulerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// ─── localStorage 键 ──────────────────────────────────────────────────────────

const LOCK_KEY = "daybreak.secretary.scheduler.lock";
const JOB_LAST_RAN_PREFIX = "daybreak.secretary.scheduler.lastRan.";

/** 默认锁过期阈值:30s。owner 若 30s 内没有刷新心跳,视为已死亡。 */
const DEFAULT_TIMEOUT_MS = 30 * 1000;

// ─── 纯函数:接管判定 ─────────────────────────────────────────────────────────

/**
 * 纯函数:本窗口此刻该不该持有/保留 owner。
 *
 * 规则(按优先级):
 *   1. 无 owner(ownerId === null) → 抢
 *   2. 我就是 owner → 续(始终 true,无论心跳是否"过期"——因为我最清楚自己还活着)
 *   3. 别的 owner 心跳已过期(now - lastHeartbeat > timeoutMs) → 抢
 *   4. 别的 owner 活跃 → 不抢
 *
 * ⚠️ 函数体内绝不读 Date.now() / Math.random()。所有时间/状态从参数注入。
 */
export function shouldTakeOver(lock: LockState, now: number): boolean {
  const { ownerId, lastHeartbeat, myId, timeoutMs } = lock;

  // 规则 1:无 owner
  if (ownerId === null) return true;

  // 规则 2:我就是 owner → 续
  if (ownerId === myId) return true;

  // 规则 3/4:别的 owner → 看心跳是否过期
  // 过期条件:elapsed > timeoutMs(严格大于,等于时视为仍活跃)
  const elapsed = now - lastHeartbeat;
  return elapsed > timeoutMs;
}

// ─── 锁的序列化/反序列化 ──────────────────────────────────────────────────────

interface StoredLock {
  ownerId: string;
  lastHeartbeat: number;
}

function readStoredLock(storage: SchedulerStorage): StoredLock | null {
  try {
    const raw = storage.getItem(LOCK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "ownerId" in parsed &&
      typeof (parsed as Record<string, unknown>).ownerId === "string" &&
      "lastHeartbeat" in parsed &&
      typeof (parsed as Record<string, unknown>).lastHeartbeat === "number"
    ) {
      return parsed as StoredLock;
    }
    return null;
  } catch {
    // JSON 解析失败或 storage 读取配额错误 → 当作无锁处理
    return null;
  }
}

function writeStoredLock(storage: SchedulerStorage, lock: StoredLock): void {
  try {
    storage.setItem(LOCK_KEY, JSON.stringify(lock));
  } catch {
    // storage 写入失败(配额超限等)→ 静默忽略;本轮 tick 仍继续
  }
}

// ─── job lastRan 持久化 ───────────────────────────────────────────────────────

function readLastRan(storage: SchedulerStorage, jobId: string): number | undefined {
  try {
    const raw = storage.getItem(JOB_LAST_RAN_PREFIX + jobId);
    if (!raw) return undefined;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? undefined : n;
  } catch {
    return undefined;
  }
}

function writeLastRan(storage: SchedulerStorage, jobId: string, ts: number): void {
  try {
    storage.setItem(JOB_LAST_RAN_PREFIX + jobId, String(ts));
  } catch {
    // 忽略写入失败
  }
}

// ─── Scheduler 实例 ───────────────────────────────────────────────────────────

export interface SchedulerOptions {
  /** 本窗口唯一 id。生产中可用 Tauri window label。 */
  windowId: string;
  /** 可注入的 storage(默认 localStorage)。 */
  storage?: SchedulerStorage;
  /** 可注入的时钟函数(默认 Date.now)。 */
  clock?: () => number;
  /** 锁过期阈值(ms),默认 30s。 */
  timeoutMs?: number;
  /**
   * 任务出错回调(同步抛异常或异步 reject 均走此钩子)。
   * 未传时兜底 console.error,保证错误可观测。
   */
  onError?: (jobId: string, err: unknown) => void;
}

export interface Scheduler {
  /** 注册一个定时任务。可在 start() 前或后调用。 */
  registerJob(job: ScheduledJob): void;
  /**
   * 执行一次 tick:尝试抢/续 owner 锁,若是 owner 则执行到点的任务。
   * 供外部测试直接调用(不依赖真实 setInterval)。
   */
  tick(): void;
  /**
   * 本窗口当前是否认为自己是 owner(内存态,以最后一次 tick 为准)。
   * ⚠️ 此值最多滞后一个 tick 间隔。若需要准确的实时归属判断,请用 isOwnerNow()。
   */
  isOwner(): boolean;
  /**
   * 实时读 storage 判断本窗口是否是 owner。
   * 供下游 job 在任务执行中途需要准确归属时调用(例如长耗时任务中途校验)。
   * 比 isOwner() 稍慢(涉及 storage 读取),但结果实时、无滞后。
   */
  isOwnerNow(): boolean;
  /** 启动定时 tick 循环。intervalMs 默认 5000(5s)。 */
  start(intervalMs?: number): void;
  /** 停止定时 tick 循环,并主动释放本窗口持有的 owner 锁。 */
  stop(): void;
}

/** 工厂函数:创建一个调度器实例。每个窗口调用一次。 */
export function createScheduler(opts: SchedulerOptions): Scheduler {
  const {
    windowId,
    storage = typeof localStorage !== "undefined" ? localStorage : makeFallbackStorage(),
    clock = () => Date.now(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onError,
  } = opts;

  // 错误上报:有 onError 钩子走钩子,否则兜底 console.error(保证可观测)
  const reportError = (jobId: string, err: unknown): void => {
    if (onError) {
      onError(jobId, err);
    } else {
      console.error(`[Scheduler] job "${jobId}" failed:`, err);
    }
  };

  const jobs: ScheduledJob[] = [];
  let _isOwner = false;
  let _timer: ReturnType<typeof setInterval> | null = null;

  function tick(): void {
    const now = clock();

    // ── 读锁 ──────────────────────────────────────────────────────────────
    const stored = readStoredLock(storage);
    const lockState: LockState = {
      ownerId: stored?.ownerId ?? null,
      lastHeartbeat: stored?.lastHeartbeat ?? 0,
      myId: windowId,
      timeoutMs,
    };

    // ── 接管判定(纯函数,不含副作用) ────────────────────────────────────
    const takeOver = shouldTakeOver(lockState, now);

    if (takeOver) {
      // 写锁:compare-and-set 风格——只在"我该抢/续"时才写
      writeStoredLock(storage, { ownerId: windowId, lastHeartbeat: now });

      // 写后回读:验证实际写入的是本窗口 id。
      // localStorage 无原子 CAS,两个独立进程同时读到「无 owner/已过期」后
      // 都可能写入自己的 id,最终 storage 里保留后写者的 id(last-write-wins)。
      // 回读可将双 owner 窗口缩减为一个:先写者读回别人的 id → 认输。
      //
      // ⚠️ 注意:这缩小但不能彻底消除竞态(读-写仍有间隙)。
      //    彻底根治需后端 mutex(如 Tauri 全局锁或服务端协调),属后续架构升级。
      const writtenBack = readStoredLock(storage);
      _isOwner = writtenBack?.ownerId === windowId;
    } else {
      // 别的活跃 owner 持有锁,本窗口退出(或保持)非 owner 状态
      _isOwner = false;
    }

    // ── 只有 owner 才执行任务 ─────────────────────────────────────────────
    if (!_isOwner) return;

    for (const job of jobs) {
      const lastRan = readLastRan(storage, job.id);
      const ctx: JobContext = { lastRan };

      let shouldRun = false;
      try {
        shouldRun = job.shouldRun(now, ctx);
      } catch {
        // shouldRun 抛异常 → 跳过此任务
        continue;
      }

      if (!shouldRun) continue;

      // 先写 lastRan,再执行(即便 run 抛也记本次时间,避免死循环重试)
      writeLastRan(storage, job.id, now);

      try {
        const result = job.run();
        // 若 run 返回 Promise,不在 tick 里 await(tick 是同步边界);
        // 上层若需要知道完成,job 自己管理异步状态。
        if (result instanceof Promise) {
          result.catch((err) => {
            reportError(job.id, err);
          });
        }
      } catch (err) {
        // 同步异常隔离:单个任务失败不影响其他任务和 tick 循环
        reportError(job.id, err);
      }
    }
  }

  /**
   * 内存态 owner 标志,以最后一次 tick 为准。
   * ⚠️ 此值最多滞后一个 tick 间隔。需要实时结果请用 isOwnerNow()。
   */
  function isOwner(): boolean {
    return _isOwner;
  }

  /**
   * 实时读 storage 判断本窗口是否持有 owner 锁。
   * 供下游 job 在执行中途需要准确归属时调用。
   */
  function isOwnerNow(): boolean {
    const stored = readStoredLock(storage);
    return stored?.ownerId === windowId;
  }

  function registerJob(job: ScheduledJob): void {
    // 幂等:相同 id 的任务只注册一次
    if (jobs.some((j) => j.id === job.id)) return;
    jobs.push(job);
  }

  function start(intervalMs = 5000): void {
    if (_timer) return;
    tick(); // 启动时立即执行一次,避免等首个 interval 才抢锁
    _timer = setInterval(tick, intervalMs);
  }

  function stop(): void {
    if (_timer) {
      clearInterval(_timer);
      _timer = null;
    }
    // 主动释放本窗口持有的锁:仅当 storage 里的 ownerId 是本窗口才删除,
    // 避免误删其他窗口已写入的锁(竞态接管场景下本窗口可能已不是 owner)。
    const stored = readStoredLock(storage);
    if (stored?.ownerId === windowId) {
      try {
        storage.removeItem(LOCK_KEY);
      } catch {
        // storage 操作失败静默忽略,不影响 stop 本身
      }
    }
    _isOwner = false;
  }

  return { registerJob, tick, isOwner, isOwnerNow, start, stop };
}

// ─── 兜底:无 localStorage 环境(SSR/纯 Node 测试)────────────────────────────

/**
 * 无 localStorage 时的内存兜底(不跨窗口,仅防崩溃)。
 * 正式跑 Tauri 时 localStorage 必然存在;这个兜底仅为 Node 环境安全。
 */
function makeFallbackStorage(): SchedulerStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
  };
}

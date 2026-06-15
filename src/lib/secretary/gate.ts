/**
 * gate.ts — AI 秘书防骚扰纯函数闸门 (Task 1.6)
 *
 * 职责:决定一条主动消息「该不该现在发」。
 *
 * 覆盖(gate-lite):
 *   1. 静默时段:工作时段外 / pausedUntil 未过 → 不发
 *   2. 去重:与最近发过的同类主动消息重复(在去重窗口内) → 不发
 *   3. 温和频率:距上次任意主动消息未超过最小间隔 → 不发
 *
 * ⚠️ 不做:完整预算、冷却评分、优先级——这些留 Phase 3。
 *
 * 设计原则:
 *   - 纯函数:所有时间从 now(Date)注入,函数体内不读 Date.now()
 *   - 无副作用:gate() 本身不更新 gateState;调用方负责写入
 *   - 所有可配置阈值作为导出常量,测试可精确引用
 */

import type { ScheduledJob } from "./scheduler";
import { composeMorningBriefing } from "./composeProactive";
import { useSettingsStore } from "../settings";
import type { Lang } from "../settings";
import type { MorningBriefingJobOpts } from "./composeProactive";

// ─── 导出常量(测试引用这些做边界断言) ────────────────────────────────────────

/** 去重窗口:同类主动消息在此时间范围内不重复发 (23h) */
export const DEDUP_WINDOW_MS = 23 * 60 * 60 * 1000;

/** 温和频率最小间隔:任意两条主动消息之间的最短时间 (5min) */
export const MIN_INTERVAL_MS = 5 * 60 * 1000;

// ─── 类型 ─────────────────────────────────────────────────────────────────────

/** 一条候选主动消息的描述 */
export interface GateCandidate {
  /** 主动消息类型,用于去重比较 */
  type: string;
  /** 消息内容摘要,用于内容级去重 */
  content: string;
  /** 工作时段起始小时(0-23) */
  workStart: number;
  /** 工作时段结束小时(0-23),开区间 [workStart, workEnd) */
  workEnd: number;
}

/** 最近已发送的一条主动消息记录 */
export interface SentRecord {
  type: string;
  content: string;
  /** 发送时间戳(ms) */
  sentAt: number;
}

/**
 * 闸门状态——调用方维护并传入。
 * gate() 本身不读写任何持久化 storage。
 */
export interface GateState {
  /** 最近已发送的主动消息列表(调用方按需修剪长度) */
  recentlySent: SentRecord[];
  /** "别烦我"截止时间戳(ms);Date.now() < pausedUntil 时拒绝所有主动消息 */
  pausedUntil: number | undefined;
  /** 上次任意主动消息发送时的时间戳(ms),用于频率控制 */
  lastProactiveSentMs: number | undefined;
}

/** gate() 的返回值 */
export interface GateResult {
  allow: boolean;
  /** 拒绝时的原因描述(英文/关键词,供日志和测试断言) */
  reason?: string;
}

// ─── 核心纯函数 ──────────────────────────────────────────────────────────────

/**
 * 决定候选主动消息此刻是否可以发送。
 *
 * 检查顺序:
 *   1. 静默时段(工作时段外) → 拒绝
 *   2. pausedUntil 未过 → 拒绝
 *   3. 去重窗口内同类消息 → 拒绝
 *   4. 温和频率最小间隔未到 → 拒绝
 *   5. 全部通过 → 允许
 *
 * @param candidate  候选消息描述
 * @param gateState  当前闸门状态(外部维护)
 * @param now        当前时间(由调用方注入,函数体内不读 Date.now())
 */
export function gate(
  candidate: GateCandidate,
  gateState: GateState,
  now: Date
): GateResult {
  const nowMs = now.getTime();
  const hour = now.getHours();

  // ── 1. 静默时段:工作时段外 ───────────────────────────────────────────────
  if (hour < candidate.workStart || hour >= candidate.workEnd) {
    return {
      allow: false,
      reason: `quiet hours: current hour=${hour}, work=[${candidate.workStart},${candidate.workEnd})`,
    };
  }

  // ── 2. pausedUntil 未过 ───────────────────────────────────────────────────
  if (gateState.pausedUntil !== undefined && nowMs <= gateState.pausedUntil) {
    return {
      allow: false,
      reason: `paused until ${new Date(gateState.pausedUntil).toISOString()}`,
    };
  }

  // ── 3. 去重:同类消息在去重窗口内已发过 ──────────────────────────────────
  const dupRecord = gateState.recentlySent.find(
    (r) => r.type === candidate.type && nowMs - r.sentAt <= DEDUP_WINDOW_MS
  );
  if (dupRecord) {
    return {
      allow: false,
      reason: `duplicate: type=${candidate.type} sent at ${new Date(dupRecord.sentAt).toISOString()} (dedup window ${DEDUP_WINDOW_MS}ms)`,
    };
  }

  // ── 4. 温和频率:最小间隔未到 ────────────────────────────────────────────
  if (
    gateState.lastProactiveSentMs !== undefined &&
    nowMs - gateState.lastProactiveSentMs <= MIN_INTERVAL_MS
  ) {
    return {
      allow: false,
      reason: `rate limit: last sent ${nowMs - gateState.lastProactiveSentMs}ms ago, min interval=${MIN_INTERVAL_MS}ms`,
    };
  }

  return { allow: true };
}

// ─── 简报投递工厂(接入 gate) ──────────────────────────────────────────────────

/**
 * createMorningBriefingJobWithGate 的配置项
 *
 * 在 MorningBriefingJobOpts 基础上增加:
 *   - gateStateProvider: 每次 run 时调用,返回最新 GateState(便于测试注入)
 *   - nowProvider: 注入"当前时间"(便于测试注入;生产传 undefined 则用 new Date())
 */
export interface MorningBriefingWithGateOpts extends MorningBriefingJobOpts {
  /**
   * 返回当前 GateState 的函数。
   * 生产代码可读 localStorage 或 in-memory store;
   * 测试直接传一个返回预设状态的函数。
   * 不传时使用默认空状态(不限制)。
   */
  gateStateProvider?: () => GateState;
  /**
   * 返回"现在"的函数,注入给 gate()。
   * 不传时使用 new Date()(生产)。
   */
  nowProvider?: () => Date;
}

/** 默认 GateState:无限制 */
function defaultGateState(): GateState {
  return {
    recentlySent: [],
    pausedUntil: undefined,
    lastProactiveSentMs: undefined,
  };
}

/**
 * 创建带 gate 的晨间简报调度任务。
 *
 * 在原 createMorningBriefingJob 逻辑基础上,run() 执行前先过 gate:
 *   gate 拒绝 → 静默跳过,不 compose 不投递
 *   gate 通过 → 正常走 composeMorningBriefing
 *
 * 工作时段配置从 reminder.workStart / reminder.workEnd 读(与 reminder.ts 保持一致)。
 * 测试可通过 nowProvider 注入时间,完全确定性。
 *
 * ⚠️ shouldRun 逻辑与原 createMorningBriefingJob 一致(不改 shouldRun,只改 run)。
 */
export function createMorningBriefingJobWithGate(
  opts: MorningBriefingWithGateOpts = {}
): ScheduledJob {
  const morningHour = opts.morningHour ?? 7;
  const gateStateProvider = opts.gateStateProvider ?? defaultGateState;
  const nowProvider = opts.nowProvider ?? (() => new Date());

  return {
    id: "morning-briefing",

    /**
     * 纯函数:当天首次 + 已到早晨时间 → true。
     * 逻辑与原 createMorningBriefingJob.shouldRun 相同。
     */
    shouldRun(now: number, ctx: { lastRan: number | undefined }): boolean {
      const d = new Date(now);
      const hour = d.getHours();

      if (hour < morningHour) return false;

      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);
      const todayStartMs = todayStart.getTime();

      if (ctx.lastRan !== undefined && ctx.lastRan >= todayStartMs) {
        return false;
      }

      return true;
    },

    async run(): Promise<void> {
      const now = nowProvider();

      // 读工作时段配置(与 reminder.ts 的 workStart/workEnd 保持一致)
      const settings = useSettingsStore.getState();
      const reminder = settings.reminder;
      const workStart = reminder?.workStart ?? 9;
      const workEnd = reminder?.workEnd ?? 22;
      const lang: Lang = opts.lang ?? settings.lang ?? "zh";

      // gate 检查
      const candidate: GateCandidate = {
        type: "morning-briefing",
        content: `morning-briefing-${now.toISOString().slice(0, 10)}`,
        workStart,
        workEnd,
      };

      const gateState = gateStateProvider();
      const result = gate(candidate, gateState, now);

      if (!result.allow) {
        console.info(`[MorningBriefingWithGate] gate 拒绝,跳过投递: ${result.reason}`);
        return;
      }

      // gate 通过 → 正常 compose + 投递
      const fmt = (d: Date): string =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

      const dateKey = fmt(now);
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const yesterdayKey = fmt(yesterday);

      await composeMorningBriefing({ dateKey, yesterdayKey, lang });
    },
  };
}

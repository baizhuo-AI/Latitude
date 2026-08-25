import type {
  ActivityRecord,
  DailyDigestRow,
  Goal,
  MemoryFact,
  ProposalRecord
} from "../../lib/db";
import type { LineageRef } from "../../dimension/types";
import type { Todo } from "../../lib/store";

/**
 * 现有事实层能支持的时间线条目。
 *
 * 这里刻意不用 cognition / growth 命名：Todo 完成、活动记录与提案裁决是
 * 真实发生，但在 Outcome / Claim 图谱接入前，不能自动解释成「用户成长了」。
 */
export type RealityTimelineKind =
  | "activity"
  | "action"
  | "decision"
  | "goal"
  | "memory"
  | "digest";

export interface RealityTimelineEntry {
  id: string;
  kind: RealityTimelineKind;
  occurredAt: string;
  title: string;
  detail?: string;
  badge: string;
  lineage?: LineageRef;
}

export interface RealityTimelineInput {
  todos: Todo[];
  activities: ActivityRecord[];
  proposals: ProposalRecord[];
  goals: Goal[];
  memoryFacts: MemoryFact[];
  digests: DailyDigestRow[];
  limit?: number;
}

const GOAL_STATUS_LABEL: Record<Goal["status"], string> = {
  active: "当前进行中",
  achieved: "当前已达成",
  abandoned: "当前已放弃"
};

const GOAL_PERIOD_LABEL: Record<Goal["period"], string> = {
  year: "年度目标",
  quarter: "季度目标",
  month: "月度目标"
};

const PROPOSAL_STATUS_LABEL: Record<ProposalRecord["status"], string> = {
  proposed: "等待决定",
  accepted: "这对我成立",
  rejected: "不太对",
  parked: "先放着",
  try: "要不试试"
};

function timestampOf(iso: string): number {
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : 0;
}

export function buildRealityTimeline(input: RealityTimelineInput): RealityTimelineEntry[] {
  const entries: RealityTimelineEntry[] = [];

  for (const todo of input.todos) {
    if (todo.status !== "done" || !todo.completedAt) continue;
    entries.push({
      id: `todo-completed:${todo.id}`,
      kind: "action",
      occurredAt: todo.completedAt,
      title: `完成了「${todo.title}」`,
      detail: todo.reason,
      badge: "行动记录",
      lineage: {
        entityType: "todo",
        entityId: todo.id,
        label: "来自你的待办"
      }
    });
  }

  for (const activity of input.activities) {
    entries.push({
      id: `activity:${activity.id}`,
      kind: "activity",
      occurredAt: activity.occurredAt,
      title: activity.content,
      badge: "现实记录",
      lineage: {
        entityType: "activity",
        entityId: activity.id,
        label: "来自活动流水"
      }
    });
  }

  for (const proposal of input.proposals) {
    if (!proposal.decidedAt || proposal.status === "proposed") continue;
    entries.push({
      id: `proposal:${proposal.id}`,
      kind: "decision",
      occurredAt: proposal.decidedAt,
      title: `对一条提案做了决定：${proposal.verdictLabel ?? PROPOSAL_STATUS_LABEL[proposal.status]}`,
      detail: proposal.quote,
      badge: "用户裁决",
      lineage: {
        entityType: "proposal",
        entityId: proposal.id,
        label: "来自一次提案裁决"
      }
    });
  }

  for (const goal of input.goals) {
    entries.push({
      id: `goal:${goal.id}`,
      kind: "goal",
      occurredAt: goal.createdAt,
      title: `记录了目标「${goal.title}」`,
      detail: `${GOAL_PERIOD_LABEL[goal.period]} · ${GOAL_STATUS_LABEL[goal.status]}${goal.description ? ` · ${goal.description}` : ""}`,
      badge: goal.period === "year" ? "长期方向" : "阶段目标",
      lineage: {
        entityType: "goal",
        entityId: goal.id,
        label: `来自你的${GOAL_PERIOD_LABEL[goal.period]}`
      }
    });
  }

  for (const fact of input.memoryFacts) {
    entries.push({
      id: `memory:${fact.id}`,
      kind: "memory",
      occurredAt: fact.createdAt,
      title: fact.content,
      detail:
        fact.source === "told"
          ? "这是你明确告诉秘书的记录。"
          : "这是 AI 留下的推测，尚未经过正式认知裁决。",
      badge: fact.source === "told" ? "你告诉我的" : "AI 推测 · 未确认",
      lineage: {
        entityType: "memory_fact",
        entityId: fact.id,
        label: fact.source === "told" ? "来自你明确告诉我的内容" : "来自一条 AI 推测"
      }
    });
  }

  for (const digest of input.digests) {
    entries.push({
      id: `digest:${digest.date}`,
      kind: "digest",
      occurredAt: digest.createdAt,
      title: `每日整理 · ${digest.date}`,
      detail: digest.summary,
      badge: "记录显示",
      lineage: {
        entityType: "digest",
        entityId: digest.date,
        label: "来自秘书的每日整理"
      }
    });
  }

  return entries
    .sort((a, b) => timestampOf(b.occurredAt) - timestampOf(a.occurredAt))
    .slice(0, input.limit ?? 100);
}

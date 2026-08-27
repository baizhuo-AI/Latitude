import type {
  ActivityRecord,
  CalendarEvent,
  DailyDigestRow,
  Goal,
  MemoryFact,
  ProposalRecord
} from "../lib/db";
import type { Todo } from "../lib/store";
import type { LineageRef } from "./types";

interface DetailRow {
  label: string;
  value: string;
}

interface ResolvedSource {
  eyebrow: string;
  title: string;
  description?: string;
  rows: DetailRow[];
  missing?: boolean;
}

function localDateTime(value?: string | number): string {
  if (value === undefined) return "未记录";
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString();
}

function resolveSource(input: {
  lineage: LineageRef;
  todos: Todo[];
  events: CalendarEvent[];
  goals: Goal[];
  activities: ActivityRecord[];
  proposals: ProposalRecord[];
  memoryFacts: MemoryFact[];
  digests: DailyDigestRow[];
}): ResolvedSource {
  const { lineage } = input;

  if (lineage.entityType === "todo") {
    const todo = input.todos.find((item) => item.id === lineage.entityId);
    if (todo) {
      return {
        eyebrow: "来源 · 待办",
        title: todo.title,
        description: todo.reason,
        rows: [
          { label: "当前状态", value: { todo: "待办", doing: "进行中", done: "已完成", dropped: "已放弃" }[todo.status] },
          { label: "安排", value: [todo.scheduledDate, todo.scheduledTime].filter(Boolean).join(" · ") || "未排期" },
          { label: "创建时间", value: localDateTime(todo.createdAt) },
          { label: "完成时间", value: localDateTime(todo.completedAt) },
          { label: "标签", value: todo.tags.length > 0 ? todo.tags.join("、") : "无" }
        ]
      };
    }
  }

  if (lineage.entityType === "calendar_event") {
    const event = input.events.find((item) => item.id === lineage.entityId);
    if (event) {
      return {
        eyebrow: "来源 · 日程",
        title: event.title,
        description: event.description,
        rows: [
          { label: "日历", value: event.calendarName || event.calendarId || "本地日历" },
          { label: "时间", value: event.isAllDay ? `${event.scheduledDate ?? ""} · 全天` : [event.scheduledDate, event.scheduledTime].filter(Boolean).join(" · ") || localDateTime(event.startTs) },
          { label: "地点", value: event.location || "未记录" },
          { label: "当前状态", value: event.status === "cancelled" ? "已取消" : "已确认" },
          { label: "同步来源", value: event.region === "lark" ? "Lark" : "飞书" },
          { label: "最近更新", value: localDateTime(event.updatedAt) }
        ]
      };
    }
  }

  if (lineage.entityType === "goal") {
    const goal = input.goals.find((item) => item.id === lineage.entityId);
    if (goal) {
      return {
        eyebrow: "来源 · 目标",
        title: goal.title,
        description: goal.description,
        rows: [
          { label: "周期", value: { year: "年度", quarter: "季度", month: "月度" }[goal.period] },
          { label: "当前状态", value: { active: "进行中", achieved: "已达成", abandoned: "已放弃" }[goal.status] },
          { label: "目标日期", value: goal.targetDate || "未设置" },
          { label: "记录时间", value: localDateTime(goal.createdAt) }
        ]
      };
    }
  }

  if (lineage.entityType === "activity") {
    const activity = input.activities.find((item) => item.id === lineage.entityId);
    if (activity) {
      return {
        eyebrow: "来源 · 记录",
        title: activity.content,
        rows: [
          { label: "发生时间", value: localDateTime(activity.occurredAt) },
          { label: "记录时间", value: localDateTime(activity.createdAt) },
          { label: "认识状态", value: "记录显示；不自动解释成认知结论" }
        ]
      };
    }
  }

  if (lineage.entityType === "proposal") {
    const proposal = input.proposals.find((item) => item.id === lineage.entityId);
    if (proposal) {
      return {
        eyebrow: "来源 · 建议",
        title: proposal.quote,
        description: proposal.consequence,
        rows: [
          { label: "当前状态", value: { proposed: "等待决定", accepted: "这对我成立", rejected: "不太对", parked: "先放着", try: "要不试试" }[proposal.status] },
          { label: "用户表达", value: proposal.verdictLabel || "尚未裁决" },
          { label: "提出时间", value: localDateTime(proposal.createdAt) },
          { label: "裁决时间", value: localDateTime(proposal.decidedAt) },
          { label: "行动面", value: proposal.actionTitle || "没有直接行动" }
        ]
      };
    }
  }

  if (lineage.entityType === "memory_fact") {
    const fact = input.memoryFacts.find((item) => item.id === lineage.entityId);
    if (fact) {
      return {
        eyebrow: "来源 · 记忆",
        title: fact.content,
        rows: [
          { label: "来源", value: fact.source === "told" ? "你明确告诉我的" : "AI 推测 · 未确认" },
          { label: "有效方式", value: fact.durability === "durable" ? "长期记录" : "阶段性记录" },
          { label: "记录时间", value: localDateTime(fact.createdAt) },
          { label: "到期时间", value: localDateTime(fact.expiresAt) }
        ]
      };
    }
  }

  if (lineage.entityType === "digest") {
    const digest = input.digests.find((item) => item.date === lineage.entityId);
    if (digest) {
      return {
        eyebrow: "来源 · 每日整理",
        title: `每日整理 · ${digest.date}`,
        description: digest.summary,
        rows: [
          { label: "生成时间", value: localDateTime(digest.createdAt) },
          { label: "认识状态", value: "记录显示" },
          { label: "上游引用", value: "当前每日整理没有保存逐条原始材料引用" }
        ]
      };
    }
  }

  return {
    eyebrow: "来源不可用",
    title: "原记录当前不可用",
    description: `${lineage.label}。它可能已删除、取消、过期，或当前数据源未连接。`,
    rows: [
      { label: "来源类型", value: lineage.entityType },
      { label: "来源标识", value: lineage.entityId },
      { label: "来源状态", value: "暂时找不到原记录" }
    ],
    missing: true
  };
}

export function SourceDetail({
  lineage,
  todos,
  events,
  goals,
  activities,
  proposals,
  memoryFacts,
  digests,
  onManageGoals
}: {
  lineage: LineageRef;
  todos: Todo[];
  events: CalendarEvent[];
  goals: Goal[];
  activities: ActivityRecord[];
  proposals: ProposalRecord[];
  memoryFacts: MemoryFact[];
  digests: DailyDigestRow[];
  onManageGoals?: () => void;
}) {
  const detail = resolveSource({
    lineage,
    todos,
    events,
    goals,
    activities,
    proposals,
    memoryFacts,
    digests
  });
  const rows = detail.missing
    ? detail.rows
    : [{ label: "与当前内容", value: lineage.label }, ...detail.rows];

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "34px 24px 56px" }}>
      <p className="dim-eyebrow">{detail.eyebrow}</p>
      <h1 style={{ margin: "5px 0 0", fontSize: 24, lineHeight: 1.4 }}>{detail.title}</h1>
      {detail.description && (
        <p style={{ margin: "12px 0 0", fontSize: 13, lineHeight: 1.75, color: "var(--dim-ink-soft)" }}>
          {detail.description}
        </p>
      )}

      <dl
        className="dim-paper"
        style={{ margin: "24px 0 0", padding: "6px 18px", opacity: detail.missing ? 0.78 : 1 }}
      >
        {rows.map((row) => (
          <div
            key={row.label}
            style={{ display: "grid", gridTemplateColumns: "104px 1fr", gap: 18, padding: "12px 0", borderBottom: "1px solid var(--dim-line)" }}
          >
            <dt className="dim-meta">{row.label}</dt>
            <dd style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>{row.value}</dd>
          </div>
        ))}
      </dl>

      {lineage.entityType === "goal" && onManageGoals && (
        <button type="button" className="dim-btn" style={{ marginTop: 18 }} onClick={onManageGoals}>
          管理长期目标 ↗
        </button>
      )}
    </div>
  );
}

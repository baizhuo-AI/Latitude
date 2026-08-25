import { describe, expect, it } from "vitest";
import { buildRealityTimeline } from "./realityTimeline";

describe("buildRealityTimeline", () => {
  it("按真实发生时间汇总并排序，不把记录解释成成长结论", () => {
    const entries = buildRealityTimeline({
      todos: [
        {
          id: "t1",
          title: "完成一次真实验证",
          priority: "none",
          tags: [],
          status: "done",
          createdAt: "2026-08-20T08:00:00Z",
          completedAt: "2026-08-24T18:00:00Z"
        }
      ],
      activities: [
        {
          id: "a1",
          content: "记录了一次复盘",
          occurredAt: "2026-08-24T17:00:00Z",
          createdAt: "2026-08-24T17:05:00Z"
        }
      ],
      proposals: [
        {
          id: "p1",
          quote: "要不要先做一个小实验？",
          status: "try",
          verdictLabel: "要不试试",
          source: "secretary",
          createdAt: "2026-08-24T12:00:00Z",
          decidedAt: "2026-08-24T16:00:00Z"
        }
      ],
      goals: [],
      memoryFacts: [],
      digests: []
    });

    expect(entries.map((entry) => entry.kind)).toEqual([
      "action",
      "activity",
      "decision"
    ]);
    expect(entries[0]).toMatchObject({
      title: "完成了「完成一次真实验证」",
      badge: "行动记录",
      lineage: { entityType: "todo", entityId: "t1" }
    });
    expect(entries[2].title).toContain("要不试试");
    expect(entries.every((entry) => !entry.title.includes("成长"))).toBe(true);
  });

  it("明确区分用户告知和 AI 推测的旧记忆", () => {
    const entries = buildRealityTimeline({
      todos: [],
      activities: [],
      proposals: [],
      goals: [],
      memoryFacts: [
        {
          id: "m1",
          category: "identity",
          content: "用户明确说过的事实",
          source: "told",
          durability: "durable",
          pinned: false,
          createdAt: "2026-08-24T10:00:00Z"
        },
        {
          id: "m2",
          category: "preference",
          content: "模型推测的偏好",
          source: "inferred",
          durability: "transient",
          pinned: false,
          createdAt: "2026-08-24T11:00:00Z"
        }
      ],
      digests: []
    });

    expect(entries[0]).toMatchObject({
      title: "模型推测的偏好",
      badge: "AI 推测 · 未确认"
    });
    expect(entries[1].badge).toBe("你告诉我的");
  });

  it("年度目标与阶段目标使用不同标签", () => {
    const entries = buildRealityTimeline({
      todos: [],
      activities: [],
      proposals: [],
      goals: [
        {
          id: "g-year",
          title: "年度方向",
          period: "year",
          status: "active",
          createdAt: "2026-08-24T10:00:00Z"
        },
        {
          id: "g-month",
          title: "本月目标",
          period: "month",
          status: "active",
          createdAt: "2026-08-24T11:00:00Z"
        }
      ],
      memoryFacts: [],
      digests: []
    });

    expect(entries[0]).toMatchObject({ title: "记录了目标「本月目标」", badge: "阶段目标" });
    expect(entries[1]).toMatchObject({ title: "记录了目标「年度方向」", badge: "长期方向" });
  });
});

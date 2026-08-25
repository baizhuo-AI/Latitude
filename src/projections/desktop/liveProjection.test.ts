import { describe, expect, it } from "vitest";
import type { ActivityRecord, CalendarEvent, Goal } from "../../lib/db";
import type { Todo } from "../../lib/store";
import { validateLayoutDocument } from "../../runtime/layout/validate";
import { buildLiveProjection, dateKeyOf } from "./liveProjection";
import type { LiveProjectionInput } from "./liveProjection";

/**
 * liveProjection 的定向验收：
 * 桌面五区只投影真实记录；没有数据的区域诚实留白；
 * 不合成关系、不伪造状态（前端体验 PRD §3、§10、§13）。
 */

const NOW = new Date(2026, 7, 21, 10, 0); // 2026-08-21 周五 10:00（本地）
const TODAY = "2026-08-21";

function makeTodo(partial: Partial<Todo> & { id: string; title: string }): Todo {
  return {
    priority: "none",
    tags: [],
    status: "todo",
    createdAt: "2026-08-18T09:00:00",
    ...partial
  };
}

function makeEvent(
  partial: Partial<CalendarEvent> & { id: string; title: string }
): CalendarEvent {
  return {
    region: "feishu",
    calendarId: "cal-1",
    remoteEventId: partial.id,
    isAllDay: false,
    status: "confirmed",
    isRecurringInstance: false,
    isWritable: false,
    localDraft: false,
    createdAt: "2026-08-18T09:00:00",
    updatedAt: "2026-08-18T09:00:00",
    ...partial
  };
}

function makeActivity(id: string, occurredAt: string): ActivityRecord {
  return { id, content: `记录 ${id}`, occurredAt, createdAt: occurredAt };
}

function build(overrides: Partial<LiveProjectionInput> = {}) {
  return buildLiveProjection({
    todos: [],
    calendarEvents: [],
    goals: [],
    activities: [],
    now: NOW,
    runtimeStatus: "ready",
    ...overrides
  });
}

function makeGoal(partial: Partial<Goal> & { id: string; title: string }): Goal {
  return {
    period: "year",
    status: "active",
    createdAt: "2026-08-18T09:00:00",
    ...partial
  };
}

function scheduleRows(result: ReturnType<typeof build>) {
  const payload = result.projection.bindings["desktop.schedule"];
  if (payload?.kind !== "anchors") throw new Error("schedule binding 不是 anchors");
  return payload;
}

describe("liveProjection · 日程区", () => {
  it("今天的待办与日历按时间交错排序，血缘指向真实对象", () => {
    const result = build({
      todos: [
        makeTodo({
          id: "t1",
          title: "写评审稿",
          scheduledDate: TODAY,
          scheduledTime: "10:30-12:00"
        }),
        makeTodo({ id: "t2", title: "回客户邮件", scheduledDate: TODAY })
      ],
      calendarEvents: [
        makeEvent({
          id: "e1",
          title: "产品周会",
          scheduledDate: TODAY,
          scheduledTime: "09:00-09:45",
          calendarName: "工作"
        })
      ]
    });

    const rows = scheduleRows(result).rows;
    expect(rows.map((r) => r.text)).toEqual([
      "产品周会",
      "写评审稿",
      "回客户邮件"
    ]);
    // 只有用户待办是行动对象；日历事件是外部事实，不可在桌面上完成
    expect(rows[0].actionable).toBeUndefined();
    expect(rows[0].lineage?.entityType).toBe("calendar_event");
    expect(rows[1].actionable).toBe(true);
    expect(rows[1].lineage).toMatchObject({ entityType: "todo", entityId: "t1" });
    // 全部来自真实记录，不存在秘书推测
    expect(rows.every((r) => r.epistemic === "recorded")).toBe(true);
    // 桌面头部回答「先做什么」：下一个可行动的待办锚点（日历事件是上下文）
    expect(result.projection.header.title).toBe("写评审稿");
  });

  it("不是今天的待办不上桌面", () => {
    const result = build({
      todos: [
        makeTodo({ id: "t1", title: "明天的事", scheduledDate: "2026-08-22" }),
        makeTodo({ id: "t2", title: "没排期的事" })
      ]
    });
    expect(scheduleRows(result).rows).toHaveLength(0);
    expect(scheduleRows(result).emptyHint).toContain("今天还没有锚点");
    expect(result.projection.header.title).toBe("今天还没有锚点");
  });

  it("今天完成的待办收进摘要行，保留为真实结果", () => {
    const result = build({
      todos: [
        makeTodo({
          id: "t1",
          title: "晨会",
          status: "done",
          completedAt: "2026-08-21T08:30:00"
        }),
        makeTodo({
          id: "t2",
          title: "写评审稿",
          scheduledDate: TODAY,
          scheduledTime: "10:30-12:00"
        })
      ]
    });
    const rows = scheduleRows(result).rows;
    const doneRow = rows.find((r) => r.done);
    expect(doneRow?.text).toContain("已完成：晨会");
    expect(doneRow?.actionable).toBeUndefined();
    // 头部指向下一个待办，而不是已完成的事
    expect(result.projection.header.title).toBe("写评审稿");
    expect(result.projection.header.subtitle).toContain("已完成 1 件");
  });

  it("超出承载的事折叠成一行如实说明，不硬塞", () => {
    const todos = Array.from({ length: 9 }, (_, i) =>
      makeTodo({
        id: `t${i}`,
        title: `第 ${i + 1} 件事`,
        scheduledDate: TODAY,
        scheduledTime: `${String(9 + i).padStart(2, "0")}:00-${String(9 + i).padStart(2, "0")}:30`
      })
    );
    const rows = scheduleRows(build({ todos })).rows;
    expect(rows).toHaveLength(7);
    expect(rows[6].text).toContain("另有 3 件事");
  });
});

describe("liveProjection · 节奏区", () => {
  it("没有日程事件时如实说明，柱子不为假", () => {
    const result = build();
    const payload = result.projection.bindings["desktop.rhythm"];
    if (payload?.kind !== "chart") throw new Error("rhythm binding 不是 chart");
    expect(payload.bars.every((b) => b === 0)).toBe(true);
    const card = result.layout.cards.find((c) => c.id === "live-rhythm");
    expect(card?.presentation?.title).toBe("今天没有日程事件");
  });

  it("忙闲分布来自真实事件，下一段时间从此刻起算", () => {
    const start = new Date(2026, 7, 21, 10, 0).getTime() / 1000;
    const end = new Date(2026, 7, 21, 11, 0).getTime() / 1000;
    const result = build({
      calendarEvents: [
        makeEvent({ id: "e1", title: "周会", startTs: start, endTs: end })
      ]
    });
    const payload = result.projection.bindings["desktop.rhythm"];
    if (payload?.kind !== "chart") throw new Error("rhythm binding 不是 chart");
    // 10:00-11:00 落在第 2 段（09:45-11:30），占 60/105 ≈ 0.57
    expect(payload.bars[1]).toBeCloseTo(0.57, 2);
    expect(payload.bars[0]).toBe(0);
    const card = result.layout.cards.find((c) => c.id === "live-rhythm");
    // 此刻在会议里，会后 11:00 → 22:00 是最长完整时间
    expect(card?.presentation?.title).toBe("下一段完整时间：660 分钟");
  });
});

describe("liveProjection · 复盘区", () => {
  it("完成度与记录数都来自本周真实数据", () => {
    const result = build({
      todos: [
        makeTodo({
          id: "t1",
          title: "周一完成的",
          status: "done",
          completedAt: "2026-08-19T18:00:00"
        }),
        makeTodo({
          id: "t2",
          title: "今天还没收口的",
          scheduledDate: TODAY
        })
      ],
      activities: [makeActivity("a1", "2026-08-20T21:00:00")]
    });
    const payload = result.projection.bindings["desktop.reviewPlan"];
    if (payload?.kind !== "progress") throw new Error("reviewPlan 不是 progress");
    expect(payload.percent).toBe(50);
    expect(payload.body).toContain("完成 1 件");
    expect(payload.body).toContain("记下 1 条记录");
    expect(payload.body).toContain("还有 1 件没收口");
  });

  it("什么都没有时体面留白，不假装有进度", () => {
    const result = build();
    const payload = result.projection.bindings["desktop.reviewPlan"];
    if (payload?.kind !== "progress") throw new Error("reviewPlan 不是 progress");
    expect(payload.percent).toBe(0);
    expect(payload.body).toContain("还没有留下记录");
  });
});

describe("liveProjection · 留白与边界", () => {
  it("资讯区宁缺：没有策展结果时明示空着", () => {
    const result = build();
    const payload = result.projection.bindings["desktop.feed"];
    if (payload?.kind !== "feed") throw new Error("feed binding 不是 feed");
    expect(payload.items).toHaveLength(0);
    expect(payload.emptyHint).toContain("空着");
  });

  it("有今日纪要时资讯区放一条「记录显示」，标注来源", () => {
    const result = build({
      todayDigest: {
        date: TODAY,
        summary: "昨天推进了评审稿，今天剩交互验证。",
        createdAt: "2026-08-21T07:30:00"
      }
    });
    const payload = result.projection.bindings["desktop.feed"];
    if (payload?.kind !== "feed") throw new Error("feed binding 不是 feed");
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0].title).toBe("今早的整理");
    expect(payload.items[0].source).toContain("记录显示");
    expect(payload.items[0].lineage?.entityType).toBe("digest");
  });

  it("没有待裁决提案时弹性格是留白便签，不是假提案", () => {
    const result = build();
    const payload = result.projection.bindings["desktop.flex"];
    expect(payload?.kind).toBe("note");
    const flexCard = result.layout.cards.find((c) => c.id === "live-flex");
    expect(flexCard?.kind).toBe("note");
  });

  it("后端给出提案时弹性格切换成提案卡，带完整裁决五态", () => {
    const result = build({
      pendingProposal: {
        id: "p1",
        quote: "要不要把复盘固定到周日下午？",
        consequence: "每周日 16:00 会收到一次回顾邀请",
        status: "proposed",
        source: "secretary",
        createdAt: "2026-08-21T08:00:00"
      }
    });
    const payload = result.projection.bindings["desktop.flex"];
    if (payload?.kind !== "proposal") throw new Error("flex 不是 proposal");
    expect(payload.quote).toContain("周日下午");
    expect(payload.consequence).toContain("每周日");
    expect(payload.verdicts?.map((v) => v.id)).toEqual([
      "interesting",
      "holds",
      "try",
      "reject",
      "park"
    ]);
    const flexCard = result.layout.cards.find((c) => c.id === "live-flex");
    expect(flexCard?.kind).toBe("proposal");
  });

  it("秘书只说她真实知道的：承认图谱未接入", () => {
    const result = build();
    expect(result.projection.secretary.note).toContain("真实记录");
    expect(result.projection.secretary.note).toContain("真的空");
    expect(result.projection.secretary.metrics).toHaveLength(0);
  });

  it("runtimeStatus 原样透传，布局文档通过运行时校验", () => {
    const ready = build({ runtimeStatus: "ready" });
    expect(ready.projection.runtimeStatus).toBe("ready");
    expect(validateLayoutDocument(ready.layout).issues).toHaveLength(0);

    const down = build({ runtimeStatus: "unavailable" });
    expect(down.projection.runtimeStatus).toBe("unavailable");
  });

  it("各数据域读取失败时显示 unknown，不把空数组说成真实没有", () => {
    const result = build({
      todosStatus: "unavailable",
      calendarStatus: "unavailable",
      activitiesStatus: "unavailable",
      proposalsStatus: "unavailable",
      digestStatus: "unavailable",
      runtimeStatus: "unavailable"
    });

    expect(scheduleRows(result).emptyHint).toContain("空白不代表今天没有安排");
    expect(result.projection.header.title).toBe("部分安排暂时不可用");
    expect(result.projection.secretary.headline).toContain("没读出来");
    expect(result.projection.secretary.note).toContain("空白不代表没有");

    const rhythmCard = result.layout.cards.find((card) => card.id === "live-rhythm");
    expect(rhythmCard?.presentation?.title).toBe("日历记录暂时不可用");

    const flex = result.projection.bindings["desktop.flex"];
    expect(flex?.kind).toBe("note");
    if (flex?.kind === "note") expect(flex.body).toContain("无法判断");

    const feed = result.projection.bindings["desktop.feed"];
    if (feed?.kind !== "feed") throw new Error("feed binding 不是 feed");
    expect(feed.emptyHint).toContain("空白不代表今天没有材料");
  });

  it("待办不可用时不渲染伪造的 0% 周进度", () => {
    const result = build({ todosStatus: "unavailable" });
    const review = result.projection.bindings["desktop.reviewPlan"];
    if (review?.kind !== "progress") throw new Error("reviewPlan 不是 progress");

    expect(review.body).toContain("无法计算本周完成度");
    expect(review.percent).toBeUndefined();
  });

  it("dateKeyOf 与本地时区口径一致", () => {
    expect(dateKeyOf(NOW)).toBe(TODAY);
  });
});

describe("liveProjection · 长期方向", () => {
  it("一个进行中目标成为真实长期方向，并保留 Goal 来源", () => {
    const result = build({
      goals: [
        makeGoal({
          id: "g1",
          title: "把维度做成真正可用的个人系统",
          description: "先跑通行动与结果闭环"
        })
      ]
    });

    expect(result.projection.constellation?.northStar).toMatchObject({
      title: "把维度做成真正可用的个人系统",
      detail: "先跑通行动与结果闭环",
      status: "single",
      lineage: { entityType: "goal", entityId: "g1" }
    });
    expect(result.projection.constellation?.cognitions).toHaveLength(0);
    // 当前没有 Goal→Action 血缘，不能拿本周 Todo 完成率冒充目标进度。
    expect(result.projection.constellation?.progress).toBeUndefined();
  });

  it("多个进行中目标不替用户静默挑选唯一北极星", () => {
    const result = build({
      goals: [
        makeGoal({ id: "g1", title: "方向一" }),
        makeGoal({ id: "g2", title: "方向二" })
      ]
    });

    expect(result.projection.constellation?.northStar.status).toBe("multiple");
    expect(result.projection.constellation?.northStar.title).toBe("你有 2 个长期方向");
    expect(result.projection.constellation?.northStar.detail).toContain("不替你挑一个");
    expect(result.projection.constellation?.northStar.lineage).toBeUndefined();
  });

  it("只有月度或季度目标时不冒充长期方向", () => {
    const result = build({
      goals: [
        makeGoal({ id: "g1", title: "本月完成内测", period: "month" }),
        makeGoal({ id: "g2", title: "本季度验证留存", period: "quarter" })
      ]
    });

    expect(result.projection.constellation?.northStar).toMatchObject({
      title: "还没有设定长期方向",
      status: "empty"
    });
    expect(result.projection.constellation?.northStar.detail).toContain(
      "2 个进行中的阶段目标"
    );
    expect(result.projection.constellation?.northStar.lineage).toBeUndefined();
  });

  it("没有进行中目标时诚实留白，不回退到演示北极星", () => {
    const result = build({
      goals: [makeGoal({ id: "g1", title: "旧目标", status: "achieved" })]
    });

    expect(result.projection.constellation?.northStar).toMatchObject({
      title: "还没有设定长期方向",
      status: "empty"
    });
  });

  it("目标数据源失败时显示不可用，不把 unknown 冒充成空目标", () => {
    const result = build({ goals: [], goalsStatus: "unavailable" });

    expect(result.projection.constellation?.northStar).toMatchObject({
      title: "长期目标暂时不可用",
      status: "unavailable"
    });
    expect(result.projection.constellation?.northStar.detail).toContain("无法判断");
  });
});

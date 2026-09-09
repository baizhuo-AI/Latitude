import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  NATIVE_CARD_REGISTRY,
  renderNativeCard
} from "../nativeRegistry";
import {
  limitFeedItems,
  type AnchorCard,
  type ChartCard,
  type FeedCard,
  type FeedItem,
  type NativeCardLayout,
  type NativeCardPayload
} from "../types";
import { DeskCardView } from ".";

const FEED_ITEMS: FeedItem[] = [
  { id: "feed-1", title: "第一条", why: "和当前选择直接相关", source: "Source A" },
  { id: "feed-2", title: "第二条", why: "提供一个相反的角度", source: "Source B" },
  { id: "feed-3", title: "第三条", why: "补齐一个事实缺口", source: "Source C" },
  { id: "feed-4", title: "第四条不应出现", why: "超过上限", source: "Source D" }
];

describe("native cards", () => {
  it("limitFeedItems 最多返回前三条且不修改输入", () => {
    const original = [...FEED_ITEMS];
    const limited = limitFeedItems(original);

    expect(limited.map((item) => item.id)).toEqual(["feed-1", "feed-2", "feed-3"]);
    expect(limited).not.toBe(original);
    expect(original).toEqual(FEED_ITEMS);
  });

  it("资讯卡只渲染三条，并上报条目 id 与稳定反馈值", async () => {
    const user = userEvent.setup();
    const onFeedFeedback = vi.fn();
    const card: FeedCard = {
      kind: "feed",
      id: "feed-card",
      span: 5,
      eyebrow: "Feed / Different Angles",
      title: "今天值得看三眼",
      items: FEED_ITEMS
    };

    render(<DeskCardView card={card} handlers={{ onFeedFeedback }} />);

    expect(screen.getByText("第一条")).toBeInTheDocument();
    expect(screen.getByText("第三条")).toBeInTheDocument();
    expect(screen.queryByText("第四条不应出现")).not.toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "有新角度" })[1]);
    expect(onFeedFeedback).toHaveBeenCalledWith("feed-2", "new-angle");
  });

  it("图表空数组显示紧凑说明，真实的零值仍按数据时段渲染", () => {
    const empty: ChartCard = {
      kind: "chart",
      id: "rhythm-card",
      span: 4,
      eyebrow: "行动回看",
      title: "这些行动该看结果了",
      bars: [],
      emptyHint: "还没有安排需要回看的行动。",
      link: "不应显示成动作",
    };
    const { container, rerender } = render(<DeskCardView card={empty} handlers={{}} />);

    expect(screen.getByText("还没有安排需要回看的行动。")).toBeInTheDocument();
    expect(container.querySelector(".dim-chart-card--empty")).toBeInTheDocument();
    expect(container.querySelector(".dim-chart-bars")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /不应显示成动作/ })).not.toBeInTheDocument();

    rerender(<DeskCardView card={{ ...empty, bars: [0, 0], emptyHint: undefined }} handlers={{}} />);
    expect(screen.queryByText("还没有安排需要回看的行动。")).not.toBeInTheDocument();
    const bars = container.querySelectorAll("[data-chart-value]");
    expect(bars).toHaveLength(2);
    expect(bars[0]).toHaveStyle({ height: "0%" });
    expect(bars[1]).toHaveAttribute("data-chart-value", "0");
  });

  it("锚点卡的血缘入口上报完整实体引用", async () => {
    const user = userEvent.setup();
    const onLineage = vi.fn();
    const lineage = {
      entityType: "experiment",
      entityId: "experiment-42",
      label: "可逆决策实验"
    };
    const card: AnchorCard = {
      kind: "anchors",
      id: "schedule-card",
      span: 7,
      eyebrow: "Schedule / Today",
      title: "今天的时间锚点",
      rows: [{ text: "14:00 复盘决策结果", meta: "NEXT", lineage }]
    };

    render(<DeskCardView card={card} handlers={{ onLineage }} />);
    await user.click(screen.getByRole("button", { name: "查看来源：可逆决策实验" }));

    expect(onLineage).toHaveBeenCalledWith(lineage);
  });

  it("带来源的行动锚点可以行内改名并上报新文字", async () => {
    const user = userEvent.setup();
    const onAnchorEdit = vi.fn();
    const row = {
      text: "和设计走一遍关键交互",
      meta: "14:00",
      actionable: true,
      lineage: { entityType: "todo", entityId: "todo-7", label: "来自你的待办" }
    };
    const card: AnchorCard = {
      kind: "anchors",
      id: "schedule-card",
      span: 7,
      eyebrow: "Schedule / Today",
      title: "今天的锚点",
      rows: [row, { text: "另有 3 件事在今天的待办里", meta: "待办" }]
    };

    render(<DeskCardView card={card} handlers={{ onAnchorEdit }} />);

    // 汇总折叠行没有可写回的实体，不出现编辑入口
    expect(
      screen.queryByRole("button", { name: "编辑：另有 3 件事在今天的待办里" })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "编辑：和设计走一遍关键交互" }));
    const input = screen.getByRole("textbox", { name: "编辑：和设计走一遍关键交互" });
    await user.clear(input);
    await user.type(input, "和设计走完核心路径{Enter}");

    expect(onAnchorEdit).toHaveBeenCalledWith(row, "和设计走完核心路径");
  });

  it("今天做过卡可以写入、修改、撤下并发起待确认回看", async () => {
    const user = userEvent.setup();
    const onActivityCapture = vi.fn();
    const onActivityEdit = vi.fn();
    const onActivityRetract = vi.fn();
    const onActivityReflect = vi.fn();
    const entry = {
      id: "activity-1",
      text: "把第一版服务接回原来的纸面",
      occurredAt: "2026-09-01T15:20:00Z",
      timeLabel: "11:20",
      lineage: {
        entityType: "evidence_event",
        entityId: "activity-1",
        label: "你在今天留下的记录"
      }
    };

    render(
      <DeskCardView
        card={{
          kind: "activity",
          id: "activity-card",
          span: 7,
          eyebrow: "真实记录",
          title: "今天做过",
          entries: [entry, { ...entry, id: "activity-2", text: "确认第一步只做真实记录" }],
          emptyHint: "还没有记录",
          capturePlaceholder: "刚才做了什么？一句话就够",
          canCapture: true,
          canReflect: true
        }}
        handlers={{
          onActivityCapture,
          onActivityEdit,
          onActivityRetract,
          onActivityReflect
        }}
      />
    );

    await user.type(screen.getByRole("textbox", { name: "记下一件已经做过的事" }), "写完活动记录卡");
    await user.click(screen.getByRole("button", { name: "记下" }));
    expect(onActivityCapture).toHaveBeenCalledWith("写完活动记录卡");

    await user.click(screen.getByRole("button", { name: "修改：把第一版服务接回原来的纸面" }));
    const edit = screen.getByRole("textbox", { name: "编辑做过的事：把第一版服务接回原来的纸面" });
    await user.clear(edit);
    await user.type(edit, "把服务接回原纸面{Enter}");
    expect(onActivityEdit).toHaveBeenCalledWith(entry, "把服务接回原纸面");

    await user.click(screen.getByRole("button", { name: "撤下：把第一版服务接回原来的纸面" }));
    expect(onActivityRetract).toHaveBeenCalledWith(entry);
    await user.click(screen.getByRole("button", { name: "帮我看看今天" }));
    expect(onActivityReflect).toHaveBeenCalledOnce();
  });

  it("注册表穷尽十种 kind，未知 kind 直接抛错", () => {
    expect(Object.keys(NATIVE_CARD_REGISTRY)).toEqual([
      "cognition",
      "feed",
      "activity",
      "anchors",
      "count",
      "note",
      "chart",
      "text",
      "proposal",
      "progress"
    ]);

    const layout: NativeCardLayout = {
      id: "unknown-card",
      span: 4,
      eyebrow: "Unknown",
      title: "Unknown"
    };

    expect(() =>
      renderNativeCard(
        { kind: "unknown" } as unknown as NativeCardPayload,
        layout,
        {}
      )
    ).toThrow("Unregistered native card kind: unknown");
  });
});

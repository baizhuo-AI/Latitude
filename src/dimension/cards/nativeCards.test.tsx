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

  it("注册表穷尽九种 kind，未知 kind 直接抛错", () => {
    expect(Object.keys(NATIVE_CARD_REGISTRY)).toEqual([
      "cognition",
      "feed",
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

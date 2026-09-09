import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { FeedCard as FeedCardData } from "../types";
import { FeedCard } from "./FeedCard";

describe("FeedCard short titles", () => {
  it("早报主标题不变，资讯显示短标题并可展开完整原标题", async () => {
    const user = userEvent.setup();
    const original =
      "GitHub - any-owner/graph-memory: 图谱记忆插件；为 Agent 保存长期上下文 · GitHub";
    const card: FeedCardData = {
      kind: "feed",
      id: "daily-feed",
      span: 5,
      eyebrow: "今日资讯",
      title: "今日早报",
      items: [{
        id: "graph-memory",
        title: original,
        why: "与当前记忆产品方向相关。",
        source: "GitHub",
      }],
    };

    render(<FeedCard card={card} />);
    expect(screen.getByRole("heading", { name: "今日早报" })).toBeInTheDocument();
    const shortHeading = screen.getByRole("heading", {
      name: "Graph Memory：图谱记忆插件",
    });
    expect(shortHeading).toHaveAttribute("title", original);

    const disclosure = screen.getByText("原标题").closest("details");
    expect(disclosure).not.toHaveAttribute("open");
    await user.click(screen.getByLabelText(
      "展开完整原标题：Graph Memory：图谱记忆插件",
    ));
    expect(disclosure).toHaveAttribute("open");
    expect(screen.getByText(original, { selector: ".dim-feed-original-title p" }))
      .toBeVisible();
  });

  it("短标题保持原样，不显示多余的原标题入口", () => {
    const card: FeedCardData = {
      kind: "feed",
      id: "daily-feed",
      span: 5,
      eyebrow: "今日资讯",
      title: "今日早报",
      items: [{
        id: "brief",
        title: "新模型开始支持本地工具调用",
        why: "提供一条新进展。",
        source: "官方博客",
      }],
    };
    render(<FeedCard card={card} />);
    expect(screen.getByRole("heading", { name: "新模型开始支持本地工具调用" }))
      .toBeInTheDocument();
    expect(screen.queryByText("原标题")).not.toBeInTheDocument();
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RealityTimeline } from "./RealityTimeline";

describe("RealityTimeline", () => {
  it("读取中不把尚未完成的读取显示成空历史", () => {
    render(<RealityTimeline entries={[]} loading />);

    expect(screen.getByRole("status")).toHaveTextContent("正在读取真实记录");
    expect(screen.queryByText(/还没有留下/)).not.toBeInTheDocument();
  });

  it("部分数据不可用时明确显示不完整状态", () => {
    render(
      <RealityTimeline
        entries={[]}
        unavailableSources={["每日整理", "记忆历史"]}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "部分记录暂时不可用：每日整理、记忆历史"
    );
    expect(screen.getByText(/不能判断没有历史/)).toBeInTheDocument();
  });

  it("来源按钮把真实 lineage 交回上层", () => {
    const onLineage = vi.fn();
    const lineage = {
      entityType: "todo",
      entityId: "todo-1",
      label: "来自你的待办"
    };
    render(
      <RealityTimeline
        entries={[
          {
            id: "entry-1",
            kind: "action",
            occurredAt: "2026-08-24T12:00:00Z",
            title: "完成了真实验证",
            badge: "行动记录",
            lineage
          }
        ]}
        onLineage={onLineage}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "◇ 看来源" }));
    expect(onLineage).toHaveBeenCalledWith(lineage);
  });
});

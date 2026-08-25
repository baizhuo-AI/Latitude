import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SourceDetail } from "./SourceDetail";

const emptySources = {
  todos: [],
  events: [],
  goals: [],
  activities: [],
  proposals: [],
  memoryFacts: [],
  digests: []
};

describe("SourceDetail", () => {
  it("展示真实 Goal 字段与它为什么被当前内容引用", () => {
    render(
      <SourceDetail
        {...emptySources}
        lineage={{
          entityType: "goal",
          entityId: "goal-1",
          label: "来自你的年度目标"
        }}
        goals={[
          {
            id: "goal-1",
            title: "建立稳定的产品验证节奏",
            description: "先做小闭环",
            period: "year",
            status: "active",
            targetDate: "2026-12-31",
            createdAt: "2026-08-24T12:00:00Z"
          }
        ]}
      />
    );

    expect(screen.getByRole("heading", { name: "建立稳定的产品验证节奏" })).toBeInTheDocument();
    expect(screen.getByText("来自你的年度目标")).toBeInTheDocument();
    expect(screen.getByText("2026-12-31")).toBeInTheDocument();
  });

  it("每日整理明确承认没有逐条上游引用", () => {
    render(
      <SourceDetail
        {...emptySources}
        lineage={{ entityType: "digest", entityId: "2026-08-24", label: "来自每日整理" }}
        digests={[
          {
            date: "2026-08-24",
            summary: "今天完成了一次验证。",
            createdAt: "2026-08-24T20:00:00Z"
          }
        ]}
      />
    );

    expect(screen.getByText("当前每日整理没有保存逐条原始材料引用")).toBeInTheDocument();
  });

  it("原对象不存在时不伪造来源", () => {
    render(
      <SourceDetail
        {...emptySources}
        lineage={{ entityType: "todo", entityId: "deleted-1", label: "来自一条待办" }}
      />
    );

    expect(screen.getByRole("heading", { name: "原记录当前不可用" })).toBeInTheDocument();
    expect(screen.getByText(/不能假装依据完整/)).toBeInTheDocument();
  });
});

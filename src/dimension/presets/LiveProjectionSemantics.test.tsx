import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Goal } from "../../lib/db";
import type { Todo } from "../../lib/store";
import { buildLiveProjection } from "../../projections/desktop/liveProjection";
import { ClueBoardPreset } from "./ClueBoardPreset";
import { ConstellationPreset } from "./ConstellationPreset";

const NOW = new Date(2026, 7, 24, 10, 0);

function liveProjection() {
  const todo: Todo = {
    id: "todo-live",
    title: "验证真实接线",
    priority: "none",
    tags: ["Latitude"],
    status: "todo",
    scheduledDate: "2026-08-24",
    createdAt: "2026-08-24T08:00:00Z"
  };
  const goal: Goal = {
    id: "goal-live",
    title: "把维度做成可靠的个人系统",
    period: "year",
    status: "active",
    createdAt: "2026-08-20T08:00:00Z"
  };
  return buildLiveProjection({
    todos: [todo],
    calendarEvents: [],
    goals: [goal],
    activities: [],
    now: NOW,
    runtimeStatus: "ready"
  }).projection;
}

describe("真实投影的上层语义边界", () => {
  it("标签分组可调整板面连线，但不会把视觉线冒充认知关系", () => {
    render(<ClueBoardPreset projection={liveProjection()} />);

    expect(screen.getByRole("heading", { name: "线索版" })).toBeInTheDocument();
    expect(screen.getByText("所有纸片可拖动 · 板面连线不会写成认知事实")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /编辑「Latitude」连接，当前为支撑/ })).toBeVisible();
  });

  it("typed 中期目标成为线索主题，板面连线可调但明确不改 Domain 关系", () => {
    const projection = liveProjection();
    projection.clueBoard = {
      title: "2 个中期目标",
      subtitle: "按明确 goalId 血缘展开。",
      themes: [
        {
          id: "goal-theme-client",
          title: "完成客户交付",
          detail: "先完成可验收的业务结果。",
          pending: 2,
          done: 0,
          lineage: {
            entityType: "goal",
            entityId: "goal-medium-client",
            label: "来自统一 Domain 的中期目标",
          },
          rows: [
            {
              text: "形成一页客户经营 POC 方案",
              meta: "关联行动",
              actionable: true,
              lineage: {
                entityType: "action",
                entityId: "action-client-poc",
                label: "来自统一 Domain 的中期目标行动",
              },
            },
          ],
        },
      ],
    };

    render(<ClueBoardPreset projection={projection} />);

    expect(screen.getByRole("heading", { name: "线索版" })).toBeInTheDocument();
    expect(screen.getByText("拖动纸签 · 点击连线编辑")).toBeVisible();
    expect(screen.getByRole("button", { name: /中期目标 1：完成客户交付/ })).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: /编辑「完成客户交付」连接，当前为支撑/ })
    );
    expect(screen.getByRole("complementary", { name: "编辑连接：完成客户交付" }))
      .toHaveTextContent("不会改变原始关系");
  });

  it("星图只放长期方向与认知，不把今日锚点抬成星", () => {
    const { container } = render(<ConstellationPreset projection={liveProjection()} />);

    expect(
      screen.getByRole("region", { name: "夜空：北极星、认知评价与大想法" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /今日锚点：验证真实接线/ })).not.toBeInTheDocument();
    expect(screen.getByText("这里只放北极星、认知评价与大想法")).toBeInTheDocument();
    // 星尘只是氛围层，保持有界，避免数百个常驻动画拖慢三层切换。
    expect(container.querySelectorAll(".cst-dust-point")).toHaveLength(84);
    // Restored entry/exit keyframes need actual radial offsets on every star and dust point.
    for (const star of container.querySelectorAll<HTMLElement>(".cst-star, .cst-dust-point")) {
      const x = parseFloat(star.style.getPropertyValue("--gx"));
      const y = parseFloat(star.style.getPropertyValue("--gy"));
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
      expect(Math.hypot(x, y)).toBeGreaterThan(0);
    }
    expect(new Set(Array.from(container.querySelectorAll<HTMLElement>(".cst-dust-point"),
      dust => dust.style.getPropertyValue("--gather-delay"))).size).toBe(3);
  });

  it("只把 Domain active/disputed orbits 画成正式轨道，并展示真实 StarState", () => {
    const projection = liveProjection();
    projection.constellation = {
      northStar: {
        title: "把维度做成可靠的个人系统",
        detail: "明确记录的长期目标",
        status: "single",
        lineage: {
          entityType: "goal",
          entityId: "goal-live",
          label: "来自统一认知行为星图",
        },
      },
      cognitions: [
        {
          id: "claim-live",
          label: "上午更容易进入写作状态",
          detail: "有三次已记录的行动结果",
          epistemic: "inferred",
          lineage: {
            entityType: "claim",
            entityId: "claim-live",
            label: "来自统一认知行为星图",
          },
          starState: {
            version: 2,
            role: "active_star",
            importance: "high",
            importanceAuthority: "system_inferred",
            salience: "hot",
            organizingPower: "connecting",
            freshness: "current",
            mass: "supported",
            radius: "medium",
            auraVersion: 1,
            stateStatus: "active",
            recomputeRequired: false,
          },
          orbit: {
            centerNodeId: "goal-live",
            centerLabel: "把维度做成可靠的个人系统",
            relationType: "orbits",
            proximity: "near",
            strength: "strong",
          },
        },
      ],
    };

    const onDiscussNode = vi.fn();
    const { container } = render(<ConstellationPreset projection={projection} onDiscussNode={onDiscussNode} />);
    expect(container.querySelector(".cst-orbit-svg line[data-relation='orbits']"))
      .toBeInTheDocument();
    expect(screen.getByText("1 条已确认的轨道")).toBeInTheDocument();

    const star = screen.getByRole("button", { name: /认知星：上午更容易进入写作状态/ });
    fireEvent.click(star);
    expect(star).toHaveAttribute("aria-pressed", "true");
    expect(star.style.getPropertyValue("--cst-size")).toBe("12px");
    expect(screen.queryByText(/组织力 connecting/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "和维度聊聊" }));
    expect(onDiscussNode).toHaveBeenCalledWith(expect.objectContaining({
      domainNodeId: "claim-live", orbitCenterId: "goal-live", orbitRelation: "orbits",
      lineage: projection.constellation.cognitions[0].lineage,
      detail: expect.stringContaining("已根据近期记录更新"),
    }));
    expect(onDiscussNode.mock.calls[0][0].detail).toContain("与「把维度做成可靠的个人系统」有已确认的关联");
  });
});

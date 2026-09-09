import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SecretaryRail } from "./Shell";
import type { Secretary } from "./types";

const SECRETARY: Secretary = {
  eyebrow: "YOUR SECRETARY",
  state: "presenting",
  gesture: "offering",
  stateCn: "有事说",
  headline: "内部生成的长说明不应常驻显示。",
  note: "内部生成的依据不应常驻显示。",
  stageLabel: "内部阶段",
  stageProgress: 74,
  stageNote: "typed basis / receipt",
  metrics: [
    { label: "熟悉", value: 78, tone: "olive", basis: "内部依据" },
    { label: "默契", value: 71, tone: "blue", basis: "内部依据" },
    { label: "权能", value: 46, tone: "rust", basis: "内部依据" }
  ]
};

describe("SecretaryRail relationship progress and simplified interaction", () => {
  it("常驻区恢复三条独立关系进度，以阶段词而非裸数值解释变化", () => {
    render(<SecretaryRail secretary={SECRETARY} />);

    expect(screen.getByText("秘书")).toBeVisible();
    expect(screen.getByText("找你")).toBeVisible();
    expect(screen.getByText("有件事需要你看看。")).toBeVisible();
    expect(screen.getByRole("heading", { name: "了解你的进度" })).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "关系 · 懂处境" }))
      .toHaveAttribute("aria-valuenow", "78");
    expect(screen.getByRole("progressbar", { name: "默契 · 合拍" }))
      .toHaveAttribute("aria-valuenow", "71");
    expect(screen.getByRole("progressbar", { name: "权能 · 代我准备" }))
      .toHaveAttribute("aria-valuenow", "46");
    expect(screen.queryByText("YOUR SECRETARY")).not.toBeInTheDocument();
    expect(screen.queryByText("内部阶段")).not.toBeInTheDocument();
    expect(screen.queryByText(/typed|receipt/i)).not.toBeInTheDocument();
    for (const basis of screen.getAllByText("内部依据")) {
      expect(basis).not.toBeVisible();
    }
  });

  it("可以逐条展开依据，并在存在来源时继续查看详情", () => {
    const onRelationInspect = vi.fn();
    const familiarity = {
      ...SECRETARY.metrics[0],
      lineage: [{
        entityType: "relationship",
        entityId: "node-relationship",
        label: "熟悉依据"
      }]
    };
    render(
      <SecretaryRail
        secretary={{ ...SECRETARY, metrics: [familiarity, ...SECRETARY.metrics.slice(1)] }}
        onRelationInspect={onRelationInspect}
      />
    );

    fireEvent.click(screen.getByLabelText("查看关系依据"));
    expect(screen.getAllByText("内部依据")[0]).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "查看关系来源详情" }));
    expect(onRelationInspect).toHaveBeenCalledWith(familiarity);
  });

  it("没有关系记录时仍显示诚实的零进度与空状态依据", () => {
    render(<SecretaryRail secretary={{ ...SECRETARY, metrics: [] }} />);

    expect(screen.getByRole("progressbar", { name: "关系 · 尚未形成" }))
      .toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByRole("progressbar", { name: "默契 · 尚未形成" }))
      .toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByRole("progressbar", { name: "权能 · 未授权" }))
      .toHaveAttribute("aria-valuenow", "0");
  });

  it("空闲和处理中使用短句", () => {
    const { rerender } = render(
      <SecretaryRail
        secretary={{ ...SECRETARY, state: "ready", gesture: "idle", stateCn: "在岗" }}
      />
    );
    expect(screen.getByText("今天想先做什么？")).toBeVisible();
    expect(screen.getByText("在")).toBeVisible();

    rerender(
      <SecretaryRail
        secretary={{ ...SECRETARY, state: "thinking", gesture: "pondering", stateCn: "处理中" }}
      />
    );
    expect(screen.getByText("稍等…")).toBeVisible();
    expect(screen.getByText("处理中")).toBeVisible();
  });

  it("点立绘直接打开对话，不再展开一组中间话术", () => {
    const onInteract = vi.fn();
    render(<SecretaryRail secretary={SECRETARY} onInteract={onInteract} />);

    fireEvent.click(screen.getByRole("button", { name: "打开对话" }));
    expect(onInteract).toHaveBeenCalledWith("chat");
    expect(screen.queryByRole("button", { name: "聊聊" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "换个表情" })).not.toBeInTheDocument();
  });

  it("聊天关闭但提醒可用时，立绘退化为待处理入口", () => {
    const onInteract = vi.fn();
    render(
      <SecretaryRail
        secretary={SECRETARY}
        notice="有一个结果需要确认。"
        onInteract={onInteract}
        actionAvailability={{ chat: false, review: true, outcome: true }}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent("有一个结果需要确认。");
    fireEvent.click(screen.getByRole("button", { name: "查看待处理" }));
    expect(onInteract).toHaveBeenCalledWith("decide");
  });

  it("有提醒时点立绘仍打开同一个对话，不在秘书栏制造第二入口", () => {
    const onInteract = vi.fn();
    render(
      <SecretaryRail
        secretary={SECRETARY}
        notice="有一个结果需要确认。"
        onInteract={onInteract}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "打开对话" }));
    expect(onInteract).toHaveBeenLastCalledWith("chat");
    expect(screen.queryByRole("button", { name: "查看提醒" })).not.toBeInTheDocument();
  });

  it("内部调度文本不会撑开秘书栏", () => {
    render(
      <SecretaryRail
        secretary={SECRETARY}
        notice={"该 action 已到日历触底 reviewAt，但这是无人值守提醒，没有新的用户证据。\n**Action**: 跑通维度完整产品闭环 (node_40e31aca, sensitivity low, demo profile)\n只接受 typed 依据和授权 receipt。"}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent("有件事需要你看看。");
    expect(screen.queryByText(/reviewAt|node_|sensitivity|typed|receipt|\*\*Action\*\*/i))
      .not.toBeInTheDocument();
  });

  it("保留收起、设置和隐藏后的唤回入口", () => {
    const onToggleCollapse = vi.fn();
    const onSettings = vi.fn();
    const first = render(
      <SecretaryRail
        secretary={SECRETARY}
        onToggleCollapse={onToggleCollapse}
        onSettings={onSettings}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "收起秘书栏" }));
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(onToggleCollapse).toHaveBeenCalledOnce();
    expect(onSettings).toHaveBeenCalledOnce();
    first.unmount();

    const onVisibilityChange = vi.fn();
    render(
      <SecretaryRail
        secretary={SECRETARY}
        visible={false}
        onVisibilityChange={onVisibilityChange}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "唤回秘书" }));
    expect(onVisibilityChange).toHaveBeenCalledWith(true);
  });
});

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretaryRail } from "./Shell";
import type { Secretary } from "./types";

const SECRETARY: Secretary = {
  eyebrow: "YOUR SECRETARY",
  state: "presenting",
  gesture: "offering",
  stateCn: "有事说",
  headline: "我把今天收成了四个锚点。",
  note: "先发日报，再修 badcase。",
  stageLabel: "默契 · 合拍",
  stageProgress: 74,
  stageNote: "每一步都由你决定。",
  metrics: [
    { label: "熟悉", value: 78, tone: "olive" },
    { label: "默契", value: 71, tone: "blue" },
    { label: "权能", value: 46, tone: "rust" }
  ]
};

afterEach(() => vi.useRealTimers());

describe("SecretaryRail relationship and interaction", () => {
  it("独立展示熟悉、默契、权能的阶段词与可访问进度", () => {
    render(<SecretaryRail secretary={SECRETARY} />);

    const familiarity = screen.getByRole("progressbar", { name: "熟悉 · 懂处境" });
    const rapport = screen.getByRole("progressbar", { name: "默契 · 合拍" });
    const authority = screen.getByRole("progressbar", { name: "权能 · 代我准备" });

    expect(familiarity).toHaveAttribute("aria-valuenow", "78");
    expect(rapport).toHaveAttribute("aria-valuenow", "71");
    expect(authority).toHaveAttribute("aria-valuenow", "46");
    expect(screen.getByText("懂处境")).toBeVisible();
    expect(screen.getAllByText("合拍").length).toBeGreaterThan(0);
    expect(screen.getByText("代我准备")).toBeVisible();
  });

  it("三条保持紧凑同屏，并可展开 typed 依据与真实来源", () => {
    const onRelationInspect = vi.fn();
    render(
      <SecretaryRail
        secretary={{
          ...SECRETARY,
          stageLabel: "关系 · 有据可查",
          stageProgress: 0,
          stageNote: "熟悉与默契只读带纠正契约的依据；当前入口只查看来源。",
          metrics: [
            {
              label: "熟悉",
              value: 46,
              tone: "olive",
              stage: "初步熟悉",
              basis: "已整理目标层级，尚未经过长期互动校准。",
              epistemicAuthority: "imported_unverified",
              correctable: true,
              lineage: [{ entityType: "insight", entityId: "relationship-1", label: "关系记录" }],
            },
            {
              label: "默契",
              value: 32,
              tone: "blue",
              stage: "正在建立",
              basis: "已能复述部分偏好，尚无真实行动结果闭环。",
              epistemicAuthority: "imported_unverified",
              correctable: true,
              lineage: [{ entityType: "insight", entityId: "relationship-1", label: "关系记录" }],
            },
            {
              label: "权能",
              value: 0,
              tone: "rust",
              stage: "未授权",
              basis: "本演示不包含 capability grant receipt。",
              correctable: false,
              lineage: [{ entityType: "insight", entityId: "relationship-1", label: "关系记录" }],
            },
          ],
        }}
        onRelationInspect={onRelationInspect}
      />
    );

    expect(screen.getByRole("progressbar", { name: "熟悉 · 初步熟悉" })).toHaveAttribute(
      "aria-valuenow",
      "46"
    );
    expect(screen.getByRole("progressbar", { name: "默契 · 正在建立" })).toHaveAttribute(
      "aria-valuenow",
      "32"
    );
    expect(screen.getByRole("progressbar", { name: "权能 · 未授权" })).toHaveAttribute(
      "aria-valuenow",
      "0"
    );
    expect(screen.getAllByText("查看依据")).toHaveLength(3);
    fireEvent.click(screen.getByLabelText("查看熟悉依据"));
    expect(screen.getByText(/已整理目标层级/)).toBeVisible();
    expect(screen.getByText(/已整理目标层级/)).toHaveTextContent("脱敏导入，待核验");
    fireEvent.click(screen.getByRole("button", { name: "查看熟悉来源详情" }));
    expect(onRelationInspect).toHaveBeenCalledWith(
      expect.objectContaining({ label: "熟悉", value: 46 })
    );
  });

  it("缺少 typed 关系数据时仍显示三条诚实的零值状态", () => {
    render(<SecretaryRail secretary={{ ...SECRETARY, metrics: [] }} />);

    expect(screen.getByRole("progressbar", { name: "熟悉 · 尚未形成" })).toHaveAttribute(
      "aria-valuenow",
      "0"
    );
    expect(screen.getByRole("progressbar", { name: "默契 · 尚未形成" })).toHaveAttribute(
      "aria-valuenow",
      "0"
    );
    expect(screen.getByRole("progressbar", { name: "权能 · 未授权" })).toHaveAttribute(
      "aria-valuenow",
      "0"
    );
  });

  it("快捷动作可点且执行后收口，立绘二次点击也可收口", () => {
    const onInteract = vi.fn();
    render(<SecretaryRail secretary={SECRETARY} onInteract={onInteract} />);

    const portrait = screen.getByRole("button", { name: "跟她说句话" });
    fireEvent.click(portrait);
    fireEvent.click(screen.getByRole("button", { name: "聊聊" }));
    expect(onInteract).toHaveBeenLastCalledWith("chat");
    expect(screen.queryByRole("button", { name: "聊聊" })).not.toBeInTheDocument();

    fireEvent.click(portrait);
    fireEvent.click(screen.getByRole("button", { name: "有什么要我定的？" }));
    expect(onInteract).toHaveBeenLastCalledWith("decide");
    expect(screen.queryByRole("button", { name: "有什么要我定的？" })).not.toBeInTheDocument();

    fireEvent.click(portrait);
    expect(portrait).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(portrait);
    expect(portrait).toHaveAttribute("aria-expanded", "false");
  });

  it("可轮换桌宠表情，但不把陪伴反应冒充新的业务动作", () => {
    const onInteract = vi.fn();
    render(<SecretaryRail secretary={SECRETARY} onInteract={onInteract} />);

    fireEvent.click(screen.getByRole("button", { name: "跟她说句话" }));
    expect(screen.getByRole("img", { name: "秘书状态：有事说；动作：递交" })).toBeVisible();
    expect(screen.getByText("桌上有一张纸，等你看看。")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "换个表情" }));
    expect(screen.getByRole("img", { name: "秘书状态：有事说；动作：递交" })).toBeVisible();
    expect(screen.getByText("要不要先从最关键的一处看？")).toBeVisible();
    expect(onInteract).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "换个表情" }));
    expect(screen.getByRole("img", { name: "秘书状态：有事说；动作：递交" })).toBeVisible();
    expect(screen.getByText("我在这儿，决定权还在你手里。")).toBeVisible();
  });

  it("键盘焦点停在气泡内时不会被自动关闭吃掉", () => {
    vi.useFakeTimers();
    render(<SecretaryRail secretary={SECRETARY} onInteract={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "跟她说句话" }));
    const expression = screen.getByRole("button", { name: "换个表情" });
    expression.focus();
    act(() => vi.advanceTimersByTime(7001));
    expect(expression).toHaveFocus();
    expect(screen.getByRole("button", { name: "换个表情" })).toBeVisible();

    screen.getByRole("button", { name: "跟她说句话" }).focus();
    act(() => vi.advanceTimersByTime(7001));
    expect(screen.queryByRole("button", { name: "换个表情" })).not.toBeInTheDocument();
  });

  it("业务状态改变时保留正在操作的气泡与键盘焦点", () => {
    const { rerender } = render(
      <SecretaryRail secretary={SECRETARY} onInteract={vi.fn()} />
    );
    const portrait = screen.getByRole("button", { name: "跟她说句话" });
    fireEvent.click(portrait);
    screen.getByRole("button", { name: "换个表情" }).focus();

    rerender(
      <SecretaryRail
        secretary={{
          ...SECRETARY,
          state: "ready",
          stateCn: "在岗",
          gesture: "idle"
        }}
        onInteract={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "换个表情" })).toHaveFocus();
    expect(portrait).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("我在。今天想先收哪一小块？")).toBeVisible();
  });

  it("回顾出口不被气泡遮挡，点击后同样收口", () => {
    const onReview = vi.fn();
    render(<SecretaryRail secretary={SECRETARY} onReview={onReview} />);

    fireEvent.click(screen.getByRole("button", { name: "跟她说句话" }));
    fireEvent.click(screen.getByRole("button", { name: "看看我们是怎么熟起来的" }));

    expect(onReview).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "聊聊" })).not.toBeInTheDocument();
  });

  it("接住事件提醒，并按 UiSurface 绑定独立禁用聊天、结果与回顾", () => {
    const onInteract = vi.fn();
    const onReview = vi.fn();
    const { rerender } = render(
      <SecretaryRail
        secretary={SECRETARY}
        notice="现实事件已经触发结果回收。"
        onInteract={onInteract}
        onReview={onReview}
        actionAvailability={{ chat: false, review: true, outcome: false }}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent("现实事件已经触发结果回收。");
    fireEvent.click(screen.getByRole("button", { name: "跟她说句话" }));
    expect(screen.getByRole("button", { name: "聊聊" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "有什么要我定的？" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "看看我们是怎么熟起来的" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "聊聊" }));
    fireEvent.click(screen.getByRole("button", { name: "有什么要我定的？" }));
    expect(onInteract).not.toHaveBeenCalled();

    rerender(
      <SecretaryRail
        secretary={SECRETARY}
        onInteract={onInteract}
        onReview={onReview}
        actionAvailability={{ chat: true, review: false, outcome: true }}
      />
    );
    expect(screen.getByRole("button", { name: "看看我们是怎么熟起来的" })).toBeDisabled();
  });

  it("隐藏时只留下左侧安全唤回入口", () => {
    const onVisibilityChange = vi.fn();
    render(
      <SecretaryRail
        secretary={SECRETARY}
        visible={false}
        onVisibilityChange={onVisibilityChange}
      />
    );

    expect(screen.getByRole("complementary", { name: "秘书栏（已隐藏）" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "唤回秘书" }));
    expect(onVisibilityChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("button", { name: "跟她说句话" })).not.toBeInTheDocument();
  });
});

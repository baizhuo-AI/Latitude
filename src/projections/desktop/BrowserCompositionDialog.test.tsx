import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  createBrowserCompositionRegistry,
  layoutV1ToUiSurfaceV2,
} from "../../runtime/composition/browserProduction";
import type { AppliedUiChange } from "../../runtime/composition/types";
import { SEED_LAYOUT_DOCUMENT } from "../../runtime/layout/seedLayout";
import { BrowserCompositionDialog } from "./BrowserCompositionDialog";

describe("BrowserCompositionDialog V2 control plane", () => {
  it("lets a user adjust five cards, secretary rail and fixed system modules", async () => {
    const user = userEvent.setup();
    const layout = structuredClone(SEED_LAYOUT_DOCUMENT);
    layout.id = "latitude-browser-live";
    layout.revision = 3;
    const document = layoutV1ToUiSurfaceV2(layout);
    const onApply = vi.fn();
    render(
      <BrowserCompositionDialog
        layout={layout}
        document={document}
        registry={createBrowserCompositionRegistry()}
        history={[]}
        onApply={onApply}
        onRollback={vi.fn()}
        onReset={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // The modal stays above the workspace, including the global secretary rail.
    expect(screen.getByRole("dialog", { name: "桌面设置" })).toHaveClass("dimension-root");
    expect(screen.getByRole("dialog", { name: "桌面设置" })).toHaveStyle({
      zIndex: "100",
    });

    await user.clear(screen.getByRole("textbox", { name: "feed 标题" }));
    await user.type(screen.getByRole("textbox", { name: "feed 标题" }), "我的证据雷达");
    await user.selectOptions(screen.getByRole("combobox", { name: "feed 宽度" }), "12");
    await user.click(screen.getByRole("checkbox", { name: "feed 隐藏" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "feed 资讯反馈动作" }),
      "",
    );
    await user.click(screen.getByRole("checkbox", { name: "隐藏秘书栏" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "秘书栏 打开对话动作" }),
      "",
    );
    await user.click(screen.getByRole("checkbox", { name: "隐藏本地产品闭环控制" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "候选共创 搁置候选动作" }),
      "",
    );
    await user.click(screen.getByRole("button", { name: "下移 feed" }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "user",
        cards: expect.objectContaining({
          "seed-feed": expect.objectContaining({
            hidden: true,
            span: 12,
            title: "我的证据雷达",
            actions: expect.objectContaining({ feedback: null }),
          }),
          "secretary-companion": expect.objectContaining({
            hidden: true,
            actions: expect.objectContaining({ chat: null }),
          }),
          "browser-control-strip": expect.objectContaining({ hidden: true }),
          "candidate-intervention-strip": expect.objectContaining({
            actions: expect.objectContaining({ park: null }),
          }),
        }),
        orderedCardIds: [
          "seed-schedule",
          "seed-feed",
          "seed-review-plan",
          "seed-rhythm",
          "seed-flex",
        ],
      }),
    );
  });

  it("多层反转只陈述历史事实，不把奇偶层误写成固定的重做", async () => {
    const user = userEvent.setup();
    const layout = structuredClone(SEED_LAYOUT_DOCUMENT);
    layout.id = "latitude-browser-live";
    layout.revision = 6;
    const document = layoutV1ToUiSurfaceV2(layout);
    const operation = {
      op: "setVisibility" as const,
      componentId: "seed-feed",
      visible: false,
    };
    const inverse = { ...operation, visible: true };
    const history: AppliedUiChange[] = [
      {
        id: "apply-1",
        actor: "user",
        authorization: "direct_user",
        reason: "隐藏资讯",
        beforeRevision: 3,
        afterRevision: 4,
        operations: [operation],
        inverse: [inverse],
        appliedAt: "2026-08-24T12:00:00Z",
        rolledBackBy: "reverse-1",
      },
      {
        id: "reverse-1",
        actor: "user",
        authorization: "direct_user",
        reason: "反转 apply-1",
        beforeRevision: 4,
        afterRevision: 5,
        operations: [inverse],
        inverse: [operation],
        appliedAt: "2026-08-24T12:01:00Z",
        rollbackOf: "apply-1",
        rolledBackBy: "reverse-2",
      },
      {
        id: "reverse-2",
        actor: "user",
        authorization: "direct_user",
        reason: "反转 reverse-1",
        beforeRevision: 5,
        afterRevision: 6,
        operations: [operation],
        inverse: [inverse],
        appliedAt: "2026-08-24T12:02:00Z",
        rollbackOf: "reverse-1",
      },
    ];
    const onRollback = vi.fn();
    render(
      <BrowserCompositionDialog
        layout={layout}
        document={document}
        registry={createBrowserCompositionRegistry()}
        history={history}
        onApply={vi.fn()}
        onRollback={onRollback}
        onReset={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByText("变更记录"));
    expect(screen.getAllByText(/曾被反转/)).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "已被反转" })).toHaveLength(2);
    expect(screen.queryByText(/重做/)).not.toBeInTheDocument();
    const available = screen.getByRole("button", { name: "反转这条操作" });
    await user.click(available);
    expect(onRollback).toHaveBeenCalledWith("reverse-2");
  });
});

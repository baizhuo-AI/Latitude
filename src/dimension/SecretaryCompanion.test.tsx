import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SEED_DESKTOP_PROJECTION } from "../projections/desktop/seedProjection";
import { SecretaryCompanion } from "./SecretaryCompanion";

describe("SecretaryCompanion", () => {
  beforeEach(() => window.localStorage.clear());

  it("is independent from a rail and exposes real interaction exits", () => {
    const onInteract = vi.fn();
    const onReview = vi.fn();
    render(
      <SecretaryCompanion
        secretary={SEED_DESKTOP_PROJECTION.secretary}
        onInteract={onInteract}
        onReview={onReview}
      />,
    );

    expect(screen.getByLabelText("独立秘书桌宠")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "和秘书说话" }));
    fireEvent.click(screen.getByRole("button", { name: "聊聊" }));
    expect(screen.queryByLabelText("秘书面板")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "和秘书说话" }));
    fireEvent.click(screen.getByRole("button", { name: "一起回顾" }));
    expect(screen.queryByLabelText("秘书面板")).not.toBeInTheDocument();

    expect(onInteract).toHaveBeenCalledWith("chat");
    expect(onReview).toHaveBeenCalledOnce();
  });

  it("can hide without becoming impossible to recover", () => {
    render(<SecretaryCompanion secretary={SEED_DESKTOP_PROJECTION.secretary} />);
    fireEvent.click(screen.getByRole("button", { name: "暂时隐藏秘书" }));
    expect(screen.queryByLabelText("独立秘书桌宠")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "唤回秘书" }));
    expect(screen.getByLabelText("独立秘书桌宠")).toBeInTheDocument();
  });

  it("starts above the persistent bottom controls on a fresh profile", () => {
    render(<SecretaryCompanion secretary={SEED_DESKTOP_PROJECTION.secretary} />);
    expect(screen.getByLabelText("独立秘书桌宠")).toHaveStyle({
      top: `${Math.max(72, window.innerHeight - 390)}px`,
    });
  });

  it("V2 visible overrides legacy hidden while retaining and mirroring x/y position", async () => {
    window.localStorage.setItem(
      "latitude.secretary-companion.v1",
      JSON.stringify({ x: 123, y: 234, hidden: true }),
    );
    const onVisibilityChange = vi.fn();
    const { rerender } = render(
      <SecretaryCompanion
        secretary={SEED_DESKTOP_PROJECTION.secretary}
        visible
        onVisibilityChange={onVisibilityChange}
      />,
    );
    const companion = screen.getByLabelText("独立秘书桌宠");
    expect(companion).toHaveStyle({ left: "123px", top: "234px" });
    await waitFor(() => expect(JSON.parse(
      window.localStorage.getItem("latitude.secretary-companion.v1")!,
    )).toEqual({ x: 123, y: 234, hidden: false }));

    fireEvent.click(screen.getByRole("button", { name: "暂时隐藏秘书" }));
    expect(onVisibilityChange).toHaveBeenCalledWith(false);
    rerender(
      <SecretaryCompanion
        secretary={SEED_DESKTOP_PROJECTION.secretary}
        visible={false}
        onVisibilityChange={onVisibilityChange}
      />,
    );
    expect(screen.getByRole("button", { name: "唤回秘书" })).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(
      window.localStorage.getItem("latitude.secretary-companion.v1")!,
    )).toEqual({ x: 123, y: 234, hidden: true }));
  });

  it("unbound chat/review/outcome are explicitly disabled and never execute", () => {
    const onInteract = vi.fn();
    const onReview = vi.fn();
    render(
      <SecretaryCompanion
        secretary={SEED_DESKTOP_PROJECTION.secretary}
        onInteract={onInteract}
        onReview={onReview}
        actionAvailability={{ chat: false, review: false, outcome: false }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "和秘书说话" }));
    const chat = screen.getByRole("button", { name: "聊聊" });
    const outcome = screen.getByRole("button", { name: "看看有什么要定" });
    const review = screen.getByRole("button", { name: "一起回顾" });
    expect(chat).toBeDisabled();
    expect(chat).toHaveAttribute("title", "秘书对话已在组件设置中关闭");
    expect(outcome).toBeDisabled();
    expect(review).toBeDisabled();
    fireEvent.click(chat);
    fireEvent.click(outcome);
    fireEvent.click(review);
    expect(onInteract).not.toHaveBeenCalled();
    expect(onReview).not.toHaveBeenCalled();
  });

  it("never exposes a raw scheduler payload in the open bubble", () => {
    render(
      <SecretaryCompanion
        secretary={SEED_DESKTOP_PROJECTION.secretary}
        notice={"该 action 已到 reviewAt。\n**Action**: node_40e31aca, sensitivity low, demo profile, typed receipt"}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("有件事需要你看看。");
    expect(screen.queryByText(/reviewAt|node_|sensitivity|typed|receipt|\*\*Action\*\*/i))
      .not.toBeInTheDocument();
  });
});

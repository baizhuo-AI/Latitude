import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DimensionApp } from "./DimensionApp";

describe("DimensionApp seed runtime", () => {
  it("诚实展示演示模式，渲染五区且不外显养成裸值", () => {
    const { container } = render(<DimensionApp />);

    expect(screen.getByText("演示模式")).toBeVisible();
    expect(container.querySelectorAll("[data-layout-card-id]")).toHaveLength(5);
    expect(screen.queryByText("78")).not.toBeInTheDocument();
    expect(screen.queryByText("71")).not.toBeInTheDocument();
    expect(screen.queryByText("46")).not.toBeInTheDocument();
    expect(screen.getByText("关系 · 脱敏演示")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "权能 · 未授权" }))
      .toHaveAttribute("aria-valuenow", "0");
  });

  it("所有未接线动作都给出演示模式提示", () => {
    render(<DimensionApp />);

    fireEvent.click(screen.getAllByRole("button", { name: "有新角度" })[0]);
    expect(screen.getByRole("status")).toHaveTextContent("演示模式");
    expect(screen.getByRole("status")).toHaveTextContent("本次不会保存");
  });

  it("初始隐藏的本子层通过 inert 退出键盘可达树", () => {
    const { container } = render(<DimensionApp />);

    expect(container.querySelector(".dim-layer--book")).toHaveAttribute("inert");
    expect(container.querySelector(".dim-layer--desk")).not.toHaveAttribute("inert");
  });

  it("设置从顶部移到秘书栏左下角，并保留原回调", () => {
    const onOpenSettings = vi.fn();
    const { container } = render(<DimensionApp onOpenSettings={onOpenSettings} />);

    const header = container.querySelector("header");
    const railFooter = container.querySelector(".dim-rail-footer");
    if (!(header instanceof HTMLElement) || !(railFooter instanceof HTMLElement)) {
      throw new Error("missing header or secretary footer");
    }

    expect(within(header).queryByRole("button", { name: "设置" })).not.toBeInTheDocument();
    const settings = within(railFooter).getByRole("button", { name: "设置" });
    settings.focus();
    expect(settings).toHaveFocus();
    fireEvent.click(settings);
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});

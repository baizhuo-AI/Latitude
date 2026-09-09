import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CardContextMenu } from "./CardContextMenu";

function Fixture({ onSelect = () => {} }: { onSelect?: () => void }) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  return <><button onClick={() => setAnchor({ x: 4000, y: 4000 })}>卡片</button>
    <CardContextMenu title="今天做过" anchor={anchor} onClose={() => setAnchor(null)} items={[
      { id: "resize", label: "调整大小", onSelect },
      { id: "disabled", label: "不可用", disabled: true, onSelect },
      { id: "edit", label: "编辑内容", onSelect },
    ]} /></>;
}

describe("card context menu", () => {
  it("uses a viewport portal, clamps edges, skips disabled items and returns focus on Escape", () => {
    const { container } = render(<Fixture />);
    const trigger = screen.getByText("卡片");
    trigger.focus(); fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "卡片设置：今天做过" });
    expect(container.contains(menu)).toBe(false);
    expect(Number.parseFloat(menu.style.left)).toBeLessThan(window.innerWidth);
    expect(Number.parseFloat(menu.style.top)).toBeLessThan(window.innerHeight);
    expect(screen.getByRole("menuitem", { name: "调整大小" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "编辑内容" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("dismisses on outside pointer and selects exactly once", () => {
    const onSelect = vi.fn();
    render(<Fixture onSelect={onSelect} />);
    fireEvent.click(screen.getByText("卡片"));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("卡片"));
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑内容" }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DimensionPresetApp } from "./DimensionPresetApp";

describe("dimension card editing", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
  });

  it("双击桌面卡片可修改呈现内容并保存到本地桌面", () => {
    const { container } = render(
      <DimensionPresetApp initialPreset="paper" syncUrl={false} />
    );

    const card = container.querySelector(
      "[data-layout-card-id='seed-flex'] .dim-drag"
    );
    if (!(card instanceof HTMLElement)) throw new Error("missing core memory card");
    card.focus();
    fireEvent.doubleClick(card);
    expect(screen.getByRole("dialog", { name: "编辑卡片" })).toBeInTheDocument();
    const titleField = screen.getByRole("textbox", { name: "卡片标题" });
    expect(titleField).toHaveFocus();

    const saveButton = screen.getByRole("button", { name: "保存到桌面" });
    const closeButton = screen.getByRole("button", { name: "关闭卡片编辑器" });
    saveButton.focus();
    fireEvent.keyDown(saveButton, { key: "Tab" });
    expect(closeButton).toHaveFocus();
    fireEvent.keyDown(closeButton, { key: "Tab", shiftKey: true });
    expect(saveButton).toHaveFocus();

    fireEvent.change(screen.getByLabelText("正文"), {
      target: { value: "把证据、判断和下一步放在同一张纸上。" }
    });
    fireEvent.click(screen.getByRole("button", { name: "保存到桌面" }));

    expect(screen.getByText("把证据、判断和下一步放在同一张纸上。")).toBeInTheDocument();
    expect(card).toHaveFocus();
    expect(window.localStorage.getItem("dim-card-edits-dimension-seed-desktop")).toContain(
      "把证据、判断和下一步放在同一张纸上。"
    );
  });

  it("演示桌面的 Todo 可改名，完成后保留完成印章", () => {
    render(<DimensionPresetApp initialPreset="paper" syncUrl={false} />);

    fireEvent.click(screen.getByRole("button", { name: "编辑：给客户 1 准备日报" }));
    const input = screen.getByRole("textbox", { name: "编辑：给客户 1 准备日报" });
    fireEvent.change(input, { target: { value: "把 AGI 研究日报发出去" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getAllByText("把 AGI 研究日报发出去").length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole("button", { name: "完成：把 AGI 研究日报发出去" }));
    expect(document.querySelector(".dim-complete-seal")).toHaveTextContent("完成");
    expect(screen.queryByRole("button", { name: "完成：把 AGI 研究日报发出去" })).not.toBeInTheDocument();
  });

  it("双击线索纸打开节点编辑器；显式铅笔移除但保留键盘入口", () => {
    vi.useFakeTimers();
    const { container } = render(
      <DimensionPresetApp initialPreset="clue-board" syncUrl={false} />
    );
    const paper = container.querySelector(".clue-thread-paper");
    if (!(paper instanceof HTMLElement)) throw new Error("thread paper missing");
    expect(paper.querySelector(".clue-paper-edit")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "编辑线索内容：工作现状" })
    ).toHaveClass("clue-paper-edit-keyboard");

    const hit = screen.getByRole("button", {
      name: /线索 1：工作现状.*双击编辑/
    });
    // 还原浏览器真实双击序列：第一次 click 先等待，第二次取消进入桌面。
    fireEvent.click(hit, { detail: 1 });
    fireEvent.click(hit, { detail: 2 });
    fireEvent.doubleClick(hit, { detail: 2 });

    expect(screen.getByRole("dialog", { name: "编辑卡片" })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(250));
    expect(container.querySelector(".dim-deck")).toHaveAttribute(
      "data-active",
      "clue-board"
    );
    expect(screen.getByRole("textbox", { name: "卡片标题" })).toHaveValue(
      "工作现状 · 行动清单"
    );
    expect(screen.getAllByRole("textbox", { name: "内容" })).toHaveLength(2);
    expect(screen.queryByDisplayValue(/newsletter 选题草稿/)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(/Q3 学习计划/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭卡片编辑器" }));
    fireEvent.click(hit, { detail: 1 });
    act(() => vi.advanceTimersByTime(231));
    expect(container.querySelector(".dim-deck")).toHaveAttribute("data-active", "paper");
  });

  it("线索板的剪报也只由双击或键盘打开编辑器", () => {
    const { container } = render(
      <DimensionPresetApp initialPreset="clue-board" syncUrl={false} />
    );
    const clipping = container.querySelector(".clue-clipping");
    if (!(clipping instanceof HTMLElement)) throw new Error("clipping missing");

    expect(container.querySelector(".clue-paper-edit")).not.toBeInTheDocument();
    fireEvent.click(clipping);
    expect(screen.queryByRole("dialog", { name: "编辑卡片" })).not.toBeInTheDocument();

    fireEvent.doubleClick(clipping);
    expect(screen.getByRole("dialog", { name: "编辑卡片" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "卡片标题" })).toHaveValue("今日早报");
  });
});

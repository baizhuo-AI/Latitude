import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DimensionPresetApp } from "./DimensionPresetApp";

describe("dimension card editing", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
  });

  it("右键桌面卡片可修改呈现内容并保存到本地桌面", () => {
    const { container } = render(
      <DimensionPresetApp initialPreset="paper" syncUrl={false} />
    );

    const card = container.querySelector(
      "[data-layout-card-id='seed-flex'] .dim-drag"
    );
    if (!(card instanceof HTMLElement)) throw new Error("missing core memory card");
    card.focus();
    fireEvent.contextMenu(card);
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑内容" }));
    fireEvent.click(screen.getByRole("button", { name: "修改标题与内容" }));
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

  it("同一 Todo 在常用区和板块之间同步改名与完成状态", () => {
    const { container } = render(<DimensionPresetApp initialPreset="paper" syncUrl={false} />);
    const common = container.querySelector<HTMLElement>("[data-layout-card-id='seed-schedule']")!;
    const work = container.querySelector<HTMLElement>("[data-layout-card-id='area-reference:thread-工作现状']")!;

    fireEvent.contextMenu(common.querySelector(".dim-drag")!);
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑内容" }));
    const editor = screen.getByRole("dialog", { name: "编辑内容：今天的锚点" });
    fireEvent.click(within(editor).getByRole("button", { name: "编辑：给客户 1 准备日报" }));
    const input = within(editor).getByRole("textbox", { name: "编辑：给客户 1 准备日报" });
    fireEvent.change(input, { target: { value: "把 AGI 研究日报发出去" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "关闭卡片内容" }));
    for (const card of [common, work]) {
      expect(within(card).getByText("把 AGI 研究日报发出去")).toBeInTheDocument();
      expect(within(card).queryByRole("button", { name: "编辑：给客户 1 准备日报" })).not.toBeInTheDocument();
    }

    fireEvent.contextMenu(work.querySelector(".dim-drag")!);
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑内容" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "完成：把 AGI 研究日报发出去" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭卡片内容" }));
    for (const card of [common, work]) {
      expect(within(card).getByText("把 AGI 研究日报发出去").closest(".dim-anchor-row"))
        .toHaveTextContent("完成");
      expect(card.querySelector(".dim-complete-seal")).toBeInTheDocument();
      expect(within(card).queryByRole("button", { name: "完成：把 AGI 研究日报发出去" })).not.toBeInTheDocument();
    }
  });

  it("右键线索纸打开节点编辑器；双击只进入对应主页板块", () => {
    const { container } = render(
      <DimensionPresetApp initialPreset="clue-board" syncUrl={false} />
    );
    const paper = container.querySelector(".clue-thread-paper");
    if (!(paper instanceof HTMLElement)) throw new Error("thread paper missing");
    expect(paper.querySelector(".clue-goal-edit, .clue-paper-edit-keyboard, .clue-paper-detail")).not.toBeInTheDocument();
    fireEvent.contextMenu(paper, { clientX: 300, clientY: 250 });
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑内容" }));

    expect(screen.getByRole("dialog", { name: "编辑卡片" })).toBeInTheDocument();
    expect(container.querySelector(".dim-deck")).toHaveAttribute("data-active", "clue-board");
    expect(screen.getByRole("textbox", { name: "卡片标题" })).toHaveValue("工作现状 · 相关记录");
    expect(screen.getAllByRole("textbox", { name: "内容" })).toHaveLength(2);
    expect(screen.queryByDisplayValue(/newsletter 选题草稿/)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(/Q3 学习计划/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭卡片编辑器" }));
    const hit = screen.getByRole("button", { name: /线索 1：工作现状.*双击进入主页板块/ });
    fireEvent.click(hit, { detail: 1 });
    expect(container.querySelector(".dim-deck")).toHaveAttribute("data-active", "clue-board");
    fireEvent.doubleClick(hit);
    expect(container.querySelector(".dim-deck")).toHaveAttribute("data-active", "paper");
  });

  it("当前方向返回常用区，线索板移除剪报而桌面保留早报", () => {
    const { container } = render(<DimensionPresetApp initialPreset="clue-board" syncUrl={false} />);
    const paper = container.querySelector("[data-deck-layer='paper']")!;
    const rootLayout = paper.querySelector("[data-layout-document]");
    expect(container.querySelector(".clue-clipping")).not.toBeInTheDocument();
    const thesis = container.querySelector<HTMLButtonElement>(".clue-thesis")!;
    expect(thesis).toHaveTextContent("回常用区");
    fireEvent.click(thesis);
    expect(container.querySelector(".dim-deck")).toHaveAttribute("data-active", "paper");
    expect(paper.querySelector("[data-layout-document]")).toBe(rootLayout);
    expect(paper.querySelector("[aria-label='当前桌面板块']")).toHaveTextContent("桌面");
    expect(screen.getByRole("heading", { name: "今日早报" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "编辑卡片" })).not.toBeInTheDocument();
  });
});

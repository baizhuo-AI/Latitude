import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_UI_PROFILE_RESTORED_EVENT } from "../../projections/desktop/browserUiComposition";
import { CustomDesktopCardForm } from "./CustomDesktopCard";
import { useCustomDesktopCards } from "./useCustomDesktopCards";

afterEach(() => { window.localStorage.clear(); });

describe("custom card editor", () => {
  it("focuses the title, keeps focus in the editor and returns it to the opener", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const cancel = vi.fn();
    const view = render(<CustomDesktopCardForm onSubmit={vi.fn()} onCancel={cancel} />);
    expect(screen.getByRole("dialog", { name: "新建卡片" })).toBeVisible();
    expect(screen.getByLabelText("标题")).toHaveFocus();
    const user = userEvent.setup();
    screen.getByRole("button", { name: "创建卡片" }).focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "关闭卡片编辑" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(cancel).toHaveBeenCalledOnce();
    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("requires a title and a safe link before saving, retaining text when validation fails", () => {
    const submit = vi.fn();
    render(<CustomDesktopCardForm onSubmit={submit} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "创建卡片" }));
    expect(screen.getByRole("alert")).toHaveTextContent("起个名字");
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "下次接着想" } });
    fireEvent.change(screen.getByLabelText("正文"), { target: { value: "还没有整理完的内容" } });
    fireEvent.change(screen.getByLabelText("链接（选填）"), { target: { value: "javascript:alert(1)" } });
    fireEvent.click(screen.getByRole("button", { name: "创建卡片" }));
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByLabelText("正文")).toHaveValue("还没有整理完的内容");
    fireEvent.change(screen.getByLabelText("链接（选填）"), { target: { value: "https://example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "创建卡片" }));
    expect(submit).toHaveBeenCalledWith({ title: "下次接着想", body: "还没有整理完的内容", template: "note", url: "https://example.com" });
  });

  it("keeps an unsaved draft when Escape or cancel is pressed until discard is explicit", async () => {
    const cancel = vi.fn();
    render(<CustomDesktopCardForm onSubmit={vi.fn()} onCancel={cancel} />);
    fireEvent.change(screen.getByLabelText("正文"), { target: { value: "还在写，不能丢。" } });
    await userEvent.setup().keyboard("{Escape}");
    expect(cancel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "继续编辑" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(screen.getByLabelText("正文")).toHaveValue("还在写，不能丢。");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    expect(cancel).toHaveBeenCalledOnce();
  });
});

it("reloads cards on same-window profile reset and remount instead of retaining stale cached cards", () => {
  function Harness() {
    const notes = useCustomDesktopCards("profile-reset-test");
    return <><output aria-label="卡片数量">{notes.cards.length}</output><button onClick={() => notes.create({ title: "本机便签", body: "待保留", template: "note" })}>创建测试卡</button></>;
  }
  const first = render(<Harness />);
  fireEvent.click(screen.getByText("创建测试卡"));
  expect(screen.getByLabelText("卡片数量")).toHaveTextContent("1");
  act(() => {
    window.localStorage.removeItem("dim-custom-cards-profile-reset-test");
    window.dispatchEvent(new Event(BROWSER_UI_PROFILE_RESTORED_EVENT));
  });
  expect(screen.getByLabelText("卡片数量")).toHaveTextContent("0");
  fireEvent.click(screen.getByText("创建测试卡"));
  first.unmount();
  window.localStorage.clear();
  render(<Harness />);
  expect(screen.getByLabelText("卡片数量")).toHaveTextContent("0");
});

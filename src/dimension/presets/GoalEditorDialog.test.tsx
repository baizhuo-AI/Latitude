import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { GoalEditorDialog } from "./GoalEditorDialog";

beforeEach(() => {
  // jsdom has no native modal implementation; browser QA covers focus and top layer.
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); },
  });
});

it("retains input on save failure and blocks empty or repeated submissions", async () => {
  let rejectSave!: (error: Error) => void;
  const onSave = vi.fn(() => new Promise<void>((_, reject) => { rejectSave = reject; }));
  const onClose = vi.fn();
  render(<GoalEditorDialog goal={null} onSave={onSave} onClose={onClose} />);
  const save = screen.getByRole("button", { name: "保存目标" });
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox", { name: "目标名称" }), { target: { value: "  新目标  " } });
  fireEvent.click(save);
  fireEvent.click(save);
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ title: "新目标" }));
  rejectSave(new Error("保存服务不可用，请重试"));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("保存服务不可用"));
  expect(screen.getByRole("textbox", { name: "目标名称" })).toHaveValue("  新目标  ");
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "保存目标" })).toBeEnabled();
});

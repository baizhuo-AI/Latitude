import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { CommandBar } from "../Shell";
import { MessageComposer } from "./MessageComposer";
import { updateDraft } from "./draftStore";

beforeEach(() => localStorage.clear());

it("shares footer text with the conversation and keeps it after a failed submit", async () => {
  const send = vi.fn().mockResolvedValue(false);
  render(<><CommandBar sessionId="footer" onSend={send} /><MessageComposer sessionId="footer" onSend={send} /></>);
  fireEvent.change(screen.getByLabelText("跟秘书说话"), { target: { value: "这段话先保留" } });
  expect(screen.getByLabelText("给秘书发消息")).toHaveValue("这段话先保留");
  const input = screen.getByLabelText("跟秘书说话");
  expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true })).toBe(true);
  expect(send).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("给秘书发消息"), { target: { value: "第一行\n第二行" } });
  expect(screen.getByLabelText("跟秘书说话")).toHaveValue("第一行\n第二行");
  await act(async () => { fireEvent.submit(screen.getByLabelText("跟秘书说话").closest("form")!); });
  expect(screen.getByLabelText("跟秘书说话")).toHaveValue("第一行\n第二行");
  send.mockResolvedValue(true);
  await act(async () => { fireEvent.submit(screen.getByLabelText("跟秘书说话").closest("form")!); });
  expect(screen.getByLabelText("给秘书发消息")).toHaveValue("");
});

it("opens the full composer when the shared draft contains an attachment", () => {
  updateDraft("with-file", () => ({ text: "检查材料", attachments: [{ id: "one", name: "草稿.md", mimeType: "text/plain", size: 3, text: "正文", range: "1 行" }] }));
  const open = vi.fn();
  const send = vi.fn();
  render(<CommandBar sessionId="with-file" onSend={send} onOpenComposer={open} />);
  fireEvent.click(screen.getByRole("button", { name: "附件 1" }));
  expect(open).toHaveBeenCalledOnce();
  fireEvent.submit(screen.getByLabelText("跟秘书说话").closest("form")!);
  expect(send).not.toHaveBeenCalled();
});

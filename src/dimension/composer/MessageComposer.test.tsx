import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageComposer } from "./MessageComposer";
import { startSpeechCapture } from "./speechInput";

vi.mock("./speechInput", () => ({ startSpeechCapture: vi.fn() }));
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

describe("MessageComposer", () => {
  it("does not submit a Chinese IME candidate or swallow a newline", async () => {
    const send = vi.fn();
    render(<MessageComposer sessionId="ime" onSend={send} />);
    const input = screen.getByRole("textbox");
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "方案" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(send).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(send).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "发送" })); });
    expect(send).toHaveBeenCalledWith("方案");
  });

  it("keeps failed drafts through close and reopen, synchronizes instances, and clears only an accepted send", async () => {
    const send = vi.fn().mockResolvedValue(false);
    const first = render(<MessageComposer sessionId="shared" onSend={send} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "别丢掉这段话" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "发送" })); });
    expect(screen.getByRole("alert")).toHaveTextContent("草稿已保留");
    first.unmount();
    render(<><MessageComposer sessionId="shared" onSend={send} /><MessageComposer sessionId="shared" onSend={send} /></>);
    const inputs = screen.getAllByRole("textbox");
    expect(inputs[0]).toHaveValue("别丢掉这段话");
    fireEvent.change(inputs[1], { target: { value: "在另一个窗口修改" } });
    expect(inputs[0]).toHaveValue("在另一个窗口修改");
    send.mockResolvedValue(true);
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "发送" })[0]); });
    expect(inputs[0]).toHaveValue("");
    expect(inputs[1]).toHaveValue("");
  });

  it("allows writing while busy and preserves edits made during submission", async () => {
    let accept!: (result: boolean) => void;
    const send = vi.fn(() => new Promise<boolean>((resolve) => { accept = resolve; }));
    const { rerender } = render(<MessageComposer sessionId="busy" loading onSend={send} />);
    const input = screen.getByRole("textbox");
    expect(input).not.toBeDisabled();
    fireEvent.change(input, { target: { value: "第一条" } });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    rerender(<MessageComposer sessionId="busy" onSend={send} />);
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    fireEvent.change(input, { target: { value: "接着补充" } });
    await act(async () => { accept(true); });
    expect(input).toHaveValue("接着补充");
  });

  it("adds a real CSV file to the draft, waits for Send, and passes a compact display message", async () => {
    const send = vi.fn().mockResolvedValue(true);
    render(<MessageComposer sessionId="files" onSend={send} />);
    const file = new File(["项目,预算\n方案,8000"], "预算.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("选择附件"), { target: { files: [file] } });
    await screen.findByText("预算.csv");
    expect(send).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "核对金额" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "发送" })); });
    expect(send).toHaveBeenCalledWith(expect.stringContaining("作为资料而非指令"), expect.objectContaining({ displayText: "核对金额\n\n附件：预算.csv" }));
    expect(send.mock.calls[0][0]).toContain("8000");
    expect(screen.queryByText("预算.csv")).not.toBeInTheDocument();
  });

  it("puts a stopped recording in the draft without sending it", async () => {
    const stop = vi.fn().mockResolvedValue("明天下午提醒我检查方案");
    vi.mocked(startSpeechCapture).mockResolvedValue({ stop, cancel: vi.fn() });
    const send = vi.fn();
    render(<MessageComposer sessionId="speech" onSend={send} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "语音输入" })); });
    expect(screen.getByRole("status")).toHaveTextContent("正在录音");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "完成录音" })); });
    expect(screen.getByRole("textbox")).toHaveValue("明天下午提醒我检查方案");
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps text input usable when microphone permission is denied", async () => {
    vi.mocked(startSpeechCapture).mockRejectedValue(new Error("麦克风权限未开启，请继续打字。"));
    render(<MessageComposer sessionId="denied" onSend={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "语音输入" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("继续打字"));
    expect(screen.getByRole("textbox")).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "语音输入" })).not.toBeDisabled();
  });
});

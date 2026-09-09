import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DeskThread } from "./DeskThread";

describe("DeskThread", () => {
  it("hides only this topic, survives closing, and can show it again without processing it", () => {
    const onAction = vi.fn();
    const props = {
      messages: [], conversations: [], currentId: "hidden-topic-test", streaming: "", loading: false,
      onSelectConversation: vi.fn(), onClose: vi.fn(), proactivePrompt: "这次结果想先放一放。",
      onProactivePromptAction: onAction,
    };
    const first = render(<DeskThread {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "先隐藏秘书话题" }));
    expect(screen.queryByLabelText("秘书主动发起的话题")).not.toBeInTheDocument();
    expect(onAction).not.toHaveBeenCalled();
    first.unmount();
    const second = render(<DeskThread {...props} />);
    expect(screen.queryByLabelText("秘书主动发起的话题")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新显示秘书话题" }));
    expect(screen.getByLabelText("秘书主动发起的话题")).toHaveTextContent(props.proactivePrompt);
    fireEvent.click(screen.getByRole("button", { name: "先隐藏秘书话题" }));
    second.rerender(<DeskThread {...props} proactivePrompt="有一件新事情。" />);
    expect(screen.getByLabelText("秘书主动发起的话题")).toHaveTextContent("有一件新事情。");
    sessionStorage.removeItem("latitude.thread.hidden-prompt:hidden-topic-test");
  });
  it("keeps this turn's process after the user's message and before the final answer", () => {
    const row = (id: string, role: "user" | "assistant", content: string) => ({ id, role, content, convId: "current", createdAt: "2026-09-04T00:00:00Z" });
    const previous = [row("old-user", "user", "上一轮问题"), row("old-answer", "assistant", "上一轮答复"), row("user", "user", "哈哈")];
    const props = { messages: previous, conversations: [], currentId: "current", streaming: "", loading: true, onSelectConversation: vi.fn(), onClose: vi.fn(), progressRunId: "current-run", progress: [{ seq: 1, kind: "reasoning" as const, text: "本轮过程" }] };
    const { container, rerender } = render(<DeskThread {...props} />);
    const messageOrder = () => [...container.querySelector(".dim-thread__messages")!.children].map((element) => element.textContent);
    expect(messageOrder().slice(0, 4)).toEqual(["上一轮问题", "上一轮答复", "哈哈", expect.stringContaining("本轮过程")]);

    rerender(<DeskThread {...props} loading={false} messages={[...previous, row("answer", "assistant", "早上好呀")]} />);
    expect(messageOrder()).toEqual(["上一轮问题", "上一轮答复", "哈哈", expect.stringContaining("查看本轮处理过程"), "早上好呀"]);
    expect(screen.getAllByText("查看本轮处理过程")).toHaveLength(1);
    const details = screen.getByText("查看本轮处理过程").closest("details");
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("查看本轮处理过程"));
    expect(details).toHaveAttribute("open");
  });

  it("shows live provider process, allows explicit stop, collapses on completion and respects reading position", () => {
    const onCancel = vi.fn();
    const props = { messages: [], conversations: [], currentId: "live", streaming: "", loading: true, onSelectConversation: vi.fn(), onClose: vi.fn(), onSend: vi.fn(), onCancel, progressRunId: "run", progress: [{ seq: 1, kind: "reasoning" as const, text: "核对已有记录。" }] };
    const { rerender } = render(<DeskThread {...props} />);
    const details = screen.getByText("正在处理 · 查看过程").closest("details");
    expect(details).toHaveAttribute("open");
    const process = screen.getByLabelText("本轮处理过程");
    Object.defineProperties(process, { scrollHeight: { value: 1200, configurable: true }, clientHeight: { value: 200 } });
    process.scrollTop = 100;
    fireEvent.scroll(process);
    rerender(<DeskThread {...props} progress={[...props.progress, { seq: 2, kind: "tool", callId: "read", text: "阅读原始证据", state: "running" }]} />);
    expect(process.scrollTop).toBe(100);
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(onCancel).toHaveBeenCalledOnce();
    rerender(<DeskThread {...props} loading={false} />);
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("查看本轮处理过程"));
    expect(details).toHaveAttribute("open");
  });

  it("能从当前对话切到飞书或主动秘书新建的会话", () => {
    const onSelectConversation = vi.fn();
    render(
      <DeskThread
        messages={[]}
        conversations={[
          {
            id: "new-from-feishu",
            title: "飞书里的新对话",
            createdAt: "2026-08-24T12:00:00Z",
            updatedAt: "2026-08-24T12:00:00Z"
          },
          {
            id: "current",
            title: "桌面当前对话",
            createdAt: "2026-08-24T10:00:00Z",
            updatedAt: "2026-08-24T10:00:00Z"
          }
        ]}
        currentId="current"
        streaming=""
        loading={false}
        onSelectConversation={onSelectConversation}
        onClose={() => undefined}
      />
    );

    fireEvent.change(screen.getByRole("combobox", { name: "切换对话" }), {
      target: { value: "new-from-feishu" }
    });

    expect(onSelectConversation).toHaveBeenCalledWith("new-from-feishu");
  });

  it("把秘书回复渲染成安全 Markdown，并把用户原话保持为纯文本", () => {
    const { container } = render(
      <DeskThread
        messages={[
          {
            id: "assistant-markdown",
            convId: "current",
            role: "assistant",
            content: [
              "## 今日 AI 线索",
              "",
              "**芯片与硬件**",
              "",
              "- [可信来源](https://example.com/report)",
              "- [危险来源](javascript:alert(1))",
              "",
              "`DeepSeek Harness`",
              "",
              "```ts",
              "const safe = true;",
              "```",
              "",
              "<script>window.__unsafe = true</script>"
            ].join("\n"),
            createdAt: "2026-08-24T12:00:00Z"
          },
          {
            id: "user-plain",
            convId: "current",
            role: "user",
            content: "**不要把我的原话改成标题**",
            createdAt: "2026-08-24T12:01:00Z"
          }
        ]}
        conversations={[]}
        currentId="current"
        streaming=""
        loading={false}
        onSelectConversation={() => undefined}
        onClose={() => undefined}
      />
    );

    expect(screen.getByRole("heading", { name: "今日 AI 线索" })).toBeInTheDocument();
    expect(screen.getByText("芯片与硬件").tagName).toBe("STRONG");
    expect(screen.getByText("DeepSeek Harness").tagName).toBe("CODE");
    expect(screen.getByText("const safe = true;").tagName).toBe("CODE");

    const source = screen.getByRole("link", { name: "可信来源" });
    expect(source).toHaveAttribute("href", "https://example.com/report");
    expect(source).toHaveAttribute("target", "_blank");
    expect(source).toHaveAttribute("rel", "noopener noreferrer nofollow");
    expect(screen.queryByRole("link", { name: "危险来源" })).not.toBeInTheDocument();
    expect(screen.getByText("危险来源")).toHaveClass("dim-markdown__unsafe-link");
    expect(container.querySelector("script")).not.toBeInTheDocument();

    const userMessage = container.querySelector('[data-role="user"]');
    expect(userMessage?.querySelector("strong")).toBeNull();
    expect(userMessage).toHaveTextContent("**不要把我的原话改成标题**");
  });

  it("把可核验依据折叠在答案下面，不展示内部思维草稿", () => {
    const { container } = render(
      <DeskThread
        messages={[{
          id: "assistant-explained",
          convId: "current",
          role: "assistant",
          content: "我先把它当成一个待确认的猜测。",
          createdAt: "2026-08-24T12:00:00Z",
          explanation: {
            summary: "这是根据你刚才说的话整理的。",
            steps: ["把你这次说的话作为本轮依据"],
            uncertainty: "还需要你确认。",
          },
        }]}
        conversations={[]}
        currentId="current"
        streaming=""
        loading={false}
        onSelectConversation={() => undefined}
        onClose={() => undefined}
      />
    );

    const summary = screen.getByText("为什么这样回答");
    const details = summary.closest("details");
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(summary);
    expect(details).toHaveAttribute("open");
    expect(screen.getByText("这是根据你刚才说的话整理的。")).toBeInTheDocument();
    expect(screen.getByText("把你这次说的话作为本轮依据")).toBeInTheDocument();
    expect(screen.getByText("还不确定：还需要你确认。")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("chain-of-thought");
  });

  it("声明对话消息区独占甲板滚动边界", () => {
    render(
      <DeskThread
        messages={[]}
        conversations={[]}
        currentId={null}
        streaming=""
        loading={false}
        onSelectConversation={() => undefined}
        onClose={() => undefined}
      />
    );

    expect(screen.getByLabelText("对话消息")).toHaveAttribute(
      "data-deck-scroll",
      "contain"
    );
  });

  it("悬浮对话打开后直接聚焦输入，Enter 发送且 Escape 关闭", async () => {
    const onSend = vi.fn();
    const onClose = vi.fn();
    const onNewConversation = vi.fn();
    render(
      <DeskThread
        messages={[]}
        conversations={[]}
        currentId="current"
        streaming=""
        loading={false}
        onSelectConversation={() => undefined}
        onNewConversation={onNewConversation}
        onClose={onClose}
        variant="floating"
        onSend={onSend}
      />
    );

    const composer = screen.getByRole("textbox", { name: "给秘书发消息" });
    expect(composer).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "新开对话" }));
    expect(onNewConversation).toHaveBeenCalledOnce();
    expect(composer).toHaveFocus();
    fireEvent.change(composer, { target: { value: "把今天做过的事整理一下" } });
    await act(async () => { fireEvent.keyDown(composer, { key: "Enter" }); });
    expect(onSend).toHaveBeenCalledWith("把今天做过的事整理一下");

    fireEvent.keyDown(screen.getByRole("dialog", { name: "与秘书的对话" }), {
      key: "Escape",
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("把秘书主动提醒作为对话开场，并在同一浮窗处理", () => {
    const onPromptAction = vi.fn();
    render(
      <DeskThread
        messages={[]}
        conversations={[]}
        currentId="current"
        streaming=""
        loading={false}
        onSelectConversation={() => undefined}
        onClose={() => undefined}
        proactivePrompt="这个行动到回看时间了，实际结果怎么样？"
        onProactivePromptAction={onPromptAction}
      />
    );

    expect(screen.getByLabelText("秘书主动发起的话题"))
      .toHaveTextContent("这个行动到回看时间了，实际结果怎么样？");
    expect(screen.queryByText("还没有对话，直接在下面说点什么。")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "处理这件事" }));
    expect(onPromptAction).toHaveBeenCalledOnce();
  });
});

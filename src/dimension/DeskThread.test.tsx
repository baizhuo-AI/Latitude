import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DeskThread } from "./DeskThread";

describe("DeskThread", () => {
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
});

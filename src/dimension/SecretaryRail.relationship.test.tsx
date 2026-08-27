import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SecretaryRail } from "./Shell";
import type { Secretary } from "./types";

const SECRETARY: Secretary = {
  eyebrow: "YOUR SECRETARY",
  state: "presenting",
  gesture: "offering",
  stateCn: "有事说",
  headline: "内部生成的长说明不应常驻显示。",
  note: "内部生成的依据不应常驻显示。",
  stageLabel: "内部阶段",
  stageProgress: 74,
  stageNote: "typed basis / receipt",
  metrics: [
    { label: "熟悉", value: 78, tone: "olive", basis: "内部依据" },
    { label: "默契", value: 71, tone: "blue", basis: "内部依据" },
    { label: "权能", value: 46, tone: "rust", basis: "内部依据" }
  ]
};

describe("SecretaryRail simplified interaction", () => {
  it("常驻区只显示人能直接理解的状态，不展示关系指标和内部依据", () => {
    render(<SecretaryRail secretary={SECRETARY} />);

    expect(screen.getByText("秘书")).toBeVisible();
    expect(screen.getByText("找你")).toBeVisible();
    expect(screen.getByText("有件事需要你看看。")).toBeVisible();
    expect(screen.queryByText("YOUR SECRETARY")).not.toBeInTheDocument();
    expect(screen.queryByText("内部阶段")).not.toBeInTheDocument();
    expect(screen.queryByText(/typed|receipt/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("空闲和处理中使用短句", () => {
    const { rerender } = render(
      <SecretaryRail
        secretary={{ ...SECRETARY, state: "ready", gesture: "idle", stateCn: "在岗" }}
      />
    );
    expect(screen.getByText("今天想先做什么？")).toBeVisible();
    expect(screen.getByText("在")).toBeVisible();

    rerender(
      <SecretaryRail
        secretary={{ ...SECRETARY, state: "thinking", gesture: "pondering", stateCn: "处理中" }}
      />
    );
    expect(screen.getByText("稍等…")).toBeVisible();
    expect(screen.getByText("处理中")).toBeVisible();
  });

  it("点立绘直接打开对话，不再展开一组中间话术", () => {
    const onInteract = vi.fn();
    render(<SecretaryRail secretary={SECRETARY} onInteract={onInteract} />);

    fireEvent.click(screen.getByRole("button", { name: "打开对话" }));
    expect(onInteract).toHaveBeenCalledWith("chat");
    expect(screen.queryByRole("button", { name: "聊聊" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "换个表情" })).not.toBeInTheDocument();
  });

  it("真实提醒优先显示；聊天关闭时立绘不可误触", () => {
    const onInteract = vi.fn();
    render(
      <SecretaryRail
        secretary={SECRETARY}
        notice="有一个结果需要确认。"
        onInteract={onInteract}
        actionAvailability={{ chat: false, review: true, outcome: true }}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent("有一个结果需要确认。");
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    expect(onInteract).toHaveBeenCalledWith("decide");
  });

  it("保留收起、设置和隐藏后的唤回入口", () => {
    const onToggleCollapse = vi.fn();
    const onSettings = vi.fn();
    const first = render(
      <SecretaryRail
        secretary={SECRETARY}
        onToggleCollapse={onToggleCollapse}
        onSettings={onSettings}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "收起秘书栏" }));
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(onToggleCollapse).toHaveBeenCalledOnce();
    expect(onSettings).toHaveBeenCalledOnce();
    first.unmount();

    const onVisibilityChange = vi.fn();
    render(
      <SecretaryRail
        secretary={SECRETARY}
        visible={false}
        onVisibilityChange={onVisibilityChange}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "唤回秘书" }));
    expect(onVisibilityChange).toHaveBeenCalledWith(true);
  });
});

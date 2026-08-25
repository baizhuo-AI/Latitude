import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LiveDimensionApp } from "./LiveDimensionApp";

describe("LiveDimensionApp 环境边界", () => {
  it("浏览器（无 Tauri）进入本地服务产品面，不再回退演示数据", () => {
    const { container } = render(<LiveDimensionApp />);

    // 浏览器现在连接 loopback Domain/Agent。服务未就绪时显示真实连接态，
    // 绝不再用 seed 内容伪装成用户数据。
    expect(screen.queryByText("演示模式")).not.toBeInTheDocument();
    expect(screen.getByLabelText("本地服务状态")).toBeInTheDocument();
    // 产品面仍保留现有五区美术骨架，甲板默认落在纸面层。
    expect(screen.getByText("今天的锚点")).toBeInTheDocument();
    expect(container.querySelector(".dim-deck")).toHaveAttribute("data-active", "paper");
  });
});

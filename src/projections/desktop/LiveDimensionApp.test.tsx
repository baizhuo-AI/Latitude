import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveDimensionApp } from "./LiveDimensionApp";

beforeEach(() => {
  window.localStorage.clear();
  // This environment boundary must not depend on services running on the test host.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Local services unavailable")));
});
afterEach(() => vi.unstubAllGlobals());

describe("LiveDimensionApp 环境边界", () => {
  it("浏览器（无 Tauri）进入真实产品面，连接状态只在设置展示且不回退演示数据", async () => {
    const { container } = render(<LiveDimensionApp />);

    expect(screen.queryByText("演示模式")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("本地服务状态")).not.toBeInTheDocument();
    expect(screen.getByText("今天的锚点")).toBeInTheDocument();
    expect(container.querySelector(".dim-deck")).toHaveAttribute("data-active", "paper");

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const settings = screen.getByRole("dialog", { name: "设置" });
    await waitFor(() => expect(within(settings).getByLabelText("本地服务状态"))
      .toHaveTextContent("数据 未连接 · 助手 未连接"));
    expect(screen.queryByText("演示模式")).not.toBeInTheDocument();
    expect(screen.queryByText("给客户 1 准备日报")).not.toBeInTheDocument();
  });
});

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { DimensionApp } from "./DimensionApp";
import { buildBrowserProjection } from "../projections/desktop/browserProjection";
import { readDesktopWorkspace } from "./desktopWorkspace";
import type { ClueThread } from "./presets/ClueBoardPreset";

function OfflineWorkspace() {
  const { projection, layout } = buildBrowserProjection({
    context: { nodes: [], edges: [] }, runtimeState: "unavailable", now: new Date("2026-09-05T12:00:00Z"),
  });
  return <DimensionApp layout={{ ...layout, id: "test-user-created-workspace" }} projection={projection} />;
}

describe("桌面卡片完整操作", () => {
  beforeEach(() => window.localStorage.clear());

  it("离线新建和编辑真实便签，移出后可从总览找回，重新挂载仍保留内容", async () => {
    const first = render(<OfflineWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "＋ 新建" }));
    const form = screen.getByRole("dialog", { name: "新建卡片" });
    fireEvent.change(within(form).getByLabelText("标题"), { target: { value: "周末读书" } });
    fireEvent.change(within(form).getByLabelText("正文"), { target: { value: "把想法记在这里。" } });
    fireEvent.click(within(form).getByRole("button", { name: "创建卡片" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "周末读书" })).toBeVisible();
    expect(screen.getByRole("button", { name: "卡片总览 6" })).toBeVisible();
    expect(screen.getByText("已存本机")).toBeVisible();

    fireEvent.contextMenu(screen.getByRole("group", { name: "卡片：周末读书" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑内容" }));
    const editor = screen.getByRole("dialog", { name: "编辑卡片" });
    fireEvent.change(within(editor).getByLabelText("正文"), { target: { value: "已经改成新的想法。" } });
    fireEvent.click(within(editor).getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.contextMenu(screen.getByRole("group", { name: "卡片：周末读书" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /移除卡片/ }));
    expect(screen.queryByRole("heading", { name: "周末读书" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭移除提示" }));
    fireEvent.click(screen.getByRole("button", { name: "卡片总览 6" }));
    const inventory = screen.getByRole("region", { name: "卡片总览" });
    await waitFor(() => expect(within(inventory).getAllByText("已移出桌面")[0]).toBeVisible());
    fireEvent.click(within(inventory).getByRole("button", { name: "放回桌面：周末读书" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "卡片总览" })).not.toBeInTheDocument());
    expect(screen.getByText("已经改成新的想法。")).toBeVisible();

    first.unmount();
    render(<OfflineWorkspace />);
    expect(screen.getByRole("heading", { name: "周末读书" })).toBeVisible();
    expect(screen.getByText("已经改成新的想法。")).toBeVisible();
    expect(screen.getByRole("button", { name: "卡片总览 6" })).toBeVisible();
  });

  it("断线时秘书、连接提示一致，空数据不宣称处理任务", () => {
    render(<OfflineWorkspace />);
    expect(screen.getByRole("region", { name: "连接状态" })).toHaveTextContent("本地服务未连接");
    expect(screen.getByText("秘书暂时没连上。")).toBeVisible();
    expect(screen.queryByText("稍等…")).not.toBeInTheDocument();
    expect(screen.queryByText("处理中")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "＋ 新建" })).toBeEnabled();
  });

  it("在明确板块中创建便签，保存界面归属并在重开后保留", async () => {
    const { projection, layout } = buildBrowserProjection({
      context: { nodes: [], edges: [] }, runtimeState: "unavailable", now: new Date("2026-09-05T12:00:00Z"),
    });
    const thread: ClueThread = { id: "research-area", title: "研究", rows: [], pending: 0, done: 0 };
    const props = { projection, layout, workspaceThreads: [thread], activeAreaId: thread.id };
    const first = render(<DimensionApp {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "＋ 新建" }));
    const form = screen.getByRole("dialog", { name: "新建卡片" });
    fireEvent.change(within(form).getByLabelText("标题"), { target: { value: "当前板块的思路" } });
    fireEvent.change(within(form).getByLabelText("正文"), { target: { value: "仅在桌面摆放，不建立知识关系。" } });
    fireEvent.click(within(form).getByRole("button", { name: "创建卡片" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const cardId = screen.getByRole("group", { name: "卡片：当前板块的思路" }).getAttribute("data-spatial-card-id")!;
    expect(cardId).toBeTruthy();
    expect(readDesktopWorkspace(layout.id).cardAreaIds).toEqual({ [cardId]: thread.id });
    first.unmount();
    render(<DimensionApp {...props} />);
    expect(screen.getByText("仅在桌面摆放，不建立知识关系。")).toBeVisible();
    expect(readDesktopWorkspace(layout.id).cardAreaIds).toEqual({ [cardId]: thread.id });
  });
});

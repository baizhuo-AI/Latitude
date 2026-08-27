import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BrowserDataSafetyDialog, type BrowserDataSafetyActions } from "./BrowserDataSafetyDialog";

describe("BrowserDataSafetyDialog truthfulness", () => {
  it("marks plaintext exports and disables non-reversible or non-applied ChangeSets", async () => {
    const actions: BrowserDataSafetyActions = {
      exportAll: vi.fn(),
      checkIntegrity: vi.fn(),
      prepareDangerous: vi.fn(),
      commitDangerous: vi.fn(),
      listChangeSets: vi.fn(async () => [
        { id: "restore-1", title: "完整恢复", status: "applied", reversible: false },
        { id: "change-1", title: "更新行动", status: "applied", reversible: true },
        { id: "change-2", title: "旧变更", status: "rolled_back", reversible: true },
      ]),
      rollbackChangeSet: vi.fn(),
    };
    const user = userEvent.setup();
    render(
      <BrowserDataSafetyDialog
        actions={actions}
        onChanged={vi.fn(async () => undefined)}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "数据与安全" })).toHaveClass("dimension-root");
    expect(screen.getByRole("dialog", { name: "数据与安全" })).toHaveStyle({
      zIndex: "100",
    });
    expect(screen.getByText(/下载文件未加密/)).toBeInTheDocument();
    await user.click(screen.getByText("桌面变更记录"));
    await waitFor(() => expect(screen.getByText(/完整恢复.*不可回滚/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "不可回滚" })).toBeDisabled();
    const rollbackButtons = screen.getAllByRole("button", { name: "回滚" });
    expect(rollbackButtons[0]).toBeEnabled();
    expect(rollbackButtons[1]).toBeDisabled();
  });

  it("keeps unbound trusted actions visibly disabled and never calls their adapters", async () => {
    const actions: BrowserDataSafetyActions = {
      exportAll: vi.fn(async () => ({})),
      checkIntegrity: vi.fn(async () => ({ ok: true })),
      prepareDangerous: vi.fn(),
      commitDangerous: vi.fn(),
      listChangeSets: vi.fn(async () => [
        { id: "change-1", title: "可回滚变更", status: "applied", reversible: true },
      ]),
      rollbackChangeSet: vi.fn(),
    };
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <BrowserDataSafetyDialog
        actions={actions}
        actionAvailability={{
          export: false,
          integrity: false,
          restore: false,
          delete: false,
          purge: false,
          rollback: false,
          close: true,
        }}
        onChanged={vi.fn(async () => undefined)}
        onClose={onClose}
      />,
    );

    const exportButton = screen.getByRole("button", { name: "下载完整导出" });
    const integrityButton = screen.getByRole("button", { name: "检查数据完整性" });
    expect(exportButton).toBeDisabled();
    expect(integrityButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "第一步：准备可恢复清空" }))
      .toBeDisabled();
    await user.click(screen.getByText("桌面变更记录"));
    await waitFor(() => expect(screen.getByRole("button", { name: "回滚" })).toBeDisabled());
    await user.click(exportButton);
    await user.click(integrityButton);
    await user.click(screen.getByRole("button", { name: "回滚" }));
    expect(actions.exportAll).not.toHaveBeenCalled();
    expect(actions.checkIntegrity).not.toHaveBeenCalled();
    expect(actions.rollbackChangeSet).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "合上" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows a partial purge receipt verbatim instead of announcing permanent deletion success", async () => {
    const actions: BrowserDataSafetyActions = {
      exportAll: vi.fn(),
      checkIntegrity: vi.fn(),
      prepareDangerous: vi.fn(async () => ({
        token: "purge-composite",
        confirmation: "PERMANENTLY DELETE ALL LATITUDE DATA",
      })),
      commitDangerous: vi.fn(async () => ({
        ok: false,
        status: "partial",
        operation: "purge_all",
        message: "永久删除只完成了一部分：Agent 仍保留 state/unowned-file。",
      })),
      listChangeSets: vi.fn(async () => []),
      rollbackChangeSet: vi.fn(),
    };
    const user = userEvent.setup();
    render(
      <BrowserDataSafetyDialog
        actions={actions}
        onChanged={vi.fn(async () => undefined)}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByText("更深一层 · 永久删除（不可恢复）"));
    await user.click(screen.getByRole("button", { name: "第一步：准备永久删除" }));
    await user.type(
      screen.getByRole("textbox", { name: "危险操作确认短语" }),
      "PERMANENTLY DELETE ALL LATITUDE DATA",
    );
    await user.click(screen.getByRole("button", { name: "第二步：确认执行" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "永久删除只完成了一部分：Agent 仍保留 state/unowned-file。",
    );
    expect(screen.queryByText(/^永久删除已完成/)).not.toBeInTheDocument();
  });

  it("offers a restart-safe two-stage restore for the latest recoverable backup", async () => {
    const actions: BrowserDataSafetyActions = {
      exportAll: vi.fn(),
      checkIntegrity: vi.fn(),
      prepareDangerous: vi.fn(),
      prepareRecentRecovery: vi.fn(async () => ({
        token: "restore-recent",
        confirmation: "RESTORE LOCAL DATA",
        recoveryBackupSavedAt: "2026-08-24T12:00:00Z",
      })),
      commitDangerous: vi.fn(async () => ({
        ok: true,
        status: "complete",
        operation: "restore",
        message: "最近可恢复备份已完整恢复。",
      })),
      listChangeSets: vi.fn(async () => []),
      rollbackChangeSet: vi.fn(),
    };
    const user = userEvent.setup();
    render(
      <BrowserDataSafetyDialog
        actions={actions}
        onChanged={vi.fn(async () => undefined)}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", {
      name: "第一步：恢复最近可恢复备份",
    }));
    expect(actions.prepareRecentRecovery).toHaveBeenCalledOnce();
    expect(await screen.findByText("RESTORE LOCAL DATA")).toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox", { name: "危险操作确认短语" }),
      "RESTORE LOCAL DATA",
    );
    await user.click(screen.getByRole("button", { name: "第二步：确认执行" }));
    expect(actions.commitDangerous).toHaveBeenCalledWith({
      token: "restore-recent",
      confirmation: "RESTORE LOCAL DATA",
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "最近可恢复备份已完整恢复。",
    );
  });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopRuntimeProvider, useDesktopRuntime } from "../../runtime/host/DesktopRuntimeProvider";
import type { DesktopRuntimePort, KnowledgeNode } from "../../runtime/host/DesktopRuntimePort";
import { CustomDesktopCardStore } from "./store";
import { cardSnapshot } from "./model";
import { useCustomDesktopCards } from "./useCustomDesktopCards";

afterEach(() => { window.localStorage.clear(); });

it("refreshes from existing host health checks and hides explicit retractions while preserving the local record", async () => {
  const layoutId = "health-retraction-test";
  const local = new CustomDesktopCardStore(layoutId);
  const card = local.create({ title: "保留原稿", body: "这段文字仍在本机备份", template: "note" })!;
  window.localStorage.setItem(local.key, JSON.stringify({ version: 1, cards: [{ ...card, domainId: "node-1", syncedRevision: 1, syncState: "synced" }] }));
  const activeNode: KnowledgeNode = { id: "node-1", kind: "resource", status: "active", payload: {
    ...cardSnapshot(card), resourceType: "desktop_card", schemaVersion: 1, clientCardId: card.id, layoutId,
  } };
  let check = 0;
  const getContext = vi.fn().mockResolvedValueOnce({ nodes: [activeNode], edges: [] })
    .mockResolvedValue({ nodes: [{ ...activeNode, status: "revoked", deletedAt: "2026-09-05T10:00:00Z" }], edges: [] });
  const host = {
    kind: "http",
    getContext,
    applyChange: vi.fn(),
    health: vi.fn(async () => {
      const checkedAt = new Date(1_700_000_000_000 + check++ * 10_000).toISOString();
      return { state: "ready", checkedAt, domain: { service: "domain", state: "ready", checkedAt }, agent: { service: "agent", state: "ready", checkedAt } };
    }),
  } as unknown as DesktopRuntimePort;
  function Harness() {
    const notes = useCustomDesktopCards(layoutId);
    const { refreshHealth } = useDesktopRuntime();
    return <><output aria-label="可用卡片数">{notes.cards.length}</output><button onClick={() => { void refreshHealth(); }}>检查连接</button></>;
  }
  render(<DesktopRuntimeProvider runtime={host} healthPollMs={0}><Harness /></DesktopRuntimeProvider>);
  await waitFor(() => expect(getContext).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText("可用卡片数")).toHaveTextContent("1");
  fireEvent.click(screen.getByText("检查连接"));
  await waitFor(() => expect(screen.getByLabelText("可用卡片数")).toHaveTextContent("0"));
  expect(getContext).toHaveBeenCalledTimes(2);
  expect(host.applyChange).not.toHaveBeenCalled();
  expect(new CustomDesktopCardStore(layoutId).getSnapshot().cards[0]).toMatchObject({ body: "这段文字仍在本机备份", domainRetracted: true });
});

it("discovers an older clue note arriving through another window's storage event", async () => {
  const layoutId = "storage-event-migration";
  function Harness() {
    const notes = useCustomDesktopCards(layoutId);
    return <output aria-label="迁入文字">{notes.cards.map((card) => card.body).join(" / ")}</output>;
  }
  render(<Harness />);
  expect(screen.getByLabelText("迁入文字")).toHaveTextContent("");
  const legacy = new CustomDesktopCardStore(`${layoutId}--clue-abc`);
  legacy.create({ title: "从旧桌面接着写", body: "其他窗口的未同步内容", template: "note" });
  fireEvent(window, new StorageEvent("storage", { key: legacy.key, newValue: window.localStorage.getItem(legacy.key) }));
  await waitFor(() => expect(screen.getByLabelText("迁入文字")).toHaveTextContent("其他窗口的未同步内容"));
  expect(new CustomDesktopCardStore(layoutId).getSnapshot().cards[0].legacyOrigin?.layoutId).toBe(`${layoutId}--clue-abc`);
});

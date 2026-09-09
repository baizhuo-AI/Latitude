import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DimensionApp } from "./DimensionApp";
import { buildBrowserProjection } from "../projections/desktop/browserProjection";
import { readDesktopFrames } from "../runtime/layout/desktopFrameStorage";

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(976);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const viewport = this.closest<HTMLElement>(".dim-desk-scroll");
    if (this.classList.contains("dim-desk-scroll")) return new DOMRect(0, 0, 1000, 700);
    if (this.classList.contains("dim-desktop-toolbar")) return new DOMRect(0, 0, 1000, 80);
    if (this.classList.contains("dim-desktop-canvas")) return new DOMRect(-(viewport?.scrollLeft ?? 0), 100 - (viewport?.scrollTop ?? 0), 1000, 200);
    const surface = this.closest<HTMLElement>("[data-desktop-zoom]");
    if (!surface) return new DOMRect();
    const zoom = Number(surface.dataset.desktopZoom) || 1;
    const left = Number.parseFloat(surface.style.left) - (viewport?.scrollLeft ?? 0);
    const top = 100 + Number.parseFloat(surface.style.top) - (viewport?.scrollTop ?? 0);
    if (this.hasAttribute("data-spatial-card-id")) {
      const slot = this.closest<HTMLElement>("[data-layout-card-id]")!;
      const [dx = 0, dy = 0] = (this.style.translate || "0 0").split(" ").map(Number.parseFloat);
      return new DOMRect(left + ((Number.parseFloat(slot.style.left) || 0) + dx) * zoom,
        top + ((Number.parseFloat(slot.style.top) || 0) + dy) * zoom,
        (Number.parseFloat(this.style.width) || 320) * zoom, (Number.parseFloat(this.style.height) || 200) * zoom);
    }
    return new DOMRect(left, top, 976 * zoom, 200 * zoom);
  });
});
afterEach(() => vi.restoreAllMocks());

describe("new desktop paper placement", () => {
  it.each([false, true])("persists a free new frame without changing existing frames (visible area full: %s)", async (full) => {
    const { projection, layout } = buildBrowserProjection({ context: { nodes: [], edges: [] }, runtimeState: "unavailable", now: new Date("2026-09-08T12:00:00Z") });
    const id = `placement-integration-${full}`;
    const existing = Object.fromEntries(layout.cards.map((card, index) => [card.id, index === 0
      ? { x: 0, y: 0, width: full ? 1000 : 420, height: full ? 1000 : 400 }
      : { x: 3500 + index * 600, y: 0, width: 420, height: 400 }]));
    localStorage.setItem(`dim-desk-frames-${id}`, JSON.stringify({ version: 1, frames: existing }));
    render(<DimensionApp layout={{ ...layout, id }} projection={projection} />);
    fireEvent.click(screen.getByRole("button", { name: "＋ 新建" }));
    const form = screen.getByRole("dialog", { name: "新建卡片" });
    fireEvent.change(within(form).getByLabelText("标题"), { target: { value: "放在空位的新便签" } });
    fireEvent.change(within(form).getByLabelText("正文"), { target: { value: "保留旁边的卡片位置。" } });
    fireEvent.click(within(form).getByRole("button", { name: "创建卡片" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const frames = readDesktopFrames(`dim-desk-frames-${id}`)!;
    const created = Object.entries(frames).find(([cardId]) => cardId.startsWith("custom-card-"))![1];
    for (const [cardId, old] of Object.entries(existing)) {
      expect(frames[cardId]).toEqual(old);
      expect(created.x + created.width <= old.x || created.x >= old.x + old.width
        || created.y + created.height <= old.y || created.y >= old.y + old.height).toBe(true);
    }
    if (!full) {
      expect(created.x).toBeGreaterThanOrEqual(-12);
      expect(created.x + created.width).toBeLessThanOrEqual(988);
    }
    expect(screen.getByRole("heading", { name: "放在空位的新便签" })).toBeInTheDocument();
  });
});

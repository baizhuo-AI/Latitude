import { describe, expect, it, vi } from "vitest";
import { arrangedCardSize, cardIsInView, cardViewportBounds, clampCardTitleToBounds, desktopZoomFor, locateCardCorrection } from "./cardSpatialGeometry";

const bounds = { left: 100, top: 80, right: 1200, bottom: 730, width: 1100, height: 650 };
const rect = (left: number, top: number, width = 320, height = 240) => ({ left, top, width, height, right: left + width, bottom: top + height });

describe("card spatial geometry", () => {
  it("reads only the nearest valid explicit desktop scale, defaulting invalid values to 100%", () => {
    const surface = document.createElement("div");
    surface.dataset.desktopZoom = "0.5";
    surface.innerHTML = '<div><span></span></div>';
    const card = surface.querySelector("span")!;
    expect(desktopZoomFor(card)).toBe(0.5);
    card.parentElement!.dataset.desktopZoom = "1.5";
    expect(desktopZoomFor(card)).toBe(1.5);
    for (const invalid of ["NaN", "Infinity", "0", "-1", ""]) {
      card.parentElement!.dataset.desktopZoom = invalid;
      expect(desktopZoomFor(card)).toBe(1);
    }
    expect(desktopZoomFor(document.createElement("div"))).toBe(1);
  });

  it("repairs cards beyond every edge, keeping the start of the title reachable", () => {
    expect(clampCardTitleToBounds(rect(-500, -500), bounds)).toEqual({ x: 600, y: 580 });
    expect(clampCardTitleToBounds(rect(1600, 1000), bounds)).toEqual({ x: -544, y: -318 });
    expect(clampCardTitleToBounds(rect(200, 140), bounds)).toEqual({ x: 0, y: 0 });
  });

  it("locate repairs unreachable negative offsets and reveals the whole paper", () => {
    const lost = rect(-1500, -1000);
    const correction = locateCardCorrection(lost, bounds);
    expect(cardIsInView(rect(lost.left + correction.x, lost.top + correction.y), bounds)).toBe(true);
    expect(cardIsInView(rect(100, 700), bounds)).toBe(false);
  });

  it("oversized cards expose their top edge without inventing negative centering", () => {
    const lost = rect(2000, 2000, 1800, 900);
    expect(locateCardCorrection(lost, bounds)).toEqual({ x: -1900, y: -1920 });
    expect(cardIsInView(rect(100, 80, 1800, 900), bounds)).toBe(true);
    expect(cardIsInView(rect(100, -20, 320, 900), bounds)).toBe(false);
  });

  it("excludes the connection notice and actual grid top when fitting six cards", () => {
    const viewport = document.createElement("div");
    viewport.className = "dim-desk-scroll";
    viewport.innerHTML = '<div class="dim-desktop-toolbar"></div><div class="dim-desktop-connection"></div><div class="dim-grid-wrap"><div class="paper"></div></div>';
    const toolbar = viewport.querySelector<HTMLElement>(".dim-desktop-toolbar")!;
    const connection = viewport.querySelector<HTMLElement>(".dim-desktop-connection")!;
    const canvas = viewport.querySelector<HTMLElement>(".dim-grid-wrap")!;
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 60, 1140, 590));
    vi.spyOn(toolbar, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 80, 1100, 40));
    vi.spyOn(connection, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 130, 1100, 40));
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 194, 1100, 600));
    const available = cardViewportBounds(canvas.querySelector<HTMLElement>(".paper")!)!;
    expect(available.top).toBe(194);
    const size = arrangedCardSize(1100, available.height, 6, 16);
    expect(available.top + size.height * 2 + 16).toBeLessThanOrEqual(available.bottom);
  });

  it("fits six cards in two readable rows when space permits, and scrolls for larger collections", () => {
    const six = arrangedCardSize(1100, 650, 6, 16);
    expect(six.width * 3 + 32).toBeLessThanOrEqual(1100);
    expect(six.height * 2 + 16).toBeLessThanOrEqual(650);
    expect(arrangedCardSize(600, 650, 12, 16).height).toBe(190);
  });

  it.each([0.5, 1, 1.5])("reserves the natural grid gutter at %s zoom when arranging cards with old negative offsets", (zoom) => {
    const viewport = document.createElement("div");
    viewport.className = "dim-desk-scroll";
    viewport.innerHTML = `<div class="dim-desktop-canvas"><div data-desktop-zoom="${zoom}"><div class="dim-grid-wrap"><div class="dim-grid"><div class="paper"></div></div></div></div></div>`;
    const stage = viewport.querySelector<HTMLElement>(".dim-desktop-canvas")!;
    const surface = viewport.querySelector<HTMLElement>("[data-desktop-zoom]")!;
    const canvas = viewport.querySelector<HTMLElement>(".dim-grid-wrap")!;
    const grid = viewport.querySelector<HTMLElement>(".dim-grid")!;
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1140, 500));
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 30, 1140, 1500));
    // Old offscreen cards have moved the camera origin by 100 logical pixels;
    // the new arrangement keeps only its normal 12px gutter and 8px grid margin.
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(new DOMRect(12 * zoom, 30 + 112 * zoom, 1100 * zoom, 1000 * zoom));
    const gridRect = new DOMRect(12 * zoom, 30 + 120 * zoom, 1100 * zoom, 800 * zoom);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(gridRect);
    vi.spyOn(grid, "getBoundingClientRect").mockReturnValue(gridRect);
    const bounds = cardViewportBounds(grid.querySelector<HTMLElement>(".paper")!)!;
    expect(bounds.top).toBe(30 + 20 * zoom);
    const size = arrangedCardSize(1100, bounds.height / zoom, 6, 16);
    if (size.height > 190) expect(bounds.top + (size.height * 2 + 16) * zoom).toBeLessThanOrEqual(bounds.bottom + zoom);
  });
});

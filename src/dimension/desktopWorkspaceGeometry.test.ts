import { beforeEach, describe, expect, it } from "vitest";
import { desktopBoundsFromScreenBoxes, findDesktopCardPlacement, readLegacyContentWidths, readOccupiedDesktopFrames, resolveLegacyDesktopFrames } from "./desktopWorkspaceGeometry";
import { reconcileDesktopWorkspace } from "./desktopWorkspace";
import { CustomDesktopCardStore } from "./custom-cards/store";

describe("desktop workspace geometry", () => {
  beforeEach(() => localStorage.clear());

  it("allocates beyond a root card's drag and size overrides without changing those records", () => {
    const id = "occupied-test";
    const frames = JSON.stringify({ version: 1, frames: { root: { x: 100, y: 50, width: 320, height: 200 } } });
    const offsets = JSON.stringify({ root: { x: 1800, y: -40 } });
    const sizes = JSON.stringify({ root: { width: 900, height: 700 } });
    localStorage.setItem(`dim-desk-frames-${id}`, frames);
    localStorage.setItem(`dim-desk-offsets-${id}`, offsets);
    localStorage.setItem(`dim-desk-sizes-${id}`, sizes);
    const occupied = readOccupiedDesktopFrames(id);
    expect(occupied.root).toEqual({ x: 1900, y: 10, width: 900, height: 700 });
    const workspace = reconcileDesktopWorkspace({ version: 1, activeAreaId: null, areas: {} }, [], id, occupied, [`${id}--clue-legacy`]);
    expect(Object.values(workspace.areas)[0].x).toBeGreaterThan(occupied.root.x + occupied.root.width);
    expect(localStorage.getItem(`dim-desk-frames-${id}`)).toBe(frames);
    expect(localStorage.getItem(`dim-desk-offsets-${id}`)).toBe(offsets);
    expect(localStorage.getItem(`dim-desk-sizes-${id}`)).toBe(sizes);
  });

  it("legacy grid deltas retain separate bases even when every saved offset is zero", () => {
    const frames = resolveLegacyDesktopFrames([0, 1, 2].map(sourceIndex => ({
      originLayoutId: "old", sourceIndex, offset: { x: 0, y: 0 }, size: { width: 430, height: 380 },
    })));
    expect(frames[1].x).toBeGreaterThan(frames[0].x + frames[0].width);
    expect(frames[2].y).toBeGreaterThan(frames[0].y + frames[0].height);
    expect(frames.map(frame => [frame.width, frame.height])).toEqual([[430, 380], [430, 380], [430, 380]]);
    const moved = resolveLegacyDesktopFrames([
      { originLayoutId: "old", sourceIndex: 0, offset: { x: -80, y: 50 } },
      { originLayoutId: "old", sourceIndex: 1, offset: { x: 100, y: -30 } },
    ]);
    expect(moved[1].x - moved[0].x).toBe(380 + 180);
    expect(moved[1].y - moved[0].y).toBe(-80);
  });

  it("preserves absolute legacy coordinates and separates distinct source desks", () => {
    const first = { x: -200, y: 400, width: 500, height: 600 };
    const second = { x: 420, y: -100, width: 300, height: 400 };
    const result = resolveLegacyDesktopFrames([
      { originLayoutId: "old-a", sourceIndex: 0, frame: first, offset: { x: 99, y: 99 } },
      { originLayoutId: "old-a", sourceIndex: 1, frame: second },
      { originLayoutId: "old-b", sourceIndex: 0, frame: first },
    ]);
    expect(result[0]).toEqual(first);
    expect(result[1]).toEqual(second);
    expect(result[2].x).toBeGreaterThan(second.x + second.width);
    expect(result[2].y).toBe(first.y);
  });

  it.each([1, 0.5, 0.5 * 0.74])("converts area bounds consistently at screen scale %s", (screenZoom) => {
    const origin = { left: 80, top: -900 };
    const bounds = desktopBoundsFromScreenBoxes(origin, [{
      left: origin.left + 2400 * screenZoom,
      top: origin.top + 170 * screenZoom,
      width: 640 * screenZoom, height: 400 * screenZoom,
    }], screenZoom);
    expect(bounds.left).toBeCloseTo(2380);
    expect(bounds.top).toBeCloseTo(105);
    expect(bounds.width).toBeCloseTo(680);
    expect(bounds.height).toBeCloseTo(485);
  });

  it("reserves a wide legacy group's space before allocating its neighboring region", () => {
    const id = "wide-migration";
    const firstId = `${id}--clue-one`;
    const secondId = `${id}--clue-two`;
    const empty = { version: 1 as const, areas: {}, activeAreaId: null };
    const first = reconcileDesktopWorkspace(empty, [], id, {}, [firstId, secondId], { [firstId]: 3100, [secondId]: 800 });
    const left = first.areas[`legacy:${firstId}`];
    const right = first.areas[`legacy:${secondId}`];
    expect(right.x).toBeGreaterThan(left.x + 720 + 3100);
    const restored = reconcileDesktopWorkspace(first, [], id, {}, [firstId, secondId], { [firstId]: 9000 });
    expect(restored.areas).toEqual(first.areas);
  });

  it("reads migration reservation width from the actual saved legacy frames and overrides", () => {
    const rootId = "migration-width-state";
    const legacyId = `${rootId}--clue-one`;
    const old = new CustomDesktopCardStore(legacyId);
    const first = old.create({ title: "宽纸张", body: "原有内容", template: "note" })!;
    const second = old.create({ title: "右侧纸张", body: "保留间距", template: "note" })!;
    localStorage.setItem(`dim-desk-frames-${legacyId}`, JSON.stringify({ version: 1, frames: {
      [first.id]: { x: -200, y: 0, width: 600, height: 300 },
      [second.id]: { x: 2300, y: 0, width: 600, height: 300 },
    } }));
    localStorage.setItem(`dim-desk-sizes-${legacyId}`, JSON.stringify({ [second.id]: { width: 900, height: 400 } }));
    localStorage.setItem(`dim-desk-offsets-${legacyId}`, JSON.stringify({ [second.id]: { x: 100, y: 20 } }));
    const root = new CustomDesktopCardStore(rootId);
    expect(readLegacyContentWidths(root.getSnapshot().cards)).toEqual({ [legacyId]: 3500 });
  });

  it("puts a new paper in a visible gap while leaving existing papers untouched", () => {
    const visible = { left: 1000, top: -500, width: 1200, height: 800 };
    const occupied = [{ left: 1400, top: -300, width: 430, height: 380 }];
    const before = JSON.stringify(occupied);
    const frame = findDesktopCardPlacement(visible, occupied);
    expect(frame.x).toBeGreaterThanOrEqual(visible.left);
    expect(frame.y).toBeGreaterThanOrEqual(visible.top);
    expect(frame.x + frame.width).toBeLessThanOrEqual(visible.left + visible.width);
    expect(frame.y + frame.height).toBeLessThanOrEqual(visible.top + visible.height);
    expect(frame.x + frame.width <= 1400 || frame.x >= 1830 || frame.y + frame.height <= -300 || frame.y >= 80).toBe(true);
    expect(JSON.stringify(occupied)).toBe(before);
  });

  it("uses an immediately neighboring edge when the entire visible area is occupied", () => {
    const visible = { left: -1000, top: 500, width: 1000, height: 700 };
    const frame = findDesktopCardPlacement(visible, [visible]);
    expect(frame.x >= 0 || frame.x + frame.width <= -1000 || frame.y >= 1200 || frame.y + frame.height <= 500).toBe(true);
    const edgeDistance = Math.min(Math.abs(frame.x), Math.abs(frame.x + frame.width + 1000),
      Math.abs(frame.y - 1200), Math.abs(frame.y + frame.height - 500));
    expect(edgeDistance).toBe(24);
  });
});

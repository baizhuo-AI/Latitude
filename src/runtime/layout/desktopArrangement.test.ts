import { describe, expect, it } from "vitest";
import { arrangeDesktopCards, recommendedCardSize } from "./desktopArrangement";
import type { DesktopArrangement, DesktopArrangementCard } from "./desktopArrangement";

const cards: DesktopArrangementCard[] = ["note", "anchors", "activity", "feed", "progress", "chart"].map((kind) => ({ id: kind, kind }));

function checkClearance(arrangement: DesktopArrangement) {
  const ids = Object.keys(arrangement.positions);
  for (let first = 0; first < ids.length; first++) {
    for (let second = first + 1; second < ids.length; second++) {
      const a = { ...arrangement.positions[ids[first]], ...arrangement.sizes[ids[first]] };
      const b = { ...arrangement.positions[ids[second]], ...arrangement.sizes[ids[second]] };
      const separate = a.x + a.width + 20 <= b.x || b.x + b.width + 20 <= a.x || a.y + a.height + 20 <= b.y || b.y + b.height + 20 <= a.y;
      expect(separate, `${ids[first]} and ${ids[second]} need readable space between them`).toBe(true);
    }
  }
}

function withArrangement(source: DesktopArrangementCard[], arrangement: DesktopArrangement) {
  return source.map((card) => ({ ...card, ...arrangement.positions[card.id], ...arrangement.sizes[card.id] }));
}

describe("desktop paper arrangement", () => {
  it("gives the early report a left reading area and compact reminders their own proportions", () => {
    const arrangement = arrangeDesktopCards(cards, 1180);
    expect(arrangement.positions.feed).toEqual({ x: 0, y: 0 });
    expect(arrangement.sizes.feed).toEqual({ width: 420, height: 440 });
    expect(arrangement.sizes.note.width).toBeLessThan(arrangement.sizes.feed.width);
    expect(arrangement.sizes.note.height).toBeLessThan(arrangement.sizes.activity.height);
    expect(arrangement.sizes.anchors.height).toBeGreaterThan(arrangement.sizes.activity.height);
    expect(arrangement.sizes.chart.width / arrangement.sizes.chart.height).toBeGreaterThan(1.5);
    expect(new Set(Object.values(arrangement.sizes).map((size) => `${size.width}x${size.height}`)).size).toBe(6);
    const firstRow = Object.values(arrangement.positions).filter(({ y }) => y === 0);
    expect(firstRow).toHaveLength(3);
    expect(Math.max(...cards.map(({ id }) => arrangement.positions[id].y + arrangement.sizes[id].height))).toBeLessThan(720);
    checkClearance(arrangement);
  });

  it.each([280, 600, 760, 1100, 1180, 1600])("stays separated within a %s px canvas and does not shuffle on a second arrange", (width) => {
    const first = arrangeDesktopCards(cards, width);
    checkClearance(first);
    for (const { id } of cards) {
      expect(first.positions[id].x).toBeGreaterThanOrEqual(0);
      expect(first.positions[id].x + first.sizes[id].width).toBeLessThanOrEqual(width);
    }
    expect(arrangeDesktopCards(withArrangement(cards, first), width)).toEqual(first);
  });

  it("keeps the existing reading order even when the report has been moved away from the left", () => {
    const source: DesktopArrangementCard[] = [
      { id: "feed", kind: "feed", x: 640, y: 100 },
      { id: "note", kind: "note", x: 80, y: 100 },
      { id: "activity", kind: "activity", x: 400, y: 100 },
      { id: "chart", kind: "chart", x: -120, y: 600 },
    ];
    const arrangement = arrangeDesktopCards(source, 1180);
    expect(arrangement.positions.note.x).toBe(0);
    expect(arrangement.positions.activity.x).toBeGreaterThan(arrangement.positions.note.x);
    expect(arrangement.positions.feed.x).toBeGreaterThan(arrangement.positions.activity.x);
    expect(arrangement.positions.chart.y).toBeGreaterThan(arrangement.positions.feed.y);
    expect(arrangeDesktopCards(withArrangement(source, arrangement), 1180)).toEqual(arrangement);
  });

  it("retains manual sizes exactly, including a paper wider than the window", () => {
    const source: DesktopArrangementCard[] = [
      { id: "feed", kind: "feed", manualSize: true, width: 1420.5, height: 850.25 },
      { id: "note", kind: "note", manualSize: true, width: 244, height: 190 },
      { id: "chart", kind: "chart", width: 1000, height: 900 },
    ];
    const arrangement = arrangeDesktopCards(source, 600);
    expect(arrangement.sizes.feed).toEqual({ width: 1420.5, height: 850.25 });
    expect(arrangement.sizes.note).toEqual({ width: 244, height: 190 });
    expect(arrangement.sizes.chart).toEqual(recommendedCardSize("chart", 600));
    expect(arrangement.positions.feed.x).toBe(0);
    expect(arrangement.positions.note.x + arrangement.sizes.note.width).toBeLessThanOrEqual(600);
    checkClearance(arrangement);
    expect(arrangeDesktopCards(withArrangement(source, arrangement), 600)).toEqual(arrangement);
  });

  it("remains stable for a larger mixed collection with manual sizes and previous overlaps", () => {
    const source: DesktopArrangementCard[] = Array.from({ length: 36 }, (_, index) => ({
      id: `paper-${index}`,
      kind: cards[index % cards.length].kind,
      x: index % 3 * 310 - 200,
      y: Math.floor(index / 3) * 190 - 100,
      manualSize: index % 4 === 0,
      width: 240 + index % 5 * 55,
      height: 180 + index % 7 * 45,
    }));
    const arrangement = arrangeDesktopCards(source, 1180);
    checkClearance(arrangement);
    expect(arrangeDesktopCards(withArrangement(source, arrangement), 1180)).toEqual(arrangement);
  });

  it("does not mutate input and recovers incomplete or invalid saved geometry", () => {
    const source = Object.freeze([
      Object.freeze({ id: "first", kind: "unknown", manualSize: true, width: Number.NaN, height: 320, x: Infinity, y: -1 }),
      Object.freeze({ id: "__proto__", kind: "note" }),
      Object.freeze({ id: "first", kind: "feed" }),
    ]);
    const arrangement = arrangeDesktopCards(source, Number.NaN);
    expect(Object.keys(arrangement.positions).sort()).toEqual(["__proto__", "first"]);
    expect(arrangement.sizes.first).toEqual({ width: 340, height: 320 });
    expect(arrangement.sizes.__proto__).toEqual({ width: 300, height: 210 });
    expect(recommendedCardSize("__proto__", 1180)).toEqual({ width: 340, height: 260 });
    checkClearance(arrangement);
    expect(arrangeDesktopCards([], 0)).toEqual({ positions: {}, sizes: {} });
  });
});

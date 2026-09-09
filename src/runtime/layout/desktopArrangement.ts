export interface DesktopArrangementCard {
  id: string;
  kind: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  manualSize?: boolean;
}

export interface DesktopCardPosition { x: number; y: number }
export interface DesktopCardDimensions { width: number; height: number }
export interface DesktopArrangement {
  positions: Record<string, DesktopCardPosition>;
  sizes: Record<string, DesktopCardDimensions>;
}

const GAP = 22;
const DEFAULT_WIDTH = 1180;

const RECOMMENDED: Record<string, DesktopCardDimensions> = {
  feed: { width: 420, height: 440 },
  activity: { width: 340, height: 290 },
  anchors: { width: 350, height: 330 },
  progress: { width: 320, height: 220 },
  chart: { width: 400, height: 220 },
  note: { width: 300, height: 210 },
  text: { width: 340, height: 260 },
  cognition: { width: 340, height: 260 },
};

const DEFAULT_ORDER = ["feed", "activity", "anchors", "progress", "chart", "note", "text", "cognition"];
const positive = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const finite = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value);
const canvasWidth = (value: number) => positive(value) ? Math.max(200, Math.floor(value)) : DEFAULT_WIDTH;

/** Reading cards receive more room than reminders. These are logical paper
 * sizes, independent of camera zoom and the height of the browser window. */
export function recommendedCardSize(kind: string, availableWidth: number): DesktopCardDimensions {
  const room = canvasWidth(availableWidth);
  const preferred = Object.prototype.hasOwnProperty.call(RECOMMENDED, kind) ? RECOMMENDED[kind] : RECOMMENDED.text;
  let width = Math.min(preferred.width, room);
  if (room >= 900) {
    // Fit a reading column between two smaller papers even on laptop screens.
    // Secondary cards share those widths so lower rows do not waste a column.
    const share = ["feed", "chart"].includes(kind) ? 0.38 : 0.31;
    width = Math.min(width, Math.floor((room - GAP * 2) * share));
  } else if (["feed", "activity", "anchors"].includes(kind)) {
    if (room >= 640) {
      const share = kind === "feed" ? 0.54 : 0.46;
      width = Math.min(width, Math.floor((room - GAP) * share));
    }
  }
  return { width, height: preferred.height };
}

function hasPosition(card: DesktopArrangementCard): card is DesktopArrangementCard & DesktopCardPosition {
  return finite(card.x) && finite(card.y);
}

function readingOrder(cards: readonly DesktopArrangementCard[]) {
  const priority = (kind: string) => {
    const index = DEFAULT_ORDER.indexOf(kind);
    return index < 0 ? DEFAULT_ORDER.length : index;
  };
  return cards.map((card, index) => ({ card, index })).sort((a, b) => {
    if (hasPosition(a.card) && hasPosition(b.card)) return a.card.y - b.card.y || a.card.x - b.card.x || a.index - b.index;
    const positionedA = hasPosition(a.card);
    const positionedB = hasPosition(b.card);
    if (positionedA !== positionedB) return positionedA ? -1 : 1;
    return priority(a.card.kind) - priority(b.card.kind) || a.index - b.index;
  }).map(({ card }) => card);
}

interface PlacedCard extends DesktopCardPosition, DesktopCardDimensions { id: string }

function hasClearance(position: DesktopCardPosition, size: DesktopCardDimensions, placed: readonly PlacedCard[]) {
  return placed.every((card) =>
    position.x + size.width + GAP <= card.x || card.x + card.width + GAP <= position.x ||
    position.y + size.height + GAP <= card.y || card.y + card.height + GAP <= position.y,
  );
}

/** Arrange once, then leave every card independent. Bottom-left placement packs
 * different-sized papers while preserving their reading order. Later papers
 * never backfill above earlier ones: the resulting order is the same on the
 * next arrange, so repeated clicks cannot reshuffle the desk. */
export function arrangeDesktopCards(cards: readonly DesktopArrangementCard[], availableWidth: number, obstacles: readonly PlacedCard[] = []): DesktopArrangement {
  const room = canvasWidth(availableWidth);
  const seen = new Set<string>();
  const unique = cards.filter((card) => {
    if (!card.id || seen.has(card.id)) return false;
    seen.add(card.id);
    return true;
  });
  const placed: PlacedCard[] = [...obstacles];
  let previous: PlacedCard | undefined;

  for (const card of readingOrder(unique)) {
    const recommended = recommendedCardSize(card.kind, room);
    const size = {
      width: card.manualSize && positive(card.width) ? card.width : recommended.width,
      height: card.manualSize && positive(card.height) ? card.height : recommended.height,
    };
    // An intentionally wide card can extend the canvas. It must not be shrunk
    // merely to fit the current viewport or push ordinary cards into that space.
    const limit = Math.max(room, size.width);
    const last = previous;
    const xs = [...new Set([0, ...placed.flatMap((item) => [item.x, item.x + item.width + GAP])])].sort((a, b) => a - b);
    const ys = [...new Set([last?.y ?? 0, ...placed.map((item) => item.y + item.height + GAP)])].sort((a, b) => a - b);
    let position: DesktopCardPosition | undefined;
    for (const y of ys) {
      if (y < 0) continue;
      if (last && y < last.y) continue;
      for (const x of xs) {
        if (x < 0) continue;
        if (last && y === last.y && x <= last.x) continue;
        if (x + size.width > limit) continue;
        if (hasClearance({ x, y }, size, placed)) {
          position = { x, y };
          break;
        }
      }
      if (position) break;
    }
    // The row below every existing paper always has enough room, including
    // malformed old coordinates and a manually oversized paper.
    position ??= { x: 0, y: placed.length ? Math.max(...placed.map((item) => item.y + item.height)) + GAP : 0 };
    previous = { id: card.id, ...position, ...size };
    placed.push(previous);
  }

  return {
    positions: Object.fromEntries(placed.slice(obstacles.length).map(({ id, x, y }) => [id, { x, y }])),
    sizes: Object.fromEntries(placed.slice(obstacles.length).map(({ id, width, height }) => [id, { width, height }])),
  };
}

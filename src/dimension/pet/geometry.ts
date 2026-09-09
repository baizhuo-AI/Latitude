export interface Point { x: number; y: number }
export interface Rect extends Point { width: number; height: number }

export function inside(point: Point, rect: Rect): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width &&
    point.y >= rect.y && point.y <= rect.y + rect.height;
}

export function fitPosition(point: Point, bounds: Rect, size: { width: number; height: number }): Point {
  return {
    x: Math.max(bounds.x, Math.min(point.x, bounds.x + Math.max(0, bounds.width - size.width))),
    y: Math.max(bounds.y, Math.min(point.y, bounds.y + Math.max(0, bounds.height - size.height))),
  };
}

export function besidePet(pet: Rect, bounds: Rect, width = 340, height = 180): Point {
  const left = pet.x - width - 12;
  return fitPosition({ x: left >= bounds.x ? left : pet.x + pet.width + 12, y: pet.y }, bounds, { width, height });
}

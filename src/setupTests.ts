import "@testing-library/jest-dom/vitest";

// jsdom does not decode image pixels; browser QA checks the rendered artwork.
if (typeof HTMLImageElement !== "undefined") HTMLImageElement.prototype.decode = () => Promise.resolve();

// jsdom has pointer events but does not implement pointer capture.
if (typeof Element !== "undefined") {
  const captures = new WeakMap<Element, Set<number>>();
  Element.prototype.setPointerCapture = function (id: number) {
    const ids = captures.get(this) ?? new Set<number>();
    ids.add(id);
    captures.set(this, ids);
  };
  Element.prototype.hasPointerCapture = function (id: number) { return captures.get(this)?.has(id) ?? false; };
  Element.prototype.releasePointerCapture = function (id: number) { captures.get(this)?.delete(id); };
}

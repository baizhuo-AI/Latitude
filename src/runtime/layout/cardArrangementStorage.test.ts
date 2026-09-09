import { afterEach, describe, expect, it } from "vitest";
import { arrangementUndoKey, readArrangementUndo, writeArrangementUndo } from "./cardArrangementStorage";

const key = arrangementUndoKey("dim-desk-arranged-storage-test");

describe("bounded arrangement undo storage", () => {
  afterEach(() => localStorage.removeItem(key));

  it("keeps one layout-scoped latest snapshot and rejects malformed persisted shapes", () => {
    expect(key).toBe("dim-desk-arrangement-undo-storage-test");
    const first = { arranged: false, scrollTop: 10, scrollLeft: 0, offsets: { one: { x: 1, y: 2 } }, sizes: {} };
    writeArrangementUndo(key, first);
    expect(readArrangementUndo(key)).toEqual(first);
    const latest = { ...first, scrollTop: 200 };
    writeArrangementUndo(key, latest);
    expect(readArrangementUndo(key)).toEqual(latest);
    localStorage.setItem(key, JSON.stringify({ ...latest, offsets: { one: { x: "12", y: 2 } } }));
    expect(readArrangementUndo(key)).toBeNull();
  });

  it("does not keep an unbounded collection or stale predecessor", () => {
    const snapshot = { arranged: false, scrollTop: 0, scrollLeft: 0, offsets: {}, sizes: {} };
    writeArrangementUndo(key, snapshot);
    writeArrangementUndo(key, { ...snapshot, offsets: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`card-${index}`, { x: 0, y: 0 }])) });
    expect(localStorage.getItem(key)).toBeNull();
    localStorage.setItem(key, " ".repeat(64_001));
    expect(readArrangementUndo(key)).toBeNull();
  });

  it("round-trips frames separately from manual offsets and rejects invalid frame geometry", () => {
    const snapshot = { arranged: false, scrollTop: 20, scrollLeft: 5,
      frames: { one: { x: 420, y: 90, width: 340, height: 290 } },
      offsets: { one: { x: -20, y: 40 } }, sizes: { one: { width: 460, height: 370 } } };
    writeArrangementUndo(key, snapshot);
    expect(readArrangementUndo(key)).toEqual(snapshot);
    const invalid = { ...snapshot, frames: { one: { ...snapshot.frames.one, height: 139 } } };
    localStorage.setItem(key, JSON.stringify(invalid));
    expect(readArrangementUndo(key)).toBeNull();
    writeArrangementUndo(key, snapshot);
    writeArrangementUndo(key, invalid);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("allows up to 512 framed cards but bounds the whole snapshot and frame count", () => {
    const frames = Object.fromEntries(Array.from({ length: 512 }, (_, index) => [`paper-${index}`, { x: index, y: 0, width: 340, height: 290 }]));
    const snapshot = { arranged: true, scrollTop: 0, scrollLeft: 0, offsets: {}, sizes: {}, frames };
    writeArrangementUndo(key, snapshot);
    expect(readArrangementUndo(key)).toEqual(snapshot);
    writeArrangementUndo(key, { ...snapshot, frames: { ...frames, extra: { x: 0, y: 0, width: 340, height: 290 } } });
    expect(localStorage.getItem(key)).toBeNull();
    const longId = "字".repeat(30_000);
    writeArrangementUndo(key, { ...snapshot, offsets: { [longId]: { x: 0, y: 0 } }, frames: { [longId]: { x: 0, y: 0, width: 340, height: 290 } } });
    expect(localStorage.getItem(key)).toBeNull();
  });
});

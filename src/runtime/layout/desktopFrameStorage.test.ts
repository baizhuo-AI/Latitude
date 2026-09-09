import { afterEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_FRAMES_PREFIX, MAX_DESKTOP_FRAME_BYTES, readDesktopFrames, validateDesktopFrameDocument, writeDesktopFrames } from "./desktopFrameStorage";

const key = `${DESKTOP_FRAMES_PREFIX}storage-test`;
const frame = { x: -20.5, y: 90, width: 420.25, height: 440 };

afterEach(() => { vi.restoreAllMocks(); localStorage.removeItem(key); });

describe("desktop frame persistence", () => {
  it("round-trips independent paper coordinates and distinguishes empty from unmigrated desks", () => {
    expect(readDesktopFrames(key)).toBeNull();
    writeDesktopFrames(key, { feed: frame });
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ version: 1, frames: { feed: frame } });
    expect(readDesktopFrames(key)).toEqual({ feed: frame });
    writeDesktopFrames(key, {});
    expect(readDesktopFrames(key)).toEqual({});
    writeDesktopFrames(key, null);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it.each([
    { version: 2, frames: {} },
    { version: 1, frames: [] },
    { version: 1, frames: { " ": frame } },
    { version: 1, frames: { feed: { ...frame, x: "0" } } },
    { version: 1, frames: { feed: { ...frame, y: Infinity } } },
    { version: 1, frames: { feed: { ...frame, width: 0 } } },
    { version: 1, frames: { feed: { ...frame, height: 139 } } },
  ])("rejects malformed geometry before local loading or profile import", (value) => {
    expect(() => validateDesktopFrameDocument(value)).toThrow(/frame/);
    localStorage.setItem(key, JSON.stringify(value));
    expect(readDesktopFrames(key)).toBeNull();
  });

  it("bounds both card count and UTF-8 storage size", () => {
    const frames = Object.fromEntries(Array.from({ length: 512 }, (_, index) => [`paper-${index}`, frame]));
    writeDesktopFrames(key, frames);
    expect(Object.keys(readDesktopFrames(key)!)).toHaveLength(512);
    expect(() => validateDesktopFrameDocument({ version: 1, frames: { ...frames, overflow: frame } })).toThrow(/count/);
    const large = { version: 1, frames: { ["字".repeat(45_000)]: frame } };
    expect(JSON.stringify(large).length).toBeLessThan(MAX_DESKTOP_FRAME_BYTES);
    expect(() => validateDesktopFrameDocument(large)).toThrow(/storage limit/);
    localStorage.setItem(key, JSON.stringify(large));
    expect(readDesktopFrames(key)).toBeNull();
    localStorage.setItem(key, " ".repeat(MAX_DESKTOP_FRAME_BYTES + 1));
    expect(readDesktopFrames(key)).toBeNull();
  });

  it("returns safe owned records and does not mutate caller geometry", () => {
    const frames = Object.freeze(Object.fromEntries([["__proto__", Object.freeze(frame)]]));
    const document = validateDesktopFrameDocument({ version: 1, frames });
    expect(Object.keys(document.frames)).toEqual(["__proto__"]);
    expect(document.frames.__proto__).toEqual(frame);
    expect(document.frames.__proto__).not.toBe(frame);
  });

  it("keeps the last valid document when an invalid write or a storage failure occurs", () => {
    writeDesktopFrames(key, { feed: frame });
    writeDesktopFrames(key, { feed: { ...frame, width: Number.NaN } });
    expect(readDesktopFrames(key)).toEqual({ feed: frame });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    expect(() => writeDesktopFrames(key, {})).not.toThrow();
    expect(readDesktopFrames(key)).toEqual({ feed: frame });
  });
});

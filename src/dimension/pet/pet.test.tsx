import { act, cleanup, renderHook } from "@testing-library/react";
import type { PointerEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { besidePet, fitPosition } from "./geometry";
import { useSecretaryPet } from "./useSecretaryPet";
import { usePetInbox } from "./usePetInbox";

const nativePet = vi.hoisted(() => ({
  available: false,
  command: vi.fn(() => Promise.resolve()),
  subscribe: vi.fn(() => Promise.resolve(() => undefined)),
}));

vi.mock("./nativePet", () => ({
  nativePetAvailable: () => nativePet.available,
  petCommand: nativePet.command,
  subscribePetState: nativePet.subscribe,
}));

let nextFrameId = 0;
let animationFrames = new Map<number, FrameRequestCallback>();

function flushAnimationFrame() {
  const pending = [...animationFrames.values()];
  animationFrames.clear();
  pending.forEach((callback) => callback(performance.now()));
}

function captureButton(rect = new DOMRect(20, 20, 180, 220)) {
  const button = document.createElement("button");
  let captured = false;
  button.getBoundingClientRect = () => rect;
  button.setPointerCapture = vi.fn(() => { captured = true; });
  button.hasPointerCapture = vi.fn(() => captured);
  button.releasePointerCapture = vi.fn(() => { captured = false; });
  return button;
}

beforeEach(() => {
  localStorage.clear();
  nativePet.available = false;
  nativePet.command.mockReset().mockResolvedValue(undefined);
  nativePet.subscribe.mockReset().mockResolvedValue(() => undefined);
  nextFrameId = 0;
  animationFrames = new Map();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = ++nextFrameId;
    animationFrames.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    animationFrames.delete(id);
  });
  vi.stubGlobal("ResizeObserver", class {
    observe() { /* Test callbacks use the equivalent window layout events. */ }
    disconnect() { /* No resources outside the test. */ }
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("pet placement", () => {
  it("preserves negative monitor coordinates and keeps adjacent panels in the work area", () => {
    const monitor = { x: -1440, y: -900, width: 1440, height: 900 };
    expect(fitPosition({ x: -1700, y: -50 }, monitor, { width: 220, height: 260 })).toEqual({ x: -1440, y: -260 });
    const position = besidePet({ x: -1430, y: -260, width: 220, height: 260 }, monitor);
    expect(position.x).toBe(-1198);
    expect(position.y).toBe(-260);
  });

  it("commits only on release, cancels to the previous position, and accepts a return to the portrait frame", () => {
    const open = vi.fn();
    const { result } = renderHook(() => useSecretaryPet(open));
    const button = captureButton();
    const dock = document.createElement("div");
    dock.getBoundingClientRect = () => new DOMRect(20, 20, 180, 220);
    act(() => result.current.setDockRef(dock));
    const pointer = (x: number, y: number) => ({ button: 0, pointerId: 1, clientX: x, clientY: y, currentTarget: button }) as PointerEvent<HTMLButtonElement>;

    act(() => result.current.handlers("dock").onPointerDown(pointer(100, 100)));
    act(() => result.current.handlers("dock").onPointerMove(pointer(600, 400)));
    expect(result.current.state.mode).toBe("docked");
    act(flushAnimationFrame);
    expect(result.current.state.dragging).toBe(true);
    act(() => result.current.handlers("dock").onPointerUp(pointer(600, 400)));
    expect(result.current.state.mode).toBe("floating");
    expect(open).not.toHaveBeenCalled();
    const previous = result.current.state;

    act(() => result.current.handlers("pet").onPointerDown(pointer(600, 400)));
    act(() => result.current.handlers("pet").onPointerMove(pointer(700, 500)));
    act(flushAnimationFrame);
    act(() => result.current.handlers("pet").onPointerCancel());
    expect(result.current.state).toEqual(previous);
    act(() => result.current.handlers("pet").onPointerDown(pointer(600, 400)));
    act(() => result.current.handlers("pet").onPointerMove(pointer(100, 100)));
    act(flushAnimationFrame);
    expect(result.current.state.overDock).toBe(true);
    act(() => result.current.handlers("pet").onPointerUp(pointer(100, 100)));
    expect(result.current.state.mode).toBe("docked");
  });

  it("opens chat for a click with minor hand movement instead of detaching", () => {
    const open = vi.fn();
    const { result } = renderHook(() => useSecretaryPet(open));
    const button = document.createElement("button");
    button.getBoundingClientRect = () => new DOMRect(0, 0, 180, 220);
    const event = { button: 0, pointerId: 1, clientX: 50, clientY: 50, currentTarget: button } as PointerEvent<HTMLButtonElement>;
    act(() => result.current.handlers("dock").onPointerDown(event));
    act(() => result.current.handlers("dock").onPointerMove({ ...event, clientX: 52 }));
    act(() => result.current.handlers("dock").onPointerUp(event));
    expect(open).toHaveBeenCalledOnce();
    expect(result.current.state.mode).toBe("docked");
  });

  it("coalesces browser movement per frame, moves with a transform, and commits the release point", () => {
    const { result } = renderHook(() => useSecretaryPet(vi.fn()));
    const button = captureButton();
    const floating = document.createElement("div");
    act(() => result.current.setFloatingRef(floating));
    const pointer = (x: number, y: number) => ({ button: 0, pointerId: 7, clientX: x, clientY: y, currentTarget: button }) as PointerEvent<HTMLButtonElement>;

    act(() => result.current.handlers("dock").onPointerDown(pointer(100, 100)));
    act(() => {
      result.current.handlers("dock").onPointerMove(pointer(600, 400));
      result.current.handlers("dock").onPointerMove(pointer(620, 420));
    });
    expect(animationFrames).toHaveLength(1);
    act(flushAnimationFrame);
    expect(result.current.state).toMatchObject({ dragging: true, x: 540, y: 340 });
    expect(floating.style.transform).toBe("translate3d(540px, 340px, 0)");

    const renderedState = result.current.state;
    act(() => result.current.handlers("dock").onPointerMove(pointer(700, 500)));
    act(flushAnimationFrame);
    expect(result.current.state).toBe(renderedState);
    expect(floating.style.transform).toBe("translate3d(620px, 420px, 0)");

    act(() => result.current.handlers("dock").onPointerUp(pointer(700, 500)));
    expect(result.current.state).toMatchObject({ mode: "floating", dragging: false, x: 620, y: 420 });
    expect(JSON.parse(localStorage.getItem("latitude.pet-placement.v1")!)).toMatchObject({ x: 620, y: 420 });
  });

  it("Escape cancels a queued move, restores the position, and releases pointer capture", () => {
    const open = vi.fn();
    const { result } = renderHook(() => useSecretaryPet(open));
    const button = captureButton(new DOMRect(0, 0, 180, 220));
    const floating = document.createElement("div");
    act(() => result.current.setFloatingRef(floating));
    const pointer = (x: number, y: number) => ({ button: 0, pointerId: 9, clientX: x, clientY: y, currentTarget: button }) as PointerEvent<HTMLButtonElement>;

    act(() => result.current.handlers("dock").onPointerDown(pointer(50, 50)));
    act(() => result.current.handlers("dock").onPointerMove(pointer(400, 300)));
    act(flushAnimationFrame);
    expect(result.current.state.dragging).toBe(true);
    act(() => result.current.handlers("dock").onPointerMove(pointer(500, 350)));
    expect(animationFrames).toHaveLength(1);

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
    expect(animationFrames).toHaveLength(0);
    expect(result.current.state).toEqual({ mode: "docked", dragging: false, overDock: false, x: 0, y: 0 });
    expect(floating.style.transform).toBe("translate3d(0px, 0px, 0)");
    expect(button.releasePointerCapture).toHaveBeenCalledOnce();
    act(() => result.current.handlers("dock").onPointerUp(pointer(500, 350)));
    expect(open).not.toHaveBeenCalled();
  });

  it("coalesces dock geometry reports, skips unchanged rectangles, and sends only the latest in-flight update", async () => {
    nativePet.available = true;
    let finishFirst!: () => void;
    nativePet.command
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }))
      .mockResolvedValue(undefined);
    const { result } = renderHook(() => useSecretaryPet(vi.fn()));
    const rail = document.createElement("aside");
    rail.className = "dim-rail";
    const dock = document.createElement("div");
    rail.append(dock);
    let rect = new DOMRect(20, 30, 180, 220);
    dock.getBoundingClientRect = () => rect;
    act(() => result.current.setDockRef(dock));

    expect(animationFrames).toHaveLength(1);
    act(flushAnimationFrame);
    expect(nativePet.command).toHaveBeenCalledTimes(1);
    expect(nativePet.command).toHaveBeenLastCalledWith("pet_set_dock_rect", {
      rect: { x: 20, y: 30, width: 180, height: 220 },
    });

    act(() => {
      window.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("resize"));
    });
    expect(animationFrames).toHaveLength(1);
    act(flushAnimationFrame);
    expect(nativePet.command).toHaveBeenCalledTimes(1);

    const unrelatedScroller = document.body.appendChild(document.createElement("div"));
    act(() => unrelatedScroller.dispatchEvent(new Event("scroll")));
    expect(animationFrames).toHaveLength(0);
    unrelatedScroller.remove();

    rect = new DOMRect(25, 30, 180, 220);
    act(() => window.dispatchEvent(new Event("scroll")));
    expect(animationFrames).toHaveLength(1);
    act(flushAnimationFrame);
    rect = new DOMRect(40, 35, 180, 220);
    act(() => window.dispatchEvent(new Event("scroll")));
    expect(animationFrames).toHaveLength(1);
    act(flushAnimationFrame);
    expect(nativePet.command).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishFirst();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(nativePet.command).toHaveBeenCalledTimes(2);
    expect(nativePet.command).toHaveBeenLastCalledWith("pet_set_dock_rect", {
      rect: { x: 40, y: 35, width: 180, height: 220 },
    });
  });
});

it("does not redisplay dismissed scheduler deliveries after remount, and preserves the next pending reminder", () => {
  const first = { id: "receipt-1", text: "到回看时间了", kind: "reminder" as const, createdAt: 1 };
  const initial = renderHook(usePetInbox);
  act(() => { initial.result.current.enqueue(first); initial.result.current.enqueue(first); initial.result.current.enqueue({ ...first, id: "receipt-2" }); });
  act(() => initial.result.current.dismiss(first.id));
  initial.unmount();
  const restored = renderHook(usePetInbox);
  act(() => restored.result.current.enqueue(first));
  expect(restored.result.current.notice?.id).toBe("receipt-2");
});

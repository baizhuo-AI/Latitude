import { act, createEvent, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DimensionDeck } from "./DimensionDeck";
import type { DimensionPresetId } from "./presetQuery";

function DeckHarness({ initial = "paper" }: { initial?: DimensionPresetId }) {
  const [active, setActive] = useState<DimensionPresetId>(initial);
  return (
    <DimensionDeck
      active={active}
      onChange={setActive}
      desk={<div>paper content</div>}
      clueBoard={<div>clue content</div>}
      constellation={<div>constellation content</div>}
    />
  );
}

function deckOf(container: HTMLElement): HTMLElement {
  const deck = container.querySelector<HTMLElement>(".dim-deck");
  if (!deck) throw new Error("missing dimension deck");
  return deck;
}

function layerOf(container: HTMLElement, id: DimensionPresetId): HTMLElement {
  const layer = container.querySelector<HTMLElement>(`[data-deck-layer="${id}"]`);
  if (!layer) throw new Error(`missing ${id} layer`);
  return layer;
}

function pinch(deck: HTMLElement, deltaY: number): WheelEvent {
  const event = createEvent.wheel(deck, {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    deltaY
  }) as WheelEvent;
  fireEvent(deck, event);
  return event;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DimensionDeck interaction grammar", () => {
  it("独占滚动区在顶部和底部都不会把 wheel 链成甲板换层", () => {
    const onChange = vi.fn();
    const { container, getByTestId } = render(
      <DimensionDeck
        active="paper"
        onChange={onChange}
        desk={(
          <div data-deck-scroll="contain" data-testid="thread-scroll">
            <span data-testid="thread-content">thread content</span>
          </div>
        )}
        clueBoard={<div>clue content</div>}
        constellation={<div>constellation content</div>}
      />
    );
    const deck = deckOf(container);
    const content = getByTestId("thread-content");

    fireEvent.wheel(content, { deltaY: -120 });
    fireEvent.wheel(content, { deltaY: 120 });

    expect(deck).toHaveAttribute("data-active", "paper");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("SELECT、BUTTON 与独占滚动区拥有 PageUp/PageDown，不切换底层甲板", () => {
    const onChange = vi.fn();
    const { getByRole, getByTestId } = render(
      <DimensionDeck
        active="clue-board"
        onChange={onChange}
        desk={<div>paper content</div>}
        clueBoard={(
          <div>
            <select aria-label="线索筛选"><option>全部</option></select>
            <button type="button">查看线索</button>
            <div data-deck-scroll="contain">
              <span tabIndex={0} data-testid="contained-focus">对话内滚动</span>
            </div>
          </div>
        )}
        constellation={<div>constellation content</div>}
      />
    );

    fireEvent.keyDown(getByRole("combobox", { name: "线索筛选" }), { key: "PageUp" });
    fireEvent.keyDown(getByRole("button", { name: "查看线索" }), { key: "PageDown" });
    fireEvent.keyDown(getByTestId("contained-focus"), { key: "PageUp" });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("任一打开的 aria-modal dialog 都接管 PageUp/PageDown", () => {
    const onChange = vi.fn();
    render(
      <DimensionDeck
        active="clue-board"
        onChange={onChange}
        desk={<div>paper content</div>}
        clueBoard={<div>clue content</div>}
        constellation={<div>constellation content</div>}
      />
    );
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    try {
      fireEvent.keyDown(window, { key: "PageUp" });
      fireEvent.keyDown(window, { key: "PageDown" });
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      dialog.remove();
    }

    fireEvent.keyDown(window, { key: "PageUp" });
    expect(onChange).toHaveBeenCalledWith("constellation");
  });

  it("受控 active 从外部改变时也补齐 corner / depth 转场", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const nodes = {
      desk: <div>paper content</div>,
      clueBoard: <div>clue content</div>,
      constellation: <div>constellation content</div>
    };
    const { container, rerender } = render(
      <DimensionDeck active="clue-board" onChange={onChange} {...nodes} />
    );

    rerender(<DimensionDeck active="paper" onChange={onChange} {...nodes} />);
    const deck = deckOf(container);
    expect(deck).toHaveAttribute("data-transition", "corner");
    expect(deck).toHaveAttribute("data-direction", "down");
    expect(layerOf(container, "clue-board")).toHaveAttribute("data-motion", "leaving");
    expect(layerOf(container, "paper")).toHaveAttribute("data-motion", "entering");

    act(() => vi.advanceTimersByTime(950));
    rerender(<DimensionDeck active="constellation" onChange={onChange} {...nodes} />);
    expect(deck).toHaveAttribute("data-transition", "depth");
    expect(deck).toHaveAttribute("data-star-gather", "gathering");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("paper 与 clue-board 之间标记为无景深的 inner-corner 透视转场", () => {
    vi.useFakeTimers();
    const { container } = render(<DeckHarness />);
    const deck = deckOf(container);

    fireEvent.wheel(deck, { deltaY: -120 });

    expect(deck).toHaveAttribute("data-active", "clue-board");
    expect(deck).toHaveAttribute("data-moving", "true");
    expect(deck).toHaveAttribute("data-transition", "corner");
    expect(deck).toHaveAttribute("data-direction", "up");
    expect(deck).toHaveAttribute("data-perspective", "inner-corner");
    expect(deck).not.toHaveAttribute("data-star-gather");
    expect(layerOf(container, "paper")).toHaveAttribute("data-motion", "leaving");
    expect(layerOf(container, "clue-board")).toHaveAttribute("data-motion", "entering");
    expect(layerOf(container, "constellation")).not.toHaveAttribute("data-motion");

    act(() => vi.advanceTimersByTime(901));
    expect(deck).not.toHaveAttribute("data-moving");
    expect(deck).not.toHaveAttribute("data-transition");
    expect(deck).not.toHaveAttribute("data-perspective");
  });

  it("任一端为 constellation 时才标记 depth zoom + blur 转场", () => {
    vi.useFakeTimers();
    const { container } = render(<DeckHarness initial="clue-board" />);
    const deck = deckOf(container);

    fireEvent.wheel(deck, { deltaY: -120 });

    expect(deck).toHaveAttribute("data-active", "constellation");
    expect(deck).toHaveAttribute("data-transition", "depth");
    expect(deck).toHaveAttribute("data-direction", "up");
    expect(deck).toHaveAttribute("data-star-gather", "gathering");
    expect(deck).not.toHaveAttribute("data-perspective");
    expect(layerOf(container, "clue-board")).toHaveAttribute("data-motion", "leaving");
    expect(layerOf(container, "constellation")).toHaveAttribute("data-motion", "entering");
    expect(layerOf(container, "constellation")).toHaveAttribute(
      "data-star-gather",
      "gathering"
    );
    expect(layerOf(container, "paper")).not.toHaveAttribute("data-motion");

    act(() => vi.advanceTimersByTime(950));
    fireEvent.keyDown(window, { key: "PageDown" });
    expect(deck).toHaveAttribute("data-active", "clue-board");
    expect(deck).toHaveAttribute("data-transition", "depth");
    expect(deck).toHaveAttribute("data-direction", "down");
    expect(deck).toHaveAttribute("data-star-gather", "dispersing");
    expect(layerOf(container, "constellation")).toHaveAttribute(
      "data-star-gather",
      "dispersing"
    );
  });

  it("ctrl+wheel 累计成 pinch：缩小升层、放大降层，并取消页面缩放", () => {
    vi.useFakeTimers();
    const { container } = render(<DeckHarness />);
    const deck = deckOf(container);

    const first = pinch(deck, 20);
    pinch(deck, 20);
    expect(first.defaultPrevented).toBe(true);
    expect(deck).toHaveAttribute("data-active", "paper");

    pinch(deck, 12);
    expect(deck).toHaveAttribute("data-active", "clue-board");
    expect(deck).toHaveAttribute("data-transition", "corner");

    // 同一串手势即使继续冒事件也只跨一层。
    pinch(deck, 120);
    expect(deck).toHaveAttribute("data-active", "clue-board");

    act(() => vi.advanceTimersByTime(950));
    pinch(deck, 60);
    expect(deck).toHaveAttribute("data-active", "constellation");
    expect(deck).toHaveAttribute("data-transition", "depth");

    act(() => vi.advanceTimersByTime(950));
    pinch(deck, -60);
    expect(deck).toHaveAttribute("data-active", "clue-board");
    expect(deck).toHaveAttribute("data-direction", "down");
  });

  it("单指下拉与键盘仍按原空间方向换层", () => {
    vi.useFakeTimers();
    const { container } = render(<DeckHarness />);
    const deck = deckOf(container);

    fireEvent.touchStart(deck, { touches: [{ clientY: 100 }] });
    fireEvent.touchEnd(deck, { changedTouches: [{ clientY: 180 }] });
    expect(deck).toHaveAttribute("data-active", "clue-board");

    act(() => vi.advanceTimersByTime(901));
    fireEvent.keyDown(window, { key: "PageUp" });
    expect(deck).toHaveAttribute("data-active", "constellation");
    act(() => vi.advanceTimersByTime(901));
    fireEvent.keyDown(window, { key: "PageDown" });
    expect(deck).toHaveAttribute("data-active", "clue-board");
  });

  it("可见转场中锁住 keyboard 与 rail，落定后才接受下一层", () => {
    vi.useFakeTimers();
    const { container, getByRole } = render(<DeckHarness />);
    const deck = deckOf(container);

    fireEvent.wheel(deck, { deltaY: -120 });
    expect(deck).toHaveAttribute("data-active", "clue-board");

    fireEvent.keyDown(window, { key: "PageUp" });
    fireEvent.click(getByRole("button", { name: "星图桌面" }));
    expect(deck).toHaveAttribute("data-active", "clue-board");
    expect(deck).toHaveAttribute("data-transition", "corner");

    act(() => vi.advanceTimersByTime(901));
    fireEvent.keyDown(window, { key: "PageUp" });
    expect(deck).toHaveAttribute("data-active", "constellation");
    expect(deck).toHaveAttribute("data-transition", "depth");
  });

  it("快速反向输入不会重启动画，落定后才允许回落", () => {
    vi.useFakeTimers();
    const { container, getByRole } = render(<DeckHarness initial="clue-board" />);
    const deck = deckOf(container);

    fireEvent.keyDown(window, { key: "PageUp" });
    expect(deck).toHaveAttribute("data-active", "constellation");

    fireEvent.keyDown(window, { key: "PageDown" });
    fireEvent.click(getByRole("button", { name: "纸面桌面" }));
    expect(deck).toHaveAttribute("data-active", "constellation");
    expect(deck).toHaveAttribute("data-star-gather", "gathering");

    act(() => vi.advanceTimersByTime(901));
    fireEvent.keyDown(window, { key: "PageDown" });
    expect(deck).toHaveAttribute("data-active", "clue-board");
    expect(deck).toHaveAttribute("data-star-gather", "dispersing");
  });
});

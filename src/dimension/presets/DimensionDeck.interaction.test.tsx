import { act, createEvent, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DimensionDeck } from "./DimensionDeck";
import type { DimensionPresetId } from "./presetQuery";

function DeckHarness({ initial = "paper", onGoHome, onSetHome }: { initial?: DimensionPresetId; onGoHome?: () => void; onSetHome?: () => void }) {
  const [active, setActive] = useState<DimensionPresetId>(initial);
  return <DimensionDeck active={active} onChange={setActive} onGoHome={onGoHome} onSetHome={onSetHome}
    desk={<div><button>桌面操作</button><input aria-label="便签" /></div>}
    clueBoard={<div><button>线索操作</button><select aria-label="线索筛选"><option>全部</option></select>
      <div data-deck-scroll="contain"><span tabIndex={0}>独占内容</span></div></div>}
    constellation={<div>星图内容</div>} />;
}
function deckOf(container: HTMLElement): HTMLElement { return container.querySelector<HTMLElement>(".dim-deck")!; }
function layerOf(container: HTMLElement, id: DimensionPresetId): HTMLElement { return container.querySelector<HTMLElement>(`[data-deck-layer="${id}"]`)!; }
function sceneOf(container: HTMLElement, id: DimensionPresetId): HTMLElement { return layerOf(container, id).querySelector<HTMLElement>(".dim-deck-layer-inner")!; }

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("DimensionDeck explicit navigation", () => {
  it("滚轮、触摸和捏合留在当前视图，不拦截画布手势", () => {
    const { container } = render(<DeckHarness />);
    const deck = deckOf(container);
    for (const deltaY of [-2400, -120, -120, -120, 2400]) {
      fireEvent.wheel(deck, { deltaY });
      const event = createEvent.wheel(deck, { bubbles: true, cancelable: true, ctrlKey: true, deltaY });
      fireEvent(deck, event);
      expect(event.defaultPrevented).toBe(false);
    }
    fireEvent.touchStart(deck, { touches: [{ clientX: 80, clientY: 100 }] });
    fireEvent.touchEnd(deck, { changedTouches: [{ clientX: 80, clientY: 650 }] });
    expect(deck).toHaveAttribute("data-active", "paper");
  });

  it("控件与独占内容接管 PageUp/PageDown，空白处键盘仍可切换", () => {
    const { container, getByRole, getByText } = render(<DeckHarness initial="clue-board" />);
    fireEvent.keyDown(getByRole("combobox", { name: "线索筛选" }), { key: "PageUp" });
    fireEvent.keyDown(getByRole("button", { name: "线索操作" }), { key: "PageDown" });
    fireEvent.keyDown(getByText("独占内容"), { key: "PageUp" });
    expect(deckOf(container)).toHaveAttribute("data-active", "clue-board");
    fireEvent.keyDown(window, { key: "PageUp" });
    expect(deckOf(container)).toHaveAttribute("data-active", "constellation");
  });

  it("打开的模态框与组合键不触发视图快捷键", () => {
    const { container } = render(<DeckHarness initial="clue-board" />);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    try { fireEvent.keyDown(window, { key: "PageUp" }); }
    finally { dialog.remove(); }
    fireEvent.keyDown(window, { key: "PageUp", metaKey: true });
    expect(deckOf(container)).toHaveAttribute("data-active", "clue-board");
  });

  it("回常用区先定位同一桌面，再从其他视图返回", () => {
    const onGoHome = vi.fn();
    const { container, getByRole } = render(<DeckHarness initial="clue-board" onGoHome={onGoHome} />);
    fireEvent.click(getByRole("button", { name: "回常用区" }));
    expect(onGoHome).toHaveBeenCalledOnce();
    expect(deckOf(container)).toHaveAttribute("data-active", "paper");
    fireEvent.click(getByRole("button", { name: "回常用区" }));
    expect(onGoHome).toHaveBeenCalledTimes(2);
  });

  it("记录与返回相邻，记录只在主页可用且不触发返回", () => {
    const onGoHome = vi.fn();
    const onSetHome = vi.fn();
    const { container, getByRole, queryByRole } = render(<DeckHarness onGoHome={onGoHome} onSetHome={onSetHome} />);
    const record = getByRole("button", { name: "记录常用区" });
    expect(record.parentElement).toBe(getByRole("button", { name: "回常用区" }).parentElement);
    fireEvent.click(record);
    expect(onSetHome).toHaveBeenCalledOnce();
    expect(onGoHome).not.toHaveBeenCalled();
    expect(deckOf(container)).toHaveAttribute("data-active", "paper");
    fireEvent.click(getByRole("button", { name: "线索板桌面" }));
    expect(queryByRole("button", { name: "记录常用区" })).not.toBeInTheDocument();
    expect(getByRole("button", { name: "回常用区" })).toBeEnabled();
  });

  it("离场视图保留挂载状态并退出交互和读屏，焦点回到固定导航", () => {
    const { container, getByRole } = render(<DeckHarness />);
    const input = getByRole("textbox", { name: "便签" });
    fireEvent.change(input, { target: { value: "保留这张便签" } });
    input.focus();
    fireEvent.click(getByRole("button", { name: "线索板桌面" }));
    expect(layerOf(container, "paper")).toHaveAttribute("inert");
    expect(layerOf(container, "paper")).toHaveAttribute("aria-hidden", "true");
    expect(getByRole("button", { name: "线索板桌面" })).toHaveFocus();
    fireEvent.click(getByRole("button", { name: "纸面桌面" }));
    expect(getByRole("textbox", { name: "便签" })).toHaveValue("保留这张便签");
    expect(layerOf(container, "paper")).not.toHaveAttribute("inert");
  });
});

describe("DimensionDeck interruptible choreography", () => {
  it("外部线索入口也执行穿行，820ms后位置、清晰度、透明度归位", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance", "requestAnimationFrame", "cancelAnimationFrame"] });
    const onChange = vi.fn();
    const nodes = { desk: <div>paper</div>, clueBoard: <div>clue</div>, constellation: <div>stars</div> };
    const { container, rerender } = render(<DimensionDeck active="clue-board" onChange={onChange} {...nodes} />);
    rerender(<DimensionDeck active="paper" onChange={onChange} {...nodes} />);
    const deck = deckOf(container);
    expect(deck).toHaveAttribute("data-transition", "passage");
    expect(deck).toHaveAttribute("data-direction", "down");
    expect(deck).not.toHaveAttribute("data-perspective");
    expect(sceneOf(container, "paper").style.opacity).toBe("0");
    act(() => vi.advanceTimersByTime(220));
    expect(deck).toHaveAttribute("data-travel-phase", "passage");
    expect(sceneOf(container, "paper").style.opacity).toBe("0");
    act(() => vi.advanceTimersByTime(160));
    expect(deck).toHaveAttribute("data-travel-phase", "arrival");
    expect(Number(sceneOf(container, "paper").style.opacity)).toBeGreaterThan(0);
    act(() => vi.advanceTimersByTime(480));
    expect(deck).not.toHaveAttribute("data-moving");
    expect(sceneOf(container, "paper").style.filter).toBe("none");
    expect(sceneOf(container, "paper").style.opacity).toBe("1");
    expect(sceneOf(container, "paper").style.transform).toBe("translate3d(0, 0px, 0) scale(1)");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("途中改向沿用当前透明度与模糊值，最后一次目标停稳且旧回调不抢回", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance", "requestAnimationFrame", "cancelAnimationFrame"] });
    const { container, getByRole } = render(<DeckHarness initial="clue-board" />);
    fireEvent.click(getByRole("button", { name: "纸面桌面" }));
    act(() => vi.advanceTimersByTime(400));
    const scene = sceneOf(container, "paper");
    const pose = { opacity: scene.style.opacity, filter: scene.style.filter, transform: scene.style.transform };
    fireEvent.click(getByRole("button", { name: "线索板桌面" }));
    expect(scene.style.opacity).toBe(pose.opacity);
    expect(scene.style.filter).toBe(pose.filter);
    expect(scene.style.transform).toBe(pose.transform);
    fireEvent.click(getByRole("button", { name: "纸面桌面" }));
    act(() => vi.advanceTimersByTime(1000));
    expect(deckOf(container)).toHaveAttribute("data-active", "paper");
    expect(deckOf(container)).not.toHaveAttribute("data-moving");
    expect(scene.style.opacity).toBe("1");
    expect(layerOf(container, "clue-board").style.visibility).toBe("hidden");
  });

  it("直达星图只让起终层参与，900ms视图过渡结束后继续2.8s星体编排", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance", "requestAnimationFrame", "cancelAnimationFrame"] });
    const { container, getByRole } = render(<DeckHarness />);
    fireEvent.click(getByRole("button", { name: "星图桌面" }));
    const deck = deckOf(container);
    expect(deck).toHaveAttribute("data-transition", "depth");
    expect(layerOf(container, "clue-board")).not.toHaveAttribute("data-motion");
    expect(layerOf(container, "clue-board").style.visibility).toBe("hidden");
    act(() => vi.advanceTimersByTime(920));
    expect(deck).not.toHaveAttribute("data-moving");
    expect(deck).toHaveAttribute("data-star-gather", "gathering");
    act(() => vi.advanceTimersByTime(1880));
    expect(deck).not.toHaveAttribute("data-star-gather");
    fireEvent.click(getByRole("button", { name: "纸面桌面" }));
    expect(deck).toHaveAttribute("data-star-gather", "dispersing");
    expect(layerOf(container, "constellation").style.visibility).toBe("visible");
    act(() => vi.advanceTimersByTime(920));
    expect(layerOf(container, "constellation").style.visibility).toBe("hidden");
    expect(deck).not.toHaveAttribute("data-star-gather");
  });

  it("星图编排中仍可连续选择，旧星体计时器不会影响新视图", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance", "requestAnimationFrame", "cancelAnimationFrame"] });
    const { container, getByRole } = render(<DeckHarness />);
    fireEvent.click(getByRole("button", { name: "星图桌面" }));
    act(() => vi.advanceTimersByTime(300));
    fireEvent.click(getByRole("button", { name: "线索板桌面" }));
    fireEvent.click(getByRole("button", { name: "纸面桌面" }));
    expect(deckOf(container)).toHaveAttribute("data-transition", "passage");
    expect(deckOf(container)).not.toHaveAttribute("data-star-gather");
    act(() => vi.advanceTimersByTime(3000));
    expect(deckOf(container)).toHaveAttribute("data-active", "paper");
    expect(deckOf(container)).not.toHaveAttribute("data-moving");
  });

  it("减少动态效果直接切换并保持相同导航与隐藏层语义", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const { container, getByRole } = render(<DeckHarness />);
    fireEvent.click(getByRole("button", { name: "线索板桌面" }));
    expect(deckOf(container)).not.toHaveAttribute("data-moving");
    expect(sceneOf(container, "clue-board").style.opacity).toBe("1");
    fireEvent.click(getByRole("button", { name: "星图桌面" }));
    expect(deckOf(container)).not.toHaveAttribute("data-star-gather");
    expect(layerOf(container, "paper")).toHaveAttribute("inert");
    expect(sceneOf(container, "constellation").style.filter).toBe("none");
  });
});

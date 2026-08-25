import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, TouchEvent as ReactTouchEvent } from "react";
import type { DimensionPresetId } from "./presetQuery";
import "./deck.css";

const useDeckLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * 垂直甲板：桌面 / 线索板 / 星图是同一份今日内容的三个层次，
 * 空间上**桌面在最下面，线索板在头顶，星图在最高处**——
 * 抬头（上滚 / 下拉 / PageUp）从执行走向结构、再走向全貌；
 * 低头回到桌上的事。
 *
 * 交互契约：
 * - 滚轮向上（deltaY < 0）= 抬头，进入更高一层；向下 = 回到低层；
 *   当前层内部还能滚动的方向不拦截（桌面的卡片列表优先自己滚）；
 * - 触摸下拉 = 抬头，上推 = 回落；
 * - PageUp / PageDown 键盘升降（输入框聚焦时不抢按键）；
 * - 右缘的层标是唯一常驻导航，按空间顺序上星图、中线索、下桌面。
 *
 * 换层不是硬切：纸面与线索板是同一空间的水平桌面和前方立面，抬头 /
 * 低头时沿共享内直角转移视线，但不模糊文字；只有进出星图才拉开景深，
 * 让群星从视线外快速聚拢并短暂强失焦。
 * 触控板 pinch 映射为距离变化：缩小升一层，放大降一层；一次手势只跨
 * 一层，避免惯性直接穿层。
 */

const LAYERS: readonly {
  id: DimensionPresetId;
  label: string;
  ariaLabel: string;
  /** 抬头方向看到的这一层 */
  up: string;
}[] = [
  { id: "constellation", label: "星图", ariaLabel: "星图桌面", up: "" },
  { id: "clue-board", label: "线索板", ariaLabel: "线索板桌面", up: "星图" },
  { id: "paper", label: "桌面", ariaLabel: "纸面桌面", up: "线索板" }
];

/** 两次翻层之间的冷却；动画没完就不再响应，避免连滚穿层。 */
const COOLDOWN_MS = 900;
/** 与轨道 transition 时长对齐，移动中的空间语法在这段时间后解除。 */
const MOVE_MS = 900;
/**
 * 星图汇聚的完整编排（北极星先亮 → 群星从容汇聚 → 星云淡入）远长于
 * 换层锁；换层语法 900ms 解除后，星体的飞行继续在自己的时间轴上走完。
 */
const STAR_GATHER_MS = 2800;
/** 滚轮 / 触摸的触发阈值，过滤触控板抖动。 */
const WHEEL_THRESHOLD = 28;
const TOUCH_THRESHOLD = 56;
/** ctrl+wheel 是 Chromium / WebKit 对触控板 pinch 的通用映射。 */
const PINCH_THRESHOLD = 48;
/** 这段静默后才把下一串 ctrl+wheel 视为新的一次 pinch。 */
const PINCH_IDLE_MS = 180;

type DeckTransition = {
  from: number;
  to: number;
  /** 纸面 <-> 线索板共享一个内直角；任一端为星图时才使用景深。 */
  kind: "corner" | "depth";
  direction: "up" | "down";
};

export interface DimensionDeckProps {
  active: DimensionPresetId;
  onChange: (next: DimensionPresetId) => void;
  desk: ReactNode;
  clueBoard: ReactNode;
  constellation: ReactNode;
  /** Host-owned Browser module controls; legacy/Tauri callers keep defaults. */
  navigationVisible?: boolean;
  actionAvailability?: {
    paper: boolean;
    clue: boolean;
    constellation: boolean;
  };
}

function layerIndex(id: DimensionPresetId): number {
  const index = LAYERS.findIndex((layer) => layer.id === id);
  return index >= 0 ? index : LAYERS.length - 1;
}

/**
 * 目标元素是否位于内部滚动容器：普通容器只在该方向还能滚时接管；
 * `data-deck-scroll="contain"` 是模态纸张等独占区域，即使到达滚动边界也
 * 不能把惯性链到甲板换层。
 */
function scrollableAncestor(target: EventTarget | null, deltaY: number): boolean {
  if (!(target instanceof Element)) return false;
  const el = target.closest("[data-deck-scroll]");
  if (!(el instanceof HTMLElement)) return false;
  if (el.dataset.deckScroll === "contain") return true;
  if (el.scrollHeight <= el.clientHeight + 2) return false;
  if (deltaY > 0) return el.scrollTop + el.clientHeight < el.scrollHeight - 2;
  return el.scrollTop > 2;
}

function containedScrollAncestor(target: EventTarget | null): boolean {
  return target instanceof Element &&
    target.closest<HTMLElement>('[data-deck-scroll="contain"]') !== null;
}

const KEYBOARD_OWNING_SELECTOR = [
  "input",
  "textarea",
  "select",
  "button",
  "a[href]",
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="menuitem"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="switch"]',
  '[role="tab"]'
].join(",");

/** PageUp/PageDown belong to the focused control or contained scroll world. */
function ownsPageKey(target: EventTarget | null): boolean {
  return target instanceof Element && (
    containedScrollAncestor(target) ||
    target.closest(KEYBOARD_OWNING_SELECTOR) !== null
  );
}

/** A modal owns the keyboard even when focus restoration is momentarily late. */
function hasOpenModalDialog(): boolean {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')]
    .some((dialog) => !dialog.hidden && dialog.getAttribute("aria-hidden") !== "true");
}

export function DimensionDeck({
  active,
  onChange,
  desk,
  clueBoard,
  constellation,
  navigationVisible = true,
  actionAvailability = { paper: true, clue: true, constellation: true },
}: DimensionDeckProps) {
  const index = layerIndex(active);
  const navigationReady = navigationVisible &&
    actionAvailability.paper &&
    actionAvailability.clue &&
    actionAvailability.constellation;
  const cooldownUntil = useRef(0);
  /** 所有用户入口共享同步锁，避免动画中途替换关键帧造成跳变。 */
  const transitionLocked = useRef(false);
  const touchStartY = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** 保留起点与终点，CSS 才能只给真正经过星图的两层加景深。 */
  const [transition, setTransition] = useState<DeckTransition | null>(null);
  /** 星图进场编排的相位：比 transition 活得久，群星落稳、星云出来后才会清空。 */
  const [starPhase, setStarPhase] = useState<"gathering" | "dispersing" | null>(null);
  const moveTimer = useRef<number | undefined>(undefined);
  const starTimer = useRef<number | undefined>(undefined);
  const previousIndex = useRef(index);
  const internalTarget = useRef<number | null>(null);
  const pinchAccumulator = useRef(0);
  const pinchCommitted = useRef(false);
  const pinchResetTimer = useRef<number | undefined>(undefined);

  const beginTransition = useCallback((from: number, to: number) => {
      transitionLocked.current = true;
      const fromId = LAYERS[from].id;
      const toId = LAYERS[to].id;
      const kind: DeckTransition["kind"] =
        fromId === "constellation" || toId === "constellation"
          ? "depth"
          : "corner";
      setTransition({
        from,
        to,
        kind,
        direction: to < from ? "up" : "down"
      });
      window.clearTimeout(moveTimer.current);
      moveTimer.current = window.setTimeout(() => {
        transitionLocked.current = false;
        setTransition(null);
      }, MOVE_MS);
      window.clearTimeout(starTimer.current);
      if (kind === "depth") {
        const phase = toId === "constellation" ? "gathering" : "dispersing";
        setStarPhase(phase);
        // 汇聚的完整编排约 2.8s；退散跟随换层窗口即可
        starTimer.current = window.setTimeout(
          () => setStarPhase(null),
          phase === "gathering" ? STAR_GATHER_MS : MOVE_MS
        );
      } else {
        setStarPhase(null);
      }
  }, []);

  const go = useCallback(
    (nextIndex: number) => {
      if (!navigationReady) return;
      const clamped = Math.max(0, Math.min(LAYERS.length - 1, nextIndex));
      if (clamped === index || transitionLocked.current) return;
      internalTarget.current = clamped;
      beginTransition(index, clamped);
      onChange(LAYERS[clamped].id);
    },
    [beginTransition, index, navigationReady, onChange]
  );

  // A hidden or partially unbound navigation module must never strand the
  // user on a layer without the fixed composition recovery entry.
  useEffect(() => {
    if (!navigationReady && active !== "paper") onChange("paper");
  }, [active, navigationReady, onChange]);

  /*
   * active 是受控值：线索纸、URL 回退等外部入口也可能直接切层。
   * 这些入口同样必须经过甲板的空间语法，不能只有 rail/wheel 才有转场。
   */
  useDeckLayoutEffect(() => {
    const from = previousIndex.current;
    if (from === index) return;
    const wasStartedInsideDeck = internalTarget.current === index;
    internalTarget.current = null;
    previousIndex.current = index;
    if (!wasStartedInsideDeck) {
      // controlled value 是外部真值：它可以覆盖旧动画，但会为自己的新动画
      // 重新上锁，直到同一个 900ms 可见周期结束。
      transitionLocked.current = false;
      beginTransition(from, index);
    }
  }, [beginTransition, index]);

  const resetPinchSession = useCallback(() => {
    pinchAccumulator.current = 0;
    pinchCommitted.current = false;
    window.clearTimeout(pinchResetTimer.current);
    pinchResetTimer.current = undefined;
  }, []);

  const schedulePinchReset = useCallback(() => {
    window.clearTimeout(pinchResetTimer.current);
    pinchResetTimer.current = window.setTimeout(resetPinchSession, PINCH_IDLE_MS);
  }, [resetPinchSession]);

  useEffect(
    () => () => {
      window.clearTimeout(moveTimer.current);
      window.clearTimeout(starTimer.current);
      window.clearTimeout(pinchResetTimer.current);
    },
    []
  );

  /**
   * direction -1 = 抬头（向星图方向），+1 = 回落（向桌面方向）。
   * 冷却只防滚轮 / 触摸的惯性连击，键盘翻层不吃冷却。
   */
  const step = useCallback(
    (direction: 1 | -1, applyCooldown = true) => {
      const now = Date.now();
      if (applyCooldown && now < cooldownUntil.current) return;
      const next = index + direction;
      if (next < 0 || next >= LAYERS.length) return;
      if (applyCooldown) cooldownUntil.current = now + COOLDOWN_MS;
      go(next);
    },
    [go, index]
  );

  const onWheel = useCallback(
    (event: WheelEvent) => {
      if (!navigationReady) return;
      // An open conversation is a local scroll world. It wins before the
      // ctrl+wheel/pinch grammar as well as at ordinary scroll boundaries.
      if (containedScrollAncestor(event.target)) return;
      if (event.ctrlKey) {
        // 触控板 pinch 会被浏览器合成为 ctrl+wheel。必须用 non-passive
        // 原生监听器取消页面缩放，才能把它稳定解释成桌面距离变化。
        event.preventDefault();
        schedulePinchReset();
        if (pinchCommitted.current || Math.abs(event.deltaY) < 0.01) return;

        const previous = pinchAccumulator.current;
        // 手势中途反向时从零重新累计，避免两股相反的小量互相抵消后误触发。
        if (previous !== 0 && Math.sign(previous) !== Math.sign(event.deltaY)) {
          pinchAccumulator.current = 0;
        }
        pinchAccumulator.current += event.deltaY;
        if (Math.abs(pinchAccumulator.current) < PINCH_THRESHOLD) return;

        const zoomingOut = pinchAccumulator.current > 0;
        pinchCommitted.current = true;
        pinchAccumulator.current = 0;
        // 缩小 = 拉远一层（纸面 -> 线索板 -> 星图）；放大反向靠近。
        step(zoomingOut ? -1 : 1);
        return;
      }

      if (Math.abs(event.deltaY) < WHEEL_THRESHOLD) return;
      if (scrollableAncestor(event.target, event.deltaY)) return;
      // 普通滚轮向上 = 抬头看更高的一层
      step(event.deltaY < 0 ? -1 : 1);
    },
    [navigationReady, schedulePinchReset, step]
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  const onTouchStart = useCallback((event: ReactTouchEvent) => {
    touchStartY.current = event.touches[0]?.clientY ?? null;
  }, []);

  const onTouchEnd = useCallback(
    (event: ReactTouchEvent) => {
      if (!navigationReady) return;
      const start = touchStartY.current;
      touchStartY.current = null;
      if (start === null) return;
      const end = event.changedTouches[0]?.clientY;
      if (end === undefined) return;
      // 手指下拉（end > start）= 把上面的层拉下来看 = 抬头
      const delta = start - end;
      if (Math.abs(delta) < TOUCH_THRESHOLD) return;
      if (scrollableAncestor(event.target, delta)) return;
      step(delta < 0 ? -1 : 1);
    },
    [navigationReady, step]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!navigationReady) return;
      if (hasOpenModalDialog() || ownsPageKey(event.target)) return;
      if (event.key === "PageUp") {
        event.preventDefault();
        step(-1, false);
      } else if (event.key === "PageDown") {
        event.preventDefault();
        step(1, false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigationReady, step]);

  // 非激活层不进入读屏树与 Tab 序；三层常驻挂载只加 inert。
  useEffect(() => {
    const layers = rootRef.current?.querySelectorAll<HTMLElement>("[data-deck-layer]");
    layers?.forEach((layer, i) => layer.toggleAttribute("inert", i !== index));
  }, [index]);

  // 空间顺序：星图在最上，桌面在最下。contents 与 LAYERS 同序。
  const contents: ReactNode[] = [constellation, clueBoard, desk];
  const above = index > 0 ? LAYERS[index - 1] : null;
  const below = index < LAYERS.length - 1 ? LAYERS[index + 1] : null;

  return (
    <div
      ref={rootRef}
      className="dim-deck"
      data-active={active}
      data-moving={transition ? true : undefined}
      data-transition={transition?.kind}
      data-direction={transition?.direction}
      data-perspective={transition?.kind === "corner" ? "inner-corner" : undefined}
      data-star-gather={starPhase ?? undefined}
      data-navigation-visible={navigationVisible ? "true" : "false"}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div
        className="dim-deck-track"
        style={{ transform: `translateY(-${index * 100}%)` }}
      >
        {LAYERS.map((layer, i) => (
          <section
            key={layer.id}
            className="dim-deck-layer"
            data-deck-layer={layer.id}
            data-pos={i === index ? "active" : i < index ? "above" : "below"}
            data-motion={
              transition && i === transition.from
                ? "leaving"
                : transition && i === transition.to
                  ? "entering"
                  : undefined
            }
            data-star-gather={layer.id === "constellation" ? starPhase ?? undefined : undefined}
            aria-hidden={i !== index}
            aria-label={layer.ariaLabel}
          >
            <div className="dim-deck-layer-inner">{contents[i]}</div>
          </section>
        ))}
      </div>

      {/*
       * 桌面与线索板之间不是一张卡片的正反面，而是同一个工作空间的
       * 水平面与前立面。换层中段显出共享的内角，让“抬头”有明确方向。
       */}
      <div className="dim-deck-inner-corner" aria-hidden="true">
        <i className="dim-deck-inner-wall" />
        <i className="dim-deck-inner-hinge" />
        <i className="dim-deck-inner-desk" />
      </div>

      {/* 右缘层标：唯一常驻导航，按空间顺序（上星图 · 中线索 · 下桌面） */}
      {navigationVisible && <nav className="dim-deck-rail" aria-label="桌面层次">
        {LAYERS.map((layer, i) => (
          <button
            key={layer.id}
            type="button"
            className="dim-deck-rail-stop"
            aria-label={layer.ariaLabel}
            aria-pressed={i === index}
            data-on={i === index ? "true" : undefined}
            disabled={!navigationReady}
            aria-disabled={!navigationReady}
            title={navigationReady ? undefined : "三层导航动作已在组件设置中关闭"}
            onClick={() => go(i)}
          >
            <span className="dim-deck-rail-dot" aria-hidden="true" />
            <span className="dim-deck-rail-label">{layer.label}</span>
          </button>
        ))}
      </nav>}

      {/* 上缘：抬头能看到的下一层 */}
      {navigationReady && above && (
        <button
          type="button"
          className="dim-deck-edge dim-deck-edge-lookup"
          onClick={() => step(-1)}
          aria-label={`抬头看${above.label}`}
        >
          <span aria-hidden="true">⌃</span>
          抬头 · {above.label}
        </button>
      )}
      {/* 下缘：回到低处 */}
      {navigationReady && below && (
        <button
          type="button"
          className="dim-deck-edge dim-deck-edge-return"
          onClick={() => step(1)}
          aria-label={`回到${below.label}`}
        >
          <span aria-hidden="true">⌄</span>
          回到{below.label}
        </button>
      )}
    </div>
  );
}

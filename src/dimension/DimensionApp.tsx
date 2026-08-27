import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { SEED_DESKTOP_PROJECTION } from "../projections/desktop/seedProjection";
import {
  runtimeStatusLabel,
  type DesktopProjection
} from "../projections/desktop/types";
import {
  LayoutRenderer,
  type LayoutCompositionSurface,
} from "../runtime/layout/LayoutRenderer";
import { SEED_LAYOUT_DOCUMENT } from "../runtime/layout/seedLayout";
import type { LayoutDocumentV1 } from "../runtime/layout/types";
import { JournalPage } from "./JournalPage";
import { AppHeader, CommandBar, DeskHeader, DimToast, SecretaryRail, useDimToast } from "./Shell";
import type { CardHandlers, CardPresentation, CognitionCard, DeskCard, SecretaryIntent } from "./types";
import "./dimension.css";

export interface DimensionAppProps {
  layout?: LayoutDocumentV1<string, CardPresentation>;
  projection?: DesktopProjection;
  /**
   * 卡片语义事件的真实出口。省略的键回退到演示提示；
   * LiveDimensionApp 会注入接真实数据的实现。
   */
  handlers?: CardHandlers;
  /** Browser-only trusted V2 surface; omitted by the existing Tauri desktop. */
  composition?: LayoutCompositionSurface;
  /** 对话条出口。省略时回退到演示提示。 */
  onSendMessage?: (text: string) => void;
  /** Browser UiSurfaceV2 may hide or unbind the host-owned command bar. */
  commandBarVisible?: boolean;
  commandBarSendEnabled?: boolean;
  /** 对话层（升起在桌面与对话条之间的一张纸）。由真实接线方提供。 */
  thread?: ReactNode;
  onOpenSettings?: () => void;
  onOpenReview?: () => void;
  onAdjustDesktop?: () => void;
  /** 添加 / 移除只改变桌面上的卡片，不删除卡片背后的真实数据。 */
  onCardVisibilityChange?: (cardId: string, visible: boolean) => void;
  /** 点秘书立绘的出口（聊聊 / 要我定的 / 回顾）。 */
  onSecretaryInteract?: (intent: SecretaryIntent) => void;
  /**
   * 秘书栏渲染方式。inline = 桌面自带的栏（独立使用时的默认）；
   * none = 不渲染（三层甲板场景下由外层提供全局常驻栏，层级在甲板之上）。
   */
  railMode?: "inline" | "none";
  /**
   * 线索聚焦：从线索板点进某条事件维度时带上它的标签，
   * 桌面上不属于这条线的锚点退焦，顶部出现可退出的胶囊。
   */
  focusTag?: string | null;
  onExitFocus?: () => void;
}

/**
 * 维度桌面最小运行时。
 *
 * 页面只承载稳定五区和交互外壳；卡位来自 LayoutDocument，内容来自
 * DesktopProjection。默认值是明确标注的 seed，不读 SQLite、不调用 LLM，
 * 也不会把任何占位动作伪装成已经写入。
 */
export function DimensionApp({
  layout = SEED_LAYOUT_DOCUMENT,
  projection = SEED_DESKTOP_PROJECTION,
  handlers,
  composition,
  onSendMessage,
  commandBarVisible = true,
  commandBarSendEnabled = true,
  thread,
  onOpenSettings,
  onOpenReview,
  onAdjustDesktop,
  onCardVisibilityChange,
  onSecretaryInteract,
  railMode = "inline",
  focusTag = null,
  onExitFocus
}: DimensionAppProps = {}) {
  const [openedCard, setOpenedCard] = useState<DeskCard | null>(null);
  const [cardPickerOpen, setCardPickerOpen] = useState(false);
  const [localCardVisibility, setLocalCardVisibility] = useState<Record<string, boolean>>({});
  const { toast, say } = useDimToast();
  const deskLayer = useRef<HTMLDivElement>(null);
  const bookLayer = useRef<HTMLDivElement>(null);

  const spread = openedCard
    ? projection.journalSpreads?.[openedCard.id]
    : undefined;
  const isOpen = openedCard?.kind === "cognition" && Boolean(spread);
  const visibleLayout = useMemo(
    () =>
      onCardVisibilityChange
        ? layout
        : {
            ...layout,
            cards: layout.cards.map((card) => ({
              ...card,
              hidden: localCardVisibility[card.id] === undefined
                ? card.hidden === true
                : !localCardVisibility[card.id]
            }))
          },
    [layout, localCardVisibility, onCardVisibilityChange]
  );
  const removedCards = visibleLayout.cards.filter((card) => card.hidden === true);

  function setCardVisible(cardId: string, visible: boolean) {
    if (onCardVisibilityChange) {
      onCardVisibilityChange(cardId, visible);
    } else {
      setLocalCardVisibility((current) => ({ ...current, [cardId]: visible }));
    }
    setCardPickerOpen(false);
    say(visible ? "已添加" : "已移除");
  }

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenedCard(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen]);

  // aria-hidden 不会阻止隐藏层里的按钮被 Tab 聚焦；inert 由 DOM 属性补齐。
  useEffect(() => {
    deskLayer.current?.toggleAttribute("inert", isOpen);
    bookLayer.current?.toggleAttribute("inert", !isOpen);
  }, [isOpen]);

  function handleOpen(card: DeskCard) {
    if (card.kind !== "cognition") {
      say("演示模式：这里会打开对应工具，并保留返回位置");
      return;
    }
    if (!projection.journalSpreads?.[card.id]) {
      say("这张认知沉淀还没有可展开的内页");
      return;
    }
    setOpenedCard(card);
  }

  const resolvedHandlers: CardHandlers = {
    onOpen: handlers?.onOpen ?? handleOpen,
    onAccept:
      handlers?.onAccept ?? (() => say("演示模式：已收到选择，本次不会保存")),
    onReject:
      handlers?.onReject ?? (() => say("演示模式：已保持原样，本次不会保存")),
    onVerdict: handlers?.onVerdict,
    onFeedFeedback:
      handlers?.onFeedFeedback ??
      ((_itemId, feedback) => {
        const label = {
          "new-angle": "有新角度",
          known: "已知道",
          "not-useful": "没用"
        }[feedback];
        say(`演示模式：已看到“${label}”，本次不会保存`);
      }),
    onLineage:
      handlers?.onLineage ?? ((lineage) => say(`来源线索：${lineage.label}`)),
    onAnchorComplete: handlers?.onAnchorComplete,
    onAnchorEdit:
      handlers?.onAnchorEdit ??
      (() => say("演示模式：改名会写回你的待办，演示里不保存")),
    onCardEdit: handlers?.onCardEdit
  };

  const backgroundTokens = layout.background.tokenOverrides as
    | CSSProperties
    | undefined;

  // 聚焦某条线索时，不属于这条线的锚点退焦（派生投影，不改原始数据）。
  const visibleBindings = useMemo(() => {
    if (!focusTag) return projection.bindings;
    const next: typeof projection.bindings = { ...projection.bindings };
    for (const [key, payload] of Object.entries(next)) {
      if (payload?.kind !== "anchors") continue;
      next[key] = {
        ...payload,
        rows: payload.rows.map((row) => ({
          ...row,
          dimmed: !row.tags?.includes(focusTag)
        }))
      };
    }
    return next;
  }, [projection.bindings, focusTag]);

  return (
    <div
      className="dimension-root"
      style={{
        ...backgroundTokens,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden"
      }}
      data-layout-document={layout.id}
      data-layout-revision={layout.revision}
    >
      <AppHeader runtimeLabel={runtimeStatusLabel(projection.runtimeStatus)} />

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {railMode === "inline" && (
          <SecretaryRail
            secretary={projection.secretary}
            onReview={
              onOpenReview ??
              (() => say("演示模式：这里会打开你们共同变化的时间线"))
            }
            onInteract={
              onSecretaryInteract ??
              ((intent) => {
                if (intent === "chat") say("演示模式：在下面对话条里直接说就行");
                else if (intent === "decide") say("演示模式：等你决定的事会出现在桌上");
                else onOpenReview?.();
              })
            }
            onSettings={
              onOpenSettings ?? (() => say("演示模式：设置页暂未接入"))
            }
          />
        )}

        <main className="dim-main">
          <div
            className={`dim-stage${isOpen ? " dim-stage--open" : ""}`}
            style={{ flex: 1, minHeight: 0 }}
          >
            <div
              ref={deskLayer}
              className="dim-layer dim-layer--desk dim-desk-scroll"
              aria-hidden={isOpen}
              data-deck-scroll
            >
              <DeskHeader
                breadcrumb={projection.header.breadcrumb}
                title={projection.header.title}
                subtitle={projection.header.subtitle}
                onAdd={() => setCardPickerOpen((open) => !open)}
                onAdjust={
                  onAdjustDesktop ??
                  (() =>
                    say("演示模式：调整桌面会先给你一份可撤销的预览"))
                }
              />
              {cardPickerOpen && (
                <section className="dim-card-picker" aria-label="添加卡片">
                  <strong>添加卡片</strong>
                  {removedCards.length > 0 ? (
                    <div className="dim-card-picker-list">
                      {removedCards.map((card) => (
                        <button
                          key={card.id}
                          type="button"
                          onClick={() => setCardVisible(card.id, true)}
                        >
                          + {card.presentation?.title ?? card.id}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span className="dim-meta">所有卡片都在桌面上</span>
                  )}
                </section>
              )}
              {focusTag && (
                <div className="dim-focus-capsule" role="status">
                  <span>
                    正在看线索 · <strong>{focusTag}</strong>
                  </span>
                  <button type="button" onClick={onExitFocus}>
                    退出聚焦
                  </button>
                </div>
              )}
              <LayoutRenderer
                document={visibleLayout}
                bindings={visibleBindings}
                handlers={resolvedHandlers}
                composition={composition}
                onCardRemove={(cardId) => setCardVisible(cardId, false)}
              />
            </div>

            <div
              ref={bookLayer}
              className="dim-layer dim-layer--book"
              aria-hidden={!isOpen}
            >
              {openedCard?.kind === "cognition" && spread && (
                <JournalPage
                  card={openedCard as CognitionCard}
                  spread={spread}
                  onClose={() => setOpenedCard(null)}
                  onCorrect={(choice) => {
                    setOpenedCard(null);
                    say(`收到！演示模式不会保存“${choice}”`);
                  }}
                />
              )}
            </div>
          </div>

          {thread}

          {commandBarVisible && (
            <CommandBar
              disabled={!commandBarSendEnabled}
              onSend={
                onSendMessage ??
                ((text) => say(`演示模式：收到“${text}”，本次不会保存`))
              }
            />
          )}
        </main>
      </div>

      <DimToast message={toast} />
    </div>
  );
}

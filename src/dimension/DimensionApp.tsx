import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { SEED_DESKTOP_PROJECTION } from "../projections/desktop/seedProjection";
import {
  runtimeStatusLabel,
  type DesktopProjection
} from "../projections/desktop/types";
import {
  LayoutRenderer,
  type LayoutCompositionSurface,
  type LayoutRendererHandle,
} from "../runtime/layout/LayoutRenderer";
import { SEED_LAYOUT_DOCUMENT } from "../runtime/layout/seedLayout";
import type { LayoutDocumentV1 } from "../runtime/layout/types";
import { JournalPage } from "./JournalPage";
import { AppHeader, CommandBar, DimToast, SecretaryRail, useDimToast } from "./Shell";
import type { AnchorRow, CardHandlers, CardPresentation, CognitionCard, DeskCard, LineageRef, NativeCardPayload, SecretaryIntent } from "./types";
import "./dimension.css";
import "./desktopToolbar.css";
import type { SendComposerMessage } from "./composer/MessageComposer";
import { DesktopCardToolbar, DesktopHomeControls, DesktopZoomControls } from "./DesktopCardToolbar";
import { DesktopZoomCanvas, type DesktopZoomHandle } from "./DesktopZoomCanvas";
import { MotionSurface } from "./SurfaceMotion";
import { AnchorsCardView } from "./cards/DeskCards";
import { renderNativeCard } from "./nativeRegistry";
import type { ClueThread } from "./presets/ClueBoardPreset";
import { areaReferenceCardId, readDesktopWorkspace, reconcileDesktopWorkspace, writeDesktopWorkspace, type DesktopArea } from "./desktopWorkspace";
import type { DesktopCardFrames } from "../runtime/layout/desktopFrameStorage";
import { desktopBoundsFromScreenBoxes, readLegacyContentWidths, readNewDesktopCardPlacement, readOccupiedDesktopFrames, resolveLegacyDesktopFrames } from "./desktopWorkspaceGeometry";
import type { DesktopCameraPosition, DesktopBounds } from "./desktopCamera";
import { BROWSER_UI_PROFILE_RESTORED_EVENT } from "../projections/desktop/browserUiComposition";
import { readLegacyDesktopCardGeometry } from "./custom-cards/legacyDesktopMigration";
import "./desktopWorkspace.css";
import {
  CustomDesktopCardContent, CustomDesktopCardForm, useCustomDesktopCards,
  type CustomDesktopCard, type CustomDesktopCardInput,
} from "./custom-cards";

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
  onSendMessage?: SendComposerMessage;
  composerSessionId?: string;
  /** Browser UiSurfaceV2 may hide or unbind the host-owned command bar. */
  commandBarVisible?: boolean;
  commandBarSendEnabled?: boolean;
  /** 对话层（升起在桌面与对话条之间的一张纸）。由真实接线方提供。 */
  thread?: ReactNode;
  onOpenSettings?: () => void;
  onOpenReview?: () => void;
  onRequestCardHelp?: (context: { cardId: string; title: string; content: string }) => void;
  onAdjustDesktop?: () => void;
  onReconnect?: () => Promise<void>;
  /** 添加 / 移除只改变桌面上的卡片，不删除卡片背后的真实数据。 */
  onCardVisibilityChange?: (cardId: string, visible: boolean) => void;
  /** 点秘书立绘的出口（聊聊 / 要我定的 / 回顾）。 */
  onSecretaryInteract?: (intent: SecretaryIntent) => void;
  /** Browser product places one direct chat launcher in the stable app header. */
  headerSecretary?: {
    notice?: string | null;
    open: boolean;
    visible: boolean;
    chatEnabled: boolean;
    outcomeEnabled: boolean;
    onRestore?: () => void;
  };
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
  workspaceThreads?: readonly ClueThread[];
  activeAreaId?: string | null;
  onActiveAreaChange?: (id: string | null) => void;
  onVisibleCardsChange?: (ids: string[]) => void;
  onCompleteAreaAnchor?: (row: AnchorRow) => void;
  onAreaLineage?: (lineage: LineageRef) => void;
  areaPresentations?: Record<string, Record<string, CardPresentation>>;
  areaBindings?: Record<string, Record<string, NativeCardPayload>>;
}

export interface DesktopWorkspaceHandle { focusArea(id: string): void; goHome(): void; setHome(): void }
const NO_THREADS: readonly ClueThread[] = [];

/**
 * 维度桌面最小运行时。
 *
 * 页面只承载稳定五区和交互外壳；卡位来自 LayoutDocument，内容来自
 * DesktopProjection。默认值是明确标注的 seed，不读 SQLite、不调用 LLM，
 * 也不会把任何占位动作伪装成已经写入。
 */
export const DimensionApp = forwardRef<DesktopWorkspaceHandle, DimensionAppProps>(function DimensionApp({
  layout = SEED_LAYOUT_DOCUMENT,
  projection = SEED_DESKTOP_PROJECTION,
  handlers,
  composition,
  onSendMessage,
  composerSessionId,
  commandBarVisible = false,
  commandBarSendEnabled = true,
  thread,
  onOpenSettings,
  onOpenReview,
  onRequestCardHelp,
  onAdjustDesktop,
  onReconnect,
  onCardVisibilityChange,
  onSecretaryInteract,
  headerSecretary,
  railMode = "inline",
  workspaceThreads = NO_THREADS,
  activeAreaId = null,
  onActiveAreaChange,
  onVisibleCardsChange,
  onCompleteAreaAnchor,
  onAreaLineage,
  areaPresentations,
  areaBindings,
}: DimensionAppProps, forwardedRef) {
  const [openedCard, setOpenedCard] = useState<DeskCard | null>(null);
  const [cardEditor, setCardEditor] = useState<"new" | CustomDesktopCard | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const customCards = useCustomDesktopCards(layout.id);
  const layoutRenderer = useRef<LayoutRendererHandle>(null);
  const desktopZoom = useRef<DesktopZoomHandle>(null);
  const [desktopScale, setDesktopScale] = useState(1);
  const [spatial, setSpatial] = useState<{
    cards: Array<{ id: string; inView: boolean }>;
    canUndoArrangement: boolean;
  }>({ cards: [], canUndoArrangement: false });
  const [pendingLocate, setPendingLocate] = useState<string | null>(null);
  const [localCardVisibility, setLocalCardVisibility] = useState<Record<string, boolean>>({});
  const [removalHistory, setRemovalHistory] = useState<Array<{ id: string; title: string }>>([]);
  const { toast, say } = useDimToast();
  const deskLayer = useRef<HTMLDivElement>(null);
  const bookLayer = useRef<HTMLDivElement>(null);
  const cameraPosition = useRef<DesktopCameraPosition>({ x: 450, y: 250, zoom: 1 });
  const [newCardFrames, setNewCardFrames] = useState<DesktopCardFrames>({});
  const [savedWorkspace, setSavedWorkspace] = useState(() => readDesktopWorkspace(layout.id));
  const workspace = useMemo(() => reconcileDesktopWorkspace(savedWorkspace, workspaceThreads, layout.id,
    readOccupiedDesktopFrames(layout.id),
    [...new Set(customCards.cards.flatMap(card => card.legacyOrigin ? [card.legacyOrigin.layoutId] : []))],
    readLegacyContentWidths(customCards.cards)),
  [savedWorkspace, workspaceThreads, layout.id, customCards.cards]);
  const areas = useMemo(() => Object.values(workspace.areas), [workspace.areas]);
  useEffect(() => {
    writeDesktopWorkspace(layout.id, workspace);
    if (JSON.stringify(workspace) !== JSON.stringify(savedWorkspace)) setSavedWorkspace(workspace);
  }, [layout.id, workspace, savedWorkspace]);
  useEffect(() => {
    const restore = () => {
      const restored = readDesktopWorkspace(layout.id);
      setSavedWorkspace(restored);
      setNewCardFrames({});
      onActiveAreaChange?.(restored.activeAreaId);
    };
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === `dim-desk-workspace-${layout.id}`) restore();
    };
    window.addEventListener(BROWSER_UI_PROFILE_RESTORED_EVENT, restore);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener(BROWSER_UI_PROFILE_RESTORED_EVENT, restore);
      window.removeEventListener("storage", storage);
    };
  }, [layout.id, onActiveAreaChange]);

  const selectArea = useCallback((id: string | null) => {
    setSavedWorkspace(current => ({ ...current, activeAreaId: id }));
    onActiveAreaChange?.(id);
  }, [onActiveAreaChange]);
  const areaForCustomCard = (card: CustomDesktopCard) => card.legacyOrigin && areas.find(area =>
    area.legacyLayoutIds?.includes(card.legacyOrigin!.layoutId));
  const legacyBindingsFor = (area: DesktopArea) => Object.entries(areaBindings?.[area.title] ?? {})
    .filter(([binding, payload]) => payload.kind !== "anchors" && binding !== "desktop.reviewPlan");
  const areaCardIds = (area: DesktopArea) => [areaReferenceCardId(area.id),
    ...customCards.cards.filter(card => areaForCustomCard(card)?.id === area.id).map(card => card.id),
    ...Object.entries(workspace.cardAreaIds ?? {}).filter(([, areaId]) => areaId === area.id).map(([cardId]) => cardId),
    ...legacyBindingsFor(area).map(([binding]) => `area-edit:${area.id}:${binding}`)];
  const boundsForArea = (area: DesktopArea): DesktopBounds => {
    const surface = deskLayer.current?.querySelector<HTMLElement>(".dim-desk-zoom-surface");
    const origin = surface?.getBoundingClientRect();
    const viewport = deskLayer.current;
    const deckScale = viewport?.clientWidth ? viewport.getBoundingClientRect().width / viewport.clientWidth || 1 : 1;
    const zoom = (Number(surface?.dataset.desktopZoom) || 1) * deckScale;
    const ids = new Set(areaCardIds(area));
    const boxes = Array.from(surface?.querySelectorAll<HTMLElement>("[data-spatial-card-id]") ?? [])
      .filter(card => ids.has(card.dataset.spatialCardId!)).map(card => card.getBoundingClientRect()).filter(box => box.width > 0);
    if (!origin || !boxes.length) return { left: area.x, top: area.y, width: 760, height: 550 };
    return desktopBoundsFromScreenBoxes(origin, boxes, zoom);
  };
  const focusArea = (id: string) => {
    const area = workspace.areas[id];
    if (!area) { goHome(); say("这条线索暂时不可用，已回到常用区。"); return; }
    selectArea(id);
    desktopZoom.current?.focusBounds(boundsForArea(area), { instant: true, remember: true });
  };
  function goHome() { selectArea(null); desktopZoom.current?.goHome(); }
  function setHome() { desktopZoom.current?.setHome(); selectArea(null); }
  function locateDesktopCard(id: string) {
    selectArea(areas.find(area => areaCardIds(area).includes(id))?.id ?? null);
    layoutRenderer.current?.locateCard(id);
  }
  useImperativeHandle(forwardedRef, () => ({ focusArea, goHome, setHome }));

  const initialFrames = useMemo<DesktopCardFrames>(() => {
    const frames: DesktopCardFrames = { ...newCardFrames };
    areas.forEach(area => {
      const thread = workspaceThreads.find(thread => thread.id === area.id);
      if (thread) frames[areaReferenceCardId(area.id)] = { x: area.x, y: area.y + 70,
        width: 640, height: Math.max(280, Math.min(640, thread.rows.length * 64 + 140)) };
      const legacy = customCards.cards.filter(card => area.legacyLayoutIds?.includes(card.legacyOrigin?.layoutId ?? ""));
      const geometry = resolveLegacyDesktopFrames(legacy.map(card => readLegacyDesktopCardGeometry(card)));
      const minimumX = Math.min(0, ...geometry.map(frame => frame.x));
      const minimumY = Math.min(0, ...geometry.map(frame => frame.y));
      legacy.forEach((card, index) => {
        const old = geometry[index];
        frames[card.id] = { x: area.x + 720 + old.x - minimumX,
          y: area.y + 70 + old.y - minimumY, width: old.width, height: old.height };
      });
      legacyBindingsFor(area).forEach(([binding], index) => {
        frames[`area-edit:${area.id}:${binding}`] = { x: area.x + 720, y: area.y + 70 + (legacy.length + index) * 380, width: 440, height: 320 };
      });
    });
    return frames;
  }, [newCardFrames, areas, workspaceThreads, customCards.cards, areaBindings]);
  const areaBounds = useMemo(() => areas.map(area => ({ left: area.x, top: area.y, width: 760, height: 640 })), [areas]);

  const spread = openedCard
    ? projection.journalSpreads?.[openedCard.id]
    : undefined;
  const isOpen = openedCard?.kind === "cognition" && Boolean(spread);
  const visibleLayout = useMemo(() => ({ ...layout,
    // Reflection belongs to dialogue; retain its source binding without making
    // the old weekly paper available in the home or card picker.
    cards: layout.cards.map(card => ({ ...card, hidden: card.binding === "desktop.reviewPlan"
      ? true : !onCardVisibilityChange && localCardVisibility[card.id] !== undefined
        ? !localCardVisibility[card.id] : card.hidden === true })),
  }), [layout, localCardVisibility, onCardVisibilityChange]);
  const inventory = useMemo(() => [
    ...visibleLayout.cards.filter(card => card.binding !== "desktop.reviewPlan").map((card) => ({
      id: card.id, title: card.presentation?.title ?? card.id,
      hidden: card.hidden === true,
      inView: spatial.cards.find((item) => item.id === card.id)?.inView ?? true,
    })),
    ...customCards.cards.map((card) => ({
      id: card.id, title: card.title, hidden: card.hidden, custom: true,
      inView: spatial.cards.find((item) => item.id === card.id)?.inView ?? true,
    })),
    ...workspaceThreads.map(thread => ({ id: areaReferenceCardId(thread.id), title: `${thread.title} · 相关记录`,
      hidden: workspace.hiddenCardIds?.includes(areaReferenceCardId(thread.id)) ?? false,
      inView: spatial.cards.find(item => item.id === areaReferenceCardId(thread.id))?.inView ?? false })),
    ...areas.flatMap(area => legacyBindingsFor(area).map(([binding]) => ({ id: `area-edit:${area.id}:${binding}`,
      title: `${area.title} · 保留的内容`, hidden: workspace.hiddenCardIds?.includes(`area-edit:${area.id}:${binding}`) ?? false,
      inView: spatial.cards.find(item => item.id === `area-edit:${area.id}:${binding}`)?.inView ?? false }))),
  ], [visibleLayout.cards, customCards.cards, spatial.cards, workspaceThreads, workspace.hiddenCardIds, areas, areaBindings]);
  useEffect(() => { onVisibleCardsChange?.(spatial.cards.filter(card => card.inView).map(card => card.id)); }, [spatial.cards, onVisibleCardsChange]);
  const removedCards = inventory.filter((card) => card.hidden);
  // 只恢复同一卡片的可见性。位置、大小与绑定数据仍由原来的布局持有。
  // 受控桌面要等宿主回传 hidden 后才提供撤销，避免把未生效的操作说成已移除。
  const undoableRemovals = removalHistory.filter((entry) =>
    removedCards.some((card) => card.id === entry.id)
  );
  const latestRemoval = undoableRemovals[undoableRemovals.length - 1];

  useEffect(() => {
    setLocalCardVisibility({});
    setRemovalHistory([]);
    setCardEditor(null);
    setPendingLocate(null);
  }, [layout.id]);

  useEffect(() => {
    if (!pendingLocate || !inventory.some((card) => card.id === pendingLocate && !card.hidden)) return;
    const frame = requestAnimationFrame(() => {
      locateDesktopCard(pendingLocate);
      setPendingLocate(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingLocate, inventory]);

  function setCardVisible(cardId: string, visible: boolean) {
    const card = inventory.find((entry) => entry.id === cardId);
    if (!card) return;
    if ("custom" in card && card.custom) {
      if (!customCards.setVisible(cardId, visible)) return;
    } else if (cardId.startsWith("area-reference:") || cardId.startsWith("area-edit:")) {
      setSavedWorkspace(current => ({ ...current, hiddenCardIds: visible
        ? (current.hiddenCardIds ?? []).filter(id => id !== cardId)
        : [...new Set([...(current.hiddenCardIds ?? []), cardId])] }));
    } else if (onCardVisibilityChange) {
      onCardVisibilityChange(cardId, visible);
    } else {
      setLocalCardVisibility((current) => ({ ...current, [cardId]: visible }));
    }
    setRemovalHistory((current) => {
      const remaining = current.filter((entry) => entry.id !== cardId);
      return visible
        ? remaining
        : [...remaining, { id: cardId, title: card.title }];
    });
    if (visible) {
      setPendingLocate(cardId);
      say("已放回桌面");
    }
  }

  const openNewCard = useCallback(() => {
    customCards.clearError();
    setCardEditor("new");
  }, [customCards.clearError]);

  function saveCustomCard(input: CustomDesktopCardInput) {
    if (cardEditor === "new") {
      const card = customCards.create(input);
      if (!card) return false;
      const camera = cameraPosition.current;
      if (activeAreaId && workspace.areas[activeAreaId]) {
        setSavedWorkspace(current => ({ ...current, cardAreaIds: { ...current.cardAreaIds, [card.id]: activeAreaId } }));
      }
      const placement = readNewDesktopCardPlacement(deskLayer.current, camera);
      setNewCardFrames(current => ({ ...current, [card.id]: placement }));
      setPendingLocate(card.id);
    } else if (cardEditor && !customCards.update(cardEditor.id, input, cardEditor.revision)) {
      return false;
    }
    setCardEditor(null);
    return true;
  }

  async function reconnect() {
    if (!onReconnect || reconnecting) return;
    setReconnecting(true);
    try { await onReconnect(); }
    catch { say("还没连上，请稍后重试或检查设置。"); }
    finally { setReconnecting(false); }
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
    onActivityCapture: handlers?.onActivityCapture,
    onActivityEdit: handlers?.onActivityEdit,
    onActivityRetract: handlers?.onActivityRetract,
    onActivityReflect: handlers?.onActivityReflect,
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

  const visibleBindings = projection.bindings;

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
      {createPortal(
        <AnimatePresence initial={false}>
          {cardEditor && <MotionSurface key="custom-card-editor" className="dimension-root dim-custom-card-backdrop"
            style={backgroundTokens}>
            <CustomDesktopCardForm
              key={cardEditor === "new" ? "new" : cardEditor.id}
              initial={cardEditor === "new" ? undefined : cardEditor}
              error={customCards.error}
              onSubmit={saveCustomCard}
              onCancel={() => setCardEditor(null)}
            />
          </MotionSurface>}
        </AnimatePresence>, document.body,
      )}

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
            className={`dim-stage dim-stage--home${isOpen ? " dim-stage--open" : ""}`}
            style={{ flex: 1, minHeight: 0 }}
          >
              <div className="dim-page-topline">
                <div className="dim-page-header-tools">
                  <time className="dim-page-date" dateTime={new Date().toLocaleDateString("en-CA")}>
                    <span aria-hidden="true" className="dim-page-date-mark">◇</span>
                    {new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })}
                  </time>
                  {projection.runtimeStatus === "demo" && <span className="dim-eyebrow">{runtimeStatusLabel(projection.runtimeStatus)}</span>}
                  {headerSecretary && <div className="dim-page-secretary-tools">
                    <AppHeader
                      title=""
                      appearance="page"
                      showRuntimeStatus={false}
                      runtimeLabel={runtimeStatusLabel(projection.runtimeStatus)}
                      secretaryLauncher={headerSecretary ? {
                        secretary: projection.secretary,
                        notice: headerSecretary.notice,
                        open: headerSecretary.open,
                        visible: headerSecretary.visible,
                        enabled: headerSecretary.chatEnabled,
                        outcomeEnabled: headerSecretary.outcomeEnabled,
                        onOpen: () => onSecretaryInteract?.("chat"),
                        onOutcome: () => onSecretaryInteract?.("decide"),
                        onRestore: headerSecretary.onRestore,
                      } : undefined}
                      onSettings={headerSecretary ? onOpenSettings : undefined}
                    />
                  </div>}
                </div>
                <div className="dim-desktop-toolbar">
                <DesktopCardToolbar
                  cards={inventory}
                  canUndoArrangement={spatial.canUndoArrangement}
                  onCreate={openNewCard}
                  onLocate={locateDesktopCard}
                  onRestore={(id) => setCardVisible(id, true)}
                  onArrange={() => layoutRenderer.current?.arrangeCards(activeAreaId && workspace.areas[activeAreaId]
                    ? areaCardIds(workspace.areas[activeAreaId])
                    : inventory.filter(card => !card.hidden && !areas.some(area => areaCardIds(area).includes(card.id))).map(card => card.id))}
                  onArrangeAll={() => layoutRenderer.current?.arrangeCards()}
                  areas={areas}
                  onLocateArea={focusArea}
                  onUndoArrangement={() => layoutRenderer.current?.undoArrangement()}
                  onAdjust={onAdjustDesktop}
                />
                </div>
              </div>
            <DesktopZoomControls cards={inventory}
                  scale={desktopScale}
                  onZoomIn={() => desktopZoom.current?.zoomIn()}
                  onZoomOut={() => desktopZoom.current?.zoomOut()}
                  onResetZoom={() => desktopZoom.current?.resetZoom()}
                  locationTools={<>
                <div className="dim-desktop-location-tools">
                  <span className={activeAreaId ? undefined : "dim-location-home-label"} aria-label="当前桌面板块">{activeAreaId ? workspace.areas[activeAreaId]?.title ?? "桌面" : "桌面"}</span>
                </div>
                  </>}
            />
            {railMode === "inline" && <DesktopHomeControls onGoHome={goHome} onSetHome={setHome} />}
            <div
              ref={deskLayer}
              className="dim-layer dim-layer--desk dim-desk-scroll"
              aria-hidden={isOpen}
              data-deck-scroll
            >
              {(projection.runtimeStatus === "unavailable" || projection.runtimeStatus === "starting") && (
                <div className="dim-desktop-connection" role="region" aria-label="连接状态">
                  <span className="dim-desktop-connection-dot" aria-hidden="true" />
                  <p>{projection.runtimeStatus === "starting"
                    ? "正在连接本地服务…"
                    : "本地服务未连接。便签仍可在本机保存。"}</p>
                  {onReconnect && <button type="button" className="dim-btn dim-btn--quiet"
                    disabled={reconnecting} onClick={() => void reconnect()}>
                    {reconnecting ? "正在重连…" : "重新连接"}
                  </button>}
                  {onOpenSettings && <button type="button" className="dim-btn dim-btn--quiet"
                    onClick={onOpenSettings}>检查设置</button>}
                </div>
              )}
              <DesktopZoomCanvas key={layout.id} layoutId={layout.id} ref={desktopZoom}
                includeBounds={areaBounds}
                onCameraChange={(camera, reason) => {
                  cameraPosition.current = camera;
                  // 纸面纹理跟随视野，页边和工具保持固定。
                  const background = deskLayer.current?.closest<HTMLElement>(".dim-deck") ?? deskLayer.current;
                  background?.style.setProperty("--desk-wood-x", `${-camera.x * camera.zoom}px`);
                  background?.style.setProperty("--desk-wood-y", `${-camera.y * camera.zoom}px`);
                  background?.style.setProperty("--desk-wood-size", `${1000 * camera.zoom}px`);
                  if (reason === "pan" && activeAreaId && workspace.areas[activeAreaId]) {
                    const bounds = boundsForArea(workspace.areas[activeAreaId]);
                    if (camera.x < bounds.left || camera.x > bounds.left + bounds.width ||
                        camera.y < bounds.top || camera.y > bounds.top + bounds.height) selectArea(null);
                  }
                }}
                onScaleChange={setDesktopScale} onNotice={say}>
              {areas.map(area => <div key={area.id}
                className={`dim-desktop-area-label${activeAreaId === area.id ? " is-current" : ""}`}
                style={{ left: area.x, top: area.y }} data-desktop-anchor={area.id}>
                <h2>{area.title}</h2>
                {!workspaceThreads.some(thread => thread.id === area.id) && <p>之前留在这条线索下的内容</p>}
              </div>)}
              <LayoutRenderer
                ref={layoutRenderer}
                onSpatialChange={setSpatial}
                initialFrames={initialFrames}
                arrangementGroups={areas.map(area => areaCardIds(area))}
                onRequestCardHelp={onRequestCardHelp}
                extraCards={[...customCards.cards.map((card) => ({
                  id: card.id,
                  title: card.title,
                  hidden: card.hidden,
                  onEdit: () => { customCards.clearError(); setCardEditor(card); },
                  context: `${card.title}\n${card.body}\n${card.url ?? ""}`,
                  content: <CustomDesktopCardContent card={card}
                    onEdit={() => { customCards.clearError(); setCardEditor(card); }}
                    onRetrySync={() => customCards.retrySync(card.id)} />,
                })), ...workspaceThreads.map(thread => {
                  const id = areaReferenceCardId(thread.id);
                  const anchorDefinition = layout.cards.find(card => card.kind === "anchors");
                  const presentation = anchorDefinition && areaPresentations?.[thread.title]?.[anchorDefinition.id];
                  return { id, kind: "anchors", title: `${thread.title} · 相关记录`, hidden: workspace.hiddenCardIds?.includes(id),
                    editableContent: Boolean(onCompleteAreaAnchor || handlers?.onAnchorEdit),
                    context: thread.rows.map(row => row.text).join("\n"),
                    content: <AnchorsCardView card={{ kind: "anchors", id, span: 7,
                      eyebrow: "相关记录", title: `${thread.title} · 相关记录`,
                      ...(presentation ?? {}), rows: thread.rows.map(row => ({ ...row, dimmed: false })),
                      emptyHint: "这条线索还没有关联记录。可以在这里放一张便签。" }}
                      onLineage={onAreaLineage ?? resolvedHandlers.onLineage}
                      onComplete={onCompleteAreaAnchor}
                      onEdit={handlers?.onAnchorEdit} /> };
                }), ...areas.flatMap(area => legacyBindingsFor(area).flatMap(([binding, payload]) => {
                  const definition = layout.cards.find(card => card.binding === binding);
                  const presentation = definition && (areaPresentations?.[area.title]?.[definition.id] ?? definition.presentation);
                  if (!presentation) return [];
                  const id = `area-edit:${area.id}:${binding}`;
                  return [{ id, kind: payload.kind, title: `${area.title} · 保留的内容`, hidden: workspace.hiddenCardIds?.includes(id),
                    context: JSON.stringify(payload),
                    content: renderNativeCard(payload, { ...presentation, id, span: 4 }, resolvedHandlers) }];
                }))]}
                document={visibleLayout}
                bindings={visibleBindings}
                handlers={resolvedHandlers}
                composition={composition}
                onCardRemove={(cardId) => setCardVisible(cardId, false)}
              />
              </DesktopZoomCanvas>
            </div>

            {latestRemoval && !isOpen && (
              <div className="dim-card-undo" role="status" aria-live="polite" aria-atomic="true">
                <span className="dim-card-undo-message" title={latestRemoval.title}>
                  已移除「{latestRemoval.title}」
                  {undoableRemovals.length > 1 && <small>另 {undoableRemovals.length - 1} 张可撤销</small>}
                </span>
                <button
                  type="button"
                  className="dim-card-undo-action"
                  aria-label={`撤销移除：${latestRemoval.title}`}
                  onClick={() => setCardVisible(latestRemoval.id, true)}
                >
                  撤销
                </button>
                <button
                  type="button"
                  className="dim-card-undo-dismiss"
                  aria-label="关闭移除提示"
                  onClick={() => setRemovalHistory([])}
                >
                  ×
                </button>
              </div>
            )}

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
              sessionId={composerSessionId}
              onOpenComposer={() => onSecretaryInteract?.("chat")}
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
});

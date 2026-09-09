import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ReactNode, KeyboardEvent, MouseEvent } from "react";
import { createPortal } from "react-dom";
import { CardContextMenu } from "../../dimension/CardContextMenu";
import { useCardLocks } from "./useCardLocks";
import { CardReadingContext } from "../../dimension/cards/CardShell";
import {
  NATIVE_CARD_REGISTRY,
  materializeDeskCard,
  renderNativeCard
} from "../../dimension/nativeRegistry";
import type {
  CardEditRequest,
  CardHandlers,
  CardPresentation,
  NativeCardKind,
  NativeCardLayout,
  NativeCardPayload
} from "../../dimension/types";
import { BROWSER_COMMAND_IDS } from "../composition/browserProduction";
import type { CompositionRegistry } from "../composition/registry";
import type { UiSurfaceDocumentV2 } from "../composition/types";
import "../../dimension/cards/card-interactions.css";
import type { LayoutCardDefinition, LayoutDocumentV1 } from "./types";
import { useCardDrag } from "./useCardDrag";
import { useCardResize } from "./useCardResize";
import type { DesktopCardFrames } from "./desktopFrameStorage";
import { useCardSpatial } from "./useCardSpatial";
import type { CardSpatialState } from "./useCardSpatial";
import "./cardResize.css";
import { resolveLayoutCards, validateLayoutDocument } from "./validate";

export interface LayoutCompositionSurface {
  document: UiSurfaceDocumentV2;
  registry: CompositionRegistry;
}

export interface LayoutRendererHandle {
  locateCard(id: string): void;
  arrangeCards(cardIds?: string[]): void;
  undoArrangement(): void;
}

export type LayoutSpatialState = CardSpatialState;

export interface ExtraDeskCard {
  id: string;
  title: string;
  content: ReactNode;
  hidden?: boolean;
  onEdit?: () => void;
  context?: string;
  kind?: string;
  editableContent?: boolean;
}

export interface LayoutRendererProps {
  /** 布局只描述格子、排布与数据 binding，不携带业务内容。 */
  document: LayoutDocumentV1<string, CardPresentation>;
  /** projection 负责把 binding 映射为当前时刻的原生卡 payload。 */
  bindings: Record<string, NativeCardPayload | undefined>;
  handlers?: CardHandlers;
  /**
   * Browser production surface. When present, card events are disabled unless
   * this trusted registry document explicitly binds them to a known command.
   * Tauri/legacy callers omit it and retain their existing handler behavior.
   */
  composition?: LayoutCompositionSurface;
  /** 从当前桌面移走一张卡；只改变桌面组成，不删除绑定的数据。 */
  onCardRemove?: (cardId: string) => void;
  /** 本机创建的内容卡独立于可信的业务组件注册表。 */
  extraCards?: ExtraDeskCard[];
  onSpatialChange?: (state: CardSpatialState) => void;
  /** Initial placement for new papers only; persisted frames always win. */
  initialFrames?: DesktopCardFrames;
  arrangementGroups?: string[][];
  onRequestCardHelp?: (context: { cardId: string; title: string; content: string }) => void;
}

function isNativeCardKind(value: string): value is NativeCardKind {
  return Object.prototype.hasOwnProperty.call(NATIVE_CARD_REGISTRY, value);
}

function FallbackCard({
  definition,
  children
}: {
  definition: LayoutCardDefinition<string, CardPresentation>;
  children: ReactNode;
}) {
  return (
    <section
      className="dim-paper"
      role="alert"
      data-layout-fallback={definition.id}
      style={{ minHeight: 110 }}
    >
      <p className="dim-eyebrow">Layout / Safe Fallback</p>
      <h3 className="dim-title">这张卡暂时无法显示</h3>
      <p className="dim-body" style={{ marginTop: 10 }}>
        {children}
      </p>
    </section>
  );
}

function renderCard(
  definition: LayoutCardDefinition<string, CardPresentation>,
  bindings: LayoutRendererProps["bindings"],
  handlers: CardHandlers
) {
  if (definition.renderer !== "native") {
    return (
      <FallbackCard definition={definition}>
        {definition.renderer === "html"
          ? "自由 HTML 渲染器尚未启用；内容没有被执行。"
          : "声明式渲染器尚未启用；请改用原生卡片。"}
      </FallbackCard>
    );
  }

  if (!isNativeCardKind(definition.kind)) {
    return (
      <FallbackCard definition={definition}>
        未知的原生卡片类型：{definition.kind}
      </FallbackCard>
    );
  }

  const payload = bindings[definition.binding];
  if (!payload) {
    return (
      <FallbackCard definition={definition}>
        找不到数据绑定：{definition.binding}
      </FallbackCard>
    );
  }

  if (payload.kind !== definition.kind) {
    return (
      <FallbackCard definition={definition}>
        数据类型与布局不一致：需要 {definition.kind}，实际是 {payload.kind}
      </FallbackCard>
    );
  }

  const presentation = definition.presentation;
  if (
    !presentation ||
    presentation.eyebrow.trim().length === 0 ||
    presentation.title.trim().length === 0
  ) {
    return (
      <FallbackCard definition={definition}>
        原生卡片缺少 presentation.eyebrow 或 presentation.title
      </FallbackCard>
    );
  }

  const layout: NativeCardLayout = {
    ...presentation,
    id: definition.id,
    span: definition.span
  };

  return renderNativeCard(payload, layout, handlers);
}

function editRequestFor(
  definition: LayoutCardDefinition<string, CardPresentation>,
  bindings: LayoutRendererProps["bindings"]
): CardEditRequest | undefined {
  if (definition.renderer !== "native" || !isNativeCardKind(definition.kind)) return;
  const payload = bindings[definition.binding];
  const presentation = definition.presentation;
  if (!payload || payload.kind !== definition.kind || !presentation) return;
  if (!presentation.eyebrow.trim() || !presentation.title.trim()) return;

  return {
    cardId: definition.id,
    binding: definition.binding,
    card: materializeDeskCard(payload, {
      ...presentation,
      id: definition.id,
      span: definition.span
    })
  };
}

function isNestedInteraction(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const interaction = target.closest(
    'button, a, input, textarea, select, [role="button"], [contenteditable="true"], [data-no-card-edit]'
  );
  // 认知卡的整纸单击负责翻开手帐；它仍是“卡片正文”，双击要交给编辑器。
  return Boolean(interaction && !interaction.hasAttribute("data-card-primary-action"));
}

function boundHandlersFor(
  definition: LayoutCardDefinition<string, CardPresentation>,
  handlers: CardHandlers,
  composition: NonNullable<LayoutRendererProps["composition"]>,
): CardHandlers {
  const component = composition.document.components.find(
    (candidate) => candidate.id === definition.id,
  );
  if (
    !component ||
    component.props.bindingRef !== definition.binding ||
    composition.registry.validateComponent(component).length > 0
  ) {
    return {};
  }
  const commandFor = (event: string): string | undefined => {
    const commandId = component.actions[event];
    return commandId && composition.registry.canBind(component.type, event, commandId)
      ? commandId
      : undefined;
  };
  const result: CardHandlers = {};
  if (
    commandFor("feedback") === BROWSER_COMMAND_IDS.feedFeedback &&
    handlers.onFeedFeedback
  ) {
    result.onFeedFeedback = (itemId, feedback) =>
      handlers.onFeedFeedback?.(itemId, feedback);
  }
  if (
    commandFor("capture") === BROWSER_COMMAND_IDS.activityCapture &&
    handlers.onActivityCapture
  ) {
    result.onActivityCapture = (text) => handlers.onActivityCapture?.(text);
  }
  if (
    commandFor("edit") === BROWSER_COMMAND_IDS.activityEdit &&
    handlers.onActivityEdit
  ) {
    result.onActivityEdit = (entry, nextText) =>
      handlers.onActivityEdit?.(entry, nextText);
  }
  if (
    commandFor("retract") === BROWSER_COMMAND_IDS.activityRetract &&
    handlers.onActivityRetract
  ) {
    result.onActivityRetract = (entry) => handlers.onActivityRetract?.(entry);
  }
  if (
    commandFor("reflect") === BROWSER_COMMAND_IDS.activityReflect &&
    handlers.onActivityReflect
  ) {
    result.onActivityReflect = () => handlers.onActivityReflect?.();
  }
  if (
    commandFor("lineage") === BROWSER_COMMAND_IDS.lineageOpen &&
    handlers.onLineage
  ) {
    result.onLineage = (lineage) => handlers.onLineage?.(lineage);
  }
  if (
    commandFor("complete") === BROWSER_COMMAND_IDS.anchorComplete &&
    handlers.onAnchorComplete
  ) {
    result.onAnchorComplete = (row) => handlers.onAnchorComplete?.(row);
  }
  if (
    commandFor("edit") === BROWSER_COMMAND_IDS.anchorEdit &&
    handlers.onAnchorEdit
  ) {
    result.onAnchorEdit = (row, nextText) => handlers.onAnchorEdit?.(row, nextText);
  }
  return result;
}

/**
 * 三层 LayoutDocument 的最小解释器。
 *
 * 实验期只点亮 native。declarative / html 是 schema 承诺，不是可执行能力；
 * 遇到它们必须显示安全降级，绝不静默为空，也绝不运行任意 HTML。
 */
export const LayoutRenderer = forwardRef<LayoutRendererHandle, LayoutRendererProps>(function LayoutRenderer({
  document,
  bindings,
  handlers = {},
  composition,
  onCardRemove,
  extraCards = [],
  onSpatialChange,
  initialFrames,
  arrangementGroups,
  onRequestCardHelp,
}, ref) {
  const { issues } = validateLayoutDocument(document);
  const locks = useCardLocks(document.id);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [resizingCard, setResizingCard] = useState<string | null>(null);
  const [editingCard, setEditingCard] = useState<string | null>(null);
  useEffect(() => { setMenu(null); setResizingCard(null); setEditingCard(null); }, [document.id]);
  useEffect(() => {
    if (!resizingCard) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || event.target.closest<HTMLElement>("[data-spatial-card-id]")?.dataset.spatialCardId !== resizingCard) setResizingCard(null);
    };
    window.document.addEventListener("pointerdown", outside);
    return () => window.document.removeEventListener("pointerdown", outside);
  }, [resizingCard]);
  // 便签可以拖散在桌面上：偏移只写在表现层（localStorage），骨架与数据不动。
  // hook 必须在提前 return 之前调用。
  const drag = useCardDrag(`dim-desk-offsets-${document.id}`);
  const resize = useCardResize(`dim-desk-sizes-${document.id}`);
  const gridRef = useRef<HTMLDivElement>(null);
  // 用户内容不能覆盖内置业务卡的身份或命令绑定。
  const fixedIds = new Set(document.cards.map((card) => card.id));
  const extraIds = new Set<string>();
  const safeExtraCards = extraCards.filter((card) => {
    if (!card.id || fixedIds.has(card.id) || extraIds.has(card.id)) return false;
    extraIds.add(card.id);
    return !card.hidden;
  });
  const spatial = useCardSpatial({
    storageKey: `dim-desk-arranged-${document.id}`,
    gridRef,
    ids: [...document.cards.filter((card) => !card.hidden).map((card) => card.id), ...safeExtraCards.map((card) => card.id)],
    drag,
    resize,
    onChange: onSpatialChange,
    initialFrames,
    arrangementGroups,
    lockedIds: locks.ids,
    initiallyCompact: Boolean(onSpatialChange && !document.composition && !Object.keys(drag.offsets).length && !Object.keys(resize.sizes).length),
    kinds: Object.fromEntries([
      ...document.cards.map((card) => [card.id, card.kind]),
      ...safeExtraCards.map((card) => [card.id, card.kind ?? "note"]),
    ]),
  });
  useImperativeHandle(ref, () => ({
    locateCard: spatial.locateCard,
    arrangeCards: spatial.arrangeCards,
    undoArrangement: spatial.undoArrangement,
  }), [spatial.locateCard, spatial.arrangeCards, spatial.undoArrangement]);

  const compositionIssues = composition
    ? composition.registry.validateDocument(composition.document)
    : [];
  if (
    composition &&
    (composition.document.id !== document.id ||
      composition.document.revision !== document.revision)
  ) {
    compositionIssues.push("V1 layout and V2 surface revision do not match");
  }

  if (issues.length > 0 || compositionIssues.length > 0) {
    return (
      <section role="alert" className="dim-paper" data-layout-invalid={document.id}>
        <p className="dim-eyebrow">Layout / Invalid Document</p>
        <h2 className="dim-title">桌面布局文档有问题</h2>
        <ul className="dim-body" style={{ margin: "10px 0 0", paddingLeft: 18 }}>
          {issues.map((issue, index) => (
            <li key={`${issue.code}-${issue.cardId ?? "document"}-${index}`}>
              {issue.message}
            </li>
          ))}
          {compositionIssues.map((issue, index) => (
            <li key={`composition-${index}`}>{issue}</li>
          ))}
        </ul>
      </section>
    );
  }

  const orderedCards = resolveLayoutCards(document);

  const papers = [
    ...orderedCards.filter(definition => !definition.hidden).map(definition => {
      const request = editRequestFor(definition, bindings);
      const bound = composition ? boundHandlersFor(definition, handlers, composition) : handlers;
      const permitted = { ...bound,
        onOpen: bound.onOpen ? (card: CardEditRequest["card"]) => { setEditingCard(null); bound.onOpen?.(card); } : undefined,
        onLineage: bound.onLineage ? (lineage: Parameters<NonNullable<CardHandlers["onLineage"]>>[0]) => { setEditingCard(null); bound.onLineage?.(lineage); } : undefined,
        onActivityReflect: bound.onActivityReflect ? () => { setEditingCard(null); bound.onActivityReflect?.(); } : undefined,
      };
      const businessEditing = definition.kind === "activity" ? Boolean(bound.onActivityCapture || bound.onActivityEdit || bound.onActivityRetract)
        : definition.kind === "anchors" ? Boolean(bound.onAnchorEdit || bound.onAnchorComplete)
          : definition.kind === "feed" ? Boolean(bound.onFeedFeedback)
            : definition.kind === "proposal" ? Boolean(bound.onAccept || bound.onReject || bound.onVerdict) : false;
      return { id: definition.id, title: presentationTitle(definition), span: definition.span, region: definition.region,
        content: renderCard(definition, bindings, permitted),
        onEdit: undefined as (() => void) | undefined,
        onEditPresentation: request && handlers.onCardEdit ? () => handlers.onCardEdit?.(request) : undefined,
        editableContent: Boolean(request && handlers.onCardEdit) || businessEditing,
        context: request ? JSON.stringify(request.card) : presentationTitle(definition) };
    }),
    ...safeExtraCards.map(card => ({ ...card, span: 4, region: "custom", onEditPresentation: undefined })),
  ];
  const selected = papers.find(card => card.id === menu?.id);
  const editing = papers.find(card => card.id === editingCard);
  const openMenu = (id: string, event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    const box = event.currentTarget.getBoundingClientRect();
    setMenu({ id, x: "clientX" in event ? event.clientX : box.left + 24,
      y: "clientY" in event ? event.clientY : box.top + 32 });
  };
  return (
    <div className="dim-grid-wrap">
      <div ref={gridRef} className="dim-grid" data-arranged={spatial.arranged || undefined}
        data-free-desktop={spatial.frames ? "true" : undefined}
        style={spatial.frames ? { height: Math.max(140, spatial.canvasHeight) } : undefined} aria-label="桌面卡片布局">
        {papers.map(card => {
          const offset = drag.offsetFor(card.id);
          const size = resize.sizeFor(card.id);
          const frame = spatial.frames?.[card.id];
          const zIndex = resize.resizingId === card.id ? 1000 : drag.zIndexFor(card.id);
          const locked = locks.isLocked(card.id);
          const sizing = resizingCard === card.id && !locked;
          return <div key={card.id} data-span={card.span} data-region={card.region} data-layout-card-id={card.id}
            style={{ zIndex, ...(frame ? { left: frame.x, top: frame.y, width: frame.width } : {}) }}>
            <div className={`dim-drag dim-resizable${size ? " is-sized" : ""}${sizing ? " is-size-editing" : ""}`}
              style={{ translate: offset.x || offset.y ? `${offset.x}px ${offset.y}px` : undefined,
                ...(size || frame ? { width: size?.width ?? frame?.width, height: size?.height ?? frame?.height } : {}), zIndex }}
              {...(!locked && !sizing ? drag.bind(card.id) : {})}
              data-card-resizable data-default-width={frame?.width} data-default-height={frame?.height}
              data-spatial-card-id={card.id} data-card-locked={locked || undefined}
              role="group" tabIndex={0} aria-label={`卡片：${card.title}`} aria-keyshortcuts="Shift+F10 ContextMenu"
              title="右键打开卡片设置" onContextMenu={event => openMenu(card.id, event)}
              onKeyDown={event => {
                if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) openMenu(card.id, event);
                else if (event.key === "Escape" && sizing) { event.preventDefault(); setResizingCard(null); }
              }}>
              <CardReadingContext.Provider value={true}><div className="dim-card-reading">{card.content}</div></CardReadingContext.Provider>
              {sizing && <>
                <button type="button" className="dim-card-resize-done" data-no-drag onClick={() => setResizingCard(null)}>完成调整</button>
                {(["right", "bottom", "corner"] as const).map(direction => <button key={direction}
                  type="button" className="dim-card-resize" data-no-drag data-resize-direction={direction}
                  aria-label={`调整${direction === "right" ? "宽度" : direction === "bottom" ? "高度" : "大小"}：${card.title}`}
                  title="拖动调整大小；方向键微调，Shift 加速；Home 恢复原大小"
                  aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home" {...resize.bind(card.id, direction)} />)}
              </>}
            </div>
          </div>;
        })}
      </div>
      <CardContextMenu title={selected?.title ?? ""} anchor={menu} onClose={() => setMenu(null)} items={selected ? [
        { id: "resize", label: "调整大小", disabled: locks.isLocked(selected.id), hint: "拖动边缘", onSelect: () => { setResizingCard(selected.id); drag.bringToFront(selected.id); } },
        { id: "edit", label: selected.onEdit || selected.editableContent ? "编辑内容" : "查看内容", onSelect: () => selected.onEdit ? selected.onEdit() : setEditingCard(selected.id) },
        { id: "help", label: "让维度帮我改", disabled: !onRequestCardHelp, hint: "打开对话", onSelect: () => onRequestCardHelp?.({ cardId: selected.id, title: selected.title, content: selected.context ?? selected.title }) },
        { id: "lock", label: locks.isLocked(selected.id) ? "解锁位置" : "锁定位置", onSelect: () => { setResizingCard(null); locks.toggle(selected.id); } },
        { id: "remove", label: "移除卡片", danger: true, disabled: !onCardRemove, hint: "可撤销", onSelect: () => { setResizingCard(null); onCardRemove?.(selected.id); } },
      ] : []} />
      {editing && <CardContentDialog title={editing.title} onClose={() => setEditingCard(null)}
        editable={editing.editableContent}
        onRequestHelp={onRequestCardHelp ? () => { setEditingCard(null); onRequestCardHelp({ cardId: editing.id, title: editing.title, content: editing.context ?? editing.title }); } : undefined}
        onEditPresentation={editing.onEditPresentation ? () => { setEditingCard(null); editing.onEditPresentation?.(); } : undefined}>
        {editing.content}
      </CardContentDialog>}
    </div>
  );
});

function presentationTitle(
  definition: LayoutCardDefinition<string, CardPresentation>
): string {
  return definition.presentation?.title?.trim() || definition.id;
}

function CardContentDialog({ title, children, onClose, onEditPresentation, onRequestHelp, editable }: {
  title: string; children: ReactNode; onClose: () => void; onEditPresentation?: () => void; onRequestHelp?: () => void; editable?: boolean;
}) {
  const root = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = window.document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLElement>("button, input")?.focus();
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const elements = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') ?? []);
      const first = elements[0]; const last = elements[elements.length - 1];
      if (event.shiftKey && window.document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && window.document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.document.addEventListener("keydown", keydown, true);
    return () => { window.document.removeEventListener("keydown", keydown, true); previous?.focus({ preventScroll: true }); };
  }, []);
  return createPortal(<div className="dimension-root dim-card-content-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={root} className="dim-card-content-dialog" role="dialog" aria-modal="true" aria-label={`${editable ? "编辑内容" : "卡片内容"}：${title}`}>
      <header><div><span>卡片内容</span><h2>{title}</h2></div><button type="button" className="dim-btn dim-btn--quiet" aria-label="关闭卡片内容" onClick={onClose}>×</button></header>
      <div className="dim-card-content-body">{children}</div>
      {(onEditPresentation || onRequestHelp) && <footer>
        {!onEditPresentation && <p>内容随真实记录更新，可以让维度帮你调整。</p>}
        <div>{onEditPresentation && <button type="button" className="dim-btn" onClick={onEditPresentation}>修改标题与内容</button>}
        {onRequestHelp && <button type="button" className="dim-btn" onClick={onRequestHelp}>让维度帮我改</button>}</div>
      </footer>}
    </section>
  </div>, window.document.body);
}

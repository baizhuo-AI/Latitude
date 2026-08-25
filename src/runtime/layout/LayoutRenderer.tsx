import type { ReactNode } from "react";
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
import { resolveLayoutCards, validateLayoutDocument } from "./validate";

export interface LayoutCompositionSurface {
  document: UiSurfaceDocumentV2;
  registry: CompositionRegistry;
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
export function LayoutRenderer({
  document,
  bindings,
  handlers = {},
  composition,
}: LayoutRendererProps) {
  const { issues } = validateLayoutDocument(document);
  // 便签可以拖散在桌面上：偏移只写在表现层（localStorage），骨架与数据不动。
  // hook 必须在提前 return 之前调用。
  const drag = useCardDrag(`dim-desk-offsets-${document.id}`);

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

  return (
    <div className="dim-grid-wrap">
      <div className="dim-grid" aria-label="桌面卡片布局">
        {orderedCards.filter((definition) => !definition.hidden).map((definition) => {
          const offset = drag.offsetFor(definition.id);
          const editRequest = editRequestFor(definition, bindings);
          const cardHandlers = composition
            ? boundHandlersFor(definition, handlers, composition)
            : handlers;
          const canEdit = Boolean(!composition && editRequest && cardHandlers.onCardEdit);
          const dragBinding = drag.bind(definition.id);
          return (
            <div
              key={definition.id}
              data-span={definition.span}
              data-region={definition.region}
              data-layout-card-id={definition.id}
            >
              <div
                className={`dim-drag${
                  drag.draggingId === definition.id ? " is-dragging" : ""
                }`}
                style={
                  offset.x || offset.y
                    ? { translate: `${offset.x}px ${offset.y}px` }
                    : undefined
                }
                {...dragBinding}
                data-card-editable={canEdit ? "true" : undefined}
                role={canEdit ? "group" : undefined}
                tabIndex={canEdit ? 0 : undefined}
                aria-label={
                  canEdit && editRequest
                    ? `卡片：${editRequest.card.title}。双击或按 Enter 编辑`
                    : undefined
                }
                aria-keyshortcuts={canEdit ? "Enter F2" : undefined}
                title={canEdit ? "双击编辑卡片；Shift + 双击归位" : undefined}
                onDoubleClick={(event) => {
                  dragBinding.onDoubleClick(event);
                  if (
                    event.defaultPrevented ||
                    !editRequest ||
                    !cardHandlers.onCardEdit ||
                    isNestedInteraction(event.target)
                  ) {
                    return;
                  }
                  cardHandlers.onCardEdit(editRequest);
                }}
                onKeyDown={(event) => {
                  if (
                    (event.key !== "Enter" && event.key !== "F2") ||
                    event.target !== event.currentTarget ||
                    !editRequest ||
                    !cardHandlers.onCardEdit
                  ) {
                    return;
                  }
                  event.preventDefault();
                  cardHandlers.onCardEdit(editRequest);
                }}
              >
                {renderCard(definition, bindings, cardHandlers)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

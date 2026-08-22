import type { ReactNode } from "react";
import {
  NATIVE_CARD_REGISTRY,
  renderNativeCard
} from "../../dimension/nativeRegistry";
import type {
  CardHandlers,
  CardPresentation,
  NativeCardKind,
  NativeCardLayout,
  NativeCardPayload
} from "../../dimension/types";
import type { LayoutCardDefinition, LayoutDocumentV1 } from "./types";
import { resolveLayoutCards, validateLayoutDocument } from "./validate";

export interface LayoutRendererProps {
  /** 布局只描述格子、排布与数据 binding，不携带业务内容。 */
  document: LayoutDocumentV1<string, CardPresentation>;
  /** projection 负责把 binding 映射为当前时刻的原生卡 payload。 */
  bindings: Record<string, NativeCardPayload | undefined>;
  handlers?: CardHandlers;
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

/**
 * 三层 LayoutDocument 的最小解释器。
 *
 * 实验期只点亮 native。declarative / html 是 schema 承诺，不是可执行能力；
 * 遇到它们必须显示安全降级，绝不静默为空，也绝不运行任意 HTML。
 */
export function LayoutRenderer({
  document,
  bindings,
  handlers = {}
}: LayoutRendererProps) {
  const { issues } = validateLayoutDocument(document);

  if (issues.length > 0) {
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
        </ul>
      </section>
    );
  }

  const orderedCards = resolveLayoutCards(document);

  return (
    <div className="dim-grid-wrap">
      <div className="dim-grid" aria-label="桌面卡片布局">
        {orderedCards.map((definition) => (
          <div
            key={definition.id}
            data-span={definition.span}
            data-region={definition.region}
            data-layout-card-id={definition.id}
          >
            {renderCard(definition, bindings, handlers)}
          </div>
        ))}
      </div>
    </div>
  );
}

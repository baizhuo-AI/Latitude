import type { ReactNode } from "react";
import { CognitionCard } from "./cards/CognitionCard";
import { FeedCard } from "./cards/FeedCard";
import {
  AnchorsCardView,
  ChartCardView,
  CountCardView,
  NoteCardView,
  ProgressCardView,
  ProposalCardView,
  TextCardView
} from "./cards/DeskCards";
import type {
  CardHandlers,
  DeskCard,
  NativeCardKind,
  NativeCardLayout,
  NativeCardPayload
} from "./types";

export type { NativeCardLayout } from "./types";

type PayloadOf<K extends NativeCardKind> = Extract<NativeCardPayload, { kind: K }>;

type NativeCardRenderer<K extends NativeCardKind> = (
  payload: PayloadOf<K>,
  layout: NativeCardLayout,
  handlers: CardHandlers
) => ReactNode;

type NativeCardRegistry = {
  [K in NativeCardKind]: NativeCardRenderer<K>;
};

function materializeTyped<P extends NativeCardPayload>(
  payload: P,
  layout: NativeCardLayout
): P & NativeCardLayout {
  // 布局字段放在后面：即使边界外的 JSON 错带了同名字段，
  // 渲染也以已校验的 layout 为准。
  return { ...payload, ...layout };
}

/** 把业务内容与布局字段合成旧卡片组件可消费的扁平结构。 */
export function materializeDeskCard(
  payload: NativeCardPayload,
  layout: NativeCardLayout
): DeskCard {
  return materializeTyped(payload, layout);
}

/**
 * 原生卡注册表。satisfies 让九种 kind 的缺失、多出或 payload 错配
 * 都在编译期报错，布局渲染器不需要再认识具体组件。
 */
export const NATIVE_CARD_REGISTRY = {
  cognition: (payload, layout, handlers) => {
    const card = materializeTyped(payload, layout);
    return <CognitionCard card={card} onOpen={() => handlers.onOpen?.(card)} />;
  },
  feed: (payload, layout, handlers) => {
    const card = materializeTyped(payload, layout);
    return (
      <FeedCard
        card={card}
        onFeedback={handlers.onFeedFeedback}
        onLineage={handlers.onLineage}
      />
    );
  },
  anchors: (payload, layout, handlers) => {
    const card = materializeTyped(payload, layout);
    return <AnchorsCardView card={card} onLineage={handlers.onLineage} />;
  },
  count: (payload, layout) => (
    <CountCardView card={materializeTyped(payload, layout)} />
  ),
  note: (payload, layout) => <NoteCardView card={materializeTyped(payload, layout)} />,
  chart: (payload, layout) => <ChartCardView card={materializeTyped(payload, layout)} />,
  text: (payload, layout) => <TextCardView card={materializeTyped(payload, layout)} />,
  proposal: (payload, layout, handlers) => {
    const card = materializeTyped(payload, layout);
    return (
      <ProposalCardView
        card={card}
        onAccept={() => handlers.onAccept?.(card)}
        onReject={() => handlers.onReject?.(card)}
      />
    );
  },
  progress: (payload, layout) => (
    <ProgressCardView card={materializeTyped(payload, layout)} />
  )
} satisfies NativeCardRegistry;

/**
 * 渲染经过布局层校验的原生卡。类型系统保证正常调用闭集；
 * 运行时仍对未知 kind 抛错，防止配置漂移后静默空白。
 */
export function renderNativeCard(
  payload: NativeCardPayload,
  layout: NativeCardLayout,
  handlers: CardHandlers = {}
): ReactNode {
  const kind = (payload as { kind?: unknown }).kind;

  if (
    typeof kind !== "string" ||
    !Object.prototype.hasOwnProperty.call(NATIVE_CARD_REGISTRY, kind)
  ) {
    throw new Error(`Unregistered native card kind: ${String(kind)}`);
  }

  // 注册表声明已对每个 kind 保留 payload 的关联类型。动态查找后
  // TypeScript 不会保留这个关联，在这一个已校验边界统一收口。
  const renderer = NATIVE_CARD_REGISTRY[kind as NativeCardKind] as unknown as (
    value: NativeCardPayload,
    cardLayout: NativeCardLayout,
    cardHandlers: CardHandlers
  ) => ReactNode;

  return renderer(payload, layout, handlers);
}

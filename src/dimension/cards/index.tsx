import { renderNativeCard } from "../nativeRegistry";
import type {
  CardHandlers,
  DeskCard,
  NativeCardLayout,
  NativeCardPayload
} from "../types";

export { CardShell } from "./CardShell";
export { CognitionCard } from "./CognitionCard";
export { FeedCard } from "./FeedCard";
export * from "./DeskCards";
export type { CardHandlers } from "../types";

/** 把旧原型的扁平卡拆回新渲染器需要的 payload + layout。 */
function splitDeskCard(card: DeskCard): {
  payload: NativeCardPayload;
  layout: NativeCardLayout;
} {
  const {
    id,
    span,
    eyebrow,
    title,
    tilt,
    paper,
    offsetY,
    tape,
    clip,
    dogear,
    ...payload
  } = card;

  return {
    payload: payload as NativeCardPayload,
    layout: {
      id,
      span,
      eyebrow,
      title,
      tilt,
      paper,
      offsetY,
      tape,
      clip,
      dogear
    }
  };
}

/** 旧桌面 API 保留，内部改由穷尽的原生卡注册表分发。 */
export function DeskCardView({
  card,
  handlers = {}
}: {
  card: DeskCard;
  handlers?: CardHandlers;
}) {
  const { payload, layout } = splitDeskCard(card);
  return <>{renderNativeCard(payload, layout, handlers)}</>;
}

/**
 * 12 栅格。骨架恒定 —— 纸片内容会变,格子不变。
 *
 * 这是重构计划第 11 节「主页变化过度」那条风险的答案:每天全量重排会让
 * 用户失去空间记忆,所以列宽由卡片自己的 span 决定,桌面层不做动态布局。
 */
export function DeskGrid({
  cards,
  handlers
}: {
  cards: DeskCard[];
  handlers?: CardHandlers;
}) {
  // 列宽走 data-span + CSS,不用内联 style —— 内联特异性最高,会让降级失效。
  // 外面这层 wrap 是容器查询的锚点:网格按自己的宽度降级,不看视口
  return (
    <div className="dim-grid-wrap">
      <div className="dim-grid">
        {cards.map((card) => (
          <div key={card.id} data-span={card.span}>
            <DeskCardView card={card} handlers={handlers} />
          </div>
        ))}
      </div>
    </div>
  );
}

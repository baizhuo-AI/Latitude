import { CognitionCard } from "./CognitionCard";
import {
  AnchorsCardView,
  ChartCardView,
  CountCardView,
  NoteCardView,
  ProgressCardView,
  ProposalCardView,
  TextCardView
} from "./DeskCards";
import type { DeskCard } from "../types";

export { CardShell } from "./CardShell";
export { CognitionCard } from "./CognitionCard";
export * from "./DeskCards";

/** 卡片动作。桌面层接管这些回调,纸片本身不知道点了之后会发生什么。 */
export interface CardHandlers {
  /** 打开成手帐本内页。目前只有认知卡会触发 */
  onOpen?: (card: DeskCard) => void;
  onAccept?: (card: DeskCard) => void;
  onReject?: (card: DeskCard) => void;
}

/**
 * 按 kind 分发。
 *
 * default 分支用 never 收口:以后往 DeskCard 联合类型里加新 kind 却忘了在这里接,
 * TypeScript 会直接报错,不会静默渲染成空白。
 */
export function DeskCardView({
  card,
  handlers = {}
}: {
  card: DeskCard;
  handlers?: CardHandlers;
}) {
  switch (card.kind) {
    case "cognition":
      return <CognitionCard card={card} onOpen={() => handlers.onOpen?.(card)} />;
    case "anchors":
      return <AnchorsCardView card={card} />;
    case "count":
      return <CountCardView card={card} />;
    case "note":
      return <NoteCardView card={card} />;
    case "chart":
      return <ChartCardView card={card} />;
    case "text":
      return <TextCardView card={card} />;
    case "proposal":
      return (
        <ProposalCardView
          card={card}
          onAccept={() => handlers.onAccept?.(card)}
          onReject={() => handlers.onReject?.(card)}
        />
      );
    case "progress":
      return <ProgressCardView card={card} />;
    default: {
      const never: never = card;
      console.error("[dimension] 未接入的卡片类型:", never);
      return null;
    }
  }
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

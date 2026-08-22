import { CardShell } from "./CardShell";
import {
  limitFeedItems,
  type FeedCard as FeedCardData,
  type FeedFeedback,
  type LineageRef
} from "../types";

const FEEDBACK_ACTIONS: readonly {
  value: FeedFeedback;
  label: string;
}[] = [
  { value: "new-angle", label: "有新角度" },
  { value: "known", label: "已知道" },
  { value: "not-useful", label: "没用" }
];

/**
 * 资讯卡。日上限在投影层控制，渲染边界再用 limitFeedItems
 * 防守一次，避免异常 payload 把早报变成信息流。
 */
export function FeedCard({
  card,
  onFeedback,
  onLineage
}: {
  card: FeedCardData;
  onFeedback?: (itemId: string, feedback: FeedFeedback) => void;
  onLineage?: (lineage: LineageRef) => void;
}) {
  const items = limitFeedItems(card.items);

  return (
    <CardShell
      eyebrow={card.eyebrow}
      title={card.title}
      tilt={card.tilt}
      paper={card.paper}
      offsetY={card.offsetY}
      tape={card.tape}
      clip={card.clip}
      dogear={card.dogear}
    >
      {items.length === 0 ? (
        <p className="dim-body" style={{ marginTop: 12 }}>
          {card.emptyHint ?? "今天没有值得占用你注意力的新资讯。"}
        </p>
      ) : (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 14 }}>
          {items.map((item) => {
            const lineage = item.lineage;

            return (
              <article key={item.id}>
                <h4
                  style={{
                    margin: 0,
                    fontSize: 12.5,
                    lineHeight: 1.5,
                    fontWeight: 600,
                    color: "var(--dim-ink)"
                  }}
                >
                  {item.title}
                </h4>
                <p className="dim-body" style={{ marginTop: 5 }}>
                  <span className="dim-eyebrow" style={{ display: "inline" }}>
                    为什么给你看　
                  </span>
                  {item.why}
                </p>
                <div
                  style={{
                    marginTop: 7,
                    display: "flex",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 6
                  }}
                >
                  <span className="dim-meta">来源 · {item.source}</span>
                  {lineage && (
                    <button
                      type="button"
                      className="dim-btn dim-btn--quiet"
                      style={{ padding: "2px 4px", color: "var(--dim-olive)", fontSize: 9 }}
                      aria-label={`查看来源：${lineage.label}`}
                      onClick={() => onLineage?.(lineage)}
                    >
                      ◇ 关联
                    </button>
                  )}
                </div>
                <div style={{ marginTop: 7, display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {FEEDBACK_ACTIONS.map((action) => (
                    <button
                      key={action.value}
                      type="button"
                      className="dim-btn dim-btn--quiet"
                      style={{ padding: "2px 5px" }}
                      onClick={() => onFeedback?.(item.id, action.value)}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </CardShell>
  );
}

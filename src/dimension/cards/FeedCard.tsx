import { CardShell } from "./CardShell";
import {
  limitFeedItems,
  type FeedCard as FeedCardData,
  type FeedFeedback,
  type LineageRef
} from "../types";
import { presentFeedTitle } from "./feedTitle";

const FEEDBACK_ACTIONS: readonly {
  value: FeedFeedback;
  label: string;
}[] = [
  { value: "new-angle", label: "有新角度" },
  { value: "known", label: "已知道" },
  { value: "not-useful", label: "没用" }
];

/** 双击里的第二次 click 不能重复落一条反馈或来源活动。 */
const isFirstActivation = (detail: number) => detail <= 1;

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
            const presentedTitle = presentFeedTitle(item);

            return (
              <article key={item.id}>
                <h4
                  className="dim-feed-item-title"
                  title={item.title}
                  style={{
                    margin: 0,
                    fontSize: 12.5,
                    lineHeight: 1.5,
                    fontWeight: 600,
                    color: "var(--dim-ink)"
                  }}
                >
                  {presentedTitle.text}
                </h4>
                {presentedTitle.needsDisclosure && (
                  <details className="dim-feed-original-title" data-no-drag data-no-card-edit>
                    <summary aria-label={`展开完整原标题：${presentedTitle.text}`}>
                      原标题
                    </summary>
                    <p>{item.title}</p>
                  </details>
                )}
                {lineage?.entityType === "digest" ? (
                  <details data-no-drag data-no-card-edit>
                    <summary className="dim-body">阅读全文 · {item.why.slice(0, 60)}{item.why.length > 60 ? "…" : ""}</summary>
                    <p className="dim-body" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.why}</p>
                  </details>
                ) : <p className="dim-body dim-feed-item-summary" title={item.why} style={{ marginTop: 5 }}>
                  {item.why}
                </p>}
                <div
                  style={{
                    marginTop: 7,
                    display: "flex",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 6
                  }}
                >
                  {item.url ? (
                    <a
                      className="dim-meta dim-feed-source-link"
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                      referrerPolicy="no-referrer"
                    >
                      来源 · {item.source} ↗
                    </a>
                  ) : (
                    <span className="dim-meta">来源 · {item.source}</span>
                  )}
                  {item.publishedAt && (
                    <span className="dim-meta">发布 · {item.publishedAt}</span>
                  )}
                  {item.freshness === "stale" && (
                    <span className="dim-meta" data-freshness="stale">较早资料</span>
                  )}
                  {lineage && (
                    <button
                      type="button"
                      className="dim-btn dim-btn--quiet"
                      style={{ padding: "2px 4px", color: "var(--dim-olive)", fontSize: 9 }}
                      aria-label={`查看来源：${lineage.label}`}
                      aria-disabled={!onLineage}
                      disabled={!onLineage}
                      title={onLineage ? undefined : "这项动作已在组件设置中关闭"}
                      onClick={(event) => {
                        if (isFirstActivation(event.detail)) onLineage?.(lineage);
                      }}
                    >
                      ◇ 关联
                    </button>
                  )}
                </div>
                {lineage?.entityType !== "digest" && <div style={{ marginTop: 7, display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {FEEDBACK_ACTIONS.map((action) => (
                    <button
                      key={action.value}
                      type="button"
                      className="dim-btn dim-btn--quiet"
                      style={{ padding: "2px 5px" }}
                      aria-disabled={!onFeedback}
                      disabled={!onFeedback}
                      title={onFeedback ? undefined : "资讯反馈已在组件设置中关闭"}
                      onClick={(event) => {
                        if (isFirstActivation(event.detail)) {
                          onFeedback?.(item.id, action.value);
                        }
                      }}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>}
              </article>
            );
          })}
        </div>
      )}
    </CardShell>
  );
}

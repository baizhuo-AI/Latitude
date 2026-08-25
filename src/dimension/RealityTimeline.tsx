import type { RealityTimelineEntry } from "../projections/desktop/realityTimeline";
import type { LineageRef } from "./types";

function dateKeyOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateLabel(key: string): string {
  if (key === "unknown") return "时间未知";
  const date = new Date(`${key}T00:00:00`);
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short"
  });
}

function timeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function grouped(entries: RealityTimelineEntry[]) {
  const map = new Map<string, RealityTimelineEntry[]>();
  for (const entry of entries) {
    const key = dateKeyOf(entry.occurredAt);
    map.set(key, [...(map.get(key) ?? []), entry]);
  }
  return Array.from(map, ([dateKey, items]) => ({ dateKey, items }));
}

/**
 * 共同变化的第一阶段读投影：只陈列真实记录，不从数量和完成率推导人格或成长。
 */
export function RealityTimeline({
  entries,
  loading = false,
  unavailableSources = [],
  onLineage
}: {
  entries: RealityTimelineEntry[];
  loading?: boolean;
  unavailableSources?: string[];
  onLineage?: (lineage: LineageRef) => void;
}) {
  const groups = grouped(entries);

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "28px 24px 56px" }}>
      <p className="dim-eyebrow">TOGETHER · RECORDED CHANGES</p>
      <h1 style={{ margin: "4px 0 0", fontSize: 24, fontWeight: 650 }}>共同变化</h1>
      <p
        style={{
          maxWidth: 660,
          margin: "10px 0 26px",
          color: "var(--dim-ink-soft)",
          fontSize: 13,
          lineHeight: 1.75
        }}
      >
        这里先汇总现有对象能还原的真实发生、明确裁决和已保存记录，不是完整审计历史。认知变化与成长结论要等结果闭环和图谱接入后才会出现；完成数量不会被解释成人格。
      </p>

      {unavailableSources.length > 0 && (
        <div
          role="alert"
          className="dim-paper"
          style={{ margin: "0 0 18px", padding: "12px 14px", color: "var(--dim-ink-soft)", fontSize: 12, lineHeight: 1.65 }}
        >
          部分记录暂时不可用：{unavailableSources.join("、")}。下方只显示已经成功读取的数据，不能据此判断完整历史。
        </div>
      )}

      {loading && groups.length === 0 ? (
        <div role="status" className="dim-paper" style={{ padding: "38px 24px", textAlign: "center", color: "var(--dim-ink-soft)" }}>
          正在读取真实记录…
        </div>
      ) : groups.length === 0 ? (
        <div
          className="dim-paper"
          style={{ padding: "38px 24px", textAlign: "center", color: "var(--dim-ink-soft)" }}
        >
          {unavailableSources.length > 0
            ? "当前没有可显示的记录；同时有数据源读取失败，因此不能判断没有历史。"
            : "还没有留下可以回看的记录。没有记录时，这里就保持空白。"}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          {groups.map((group) => (
            <section key={group.dateKey} aria-labelledby={`timeline-${group.dateKey}`}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                <h2
                  id={`timeline-${group.dateKey}`}
                  style={{ margin: 0, fontSize: 12, letterSpacing: "0.08em" }}
                >
                  {dateLabel(group.dateKey)}
                </h2>
                <span style={{ height: 1, flex: 1, background: "var(--dim-line)" }} />
                <span className="dim-meta">{group.items.length} 条</span>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {group.items.map((entry) => (
                  <article
                    key={entry.id}
                    className="dim-paper"
                    style={{ padding: "13px 15px", display: "grid", gridTemplateColumns: "54px 1fr", gap: 12 }}
                  >
                    <time className="dim-meta" dateTime={entry.occurredAt} style={{ paddingTop: 2 }}>
                      {timeLabel(entry.occurredAt)}
                    </time>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                        <strong style={{ flex: 1, fontSize: 13, lineHeight: 1.55 }}>{entry.title}</strong>
                        <span className="dim-chip" style={{ pointerEvents: "none", whiteSpace: "nowrap" }}>
                          {entry.badge}
                        </span>
                      </div>
                      {entry.detail && (
                        <p style={{ margin: "6px 0 0", fontSize: 12, lineHeight: 1.65, color: "var(--dim-ink-soft)" }}>
                          {entry.detail}
                        </p>
                      )}
                      {entry.lineage && onLineage && (
                        <button
                          type="button"
                          className="dim-btn dim-btn--quiet"
                          style={{ marginTop: 9 }}
                          onClick={() => onLineage(entry.lineage!)}
                        >
                          ◇ 看来源
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

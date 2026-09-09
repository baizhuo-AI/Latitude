import type { AnchorRow } from "../../dimension/types";
import type { DesktopProjection } from "./types";
import type { DesktopContentState } from "./useDesktopContent";

/** Read committed business outputs only. Never publish while rendering or turn
 * arbitrary graph nodes into business records. The graph still powers the other surfaces. */
export function projectPublishedDesktop(projection: DesktopProjection, content?: DesktopContentState): DesktopProjection {
  if (!content) return projection; // compatibility for non-business runtime adapters
  const data = content.data;
  const todos = data?.todos ?? [];
  const todoRows: AnchorRow[] = todos.map(todo => ({
    text: todo.title, meta: [todo.scheduledDate, todo.scheduledTime].filter(Boolean).join(" · ") || "待安排",
    actionable: todo.status !== "done", done: todo.status === "done",
    lineage: { entityType: "todo", entityId: todo.id, label: "已保存的待办" },
  }));
  const rows: AnchorRow[] = [
    ...(data?.events ?? []).map(event => ({
      text: event.title, meta: event.scheduledTime ?? "今日日程", actionable: false,
      lineage: { entityType: "calendar_event" as const, entityId: event.id, label: "已保存的日程" },
    })),
    ...todoRows,
  ];
  const clueBoard = projection.clueBoard && { ...projection.clueBoard, themes: projection.clueBoard.themes.map(theme => {
    // Recompute business references from their committed records. Source IDs
    // can link one todo to several goals; titles and tags never imply ownership.
    const graphRows = theme.rows.filter(row => row.lineage?.entityType !== "todo");
    const sourceIds = new Set([theme.lineage.entityId, ...graphRows.flatMap(row => row.lineage ? [row.lineage.entityId] : [])]);
    const seen = new Set<string>();
    const related = todoRows.filter((_row, index) => {
      const todo = todos[index];
      if (seen.has(todo.id) || !todo.sourceNodeIds.some(id => sourceIds.has(id))) return false;
      seen.add(todo.id);
      return true;
    });
    // pending/done still describe graph actions and actual outcomes. Checking a
    // business todo must never count as evidence that its source action worked.
    return { ...theme, rows: [...graphRows, ...related] };
  }) };
  const hint = content.status === "starting" ? "正在读取已保存的便签…"
    : content.status === "unavailable" ? "便签记录暂时没读出来，请重新连接。" : undefined;
  return { ...projection, ...(clueBoard ? { clueBoard } : {}), bindings: { ...projection.bindings,
    "desktop.schedule": { kind: "anchors", rows, emptyHint: hint ?? "还没有保存的待办或今日日程。" },
    "desktop.feed": { kind: "feed", emptyHint: hint ?? "还没有保存的每日整理。", items: (data?.digests.slice(0, 1) ?? []).map(digest => ({
      id: `digest-${digest.date}`, title: digest.date === data?.date ? "今天的每日整理" : `${digest.date} · 每日整理`,
      why: digest.summary, source: "已保存的每日整理",
      lineage: { entityType: "digest" as const, entityId: digest.date, label: "每日整理全文" },
    })) },
  } };
}

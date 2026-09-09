import { describe, expect, it } from "vitest";
import { buildBrowserProjection } from "./browserProjection";
import { projectPublishedDesktop } from "./publishedDesktopProjection";
import type { DesktopContent } from "../../shared/desktopContent";
describe("published desktop read model", () => {
  it("reads saved content instead of graph-generated rows while preserving cognitive views", () => {
    const base = buildBrowserProjection({ context: { nodes: [{ id: "action-1", kind: "action", label: "图谱行动不是便签" }], edges: [] }, now: new Date("2026-09-07T10:00:00Z"), runtimeState: "ready" }).projection;
    const result = projectPublishedDesktop(base, { status: "ready", data: {
      date: "2026-09-07", events: [],
      todos: [{ id: "t1", title: "真正落库的待办", status: "todo", scheduledDate: null, scheduledTime: null, sourceNodeIds: ["action-1"], updatedAt: "v1" }],
      digests: [{ date: "2026-06-16", summary: "历史全文", sourceNodeIds: [] }],
    } });
    expect(result.bindings["desktop.schedule"]).toMatchObject({ rows: [{ text: "真正落库的待办", lineage: { entityType: "todo", entityId: "t1" } }] });
    expect(result.bindings["desktop.feed"]).toMatchObject({ items: [{ title: "2026-06-16 · 每日整理", why: "历史全文" }] });
    expect(result.secretary).toBe(base.secretary);
    expect(result.constellation).toBe(base.constellation);
    expect(JSON.stringify(base.bindings["desktop.schedule"])).not.toContain("真正落库");
  });
  it("does not turn a business read failure into an empty graph fallback", () => {
    const base = buildBrowserProjection({ context: { nodes: [], edges: [] }, now: new Date(), runtimeState: "ready" }).projection;
    expect(projectPublishedDesktop(base, { status: "unavailable" }).bindings["desktop.schedule"]).toMatchObject({ rows: [], emptyHint: "便签记录暂时没读出来，请重新连接。" });
  });

  it("shares committed todo rows with every explicitly related goal without changing action outcome semantics", () => {
    const base = buildBrowserProjection({ context: { nodes: [
      { id: "goal-delivery", kind: "goal", label: "客户交付", authority: "user_stated",
        payload: { horizon: "medium-term", surfaceRole: "clue.theme" } },
      { id: "goal-learning", kind: "goal", label: "学习", authority: "user_stated",
        payload: { horizon: "medium-term", surfaceRole: "clue.theme" } },
      { id: "action-delivery", kind: "action", label: "验证交付流程", status: "active", payload: { goalId: "goal-delivery" } },
    ], edges: [] }, now: new Date("2026-09-08T10:00:00Z"), runtimeState: "ready" }).projection;
    const data: DesktopContent = { date: "2026-09-08", events: [], digests: [], todos: [
      { id: "related-todo", title: "准备材料", status: "todo", scheduledDate: null, scheduledTime: null, updatedAt: "v1",
        sourceNodeIds: ["action-delivery", "goal-learning", "action-delivery"] },
      { id: "unrelated-todo", title: "客户交付", status: "todo", scheduledDate: null, scheduledTime: null, updatedAt: "v1", sourceNodeIds: [] },
      { id: "unknown-source", title: "验证交付流程", status: "todo", scheduledDate: null, scheduledTime: null, updatedAt: "v1", sourceNodeIds: ["unknown"] },
    ] };
    const projected = projectPublishedDesktop(base, { status: "ready", data });
    const schedule = projected.bindings["desktop.schedule"];
    if (schedule?.kind !== "anchors") throw new Error("Expected a business schedule");
    for (const theme of projected.clueBoard!.themes) {
      const related = theme.rows.filter(row => row.lineage?.entityType === "todo");
      expect(related).toHaveLength(1);
      expect(related[0]).toBe(schedule.rows[0]);
      expect(related[0]).toMatchObject({ actionable: true, done: false, lineage: { entityType: "todo", entityId: "related-todo" } });
      expect(theme.rows.some(row => ["unrelated-todo", "unknown-source"].includes(row.lineage?.entityId ?? ""))).toBe(false);
    }
    const completed = projectPublishedDesktop(projected, { status: "ready", data: { ...data,
      todos: data.todos.map(todo => todo.id === "related-todo" ? { ...todo, status: "done", updatedAt: "v2" } : todo) } });
    const completedSchedule = completed.bindings["desktop.schedule"];
    if (completedSchedule?.kind !== "anchors") throw new Error("Expected a business schedule");
    const delivery = completed.clueBoard!.themes.find(theme => theme.lineage.entityId === "goal-delivery")!;
    expect(delivery.rows.filter(row => row.lineage?.entityId === "related-todo")).toEqual([completedSchedule.rows[0]]);
    expect(completedSchedule.rows[0]).toMatchObject({ actionable: false, done: true });
    expect(delivery.rows.find(row => row.lineage?.entityId === "action-delivery")).toMatchObject({ actionable: true, done: false });
    expect(delivery).toMatchObject({ pending: 1, done: 0 });
    expect(base.clueBoard!.themes.flatMap(theme => theme.rows).some(row => row.lineage?.entityType === "todo")).toBe(false);
  });

  it("leaves calendar records in the common area because their model has no source references", () => {
    const base = buildBrowserProjection({ context: { nodes: [
      { id: "goal-delivery", kind: "goal", label: "客户交付", authority: "user_stated",
        payload: { horizon: "medium-term", surfaceRole: "clue.theme" } },
    ], edges: [] }, now: new Date(), runtimeState: "ready" }).projection;
    const result = projectPublishedDesktop(base, { status: "ready", data: { date: "2026-09-08", todos: [], digests: [],
      events: [{ id: "event-1", title: "客户交付", scheduledDate: "2026-09-08", scheduledTime: "10:00", startTs: null, endTs: null, status: "confirmed" }] } });
    expect(result.bindings["desktop.schedule"]).toMatchObject({ rows: [{ lineage: { entityType: "calendar_event", entityId: "event-1" } }] });
    expect(result.clueBoard!.themes[0].rows).toHaveLength(0);
  });
});

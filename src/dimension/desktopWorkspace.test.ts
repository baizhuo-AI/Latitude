import { describe, expect, it } from "vitest";
import { legacyThreadLayoutId, reconcileDesktopWorkspace, validateDesktopWorkspaceDocument,
  type DesktopWorkspaceDocument } from "./desktopWorkspace";
import type { ClueThread } from "./presets/ClueBoardPreset";

const rootId = "desktop-test";
const empty: DesktopWorkspaceDocument = { version: 1, areas: {}, activeAreaId: null };
const thread = (id = "goal-theme-delivery", title = "客户交付"): ClueThread => ({ id, title, rows: [], pending: 0, done: 0 });

describe("single desktop workspace", () => {
  it("keeps a renamed thread's stable area and existing card placement references", () => {
    const original = reconcileDesktopWorkspace(empty, [thread()], rootId);
    const stored: DesktopWorkspaceDocument = { ...original, activeAreaId: thread().id,
      cardAreaIds: { "custom-card-one": thread().id }, hiddenCardIds: ["custom-card-hidden"] };
    const result = reconcileDesktopWorkspace(stored, [thread(undefined, "交付收尾")], rootId,
      { far: { x: 50_000, y: 0, width: 400, height: 300 } });
    expect(result.areas[thread().id]).toMatchObject({ id: thread().id, title: "交付收尾",
      x: original.areas[thread().id].x, y: original.areas[thread().id].y,
      legacyLayoutIds: [legacyThreadLayoutId(rootId, "客户交付"), legacyThreadLayoutId(rootId, "交付收尾")] });
    expect(result.cardAreaIds).toEqual(stored.cardAreaIds);
    expect(result.activeAreaId).toBe(thread().id);
    expect(result.hiddenCardIds).toEqual(stored.hiddenCardIds);
    expect(stored.areas[thread().id].title).toBe("客户交付");
  });

  it("adopts a recovered legacy area once and retargets selected-area and card links", () => {
    const legacyId = legacyThreadLayoutId(rootId, thread().title);
    const legacy = reconcileDesktopWorkspace(empty, [], rootId, {}, [legacyId]);
    const priorId = `legacy:${legacyId}`;
    const stored: DesktopWorkspaceDocument = { ...legacy, activeAreaId: priorId, cardAreaIds: { "custom-card-existing": priorId } };
    const migrated = reconcileDesktopWorkspace(stored, [thread()], rootId, {}, [legacyId]);
    expect(Object.keys(migrated.areas)).toEqual([thread().id]);
    expect(migrated.areas[thread().id]).toMatchObject({ x: legacy.areas[priorId].x, y: legacy.areas[priorId].y, legacyLayoutIds: [legacyId] });
    expect(migrated.activeAreaId).toBe(thread().id);
    expect(migrated.cardAreaIds).toEqual({ "custom-card-existing": thread().id });
    expect(reconcileDesktopWorkspace(migrated, [thread()], rootId, {}, [legacyId])).toEqual(migrated);
    expect(validateDesktopWorkspaceDocument(migrated)).toEqual(migrated);
  });

  it("retains historical areas and card links after their current source disappears", () => {
    const initial = reconcileDesktopWorkspace(empty, [thread()], rootId);
    const stored: DesktopWorkspaceDocument = { ...initial, activeAreaId: thread().id,
      cardAreaIds: { "custom-card-history": thread().id } };
    expect(reconcileDesktopWorkspace(stored, [], rootId)).toEqual(stored);
  });

  it("places newly discovered areas beyond saved paper frames and earlier areas", () => {
    const result = reconcileDesktopWorkspace(empty, [thread(), thread("goal-theme-study", "学习")], rootId,
      { saved: { x: 3900, y: -20, width: 700, height: 400 } });
    expect(result.areas[thread().id].x).toBe(4600 + 420);
    expect(result.areas["goal-theme-study"].x).toBe(result.areas[thread().id].x + 1100 + 420);
  });

  it("keeps distinct stable goal IDs separate even when their titles have the same legacy hash", () => {
    const result = reconcileDesktopWorkspace(empty, [thread("goal-one"), thread("goal-two")], rootId);
    expect(Object.keys(result.areas)).toEqual(["goal-one", "goal-two"]);
    expect(result.areas["goal-one"].x).not.toBe(result.areas["goal-two"].x);
    expect(result.areas["goal-one"].legacyLayoutIds).toEqual([legacyThreadLayoutId(rootId, "客户交付")]);
    expect(result.areas["goal-two"].legacyLayoutIds).toEqual([]);
  });

  it("accepts optional card links only to an existing area and rejects inherited entries", () => {
    const base = reconcileDesktopWorkspace(empty, [thread()], rootId);
    expect(validateDesktopWorkspaceDocument(base)).toEqual(base);
    expect(validateDesktopWorkspaceDocument({ ...base, cardAreaIds: { "custom-card-one": thread().id } }).cardAreaIds)
      .toEqual({ "custom-card-one": thread().id });
    for (const cardAreaIds of [[], null, { card: "missing" }, { card: "constructor" }, { card: 12 }, { " ": thread().id },
      { ["x".repeat(1001)]: thread().id }, new Date(), Object.create({ card: thread().id }),
      Object.fromEntries(Array.from({ length: 1025 }, (_, index) => [`card-${index}`, thread().id]))]) {
      expect(() => validateDesktopWorkspaceDocument({ ...base, cardAreaIds })).toThrow(/card area mapping/);
    }
  });
});

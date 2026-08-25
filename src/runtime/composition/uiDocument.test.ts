import { describe, expect, it } from "vitest";
import { CompositionRegistry } from "./registry";
import {
  InvalidUiChangeError,
  UiDocumentEngine,
  UiRevisionConflictError,
} from "./uiDocument";
import type { UiComponentInstance, UiSurfaceDocumentV2 } from "./types";

function fixture() {
  const registry = new CompositionRegistry();
  registry.registerModule({ id: "latitude.today", title: "Today", version: "1" });
  registry.registerCommand({
    id: "todo.complete",
    moduleId: "latitude.today",
    risk: "reversible-write",
    description: "Complete one action",
  });
  registry.registerComponent({
    type: "latitude.anchors",
    moduleId: "latitude.today",
    slots: ["main", "aside"],
    events: ["complete"],
    validateProps: (props) => (Array.isArray(props.rows) ? [] : ["rows must be an array"]),
  });
  const component: UiComponentInstance = {
    id: "anchors",
    type: "latitude.anchors",
    moduleId: "latitude.today",
    slot: "main",
    order: 0,
    visible: true,
    grid: { columnSpan: 7, rowSpan: 1 },
    props: { rows: [] },
    actions: { complete: "todo.complete" },
  };
  const document: UiSurfaceDocumentV2 = {
    schemaVersion: 2,
    id: "desktop",
    revision: 0,
    title: "Desktop",
    components: [component],
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
  return { registry, component, document };
}

describe("UiDocumentEngine", () => {
  it("auto-applies a model change with a receipt and exact rollback", () => {
    const { registry, document } = fixture();
    const engine = new UiDocumentEngine(document, registry);
    const receipt = engine.apply({
      id: "model-1",
      baseRevision: 0,
      actor: "model",
      authorization: "preauthorized",
      reason: "Move today's anchors beside the focus card",
      operations: [
        { op: "move", componentId: "anchors", slot: "aside", order: 2 },
        { op: "resize", componentId: "anchors", columnSpan: 5, rowSpan: 2 },
      ],
      createdAt: "2026-08-24T01:00:00.000Z",
    });

    expect(receipt.afterRevision).toBe(1);
    expect(receipt.inverse).toEqual([
      { op: "resize", componentId: "anchors", columnSpan: 7, rowSpan: 1 },
      { op: "move", componentId: "anchors", slot: "main", order: 0 },
    ]);
    expect(engine.snapshot().document.components[0]).toMatchObject({
      slot: "aside",
      grid: { columnSpan: 5, rowSpan: 2 },
    });

    engine.rollback("model-1", "user-rollback-1", "2026-08-24T02:00:00.000Z");
    expect(engine.snapshot().document.components[0]).toMatchObject({
      slot: "main",
      grid: { columnSpan: 7, rowSpan: 1 },
    });
  });

  it("rejects stale revisions and unknown trusted commands", () => {
    const { registry, document } = fixture();
    const engine = new UiDocumentEngine(document, registry);
    expect(() =>
      engine.apply({
        id: "stale",
        baseRevision: 9,
        actor: "model",
        authorization: "automatic",
        reason: "stale",
        operations: [{ op: "setVisibility", componentId: "anchors", visible: false }],
        createdAt: "2026-08-24T01:00:00.000Z",
      }),
    ).toThrow(UiRevisionConflictError);

    expect(() =>
      engine.apply({
        id: "bad-command",
        baseRevision: 0,
        actor: "model",
        authorization: "automatic",
        reason: "bind an invented capability",
        operations: [
          {
            op: "bindAction",
            componentId: "anchors",
            event: "complete",
            commandId: "shell.exec",
          },
        ],
        createdAt: "2026-08-24T01:00:00.000Z",
      }),
    ).toThrow(InvalidUiChangeError);
  });

  it("does not allow unregistered component code", () => {
    const { registry, component, document } = fixture();
    const engine = new UiDocumentEngine(document, registry);
    expect(() =>
      engine.apply({
        id: "arbitrary-code",
        baseRevision: 0,
        actor: "model",
        authorization: "automatic",
        reason: "attempt arbitrary code",
        operations: [
          {
            op: "add",
            component: {
              ...component,
              id: "evil",
              type: "javascript.eval",
              props: { source: "alert(1)" },
            },
          },
        ],
        createdAt: "2026-08-24T01:00:00.000Z",
      }),
    ).toThrow("unknown component type");
  });
});

import { describe, expect, it } from "vitest";
import { SEED_LAYOUT_DOCUMENT } from "../layout/seedLayout";
import {
  BROWSER_COMMAND_IDS,
  BROWSER_LAYOUT_COMPONENT_IDS,
  assertBrowserProductionOperations,
  createBrowserCompositionRegistry,
  layoutV1ToUiSurfaceV2,
  migrateFiveCardBrowserSurface,
  uiSurfaceV2ToLayoutV1,
} from "./browserProduction";

describe("Browser production composition registry", () => {
  it("keeps five-card LayoutV1 art inside a 15-component trusted Browser surface", () => {
    const layout = structuredClone(SEED_LAYOUT_DOCUMENT);
    layout.id = "latitude-browser-live";
    layout.revision = 3;
    const surface = layoutV1ToUiSurfaceV2(layout, "2026-08-24T12:00:00.000Z");

    expect(surface.components).toHaveLength(15);
    for (const component of surface.components.filter((item) =>
      BROWSER_LAYOUT_COMPONENT_IDS.includes(
        item.id as (typeof BROWSER_LAYOUT_COMPONENT_IDS)[number],
      ))) {
      expect(Object.keys(component.props).sort()).toEqual(["bindingRef", "presentation"]);
      expect(component.props).not.toHaveProperty("payload");
      expect(component.props).not.toHaveProperty("statement");
    }
    expect(
      uiSurfaceV2ToLayoutV1(surface, layout).cards.map((card) => card.presentation),
    ).toEqual(layout.cards.map((card) => card.presentation));
    expect(surface.components.find((item) => item.id === "secretary-companion"))
      .toMatchObject({
        type: "latitude.secretary-companion",
        slot: "overlay",
        visible: true,
        grid: { columnSpan: 1, rowSpan: 1 },
        props: { bindingRef: "desktop.secretary" },
        actions: {
          chat: BROWSER_COMMAND_IDS.companionChat,
          review: BROWSER_COMMAND_IDS.companionReview,
          outcome: BROWSER_COMMAND_IDS.companionOutcome,
        },
      });
  });

  it("rejects a registered command when the component event did not allow it", () => {
    const layout = structuredClone(SEED_LAYOUT_DOCUMENT);
    layout.id = "latitude-browser-live";
    layout.revision = 3;
    const surface = layoutV1ToUiSurfaceV2(layout);
    const feed = surface.components.find((component) => component.id === "seed-feed")!;
    feed.actions.feedback = BROWSER_COMMAND_IDS.anchorComplete;

    expect(createBrowserCompositionRegistry().validateDocument(surface)).toContain(
      "component seed-feed cannot bind command latitude.anchor.complete to event feedback",
    );
  });

  it("rejects Domain semantic content and arbitrary presentation keys in props", () => {
    const layout = structuredClone(SEED_LAYOUT_DOCUMENT);
    layout.id = "latitude-browser-live";
    layout.revision = 3;
    const surface = layoutV1ToUiSurfaceV2(layout);
    const feed = surface.components.find((component) => component.id === "seed-feed")!;
    feed.props = {
      ...feed.props,
      statement: "模型不可以把长期记忆塞进布局",
      presentation: {
        ...(feed.props.presentation as Record<string, string>),
        html: "<script>alert(1)</script>",
      },
    };

    expect(createBrowserCompositionRegistry().validateDocument(surface).join("\n")).toMatch(
      /forbidden key statement.*forbidden key html/s,
    );
  });

  it("migrates the legacy five-card V2 at the same revision and never projects overlay into LayoutV1", () => {
    const layout = structuredClone(SEED_LAYOUT_DOCUMENT);
    layout.id = "latitude-browser-live";
    layout.revision = 7;
    const current = layoutV1ToUiSurfaceV2(layout);
    current.components = current.components.filter((item) =>
      BROWSER_LAYOUT_COMPONENT_IDS.includes(
        item.id as (typeof BROWSER_LAYOUT_COMPONENT_IDS)[number],
      ));

    const migrated = migrateFiveCardBrowserSurface(current, false);
    expect(migrated.revision).toBe(7);
    expect(migrated.components).toHaveLength(15);
    expect(migrated.components.find((item) => item.id === "secretary-companion"))
      .toMatchObject({ visible: false, slot: "overlay" });
    expect(uiSurfaceV2ToLayoutV1(migrated, layout).cards).toHaveLength(5);
    expect(uiSurfaceV2ToLayoutV1(migrated, layout).arrangement.orderedCardIds)
      .toEqual(layout.arrangement.orderedCardIds);
  });

  it("rejects forged companion history operations outside visibility/exact bindings", () => {
    expect(() => assertBrowserProductionOperations([{
      op: "move",
      componentId: "secretary-companion",
      slot: "overlay",
      order: 1,
    }])).toThrow(/only allows visibility/);
    expect(() => assertBrowserProductionOperations([{
      op: "bindAction",
      componentId: "secretary-companion",
      event: "chat",
      commandId: BROWSER_COMMAND_IDS.companionOutcome,
    }])).toThrow(/cannot bind command/);
  });

  it("migrates the trusted old six-component surface at the same revision", () => {
    const layout = structuredClone(SEED_LAYOUT_DOCUMENT);
    layout.id = "latitude-browser-live";
    layout.revision = 11;
    const oldSix = layoutV1ToUiSurfaceV2(layout);
    oldSix.components = oldSix.components.filter((component) =>
      BROWSER_LAYOUT_COMPONENT_IDS.includes(
        component.id as (typeof BROWSER_LAYOUT_COMPONENT_IDS)[number],
      ) || component.id === "secretary-companion");
    oldSix.components.find((component) => component.id === "secretary-companion")!.visible = false;

    const migrated = migrateFiveCardBrowserSurface(oldSix);
    expect(migrated.revision).toBe(11);
    expect(migrated.components).toHaveLength(15);
    expect(migrated.components.find((component) => component.id === "secretary-companion"))
      .toMatchObject({ visible: false });
    expect(migrated.components.find((component) => component.id === "command-bar"))
      .toMatchObject({ visible: true, props: { bindingRef: "desktop.commandBar" } });
  });

  it("rejects layout operations and cross-command binding on fixed system modules", () => {
    expect(() => assertBrowserProductionOperations([{
      op: "resize",
      componentId: "browser-control-strip",
      columnSpan: 12,
      rowSpan: 1,
    }])).toThrow(/only allows visibility/);
    expect(() => assertBrowserProductionOperations([{
      op: "bindAction",
      componentId: "browser-control-strip",
      event: "refresh",
      commandId: BROWSER_COMMAND_IDS.agentCancel,
    }])).toThrow(/cannot bind command/);
  });
});

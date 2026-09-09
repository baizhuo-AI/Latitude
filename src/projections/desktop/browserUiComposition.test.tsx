import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { validateLayoutDocument } from "../../runtime/layout/validate";
import {
  BROWSER_LAYOUT_COMPONENT_IDS,
  BROWSER_PRODUCT_LAYOUT_DOCUMENT as SEED_LAYOUT_DOCUMENT,
  componentProps,
  createBrowserCompositionRegistry,
  layoutV1ToUiSurfaceV2,
  readPresentation,
} from "../../runtime/composition/browserProduction";
import { UiDocumentEngine } from "../../runtime/composition/uiDocument";
import {
  dispatchAgentUiChangeSet,
  exportBrowserUiCompositionBackup,
  restoreBrowserUiCompositionBackup,
  uiChangeSetFromAgentRun,
  useBrowserUiComposition,
} from "./browserUiComposition";

describe("browser UiChangeSet", () => {
  beforeEach(() => window.localStorage.clear());

  it("只迁移 persisted 旧默认标题，并用一次 system receipt 保留其他桌面偏好", () => {
    const base = structuredClone(SEED_LAYOUT_DOCUMENT);
    base.cards.find((card) => card.id === "seed-flex")!.presentation!.title = "最近值得想一想";
    base.cards.find((card) => card.id === "seed-rhythm")!.presentation!.title = "这些行动该看结果了";

    const persistedLayout = structuredClone(base);
    persistedLayout.revision = 9;
    persistedLayout.cards.find((card) => card.id === "seed-flex")!.presentation!.title = "当前认知张力";
    const rhythm = persistedLayout.cards.find((card) => card.id === "seed-rhythm")!;
    rhythm.presentation!.title = "结果回收时间窗";
    rhythm.span = 12;
    persistedLayout.cards.find((card) => card.id === "seed-feed")!.hidden = true;
    persistedLayout.arrangement.orderedCardIds = [
      "seed-flex",
      "seed-rhythm",
      "seed-review-plan",
      "seed-feed",
      "seed-schedule",
      "seed-activity",
    ];
    window.localStorage.setItem(
      `latitude.browser-ui-composition.v2:${base.id}`,
      JSON.stringify({ document: layoutV1ToUiSurfaceV2(persistedLayout), changes: [] }),
    );

    const first = renderHook(() => useBrowserUiComposition(structuredClone(base)));
    expect(first.result.current.document.revision).toBe(10);
    expect(first.result.current.layout.arrangement.orderedCardIds).toEqual(
      persistedLayout.arrangement.orderedCardIds,
    );
    expect(first.result.current.layout.cards.find((card) => card.id === "seed-feed")?.hidden)
      .toBe(true);
    expect(first.result.current.layout.cards.find((card) => card.id === "seed-rhythm"))
      .toMatchObject({ span: 12, presentation: { title: "这些行动该看结果了" } });
    expect(first.result.current.layout.cards.find((card) => card.id === "seed-flex")?.presentation)
      .toMatchObject({ title: "最近值得想一想" });
    expect(first.result.current.history).toHaveLength(1);
    expect(first.result.current.history[0]).toMatchObject({
      actor: "system",
      authorization: "automatic",
      reason: "更新 Browser 默认卡片文案",
      beforeRevision: 9,
      afterRevision: 10,
    });
    expect(first.result.current.history[0].operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op: "setProps", componentId: "seed-flex" }),
        expect.objectContaining({ op: "setProps", componentId: "seed-rhythm" }),
      ]),
    );
    const storedAfterMigration = window.localStorage.getItem(
      `latitude.browser-ui-composition.v2:${base.id}`,
    );

    first.unmount();
    const second = renderHook(() => useBrowserUiComposition(structuredClone(base)));
    expect(second.result.current.document.revision).toBe(10);
    expect(second.result.current.history).toHaveLength(1);
    expect(window.localStorage.getItem(`latitude.browser-ui-composition.v2:${base.id}`))
      .toBe(storedAfterMigration);
  });

  it("保留用户明确选回旧标题，同时不把只改纸面样式误判成改名", () => {
    const base = structuredClone(SEED_LAYOUT_DOCUMENT);
    base.cards.find((card) => card.id === "seed-flex")!.presentation!.title = "最近值得想一想";
    base.cards.find((card) => card.id === "seed-rhythm")!.presentation!.title = "这些行动该看结果了";

    const startingLayout = structuredClone(base);
    startingLayout.cards.find((card) => card.id === "seed-flex")!.presentation!.title = "我给它起的名字";
    startingLayout.cards.find((card) => card.id === "seed-rhythm")!.presentation!.title = "结果回收时间窗";
    const engine = new UiDocumentEngine(
      layoutV1ToUiSurfaceV2(startingLayout),
      createBrowserCompositionRegistry(),
    );
    const before = engine.snapshot().document;
    const flex = before.components.find((component) => component.id === "seed-flex")!;
    const rhythm = before.components.find((component) => component.id === "seed-rhythm")!;
    engine.apply({
      id: "user-copy-and-style",
      baseRevision: before.revision,
      actor: "user",
      authorization: "direct_user",
      reason: "选回熟悉的标题并调整纸面",
      operations: [
        {
          op: "setProps",
          componentId: flex.id,
          props: componentProps(String(flex.props.bindingRef), {
            ...readPresentation(flex.props),
            title: "当前认知张力",
          }),
        },
        {
          op: "setProps",
          componentId: rhythm.id,
          props: componentProps(String(rhythm.props.bindingRef), {
            ...readPresentation(rhythm.props),
            tilt: 1.25,
          }),
        },
      ],
      createdAt: "2026-09-05T08:00:00.000Z",
    });
    const persisted = engine.snapshot();
    window.localStorage.setItem(
      `latitude.browser-ui-composition.v2:${base.id}`,
      JSON.stringify({ document: persisted.document, changes: persisted.changes }),
    );

    const { result } = renderHook(() => useBrowserUiComposition(base));
    expect(result.current.layout.cards.find((card) => card.id === "seed-flex")?.presentation)
      .toMatchObject({ title: "当前认知张力" });
    expect(result.current.layout.cards.find((card) => card.id === "seed-rhythm")?.presentation)
      .toMatchObject({ title: "这些行动该看结果了", tilt: 1.25 });
    expect(result.current.history).toHaveLength(2);
    expect(result.current.history[1]).toMatchObject({
      actor: "system",
      beforeRevision: persisted.document.revision,
      afterRevision: persisted.document.revision + 1,
      operations: [expect.objectContaining({ op: "setProps", componentId: "seed-rhythm" })],
    });
  });

  it("保存显隐、顺序、宽度、标题，并以新的 ChangeSet 精确回滚", () => {
    const { result } = renderHook(() =>
      useBrowserUiComposition(structuredClone(SEED_LAYOUT_DOCUMENT)),
    );
    const originalOrder = [...result.current.layout.arrangement.orderedCardIds];

    act(() => {
      result.current.applyChangeSet({
        actor: "user",
        reason: "把行动放在第一张纸",
        orderedCardIds: [
          "seed-schedule",
          "seed-activity",
          "seed-feed",
          "seed-review-plan",
          "seed-rhythm",
          "seed-flex",
        ],
        cards: {
          "seed-feed": { hidden: true },
          "seed-schedule": { span: 12, title: "本周唯一行动" },
        },
      });
    });

    expect(result.current.layout.composition).toMatchObject({ mode: "user-customized" });
    expect(result.current.layout.arrangement.orderedCardIds[0]).toBe("seed-schedule");
    expect(result.current.layout.cards.find((card) => card.id === "seed-feed")?.hidden).toBe(true);
    expect(result.current.layout.cards.find((card) => card.id === "seed-schedule")).toMatchObject({
      span: 12,
      presentation: { title: "本周唯一行动" },
    });
    expect(validateLayoutDocument(result.current.layout).valid).toBe(true);

    const appliedId = result.current.history[0].id;
    act(() => {
      result.current.rollbackChangeSet(appliedId);
    });
    expect(result.current.layout.arrangement.orderedCardIds).toEqual(originalOrder);
    expect(result.current.layout.cards.find((card) => card.id === "seed-feed")?.hidden).not.toBe(true);
    expect(result.current.history[result.current.history.length - 1]).toMatchObject({
      rollbackOf: appliedId,
    });
  });

  it("Agent 使用同一白名单入口，非法卡片不会落地", () => {
    const { result } = renderHook(() =>
      useBrowserUiComposition(structuredClone(SEED_LAYOUT_DOCUMENT)),
    );

    act(() => {
      dispatchAgentUiChangeSet({
        actor: "agent",
        baseRevision: result.current.document.revision,
        surfaceId: result.current.document.id,
        reason: "隐藏当前无关资讯",
        cards: { "seed-feed": { hidden: true } },
      });
    });
    expect(result.current.layout.cards.find((card) => card.id === "seed-feed")?.hidden).toBe(true);
    expect(result.current.history[0]).toMatchObject({ actor: "model" });

    act(() => {
      dispatchAgentUiChangeSet({
        actor: "agent",
        baseRevision: result.current.document.revision,
        surfaceId: result.current.document.id,
        reason: "尝试注入未知组件",
        cards: { "arbitrary-html": { title: "<script>" } },
      });
    });
    expect(result.current.history).toHaveLength(1);
  });

  it("Agent UiChangeSet 以 layout revision 做 CAS，过期建议不会覆盖较新的桌面", () => {
    const { result } = renderHook(() =>
      useBrowserUiComposition(structuredClone(SEED_LAYOUT_DOCUMENT)),
    );
    const baseRevision = result.current.layout.revision;

    act(() => {
      dispatchAgentUiChangeSet({
        actor: "agent",
        baseRevision,
        surfaceId: result.current.document.id,
        reason: "先调整资讯标题",
        cards: { "seed-feed": { title: "证据雷达" } },
      });
    });
    expect(result.current.history).toHaveLength(1);

    act(() => {
      dispatchAgentUiChangeSet({
        actor: "agent",
        baseRevision,
        surfaceId: result.current.document.id,
        reason: "用旧版本覆盖",
        cards: { "seed-feed": { title: "过期标题" } },
      });
    });
    expect(result.current.history).toHaveLength(1);
    expect(result.current.layout.cards.find((card) => card.id === "seed-feed")?.presentation)
      .toMatchObject({ title: "证据雷达" });
  });

  it("用户与 Agent 都落为 V2 operation，非法 event-command 绑定不会落地", () => {
    const { result } = renderHook(() =>
      useBrowserUiComposition(structuredClone(SEED_LAYOUT_DOCUMENT)),
    );

    act(() => {
      result.current.applyChangeSet({
        actor: "user",
        reason: "暂时关闭资讯反馈并调整纸面",
        operations: [
          {
            op: "set_props",
            componentId: "seed-feed",
            presentation: { title: "只读证据雷达", tilt: -0.4 },
          },
          {
            op: "bind_action",
            componentId: "seed-feed",
            event: "feedback",
            commandId: null,
          },
        ],
      });
    });

    expect(result.current.document.components.find((item) => item.id === "seed-feed"))
      .toMatchObject({
        props: { presentation: { title: "只读证据雷达", tilt: -0.4 } },
        actions: { lineage: "latitude.lineage.open" },
      });
    expect(result.current.history[0].operations.map((operation) => operation.op)).toEqual([
      "setProps",
      "bindAction",
    ]);

    expect(() =>
      result.current.applyChangeSet({
        actor: "user",
        reason: "把行动写命令绑到资讯反馈",
        operations: [
          {
            op: "bind_action",
            componentId: "seed-feed",
            event: "feedback",
            commandId: "latitude.anchor.complete",
          },
        ],
      }),
    ).toThrow(/cannot bind command/);
    expect(result.current.history).toHaveLength(1);
  });

  it("恢复旧 V1 profile 后迁移到 V2、保留纸面状态并以新格式导出", () => {
    const legacy = structuredClone(SEED_LAYOUT_DOCUMENT);
    legacy.cards = legacy.cards.map((card) =>
      card.id === "seed-feed" ? { ...card, hidden: true } : card,
    );
    legacy.revision += 1;
    restoreBrowserUiCompositionBackup({
      format: "latitude.browser-ui-composition@0.1",
      exportedAt: "2026-08-24T12:00:00.000Z",
      documents: {
        [SEED_LAYOUT_DOCUMENT.id]: { current: legacy, history: [] },
      },
    });

    const { result } = renderHook(() =>
      useBrowserUiComposition(structuredClone(SEED_LAYOUT_DOCUMENT)),
    );
    expect(result.current.layout.cards.find((card) => card.id === "seed-feed")?.hidden).toBe(true);
    expect(result.current.history[0]).toMatchObject({ actor: "system" });
    expect(window.localStorage.getItem(
      `latitude.browser-ui-composition.v2:${SEED_LAYOUT_DOCUMENT.id}`,
    )).not.toBeNull();
    expect(exportBrowserUiCompositionBackup().format).toBe(
      "latitude.browser-ui-composition@0.2",
    );
  });

  it("解析 Host V2 原始 operations、surface CAS 与 Domain node 来源链", () => {
    expect(uiChangeSetFromAgentRun({
      result: {
        uiChangeSet: {
          schemaVersion: 2,
          surfaceId: "latitude-browser-live",
          baseRevision: 8,
          reason: "只保留今天要看的组件",
          domainNodeId: "resource-ui-change-8",
          operations: [
            { op: "set_visibility", componentId: "seed-feed", visible: false },
            {
              op: "bind_action",
              componentId: "seed-schedule",
              event: "complete",
              commandId: null,
            },
          ],
        },
      },
    })).toEqual({
      actor: "agent",
      surfaceId: "latitude-browser-live",
      baseRevision: 8,
      reason: "只保留今天要看的组件",
      sourceRunId: "resource-ui-change-8",
      operations: [
        { op: "set_visibility", componentId: "seed-feed", visible: false },
        {
          op: "bind_action",
          componentId: "seed-schedule",
          event: "complete",
          commandId: null,
        },
      ],
    });
  });

  it("用户与 Agent 通过同一 CAS 链调整 companion visible/action，过期 Agent 不覆盖", () => {
    const base = structuredClone(SEED_LAYOUT_DOCUMENT);
    base.id = "latitude-browser-live";
    base.revision = 3;
    const { result } = renderHook(() => useBrowserUiComposition(base));

    act(() => {
      result.current.applyChangeSet({
        actor: "user",
        reason: "隐藏桌宠并关闭结果入口",
        operations: [
          { op: "set_visibility", componentId: "secretary-companion", visible: false },
          {
            op: "bind_action",
            componentId: "secretary-companion",
            event: "outcome",
            commandId: null,
          },
        ],
      });
    });
    expect(result.current.document.components.find((item) => item.id === "secretary-companion"))
      .toMatchObject({ visible: false, actions: {
        chat: "latitude.companion.chat",
        review: "latitude.companion.review",
      } });

    const currentRevision = result.current.document.revision;
    act(() => {
      dispatchAgentUiChangeSet({
        actor: "agent",
        surfaceId: "latitude-browser-live",
        baseRevision: currentRevision,
        reason: "唤回秘书但保持结果入口关闭",
        sourceRunId: "domain-ui-companion-1",
        operations: [
          { op: "set_visibility", componentId: "secretary-companion", visible: true },
        ],
      });
    });
    expect(result.current.document.components.find((item) => item.id === "secretary-companion"))
      .toMatchObject({ visible: true });
    expect(result.current.history[result.current.history.length - 1]).toMatchObject({
      actor: "model",
      sourceRunId: "domain-ui-companion-1",
    });

    act(() => {
      dispatchAgentUiChangeSet({
        actor: "agent",
        surfaceId: "latitude-browser-live",
        baseRevision: currentRevision,
        reason: "过期隐藏",
        operations: [
          { op: "set_visibility", componentId: "secretary-companion", visible: false },
        ],
      });
    });
    expect(result.current.document.components.find((item) => item.id === "secretary-companion"))
      .toMatchObject({ visible: true });
    expect(result.current.history).toHaveLength(2);
  });

  it("五卡 V2 按 legacy hidden 迁移 companion，但保留本地 x/y 位置", () => {
    const base = structuredClone(SEED_LAYOUT_DOCUMENT);
    base.id = "latitude-browser-live";
    base.revision = 3;
    const legacyFive = layoutV1ToUiSurfaceV2(base);
    legacyFive.components = legacyFive.components.filter((item) =>
      BROWSER_LAYOUT_COMPONENT_IDS.includes(
        item.id as (typeof BROWSER_LAYOUT_COMPONENT_IDS)[number],
      ) && item.id !== "seed-activity");
    window.localStorage.setItem(
      "latitude.secretary-companion.v1",
      JSON.stringify({ x: 123, y: 234, hidden: true }),
    );
    window.localStorage.setItem(
      "latitude.browser-ui-composition.v2:latitude-browser-live",
      JSON.stringify({ document: legacyFive, changes: [] }),
    );

    const { result } = renderHook(() => useBrowserUiComposition(base));
    expect(result.current.document.revision).toBe(3);
    expect(result.current.document.components).toHaveLength(16);
    expect(result.current.document.components.find((item) => item.id === "secretary-companion"))
      .toMatchObject({ visible: false });
    expect(JSON.parse(window.localStorage.getItem("latitude.secretary-companion.v1")!))
      .toEqual({ x: 123, y: 234, hidden: true });
    expect(JSON.parse(window.localStorage.getItem(
      "latitude.browser-ui-composition.v2:latitude-browser-live",
    )!).document.components).toHaveLength(16);
  });

  it("用户与 Agent 通过同一 CAS 调整系统模块，非法 move/command 不落地", () => {
    const base = structuredClone(SEED_LAYOUT_DOCUMENT);
    base.id = "latitude-browser-live";
    base.revision = 3;
    const { result } = renderHook(() => useBrowserUiComposition(base));

    act(() => {
      result.current.applyChangeSet({
        actor: "user",
        reason: "隐藏控制条并关闭候选搁置",
        operations: [
          { op: "set_visibility", componentId: "browser-control-strip", visible: false },
          {
            op: "bind_action",
            componentId: "candidate-intervention-strip",
            event: "park",
            commandId: null,
          },
        ],
      });
    });
    expect(result.current.document.components.find(
      (component) => component.id === "browser-control-strip",
    )).toMatchObject({ visible: false });
    expect(result.current.document.components.find(
      (component) => component.id === "candidate-intervention-strip",
    )?.actions).not.toHaveProperty("park");

    const currentRevision = result.current.document.revision;
    act(() => {
      dispatchAgentUiChangeSet({
        actor: "agent",
        surfaceId: "latitude-browser-live",
        baseRevision: currentRevision,
        sourceRunId: "resource-system-ui-1",
        reason: "恢复控制条并关闭发送",
        operations: [
          { op: "set_visibility", componentId: "browser-control-strip", visible: true },
          {
            op: "bind_action",
            componentId: "command-bar",
            event: "send",
            commandId: null,
          },
        ],
      });
    });
    expect(result.current.document.components.find(
      (component) => component.id === "browser-control-strip",
    )).toMatchObject({ visible: true });
    expect(result.current.history[result.current.history.length - 1]).toMatchObject({
      actor: "model",
      sourceRunId: "resource-system-ui-1",
    });

    act(() => {
      dispatchAgentUiChangeSet({
        actor: "agent",
        surfaceId: "latitude-browser-live",
        baseRevision: currentRevision,
        reason: "过期系统覆盖",
        operations: [
          { op: "set_visibility", componentId: "browser-control-strip", visible: false },
        ],
      });
    });
    expect(result.current.document.components.find(
      (component) => component.id === "browser-control-strip",
    )).toMatchObject({ visible: true });
    expect(result.current.history).toHaveLength(2);

    expect(() => result.current.applyChangeSet({
      actor: "user",
      reason: "非法移动固定模块",
      operations: [
        { op: "move", componentId: "browser-control-strip", order: 0 },
      ],
    })).toThrow(/only allows visibility/);
    expect(() => result.current.applyChangeSet({
      actor: "user",
      reason: "非法跨模块命令",
      operations: [
        {
          op: "bind_action",
          componentId: "browser-control-strip",
          event: "refresh",
          commandId: "latitude.agent.cancel",
        },
      ],
    })).toThrow(/cannot bind command/);
  });

  it("拒绝含固定模块非法历史操作的损坏 profile", () => {
    const base = structuredClone(SEED_LAYOUT_DOCUMENT);
    base.id = "latitude-browser-live";
    base.revision = 4;
    const document = layoutV1ToUiSurfaceV2(base);
    expect(() => restoreBrowserUiCompositionBackup({
      format: "latitude.browser-ui-composition@0.2",
      exportedAt: "2026-08-24T12:00:00.000Z",
      documents: {
        "latitude-browser-live": {
          document,
          changes: [{
            id: "forged-system-history",
            actor: "model",
            authorization: "preauthorized",
            reason: "伪造固定模块移动",
            beforeRevision: 3,
            afterRevision: 4,
            operations: [{
              op: "move",
              componentId: "browser-control-strip",
              slot: "system-control",
              order: 0,
            }],
            inverse: [{
              op: "move",
              componentId: "browser-control-strip",
              slot: "system-control",
              order: 0,
            }],
            appliedAt: "2026-08-24T12:00:00.000Z",
          }],
        },
      },
    })).toThrow(/only allows visibility/);
  });
});

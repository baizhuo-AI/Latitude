import { describe, expect, it } from "vitest";
import type { LayoutDocumentV1 } from "./types";
import {
  LayoutDocumentValidationError,
  assertValidLayoutDocument,
  resolveLayoutCards,
  validateLayoutDocument
} from "./validate";

type SeedCardKind = "feed" | "anchors" | "progress" | "note" | "proposal";
type SeedPresentation = { paper: "plain" | "sticky" };

function createValidDocument(): LayoutDocumentV1<SeedCardKind, SeedPresentation> {
  return {
    schemaVersion: 1,
    id: "seed-desktop",
    revision: 1,
    background: {
      theme: "paper",
      texture: "linen",
      density: "comfortable",
      tokenOverrides: {
        "--dim-canvas": "#efece0"
      }
    },
    cards: [
      {
        id: "schedule-today",
        region: "schedule",
        renderer: "native",
        kind: "anchors",
        span: 7,
        binding: "desktop.schedule",
        presentation: { paper: "plain" }
      },
      {
        id: "rhythm-today",
        region: "rhythm",
        renderer: "native",
        kind: "note",
        span: 4,
        binding: "desktop.rhythm",
        presentation: { paper: "sticky" }
      },
      {
        id: "feed-today",
        region: "feed",
        renderer: "native",
        kind: "feed",
        span: 5,
        binding: "desktop.feed",
        presentation: { paper: "plain" }
      },
      {
        id: "flex-today",
        region: "flex",
        renderer: "native",
        kind: "proposal",
        span: 4,
        binding: "desktop.flex",
        presentation: { paper: "sticky" }
      },
      {
        id: "review-plan-today",
        region: "review-plan",
        renderer: "native",
        kind: "progress",
        span: 4,
        binding: "desktop.reviewPlan",
        presentation: { paper: "plain" }
      }
    ],
    arrangement: {
      strategy: "frequency-weighted",
      orderedCardIds: [
        "feed-today",
        "schedule-today",
        "review-plan-today",
        "rhythm-today",
        "flex-today"
      ],
      params: { maxChangesPerRefresh: 1 },
      rationale: ["资讯先读，日程占最大面积", "低频内容放在下排"]
    }
  };
}

function codes(document: unknown): string[] {
  return validateLayoutDocument(document).issues.map((entry) => entry.code);
}

describe("LayoutDocumentV1", () => {
  it("冻结背景、卡和排布三层，并接受合法种子布局", () => {
    const document = createValidDocument();

    expect(Object.keys(document)).toEqual([
      "schemaVersion",
      "id",
      "revision",
      "background",
      "cards",
      "arrangement"
    ]);
    expect(document.background).toMatchObject({
      theme: "paper",
      texture: "linen",
      density: "comfortable"
    });
    expect(document.cards).toHaveLength(5);
    expect(document.arrangement.strategy).toBe("frequency-weighted");
    expect(validateLayoutDocument(document)).toEqual({ valid: true, issues: [] });
    expect(() => assertValidLayoutDocument(document)).not.toThrow();
  });

  it("严格按 orderedCardIds 稳定解析，不使用 cards 数组顺序", () => {
    const document = createValidDocument();

    const first = resolveLayoutCards(document);
    const second = resolveLayoutCards(document);

    expect(first.map((card) => card.id)).toEqual(
      document.arrangement.orderedCardIds
    );
    expect(second.map((card) => card.id)).toEqual(
      document.arrangement.orderedCardIds
    );
    expect(first.map((card) => card.region)).toEqual([
      "feed",
      "schedule",
      "review-plan",
      "rhythm",
      "flex"
    ]);
    expect(first.map((card) => card.span)).toEqual([5, 7, 4, 4, 4]);
  });

  it("只对带 ChangeSet 收据的组合桌面放开重排、改宽和显隐", () => {
    const document = createValidDocument();
    document.composition = {
      mode: "user-customized",
      changeSetId: "ui-change-1"
    };
    [document.arrangement.orderedCardIds[0], document.arrangement.orderedCardIds[1]] = [
      document.arrangement.orderedCardIds[1],
      document.arrangement.orderedCardIds[0]
    ];
    document.cards[0] = { ...document.cards[0], span: 12, hidden: true };

    expect(validateLayoutDocument(document)).toEqual({ valid: true, issues: [] });

    const forged = { ...document, composition: { mode: "user-customized" } };
    expect(codes(forged)).toContain("invalid_composition");
    expect(codes(forged)).toContain("invalid_seed_region_order");
  });

  it("只替换 binding 不改变任何布局 slot", () => {
    const before = createValidDocument();
    const after: LayoutDocumentV1<SeedCardKind, SeedPresentation> = {
      ...before,
      cards: before.cards.map((card) => ({
        ...card,
        binding: `next.${card.region}`
      }))
    };

    const slot = (document: LayoutDocumentV1<SeedCardKind, SeedPresentation>) =>
      resolveLayoutCards(document).map(({ id, region, renderer, kind, span }) => ({
        id,
        region,
        renderer,
        kind,
        span
      }));

    expect(slot(after)).toEqual(slot(before));
    expect(resolveLayoutCards(after).map((card) => card.binding)).not.toEqual(
      resolveLayoutCards(before).map((card) => card.binding)
    );
  });

  it("拒绝重复 card id", () => {
    const document = createValidDocument();
    document.cards[1] = { ...document.cards[1], id: document.cards[0].id };

    expect(codes(document)).toContain("duplicate_card_id");
  });

  it("拒绝 orderedCardIds 里的重复 id", () => {
    const document = createValidDocument();
    document.arrangement.orderedCardIds[1] = document.arrangement.orderedCardIds[0];

    expect(codes(document)).toContain("duplicate_arrangement_id");
  });

  it("同时报告悬空 id 与未进入排布的 card", () => {
    const document = createValidDocument();
    document.arrangement.orderedCardIds[0] = "missing-card";

    const result = validateLayoutDocument(document);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "dangling_arrangement_id",
          cardId: "missing-card"
        }),
        expect.objectContaining({
          code: "unarranged_card",
          cardId: "feed-today"
        })
      ])
    );
  });

  it("拒绝空 binding", () => {
    const document = createValidDocument();
    document.cards[0] = { ...document.cards[0], binding: "   " };

    expect(codes(document)).toContain("empty_binding");
  });

  it("拒绝非法 span", () => {
    const document = createValidDocument() as unknown as {
      cards: Array<Record<string, unknown>>;
    };
    document.cards[0].span = 6;

    expect(codes(document)).toContain("invalid_span");
  });

  it("拒绝缺区、错误 seed 区域顺序和错误 span 顺序", () => {
    const missingRegion = createValidDocument();
    missingRegion.arrangement.orderedCardIds.pop();

    const wrongRegionOrder = createValidDocument();
    [wrongRegionOrder.arrangement.orderedCardIds[0], wrongRegionOrder.arrangement.orderedCardIds[1]] = [
      wrongRegionOrder.arrangement.orderedCardIds[1],
      wrongRegionOrder.arrangement.orderedCardIds[0]
    ];

    const wrongSpans = createValidDocument();
    const feed = wrongSpans.cards.find((card) => card.region === "feed")!;
    const schedule = wrongSpans.cards.find((card) => card.region === "schedule")!;
    feed.span = 7;
    schedule.span = 5;

    expect(codes(missingRegion)).toEqual(
      expect.arrayContaining([
        "invalid_seed_card_count",
        "invalid_seed_region_order",
        "invalid_seed_span_order"
      ])
    );
    expect(codes(wrongRegionOrder)).toContain("invalid_seed_region_order");
    expect(codes(wrongSpans)).toContain("invalid_seed_span_order");
  });

  it.each(["x", "y", "row", "column"])(
    "拒绝任意层级出现坐标字段 %s",
    (coordinate) => {
      const document = createValidDocument() as unknown as Record<string, unknown>;
      const cards = document.cards as Array<Record<string, unknown>>;
      cards[0].presentation = {
        paper: "plain",
        [coordinate]: 1
      };

      expect(validateLayoutDocument(document).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "forbidden_coordinate",
            cardId: "schedule-today"
          })
        ])
      );
    }
  );

  it("assert 与 resolve 对非法文档抛出携带 issues 的结构化错误", () => {
    const document = createValidDocument();
    document.cards[0] = { ...document.cards[0], binding: "" };

    expect(() => assertValidLayoutDocument(document)).toThrow(
      LayoutDocumentValidationError
    );

    try {
      resolveLayoutCards(document);
      throw new Error("resolveLayoutCards 应该拒绝非法文档");
    } catch (error) {
      expect(error).toBeInstanceOf(LayoutDocumentValidationError);
      expect((error as LayoutDocumentValidationError).issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "empty_binding" })])
      );
    }
  });
});

import type {
  LayoutCardDefinition,
  LayoutDocumentV1,
  LayoutRegion,
  LayoutRendererKind,
  LayoutSpan
} from "./types";

export type LayoutValidationIssueCode =
  | "invalid_document"
  | "invalid_schema_version"
  | "invalid_document_id"
  | "invalid_revision"
  | "invalid_background"
  | "invalid_theme"
  | "invalid_texture"
  | "invalid_density"
  | "invalid_token_overrides"
  | "invalid_cards"
  | "invalid_card"
  | "invalid_card_id"
  | "duplicate_card_id"
  | "invalid_region"
  | "invalid_renderer"
  | "invalid_kind"
  | "invalid_span"
  | "invalid_hidden"
  | "invalid_composition"
  | "empty_binding"
  | "invalid_arrangement"
  | "invalid_strategy"
  | "invalid_ordered_card_ids"
  | "duplicate_arrangement_id"
  | "dangling_arrangement_id"
  | "unarranged_card"
  | "invalid_arrangement_params"
  | "invalid_rationale"
  | "invalid_seed_card_count"
  | "invalid_seed_region_order"
  | "invalid_seed_span_order"
  | "forbidden_coordinate";

export interface LayoutValidationIssue {
  code: LayoutValidationIssueCode;
  message: string;
  cardId?: string;
}

export interface LayoutValidationResult {
  valid: boolean;
  issues: LayoutValidationIssue[];
}

const RENDERERS = new Set<LayoutRendererKind>([
  "native",
  "declarative",
  "html"
]);
const REGIONS = new Set<LayoutRegion>([
  "feed",
  "schedule",
  "review-plan",
  "rhythm",
  "flex"
]);
const SPANS = new Set<LayoutSpan>([4, 5, 7, 12]);
const SEED_REGION_ORDER: readonly LayoutRegion[] = [
  "feed",
  "schedule",
  "review-plan",
  "rhythm",
  "flex"
];
const SEED_SPAN_ORDER: readonly LayoutSpan[] = [5, 7, 4, 4, 4];
const FORBIDDEN_COORDINATE_KEYS = new Set(["x", "y", "row", "column"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function issue(
  issues: LayoutValidationIssue[],
  code: LayoutValidationIssueCode,
  message: string,
  cardId?: string
): void {
  issues.push(cardId ? { code, message, cardId } : { code, message });
}

/**
 * 坐标属于渲染器输出，不属于布局文档。递归检查也覆盖 presentation，
 * 避免用自由配置绕过「排布存规则、不存坐标」的契约。
 */
function validateNoCoordinates(
  value: unknown,
  issues: LayoutValidationIssue[],
  cardId?: string,
  seen = new WeakSet<object>()
): void {
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      validateNoCoordinates(entry, issues, cardId, seen);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  const nestedCardId =
    cardId ??
    (isNonEmptyString(record.id) &&
    "region" in record &&
    "renderer" in record &&
    "binding" in record
      ? record.id
      : undefined);

  for (const [key, entry] of Object.entries(record)) {
    if (FORBIDDEN_COORDINATE_KEYS.has(key)) {
      issue(
        issues,
        "forbidden_coordinate",
        `布局文档不能包含坐标字段「${key}」`,
        nestedCardId
      );
    }
    validateNoCoordinates(entry, issues, nestedCardId, seen);
  }
}

function validateBackground(
  background: unknown,
  issues: LayoutValidationIssue[]
): void {
  if (!isRecord(background)) {
    issue(issues, "invalid_background", "background 必须是对象");
    return;
  }

  if (background.theme !== "paper") {
    issue(issues, "invalid_theme", "background.theme 必须是 paper");
  }
  if (!new Set(["linen", "plain", "grid"]).has(background.texture as string)) {
    issue(
      issues,
      "invalid_texture",
      "background.texture 必须是 linen、plain 或 grid"
    );
  }
  if (!new Set(["comfortable", "compact"]).has(background.density as string)) {
    issue(
      issues,
      "invalid_density",
      "background.density 必须是 comfortable 或 compact"
    );
  }

  if (background.tokenOverrides !== undefined) {
    const overrides = background.tokenOverrides;
    if (
      !isRecord(overrides) ||
      Object.values(overrides).some((value) => typeof value !== "string")
    ) {
      issue(
        issues,
        "invalid_token_overrides",
        "background.tokenOverrides 必须是字符串键值表"
      );
    }
  }
}

function validateCards(
  cards: unknown,
  issues: LayoutValidationIssue[]
): Map<string, LayoutCardDefinition> {
  const cardsById = new Map<string, LayoutCardDefinition>();
  if (!Array.isArray(cards)) {
    issue(issues, "invalid_cards", "cards 必须是数组");
    return cardsById;
  }

  for (const candidate of cards) {
    if (!isRecord(candidate)) {
      issue(issues, "invalid_card", "每个 card 必须是对象");
      continue;
    }

    const cardId = isNonEmptyString(candidate.id) ? candidate.id : undefined;

    if (!cardId) {
      issue(issues, "invalid_card_id", "card.id 不能为空");
    } else if (cardsById.has(cardId)) {
      issue(
        issues,
        "duplicate_card_id",
        `card.id「${cardId}」重复`,
        cardId
      );
    }

    if (!REGIONS.has(candidate.region as LayoutRegion)) {
      issue(
        issues,
        "invalid_region",
        "card.region 必须属于五个稳定区",
        cardId
      );
    }
    if (!RENDERERS.has(candidate.renderer as LayoutRendererKind)) {
      issue(
        issues,
        "invalid_renderer",
        "card.renderer 必须是 native、declarative 或 html",
        cardId
      );
    }
    if (!isNonEmptyString(candidate.kind)) {
      issue(issues, "invalid_kind", "card.kind 不能为空", cardId);
    }
    if (!SPANS.has(candidate.span as LayoutSpan)) {
      issue(
        issues,
        "invalid_span",
        "card.span 必须是 4、5、7 或 12",
        cardId
      );
    }
    if (candidate.hidden !== undefined && typeof candidate.hidden !== "boolean") {
      issue(
        issues,
        "invalid_hidden",
        "card.hidden 必须是布尔值",
        cardId
      );
    }
    if (!isNonEmptyString(candidate.binding)) {
      issue(issues, "empty_binding", "card.binding 不能为空", cardId);
    }

    if (cardId && !cardsById.has(cardId)) {
      cardsById.set(cardId, candidate as unknown as LayoutCardDefinition);
    }
  }

  return cardsById;
}

function validateArrangement(
  arrangement: unknown,
  cardsById: Map<string, LayoutCardDefinition>,
  issues: LayoutValidationIssue[],
  strictSeedGeometry: boolean
): void {
  if (!isRecord(arrangement)) {
    issue(issues, "invalid_arrangement", "arrangement 必须是对象");
    return;
  }

  if (arrangement.strategy !== "frequency-weighted") {
    issue(
      issues,
      "invalid_strategy",
      "arrangement.strategy 必须是 frequency-weighted"
    );
  }

  if (
    !isRecord(arrangement.params) ||
    arrangement.params.maxChangesPerRefresh !== 1
  ) {
    issue(
      issues,
      "invalid_arrangement_params",
      "arrangement.params.maxChangesPerRefresh 必须严格为 1"
    );
  }

  if (
    !Array.isArray(arrangement.rationale) ||
    arrangement.rationale.some((entry) => !isNonEmptyString(entry))
  ) {
    issue(
      issues,
      "invalid_rationale",
      "arrangement.rationale 必须是非空字符串数组"
    );
  }

  if (!Array.isArray(arrangement.orderedCardIds)) {
    issue(
      issues,
      "invalid_ordered_card_ids",
      "arrangement.orderedCardIds 必须是数组"
    );
    return;
  }

  const orderedCardIds = arrangement.orderedCardIds;
  const seenIds = new Set<string>();
  for (const id of orderedCardIds) {
    if (!isNonEmptyString(id)) {
      issue(
        issues,
        "invalid_ordered_card_ids",
        "arrangement.orderedCardIds 只能包含非空字符串"
      );
      continue;
    }
    if (seenIds.has(id)) {
      issue(
        issues,
        "duplicate_arrangement_id",
        `排布 id「${id}」重复`,
        id
      );
    }
    seenIds.add(id);
    if (!cardsById.has(id)) {
      issue(
        issues,
        "dangling_arrangement_id",
        `排布引用了不存在的 card「${id}」`,
        id
      );
    }
  }

  for (const cardId of cardsById.keys()) {
    if (!seenIds.has(cardId)) {
      issue(
        issues,
        "unarranged_card",
        `card「${cardId}」没有进入排布`,
        cardId
      );
    }
  }

  if (orderedCardIds.length !== SEED_REGION_ORDER.length) {
    issue(
      issues,
      "invalid_seed_card_count",
      "frequency-weighted 种子布局必须恰好包含五个卡位"
    );
  }

  const resolvedCards = orderedCardIds
    .map((id) => (typeof id === "string" ? cardsById.get(id) : undefined))
    .filter((card): card is LayoutCardDefinition => card !== undefined);

  // 基准 seed 的几何是回归锚点；派生桌面允许在相同五区契约内重新排布。
  if (strictSeedGeometry) {
    const actualRegions = resolvedCards.map((card) => card.region);
    if (
      actualRegions.length !== SEED_REGION_ORDER.length ||
      actualRegions.some((region, index) => region !== SEED_REGION_ORDER[index])
    ) {
      issue(
        issues,
        "invalid_seed_region_order",
        "种子布局区域顺序必须是 feed、schedule、review-plan、rhythm、flex"
      );
    }

    const actualSpans = resolvedCards.map((card) => card.span);
    if (
      actualSpans.length !== SEED_SPAN_ORDER.length ||
      actualSpans.some((span, index) => span !== SEED_SPAN_ORDER[index])
    ) {
      issue(
        issues,
        "invalid_seed_span_order",
        "种子布局 span 顺序必须是 5、7、4、4、4"
      );
    }
  }
}

/** 对未知输入做完整运行时校验；不会抛错。 */
export function validateLayoutDocument(document: unknown): LayoutValidationResult {
  const issues: LayoutValidationIssue[] = [];
  if (!isRecord(document)) {
    issue(issues, "invalid_document", "布局文档必须是对象");
    return { valid: false, issues };
  }

  validateNoCoordinates(document, issues);

  if (document.schemaVersion !== 1) {
    issue(issues, "invalid_schema_version", "schemaVersion 必须严格为 1");
  }
  if (!isNonEmptyString(document.id)) {
    issue(issues, "invalid_document_id", "布局文档 id 不能为空");
  }
  if (!Number.isInteger(document.revision) || (document.revision as number) < 0) {
    issue(issues, "invalid_revision", "revision 必须是非负整数");
  }

  const composition = document.composition;
  const userCustomized =
    isRecord(composition) &&
    composition.mode === "user-customized" &&
    isNonEmptyString(composition.changeSetId);
  if (composition !== undefined && !userCustomized) {
    issue(
      issues,
      "invalid_composition",
      "composition 必须带有 user-customized 模式和有效的 changeSetId"
    );
  }

  validateBackground(document.background, issues);
  const cardsById = validateCards(document.cards, issues);
  validateArrangement(
    document.arrangement,
    cardsById,
    issues,
    // 只有由线索节点明确派生的桌面允许重排五区；普通/未知布局继续守住
    // seed 几何护栏，不能仅凭换一个 id 就绕过顺序与 span 校验。
    !userCustomized &&
      !(typeof document.id === "string" && document.id.includes("--clue-"))
  );

  return { valid: issues.length === 0, issues };
}

export class LayoutDocumentValidationError extends Error {
  readonly issues: LayoutValidationIssue[];

  constructor(issues: LayoutValidationIssue[]) {
    super(issues.map((entry) => entry.message).join("；"));
    this.name = "LayoutDocumentValidationError";
    this.issues = issues;
  }
}

/** 校验失败时携带全部结构化 issues 抛错。 */
export function assertValidLayoutDocument(
  document: unknown
): asserts document is LayoutDocumentV1 {
  const result = validateLayoutDocument(document);
  if (!result.valid) {
    throw new LayoutDocumentValidationError(result.issues);
  }
}

/**
 * 严格按 arrangement.orderedCardIds 解析卡片。
 *
 * 不允许回退到 cards 数组顺序，也不跳过悬空 id；非法文档先整体拒绝。
 */
export function resolveLayoutCards<
  TKind extends string = string,
  TPresentation = unknown
>(
  document: LayoutDocumentV1<TKind, TPresentation>
): Array<LayoutCardDefinition<TKind, TPresentation>> {
  const validation = validateLayoutDocument(document);
  if (!validation.valid) {
    throw new LayoutDocumentValidationError(validation.issues);
  }

  const cardsById = new Map(document.cards.map((card) => [card.id, card]));
  return document.arrangement.orderedCardIds.map((id) => {
    const card = cardsById.get(id);
    // validateLayoutDocument 已保证不可能悬空；此分支保护未来重构时不静默退化。
    if (!card) {
      throw new LayoutDocumentValidationError([
        {
          code: "dangling_arrangement_id",
          message: `排布引用了不存在的 card「${id}」`,
          cardId: id
        }
      ]);
    }
    return card;
  });
}

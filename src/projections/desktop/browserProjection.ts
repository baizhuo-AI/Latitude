import type { WebSearchItem } from "../../runtime/host/agentClient";
import type {
  KnowledgeContext,
  KnowledgeNode,
  RuntimeServiceState,
} from "../../runtime/host/DesktopRuntimePort";
import { SEED_LAYOUT_DOCUMENT } from "../../runtime/layout/seedLayout";
import type { LayoutDocumentV1 } from "../../runtime/layout/types";
import type {
  AnchorRow,
  CardPresentation,
  FeedItem,
  NativeCardKind,
  RelationMetric,
} from "../../dimension/types";
import type { DesktopProjection } from "./types";

export interface BrowserProjectionInput {
  context: KnowledgeContext;
  runtimeState: RuntimeServiceState;
  now: Date;
  webResults?: readonly WebSearchItem[];
  /** Retained for feedback/audit callers; feed reasons come only from the
   * immutable ranking-time whyNow persisted by Domain. */
  searchReason?: string;
}

export interface BrowserProjectionResult {
  projection: DesktopProjection;
  layout: LayoutDocumentV1<NativeCardKind, CardPresentation>;
}

/**
 * Project the unified graph into the existing five-paper Latitude desktop.
 * This is deliberately a read model: it invents no facts and writes nothing.
 */
export function buildBrowserProjection(input: BrowserProjectionInput): BrowserProjectionResult {
  const nodes = input.context.nodes ?? [];
  const actions = nodes.filter(isDomainAction);
  const outcomes = nodes.filter((node) => node.kind === "outcome");
  const claims = nodes.filter((node) => node.kind === "claim");
  const currentClaim = selectCurrentClaim(claims);
  const tensions = nodes.filter((node) => node.kind === "tension");
  const goals = nodes.filter(
    (node) => node.kind === "goal" && !isClosed(node) && isUserOwnedGoal(node),
  );
  const mediumGoals = goals.filter((node) => isGoalSurface(node, "medium-term", "clue.theme"));
  const shortGoals = goals.filter((node) => isGoalSurface(node, "short-term", "desktop.goal"));
  const goalById = new Map(goals.map((goal) => [goal.id, goal]));
  const desktopActions = actions.filter((action) => {
    const surfaceRole = optionalString(payloadOf(action).surfaceRole);
    // Explicit clue actions stay on their medium-horizon board. Legacy/Host
    // actions predate surfaceRole and must remain recoverable on the desktop.
    if (surfaceRole === undefined) return true;
    if (surfaceRole !== "desktop.action") return false;
    const goalId = optionalString(payloadOf(action).goalId);
    if (!goalId) return true;
    const goal = goalById.get(goalId);
    // A bounded context may contain the action without its goal; keep the
    // action available for result collection instead of hiding a real record.
    return goal ? shortGoals.some((candidate) => candidate.id === goal.id) : true;
  });
  const openActions = desktopActions.filter((node) => !isClosed(node));
  const designatedNorthStars = goals.filter(
    (node) => isGoalSurface(node, "north-star", "constellation.north-star"),
  );
  const candidates = nodes.filter(isCandidateNode);
  const openCandidates = candidates
    .filter((node) => ["proposed", "touched", "shaping"].includes(candidateStateOf(node)))
    .sort((left, right) => candidateSortKey(left) - candidateSortKey(right));
  const currentCandidate = openCandidates[0];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const starStateByCenter = new Map(
    (input.context.starStates ?? []).flatMap((value) => {
      const state = starStateOf(value);
      return state ? [[state.centerNodeId, state] as const] : [];
    }),
  );
  const cognitiveStars = nodes
    .filter(isConstellationKnowledgeNode)
    .sort(nodeProjectionOrder);
  const allowedConstellationIds = new Set([
    ...cognitiveStars.map((node) => node.id),
    ...designatedNorthStars.map((node) => node.id),
  ]);
  const orbitEdges = input.context.edges.filter(
    (edge) =>
      edgeRelation(edge) === "orbits" &&
      isCanonicalOrbitStatus(edge.status) &&
      Boolean(edgeFrom(edge) && allowedConstellationIds.has(edgeFrom(edge)!)) &&
      Boolean(edgeTo(edge) && allowedConstellationIds.has(edgeTo(edge)!)),
  );
  // Only a user-authorized, explicitly typed north-star is eligible. A lone
  // medium/short/imported goal must never be promoted because it happens to be
  // the only goal in the current context window.
  const primaryGoal = designatedNorthStars.length === 1
    ? designatedNorthStars[0]
    : undefined;
  const unresolvedNorthStars = designatedNorthStars;
  const orbitEndpointNodes = orbitEdges.flatMap((edge) =>
    [edgeFrom(edge), edgeTo(edge)].flatMap((id) => {
      const node = id ? nodeById.get(id) : undefined;
      return node && isConstellationKnowledgeNode(node) ? [node] : [];
    }),
  );
  const constellationNodes = uniqueNodes([
    // A real orbital relationship must not be pushed out of the six visible
    // star slots by unrelated claims. Its endpoints are the first projection
    // priority; generic cognitive stars fill the remaining room.
    ...orbitEndpointNodes,
    ...cognitiveStars.filter((node) => starStateByCenter.has(node.id)),
    ...cognitiveStars,
  ]);
  const reviews = nodes.filter(
    (node) =>
      node.kind === "insight" &&
      (payloadOf(node).reviewType === "weekly" ||
        (typeof payloadOf(node).periodStart === "string" &&
          typeof payloadOf(node).periodEnd === "string") ||
        labelOf(node) === "真实周回顾"),
  );
  const due = openActions.filter((action) => isDue(action, input.now));
  const nextAction = [...openActions].sort((left, right) =>
    reviewAtOf(left).localeCompare(reviewAtOf(right)),
  )[0];
  const clueBoard = buildClueBoardModel(nodes, mediumGoals, shortGoals, actions, outcomes);
  const deskRows = buildDesktopRows(shortGoals, openActions, input.now);
  const relationship = buildRelationshipMetrics(nodes, input.now);
  const curatorSignals = curatorSignalByResource(nodes);
  const suppressedResources = new Set(
    [...curatorSignals].flatMap(([resourceId, signal]) =>
      signal === "negative" || signal === "already_known" ? [resourceId] : []
    ),
  );
  const persistedWebResults = nodes
    .filter((node) => !suppressedResources.has(node.id))
    .flatMap(webResultFromResourceNode);
  const curatedWebResults = curatedWebResultsFromLatestDigest(nodes).filter(
    (result) => !suppressedResources.has(optionalString(result.evidenceNodeId) ?? ""),
  );
  const feedItems = projectFeed(
    curatedWebResults.length > 0
      ? curatedWebResults
      : [
          // Before the first explicit/daily digest exists, durable search
          // evidence remains a useful bootstrap. Once a digest is present,
          // ordinary searches must not silently rewrite the newspaper card.
          ...persistedWebResults,
          ...(input.webResults ?? []).filter(
            (result) => !suppressedResources.has(optionalString(result.evidenceNodeId) ?? ""),
          ),
        ],
    input.now,
  );
  const runtimeReady = input.runtimeState === "ready";

  const projection: DesktopProjection = {
    generatedAt: input.now.toISOString(),
    runtimeStatus:
      input.runtimeState === "ready"
        ? "ready"
        : input.runtimeState === "starting"
          ? "starting"
          : "unavailable",
    header: {
      breadcrumb: "TODAY · EVIDENCE LOOP",
      title: shortGoals.length > 0
        ? `${shortGoals.length} 个短期目标正在展开`
        : nextAction
          ? labelOf(nextAction)
          : "现在没有明确的短期目标",
      subtitle: runtimeReady
        ? shortGoals.length > 0
          ? `${shortGoals.map(labelOf).join(" · ")}；${openActions.length} 个关联行动在进行，${due.length} 个结果窗口已到。`
          : `${openActions.length} 个行动在进行 · ${due.length} 个结果窗口已到 · ${openCandidates.length} 个共创候选 · ${claims.length} 条可追溯认知`
        : "本地服务未就绪；当前不把未知显示成空白。",
    },
    secretary: {
      eyebrow: "YOUR SECRETARY",
      state: runtimeReady ? (due.length ? "presenting" : "ready") : "thinking",
      gesture: runtimeReady ? (due.length ? "reminding" : "organizing") : "comparing",
      stateCn: runtimeReady ? (due.length ? "等你回收结果" : "在岗") : "连接本地内核",
      headline: runtimeReady
        ? due.length
          ? `有 ${due.length} 个行动到了结果窗口。`
          : "我在，事实和行动都从同一张图里读取。"
        : "我还没有读到本地内核。",
      note: runtimeReady
        ? "我可以直接修订长期认知；每一次修改都会留下来源、前后版本和撤销入口。"
        : "服务恢复前我不会拿演示数据冒充你的记录。",
      stageLabel: relationship.hasTypedSource ? "关系 · 有据可查" : "关系 · 等待证据",
      stageProgress: 0,
      stageNote: "熟悉与默契只读带纠正契约的 typed 依据；当前入口只查看来源，权能只认有效授权 receipt。",
      metrics: relationship.metrics,
    },
    bindings: {
      "desktop.feed": {
        kind: "feed",
        items: feedItems,
        emptyHint: runtimeReady
          ? "还没有与当前张力足够相关、且有真实来源的资讯。"
          : "资讯策展等待本地 Agent Host。",
      },
      "desktop.schedule": {
        kind: "anchors",
        rows: deskRows,
        emptyHint: runtimeReady
          ? "现在没有未闭环的行动"
          : "行动记录暂时不可用。",
      },
      "desktop.reviewPlan": {
        kind: "progress",
        body:
          reviews.length > 0
            ? weeklyReviewBody(reviews[0])
            : outcomes.length > 0
              ? `已经留下 ${outcomes.length} 个真实结果；下一次周回顾会把变化而非待办数量串起来。`
              : "真实周回顾会在行动产生结果后出现；现在没有材料就不生成漂亮总结。",
        ...(actions.length > 0
          ? { percent: Math.round((outcomes.length / actions.length) * 100) }
          : {}),
        leftMeta: reviews.length > 0
          ? weeklyReviewMeta(reviews[0])
          : `${outcomes.length} 个结果 · ${due.length} 个待回收`,
      },
      "desktop.rhythm": {
        kind: "chart",
        bars: dueBars(openActions, input.now),
        link: due.length ? "回收到期行动的结果" : "查看行动时间窗",
      },
      "desktop.flex": currentCandidate
        ? {
            kind: "note",
            body: statementOf(currentCandidate) || labelOf(currentCandidate),
            quote: candidateProjectionQuote(currentCandidate, input.now),
          }
        : tensions.length
        ? {
            kind: "note",
            body: statementOf(tensions[0]) || labelOf(tensions[0]),
            quote: "这是一条待验证的张力，不是已经成立的结论。",
          }
        : currentClaim
          ? {
              kind: "note",
              body: statementOf(currentClaim) || labelOf(currentClaim),
              quote: epistemicLabel(currentClaim),
            }
          : {
              kind: "note",
              body: "图谱里还没有可投影的认知。",
              quote: "先留下证据，再形成判断。",
            },
    },
    journalSpreads: {},
    clueBoard,
    constellation: {
      northStar: designatedNorthStars.length
        ? primaryGoal
          ? {
              title: labelOf(primaryGoal),
              detail: statementOf(primaryGoal) || "来自你明确记录的长期方向。",
              status: "single" as const,
              lineage: {
                entityType: "goal",
                entityId: primaryGoal.id,
                label: "来自统一认知行为星图",
              },
            }
          : {
              title: `${unresolvedNorthStars.length} 个并行的长期方向`,
              detail: unresolvedNorthStars.slice(0, 4).map(labelOf).join("、"),
              status: "multiple" as const,
            }
        : {
            title: "还没有明确的长期方向",
            detail: "系统不会拿短期行动冒充北极星。",
            status: runtimeReady ? "empty" : "unavailable",
          },
      cognitions: constellationNodes.slice(0, 10).map((node) => {
        const starState = starStateByCenter.get(node.id);
        const orbitEdge = orbitEdges.find((edge) => edgeFrom(edge) === node.id);
        const orbitCenterId = orbitEdge ? edgeTo(orbitEdge) : undefined;
        const orbitCenter = orbitCenterId ? nodeById.get(orbitCenterId) : undefined;
        return {
          id: node.id,
          role: optionalString(payloadOf(node).surfaceRole) === "constellation.big-idea"
            ? "big-idea" as const
            : "cognition" as const,
          label: labelOf(node),
          detail: `${epistemicLabel(node)}：${statementOf(node) || labelOf(node)}`,
          epistemic: epistemicOf(node),
          lineage: {
            entityType: node.kind,
            entityId: node.id,
            label: "来自统一认知行为星图",
          },
          ...(starState ? { starState } : {}),
          ...(orbitEdge && orbitCenterId
            ? {
                orbit: {
                  centerNodeId: orbitCenterId,
                  centerLabel: orbitCenter ? labelOf(orbitCenter) : orbitCenterId,
                  relationType: edgeRelation(orbitEdge) || "orbits",
                  ...(optionalString(orbitEdge.proximity)
                    ? { proximity: optionalString(orbitEdge.proximity) }
                    : {}),
                  ...(optionalString(orbitEdge.strength)
                    ? { strength: optionalString(orbitEdge.strength) }
                    : {}),
                },
              }
            : {}),
        };
      }),
    },
  };

  const layout = structuredClone(
    SEED_LAYOUT_DOCUMENT,
  ) as LayoutDocumentV1<NativeCardKind, CardPresentation>;
  layout.id = "latitude-browser-live";
  layout.revision += 1;
  for (const card of layout.cards) {
    if (!card.presentation) continue;
    if (card.binding === "desktop.reviewPlan") {
      card.presentation.title = "真实周回顾";
    } else if (card.binding === "desktop.rhythm") {
      card.presentation.title = "结果回收时间窗";
    } else if (card.binding === "desktop.flex") {
      card.presentation.title = currentCandidate ? "共创候选" : "当前认知张力";
    }
  }
  return { projection, layout };
}

function payloadOf(node: KnowledgeNode): Record<string, unknown> {
  const payload = node.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

/** Personal goals need personal authority; a model/imported goal is context, not YOUR GOAL. */
function isUserOwnedGoal(node: KnowledgeNode): boolean {
  const authority = optionalString(node.authority);
  if (authority) {
    return ["user_stated", "user_confirmed", "user_corrected"].includes(authority);
  }
  return optionalString(node.origin) === "user";
}

function isGoalSurface(
  node: KnowledgeNode,
  horizon: "north-star" | "medium-term" | "short-term",
  surfaceRole: string,
): boolean {
  if (node.kind !== "goal" || optionalString(payloadOf(node).horizon) !== horizon) return false;
  return optionalString(payloadOf(node).surfaceRole) === surfaceRole;
}

function isDomainAction(node: KnowledgeNode): boolean {
  return node.kind === "action";
}

function isConstellationKnowledgeNode(node: KnowledgeNode): boolean {
  if (node.kind !== "claim" || isClosed(node)) return false;
  const surfaceRole = optionalString(payloadOf(node).surfaceRole);
  return surfaceRole === "constellation.cognition" ||
    surfaceRole === "constellation.big-idea";
}

function nodeProjectionOrder(left: KnowledgeNode, right: KnowledgeNode): number {
  const leftOrder = Number(payloadOf(left).order);
  const rightOrder = Number(payloadOf(right).order);
  const safeLeft = Number.isFinite(leftOrder) ? leftOrder : Number.MAX_SAFE_INTEGER;
  const safeRight = Number.isFinite(rightOrder) ? rightOrder : Number.MAX_SAFE_INTEGER;
  return safeLeft - safeRight || left.id.localeCompare(right.id);
}

function boardTagsOf(node: KnowledgeNode): string[] | undefined {
  return stringArray(payloadOf(node).boardTags) ?? stringArray(payloadOf(node).tags);
}

function isGoalComplete(node: KnowledgeNode): boolean {
  return ["achieved", "completed", "concluded"].includes(optionalString(node.status) ?? "");
}

function buildDesktopRows(
  shortGoals: readonly KnowledgeNode[],
  actions: readonly KnowledgeNode[],
  now: Date,
): AnchorRow[] {
  const goalRows = [...shortGoals].sort(nodeProjectionOrder).map((goal) => ({
    text: labelOf(goal),
    meta: isGoalComplete(goal) ? "短期目标 · 已达成" : "短期目标 · 进行中",
    actionable: false,
    done: isGoalComplete(goal),
    epistemic: epistemicOf(goal),
    tags: boardTagsOf(goal),
    lineage: {
      entityType: "goal",
      entityId: goal.id,
      label: "来自统一 Domain 的短期目标",
    },
  } satisfies AnchorRow));
  const actionRows = [...actions]
    .sort((left, right) => reviewAtOf(left).localeCompare(reviewAtOf(right)))
    .map((action) => ({
      text: labelOf(action),
      meta: reviewMeta(action, now),
      actionable: true,
      done: false,
      epistemic: epistemicOf(action),
      tags: boardTagsOf(action),
      lineage: {
        entityType: "action",
        entityId: action.id,
        label: optionalString(payloadOf(action).surfaceRole) === "desktop.action" &&
          optionalString(payloadOf(action).goalId)
          ? "来自统一 Domain 的短期目标行动"
          : "来自统一认知行为星图",
      },
    } satisfies AnchorRow));
  return [...goalRows, ...actionRows];
}

function buildClueBoardModel(
  nodes: readonly KnowledgeNode[],
  mediumGoals: readonly KnowledgeNode[],
  shortGoals: readonly KnowledgeNode[],
  actions: readonly KnowledgeNode[],
  outcomes: readonly KnowledgeNode[],
): NonNullable<DesktopProjection["clueBoard"]> {
  const outcomeActionIds = new Set(
    outcomes.flatMap((outcome) => {
      const actionId = optionalString(payloadOf(outcome).actionId);
      return actionId ? [actionId] : [];
    }),
  );
  const themes = [...mediumGoals].sort(nodeProjectionOrder).map((mediumGoal) => {
    const childGoals = shortGoals.filter((goal) =>
      optionalString(payloadOf(goal).mediumGoalId) === mediumGoal.id ||
      optionalString(payloadOf(goal).parentGoalId) === mediumGoal.id,
    );
    const relatedActions = actions.filter((action) =>
      optionalString(payloadOf(action).mediumGoalId) === mediumGoal.id ||
      optionalString(payloadOf(action).goalId) === mediumGoal.id ||
      childGoals.some((goal) => optionalString(payloadOf(action).goalId) === goal.id),
    );
    const relatedOutcomes = outcomes.filter((outcome) =>
      optionalString(payloadOf(outcome).mediumGoalId) === mediumGoal.id ||
      relatedActions.some((action) => optionalString(payloadOf(outcome).actionId) === action.id),
    );
    const supportingNodes = nodes.filter((node) =>
      !["goal", "action", "outcome"].includes(node.kind) &&
      optionalString(payloadOf(node).mediumGoalId) === mediumGoal.id,
    );
    const rows: AnchorRow[] = [
      ...relatedActions.map((action) => {
        const hasOutcome = outcomeActionIds.has(action.id);
        return {
          text: labelOf(action),
          meta: hasOutcome
            ? "已有真实结果"
            : isClosed(action)
              ? "已结束 · 无结果证据"
              : "关联行动",
          actionable: !hasOutcome && !isClosed(action),
          done: hasOutcome,
          epistemic: epistemicOf(action),
          tags: boardTagsOf(action),
          lineage: {
            entityType: "action",
            entityId: action.id,
            label: "来自统一 Domain 的中期目标行动",
          },
        } satisfies AnchorRow;
      }),
      ...relatedOutcomes.map((outcome) => ({
        text: labelOf(outcome),
        meta: "真实行动结果",
        actionable: false,
        done: true,
        epistemic: epistemicOf(outcome),
        tags: boardTagsOf(outcome),
        lineage: {
          entityType: "outcome",
          entityId: outcome.id,
          label: "来自统一 Domain 的结果回收",
        },
      } satisfies AnchorRow)),
      ...supportingNodes.sort(nodeProjectionOrder).map((node) => ({
        text: labelOf(node),
        meta: clueNodeKindLabel(node.kind),
        actionable: false,
        done: false,
        epistemic: epistemicOf(node),
        tags: boardTagsOf(node),
        lineage: {
          entityType: node.kind,
          entityId: node.id,
          label: "由 Domain 明确关联到这个中期目标",
        },
      } satisfies AnchorRow)),
    ];
    return {
      id: `goal-theme-${mediumGoal.id}`,
      title: labelOf(mediumGoal),
      detail: statementOf(mediumGoal) || "来自你明确记录的中期目标。",
      rows,
      pending: relatedActions.filter((action) => !outcomeActionIds.has(action.id)).length,
      done: relatedActions.filter((action) => outcomeActionIds.has(action.id)).length,
      lineage: {
        entityType: "goal",
        entityId: mediumGoal.id,
        label: "来自统一 Domain 的中期目标",
      },
    };
  });
  return {
    title: themes.length > 0 ? `${themes.length} 个中期目标` : "还没有明确的中期目标",
    subtitle: themes.length > 0
      ? `${actions.length} 个行动与相关证据按明确 goalId / mediumGoalId 指针展开；短期目标留在纸面桌面。`
      : "记录中期目标后，它会成为线索板主题；系统不会从关键词猜一块板。",
    themes,
  };
}

function clueNodeKindLabel(kind: string): string {
  return {
    resource: "相关资料",
    tension: "待验证张力",
    method: "相关方法",
    insight: "回顾记录",
    claim: "认知线索",
  }[kind] ?? "关联记录";
}

interface RelationshipProjection {
  hasTypedSource: boolean;
  metrics: RelationMetric[];
}

const EMPTY_RELATION_METRICS: readonly RelationMetric[] = [
  {
    label: "熟悉",
    value: 0,
    tone: "olive",
    stage: "尚未形成",
    basis: "统一 Domain 尚未提供带依据的熟悉度记录。",
    correctable: false,
  },
  {
    label: "默契",
    value: 0,
    tone: "blue",
    stage: "尚未形成",
    basis: "统一 Domain 尚未提供带依据的协作记录。",
    correctable: false,
  },
  {
    label: "权能",
    value: 0,
    tone: "rust",
    stage: "未授权",
    basis: "当前没有仍有效的明确授权 receipt。",
    correctable: false,
  },
];

/**
 * 秘书关系是 Domain 的 read model，而不是前端养成算法。熟悉与默契必须带
 * typed basis；权能还必须通过被关系节点引用、且仍有效的显式授权 receipt。
 */
function buildRelationshipMetrics(
  nodes: readonly KnowledgeNode[],
  now: Date,
): RelationshipProjection {
  const sources = nodes
    .filter((node) =>
      node.kind === "insight" &&
      !isClosed(node) &&
      optionalString(payloadOf(node).surfaceRole) === "secretary.relationship" &&
      Number(payloadOf(node).relationshipSchemaVersion) === 1,
    )
    .sort((left, right) => {
      // A real relationship record always outranks the bundled demo fixture.
      const demoRank = Number(Boolean(payloadOf(left).demo)) - Number(Boolean(payloadOf(right).demo));
      if (demoRank !== 0) return demoRank;
      const timeRank = nodeTimestamp(right) - nodeTimestamp(left);
      return timeRank || left.id.localeCompare(right.id);
    });
  const source = sources[0];
  if (!source) {
    return { hasTypedSource: false, metrics: EMPTY_RELATION_METRICS.map((metric) => ({ ...metric })) };
  }

  const metrics = recordOf(payloadOf(source).metrics);
  const sourceLineage = {
    entityType: source.kind,
    entityId: source.id,
    label: "来自统一 Domain 的秘书关系记录",
  };
  const familiarity = relationMetricFromTyped(
    "熟悉",
    "olive",
    recordOf(metrics?.familiarity),
    source,
    sourceLineage,
  );
  const rapport = relationMetricFromTyped(
    "默契",
    "blue",
    recordOf(metrics?.rapport),
    source,
    sourceLineage,
  );
  const capabilityPayload = recordOf(metrics?.capability);
  const receiptIds = stringArray(capabilityPayload?.grantReceiptIds) ?? [];
  const referencedReceipts = receiptIds.flatMap((id) => {
    const receipt = nodes.find((node) => node.id === id);
    return receipt ? [receipt] : [];
  });
  const activeReceipts = referencedReceipts
    .filter((receipt) => isActiveExplicitCapabilityGrant(receipt, now))
    .sort((left, right) => nodeTimestamp(right) - nodeTimestamp(left) || left.id.localeCompare(right.id));
  // Multiple grants can cover different scopes. This scalar displays the most
  // recent active receipt only; it never merges scopes or falls back to a
  // relationship-node number that was not itself authorized.
  const selectedReceipt = activeReceipts[0];
  const receiptValue = selectedReceipt
    ? numericMetricValue(
        payloadOf(selectedReceipt).capabilityValue ?? payloadOf(selectedReceipt).value,
      )
    : undefined;
  const capabilityGranted = selectedReceipt !== undefined && receiptValue !== undefined;
  const capabilityValue = capabilityGranted ? receiptValue : 0;
  const capabilityLineage = [
    sourceLineage,
    ...referencedReceipts.map((receipt) => ({
      entityType: receipt.kind,
      entityId: receipt.id,
      label: receipt.id === selectedReceipt?.id
        ? "当前采用的明确授权 receipt"
        : activeReceipts.includes(receipt)
          ? "仍有效但未作为当前标量的授权 receipt"
        : "已失效或不完整的授权 receipt",
    })),
  ];
  const capability: RelationMetric = {
    label: "权能",
    value: capabilityValue,
    tone: "rust",
    stage: capabilityGranted
      ? optionalString(payloadOf(selectedReceipt).stage) ?? "已授权"
      : "未授权",
    basis: capabilityGranted
      ? optionalString(payloadOf(selectedReceipt).basis) ?? "由当前仍有效的明确授权 receipt 记录。"
      : "当前没有带合法权能值、仍有效的明确授权 receipt。",
    epistemicAuthority: capabilityGranted
      ? optionalString(selectedReceipt.authority)
      : "system_recorded",
    lineage: capabilityLineage,
    correctable: false,
  };

  return {
    hasTypedSource: true,
    metrics: [familiarity, rapport, capability],
  };
}

function relationMetricFromTyped(
  label: "熟悉" | "默契",
  tone: RelationMetric["tone"],
  metric: Record<string, unknown> | undefined,
  source: KnowledgeNode,
  lineage: NonNullable<RelationMetric["lineage"]>[number],
): RelationMetric {
  const basis = optionalString(metric?.basis);
  // A scalar without a typed explanation is not evidence and fails closed.
  const eligible = Boolean(basis) && metric?.correctable === true;
  return {
    label,
    value: eligible ? numericMetricValue(metric?.value) ?? 0 : 0,
    tone,
    stage: eligible ? optionalString(metric?.stage) ?? "尚未形成" : "尚未形成",
    basis: basis ?? `统一 Domain 尚未提供带依据的${label}记录。`,
    epistemicAuthority: optionalString(metric?.epistemicAuthority) ?? optionalString(source.authority),
    lineage: [lineage],
    correctable: eligible,
  };
}

function isActiveExplicitCapabilityGrant(node: KnowledgeNode, now: Date): boolean {
  const payload = payloadOf(node);
  if (optionalString(payload.surfaceRole) !== "secretary.capability-grant") return false;
  if (optionalString(payload.grantState) !== "granted" || isClosed(node)) return false;
  const authority = optionalString(node.authority) ?? "";
  const authorityCanRecordGrant = authority === "system_recorded" ||
    ["user_stated", "user_confirmed", "user_corrected"].includes(authority);
  const explicit = authorityCanRecordGrant && (
    optionalString(payload.authorizationMode) === "explicit" ||
    payload.explicitGrant === true ||
    ["user_stated", "user_confirmed", "user_corrected"].includes(authority)
  );
  if (!explicit || optionalString(payload.revokedAt)) return false;
  const expiresAt = optionalString(payload.expiresAt) ?? optionalString(node.expiresAt);
  if (!expiresAt) return true;
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) && expiry > now.getTime();
}

function numericMetricValue(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function nodeTimestamp(node: KnowledgeNode): number {
  const timestamp = optionalString(node.updatedAt) ?? optionalString(node.createdAt);
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function labelOf(node: KnowledgeNode): string {
  const label = typeof node.label === "string" ? node.label : node.title;
  return label?.trim() || "未命名记录";
}

function statementOf(node: KnowledgeNode): string {
  const statement = typeof node.statement === "string" ? node.statement : node.content;
  return statement?.trim() || "";
}

/**
 * A revision updates the old claim and inserts its replacement in the same
 * SQLite transaction, so both rows can have an identical `updatedAt`. Context
 * ordering is therefore not a semantic contract. Prefer a live/scoped claim
 * over superseded history, then use revision lineage and timestamps only as
 * deterministic tie-breakers.
 */
function selectCurrentClaim(claims: readonly KnowledgeNode[]): KnowledgeNode | undefined {
  return [...claims].sort((left, right) => {
    const statusRank = claimProjectionStatusRank(left) - claimProjectionStatusRank(right);
    if (statusRank !== 0) return statusRank;
    const revisionRank = claimRevisionRank(right) - claimRevisionRank(left);
    if (revisionRank !== 0) return revisionRank;
    const timeRank = claimProjectionTime(right) - claimProjectionTime(left);
    if (timeRank !== 0) return timeRank;
    return left.id.localeCompare(right.id);
  })[0];
}

function claimProjectionStatusRank(node: KnowledgeNode): number {
  const status = optionalString(node.status) ?? "active";
  if (status === "active" || status === "scoped") return 0;
  if (["superseded", "revoked", "deleted", "expired", "rejected"].includes(status)) {
    return 2;
  }
  return 1;
}

function claimRevisionRank(node: KnowledgeNode): number {
  const payload = payloadOf(node);
  return optionalString(payload.previousClaimId) || optionalString(payload.revisionEffect)
    ? 1
    : 0;
}

function claimProjectionTime(node: KnowledgeNode): number {
  const value = optionalString(node.updatedAt) ?? optionalString(node.createdAt);
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function weeklyReviewBody(node: KnowledgeNode): string {
  const sections = recordValue(payloadOf(node).sections);
  const singleLoop = recordValue(sections?.singleLoop);
  const doubleLoop = recordValue(sections?.doubleLoop);
  if (singleLoop && doubleLoop) {
    const outcomeCount = arrayValue(singleLoop.outcomes).length;
    const dueCount = arrayValue(singleLoop.dueActions).length;
    const noEvidenceCount = arrayValue(
      singleLoop.actionsWithoutEvidence ?? singleLoop.noEvidenceActions,
    ).length;
    const changedCount = arrayValue(doubleLoop.changedClaims).length;
    const contradictionCount = arrayValue(doubleLoop.contradictions).length;
    const pendingCount = arrayValue(doubleLoop.pendingRevisions).length;
    const reframeCount = arrayValue(doubleLoop.reframePrompts).length;
    const candidates = recordValue(doubleLoop.candidates);
    const openCandidateCount = arrayValue(candidates?.open).length;
    const concludedCandidateCount = arrayValue(candidates?.concluded).length;
    const parkedCandidateCount = arrayValue(candidates?.parked).length;
    const questions = [optionalString(singleLoop.question), optionalString(doubleLoop.question)]
      .filter((value): value is string => Boolean(value));
    return `换了做法：${outcomeCount} 个真实结果，${dueCount} 个结果窗口待回收，${noEvidenceCount} 个行动仍缺证据。改了看法：${changedCount} 条认知发生变化，${contradictionCount} 处矛盾，${pendingCount} 条修订待裁决，${reframeCount} 个重构提示。共创候选：${openCandidateCount} 个进行中，${concludedCandidateCount} 个形成结论，${parkedCandidateCount} 个已搁置。${questions.length ? ` 本周要问：${questions.join("；")}` : ""}`;
  }
  return statementOf(node) || labelOf(node);
}

function weeklyReviewMeta(node: KnowledgeNode): string {
  const payload = payloadOf(node);
  const sections = recordValue(payload.sections);
  const singleLoop = recordValue(sections?.singleLoop);
  const doubleLoop = recordValue(sections?.doubleLoop);
  const period = reviewPeriodLabel(
    optionalString(payload.periodStart) || optionalString(node.periodStart),
    optionalString(payload.periodEnd) || optionalString(node.periodEnd),
  );
  if (!singleLoop || !doubleLoop) return period || "真实周期折叠";
  const behavior = arrayValue(singleLoop.outcomes).length;
  const cognition = arrayValue(doubleLoop.changedClaims).length;
  return `${period ? `${period} · ` : ""}换了做法 ${behavior} · 改了看法 ${cognition}`;
}

function reviewPeriodLabel(start: string | undefined, end: string | undefined): string | undefined {
  if (!start || !end) return undefined;
  const compact = (value: string) => {
    const match = value.match(/^\d{4}-(\d{2})-(\d{2})/);
    return match ? `${Number(match[1])}月${Number(match[2])}日` : value;
  };
  return `周期 ${compact(start)} → ${compact(end)}`;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function isCandidateNode(node: KnowledgeNode): boolean {
  return node.kind === "candidate" || (
    node.kind === "experiment" && payloadOf(node).interventionType === "candidate"
  );
}

export function candidateStateOf(node: KnowledgeNode): string {
  const state = optionalString(payloadOf(node).candidateState);
  if (state) return state;
  // Compatibility only: typed Domain writes always persist candidateState.
  return node.status === "active" ? "touched" : optionalString(node.status) ?? "proposed";
}

function candidateSortKey(node: KnowledgeNode): number {
  const stateRank = { shaping: 0, touched: 1, proposed: 2 }[candidateStateOf(node)] ?? 9;
  const updated = optionalString(node.updatedAt) ?? optionalString(node.createdAt);
  const time = updated ? Date.parse(updated) : 0;
  return stateRank * 1_000_000_000_000 - (Number.isFinite(time) ? time : 0);
}

function candidateProjectionQuote(node: KnowledgeNode, now: Date): string {
  const payload = payloadOf(node);
  const state = candidateStateOf(node);
  const labels: Record<string, string> = {
    proposed: "候选 · 等待触碰",
    touched: "已触碰 · 等待塑形",
    shaping: "塑形中 · 等待结论",
    concluded: "已形成结论",
    parked: "已搁置",
  };
  const dueAt = state === "proposed"
    ? optionalString(payload.proposedSilenceDueAt)
    : state === "shaping"
      ? optionalString(payload.shapingFollowupDueAt)
      : undefined;
  const due = dueAt && Date.parse(dueAt) <= now.getTime();
  if (due && state === "proposed") return `${labels[state]} · 已安静 3 天，只提示，不自动收起`;
  if (due && state === "shaping" && !optionalString(payload.shapingPromptedAt)) {
    return `${labels[state]} · 7 天轻提醒，只问一次，不自动下结论`;
  }
  return labels[state] ?? "共创候选 · 状态待校验";
}

function reviewAtOf(node: KnowledgeNode): string {
  return typeof node.reviewAt === "string" ? node.reviewAt : "9999-12-31T23:59:59Z";
}

function isClosed(node: KnowledgeNode): boolean {
  return ["concluded", "superseded", "expired", "rejected", "revoked", "deleted"].includes(
    String(node.status ?? ""),
  ) || Boolean(node.outcome);
}

function isDue(node: KnowledgeNode, now: Date): boolean {
  const reviewAt = reviewAtOf(node);
  const time = Date.parse(reviewAt);
  return Number.isFinite(time) && time <= now.getTime();
}

function reviewMeta(node: KnowledgeNode, now: Date): string {
  const reviewAt = reviewAtOf(node);
  if (reviewAt.startsWith("9999")) return "待补回看时间";
  if (isDue(node, now)) return "结果待回收";
  const date = new Date(reviewAt);
  return Number.isNaN(date.getTime())
    ? "回看时间无效"
    : `回看 ${date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}`;
}

function epistemicOf(node: KnowledgeNode): "recorded" | "inferred" | "confirmed" {
  if (["user_confirmed", "user_corrected"].includes(String(node.authority))) return "confirmed";
  if (["source_verified", "user_stated", "system_recorded"].includes(String(node.authority))) {
    return "recorded";
  }
  return "inferred";
}

function epistemicLabel(node: KnowledgeNode): string {
  if (String(node.authority) === "imported_unverified") return "脱敏导入，待核验";
  const state = epistemicOf(node);
  return state === "confirmed" ? "你已确认" : state === "recorded" ? "记录显示" : "AI 推测，待现实检验";
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string" && Boolean(item));
  return strings.length ? strings : undefined;
}

function dueBars(actions: readonly KnowledgeNode[], now: Date): number[] {
  const buckets = Array<number>(8).fill(0);
  for (const action of actions) {
    const time = Date.parse(reviewAtOf(action));
    if (!Number.isFinite(time)) continue;
    const days = Math.floor((time - now.getTime()) / 86_400_000);
    const index = Math.min(7, Math.max(0, days));
    buckets[index] += 1;
  }
  const max = Math.max(1, ...buckets);
  return buckets.map((value) => Math.round((value / max) * 100) / 100);
}

function projectFeed(
  results: readonly WebSearchItem[],
  at: Date,
): FeedItem[] {
  const seenUrls = new Set<string>();
  const seenHashes = new Set<string>();
  const now = at.getTime();
  return results.flatMap((result) => {
    const url = canonicalWebUrl(result.url);
    const contentHash = optionalString(result.contentHash);
    if (
      !url ||
      !result.title?.trim() ||
      seenUrls.has(url) ||
      (contentHash !== undefined && seenHashes.has(contentHash))
    ) return [];
    seenUrls.add(url);
    if (contentHash) seenHashes.add(contentHash);
    const published = result.publishedAt ? Date.parse(result.publishedAt) : Number.NaN;
    const ageDays = Number.isFinite(published) ? (now - published) / 86_400_000 : undefined;
    const evidenceNodeId = optionalString(result.evidenceNodeId);
    const evidenceRefId = optionalString(result.evidenceRefId);
    const whyNow =
      optionalString(result.whyNow) ||
      "LEGACY：这条历史资讯未保存当时的推荐理由；当前张力和搜索词不会被拿来改写它。";
    return [{
      id: `web-${contentHash ?? stableHash(url)}`,
      title: result.title.trim(),
      why: whyNow,
      source: optionalString(result.source) || safeHostname(url),
      url,
      publishedAt: result.publishedAt,
      retrievedAt: result.retrievedAt,
      provider: optionalString(result.provider),
      queryId: optionalString(result.queryId),
      contentHash,
      evidenceRefId,
      freshness:
        ageDays === undefined ? "aging" : ageDays > 180 ? "stale" : ageDays > 30 ? "aging" : "fresh",
      lineage: evidenceNodeId
        ? {
            entityType: "resource",
            entityId: evidenceNodeId,
            label: "来自已留痕的外部搜索证据",
          }
        : undefined,
    } satisfies FeedItem];
  }).slice(0, 3);
}

/** Rebuild the feed from durable Domain resources after refresh/restart. */
function webResultFromResourceNode(node: KnowledgeNode): WebSearchItem[] {
  if (node.kind !== "resource" || isClosed(node)) return [];
  const payload = payloadOf(node);
  if (payload.untrustedContent !== true || payload.promptAuthority !== "none") return [];
  const url = optionalString(payload.url);
  if (!url || !canonicalWebUrl(url)) return [];
  const title = optionalString(payload.title) || labelOf(node);
  const retrievedAt = optionalString(payload.retrievedAt) || optionalString(node.createdAt);
  const snippet = optionalString(payload.snippet) || statementOf(node);
  const publishedAt = optionalString(payload.publishedAt);
  const provider = optionalString(payload.provider);
  const query = optionalString(payload.query);
  const whyNow = optionalString(payload.whyNow);
  const contentHash = optionalString(payload.contentHash);
  const evidenceRefId = optionalString(payload.evidenceRefId);
  return [{
    title,
    url,
    ...(snippet ? { snippet } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(retrievedAt ? { retrievedAt } : {}),
    ...(provider ? { provider } : {}),
    ...(query ? { query } : {}),
    ...(whyNow ? { whyNow } : {}),
    ...(contentHash ? { contentHash } : {}),
    ...(evidenceRefId ? { evidenceRefId } : {}),
    evidenceNodeId: node.id,
  }];
}

/**
 * A newspaper issue is an explicit curation receipt, not merely the three most
 * recent web searches. This keeps an unrelated ad-hoc query from replacing the
 * user's morning brief while preserving every search as auditable evidence.
 */
function curatedWebResultsFromLatestDigest(
  nodes: readonly KnowledgeNode[],
): WebSearchItem[] {
  const digest = nodes
    .filter((node) =>
      node.kind === "resource" &&
      !isClosed(node) &&
      payloadOf(node).resourceType === "daily_web_curation" &&
      Array.isArray(payloadOf(node).items)
    )
    .sort((left, right) => nodeTimestamp(right) - nodeTimestamp(left))[0];
  if (!digest) return [];

  const items = payloadOf(digest).items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((value) => {
    const item = recordOf(value);
    if (!item) return [];
    const title = optionalString(item.title);
    const url = optionalString(item.url);
    const whyNow = optionalString(item.whyNow);
    if (!title || !url || !whyNow || !canonicalWebUrl(url)) return [];
    const snippet = optionalString(item.snippet);
    const publishedAt = optionalString(item.publishedAt);
    const retrievedAt = optionalString(item.retrievedAt);
    const provider = optionalString(item.provider);
    const contentHash = optionalString(item.contentHash);
    const evidenceNodeId = optionalString(item.evidenceNodeId);
    const evidenceRefId = optionalString(item.evidenceRefId);
    return [{
      title,
      url,
      whyNow,
      ...(snippet ? { snippet } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(retrievedAt ? { retrievedAt } : {}),
      ...(provider ? { provider } : {}),
      ...(contentHash ? { contentHash } : {}),
      ...(evidenceNodeId ? { evidenceNodeId } : {}),
      ...(evidenceRefId ? { evidenceRefId } : {}),
    }];
  });
}

function curatorSignalByResource(nodes: readonly KnowledgeNode[]): Map<string, string> {
  const latest = new Map<string, { signal: string; at: number }>();
  for (const node of nodes) {
    if (node.kind !== "interest" || isClosed(node)) continue;
    const payload = payloadOf(node);
    if (payload.preferenceType !== "curator_preference") continue;
    const targetResourceId = optionalString(payload.targetResourceId);
    const signal = optionalString(payload.signal);
    if (!targetResourceId || !signal) continue;
    const recordedAt = optionalString(payload.recordedAt)
      || optionalString(node.recordedAt)
      || optionalString(node.updatedAt);
    const parsed = recordedAt ? Date.parse(recordedAt) : Number.NaN;
    const at = Number.isFinite(parsed) ? parsed : 0;
    const current = latest.get(targetResourceId);
    if (!current || at > current.at) latest.set(targetResourceId, { signal, at });
  }
  return new Map([...latest].map(([resourceId, value]) => [resourceId, value.signal]));
}

function canonicalWebUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function uniqueNodes(nodes: readonly KnowledgeNode[]): KnowledgeNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

function edgeFrom(edge: KnowledgeContext["edges"][number]): string | undefined {
  return optionalString(edge.fromNodeId) || optionalString(edge.sourceId);
}

function edgeTo(edge: KnowledgeContext["edges"][number]): string | undefined {
  return optionalString(edge.toNodeId) || optionalString(edge.targetId);
}

function edgeRelation(edge: KnowledgeContext["edges"][number]): string | undefined {
  return optionalString(edge.relationType) || optionalString(edge.kind);
}

function isCanonicalOrbitStatus(value: unknown): boolean {
  const status = optionalString(value);
  // Older adapters omitted edge status. Current Domain returns it and uses
  // `proposed` for semantic-only placement; proposed is deliberately not drawn
  // as a formal orbit.
  return status === undefined || status === "active" || status === "disputed";
}

function starStateOf(value: unknown): {
  centerNodeId: string;
  version: number;
  role: string;
  importance: string;
  importanceAuthority?: string;
  salience: string;
  organizingPower?: string;
  freshness: string;
  mass?: string;
  radius?: string;
  auraVersion?: number;
  stateStatus?: string;
  recomputeRequired: boolean;
} | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const centerNodeId = optionalString(record.centerNodeId);
  const role = optionalString(record.role);
  const importance = optionalString(record.importance);
  const salience = optionalString(record.salience);
  const freshness = optionalString(record.freshness);
  const version = Number(record.version);
  const auraVersion = Number(record.auraVersion);
  const importanceAuthority = optionalString(record.importanceAuthority);
  const organizingPower = optionalString(record.organizingPower);
  const mass = optionalString(record.mass);
  const radius = optionalString(record.radius);
  const stateStatus = optionalString(record.stateStatus);
  if (
    !centerNodeId || !role || !importance || !salience || !freshness ||
    !Number.isInteger(version) || version < 1
  ) return undefined;
  return {
    centerNodeId,
    version,
    role,
    importance,
    ...(importanceAuthority ? { importanceAuthority } : {}),
    salience,
    ...(organizingPower ? { organizingPower } : {}),
    freshness,
    ...(mass ? { mass } : {}),
    ...(radius ? { radius } : {}),
    ...(Number.isInteger(auraVersion) && auraVersion >= 0 ? { auraVersion } : {}),
    ...(stateStatus ? { stateStatus } : {}),
    recomputeRequired: record.recomputeRequired === true,
  };
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "外部来源";
  }
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

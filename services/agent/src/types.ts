import type { SessionEvent } from "@deepseek-ai/dsh-session";

export const AGENT_HOST_API_VERSION = "v1" as const;

/** No implicit product limits. Only a caller's explicit budget may stop a run. */
export interface AgentRunBudgets {
  maxSteps?: number;
  maxToolCalls?: number;
  wallClockMs?: number;
  maxOutputTokens?: number;
}

export interface AgentRunRequest {
  useHistory?: boolean;
  /** Stable conversation identity. Runs for the same session are serialized. */
  sessionId: string;
  /** User-authored content for the next ordinary turn. */
  text: string;
  /** Browser retry identity; the Idempotency-Key header remains authoritative. */
  clientRequestId?: string;
  /** Optional per-run Latitude persona fragment. It never carries credentials. */
  systemPrompt?: string;
  budgets?: Partial<AgentRunBudgets>;
  /** Internal provenance. Browser-normalized requests always omit this (= user). */
  initiator?: "user" | "scheduler";
}

export interface InternalAgentRunRequest extends AgentRunRequest {
  runId: string;
  budgets: AgentRunBudgets;
}

export type BudgetStopReason = "step" | "tool" | "wall_clock";

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface BrowserUiCardPatch {
  hidden?: boolean;
  span?: 4 | 5 | 7 | 12;
  title?: string;
}

export const BROWSER_UI_CARD_IDS = [
  "seed-feed",
  "seed-schedule",
  "seed-review-plan",
  "seed-rhythm",
  "seed-flex",
] as const;

export const BROWSER_UI_FIXED_COMPONENT_IDS = [
  "secretary-companion",
  "browser-control-strip",
  "candidate-intervention-strip",
  "browser-thread",
  "outcome-dialog",
  "diagnostics-dialog",
  "data-safety-dialog",
  "command-bar",
  "dimension-navigation",
  "source-inspector-dialog",
] as const;

export const BROWSER_UI_COMPONENT_IDS = [
  ...BROWSER_UI_CARD_IDS,
  ...BROWSER_UI_FIXED_COMPONENT_IDS,
] as const;

export const BROWSER_UI_EVENT_COMMANDS = {
  "seed-feed": {
    feedback: "latitude.feed.feedback",
    lineage: "latitude.lineage.open",
  },
  "seed-schedule": {
    complete: "latitude.anchor.complete",
    edit: "latitude.anchor.edit",
    lineage: "latitude.lineage.open",
  },
  "secretary-companion": {
    chat: "latitude.companion.chat",
    review: "latitude.companion.review",
    outcome: "latitude.companion.outcome",
  },
  "browser-control-strip": {
    search: "latitude.control.search-web",
    refresh: "latitude.control.refresh",
    review: "latitude.companion.review",
    cancel: "latitude.agent.cancel",
  },
  "candidate-intervention-strip": {
    touch: "latitude.candidate.touch",
    shape: "latitude.candidate.shape",
    conclude: "latitude.candidate.conclude",
    park: "latitude.candidate.park",
  },
  "browser-thread": {
    close: "latitude.thread.close",
  },
  "outcome-dialog": {
    submit: "latitude.outcome.submit",
    close: "latitude.outcome.close",
  },
  "diagnostics-dialog": {
    data_safety: "latitude.diagnostics.data-safety",
    close: "latitude.diagnostics.close",
  },
  "data-safety-dialog": {
    export: "latitude.data-safety.export",
    integrity: "latitude.data-safety.integrity",
    restore: "latitude.data-safety.restore",
    delete: "latitude.data-safety.delete",
    purge: "latitude.data-safety.purge",
    rollback: "latitude.data-safety.rollback",
    close: "latitude.data-safety.close",
  },
  "command-bar": {
    send: "latitude.agent.send",
  },
  "dimension-navigation": {
    paper: "latitude.navigation.paper",
    clue: "latitude.navigation.clue",
    constellation: "latitude.navigation.constellation",
  },
  "source-inspector-dialog": {
    close: "latitude.inspector.close",
  },
} as const;

export type BrowserUiCardId = (typeof BROWSER_UI_CARD_IDS)[number];
export type BrowserUiComponentId = (typeof BROWSER_UI_COMPONENT_IDS)[number];

export interface BrowserUiTapePatch {
  side: "left" | "right";
  offset: number;
  width: number;
  color: string;
  tilt: number;
}

/** Presentation-only properties accepted by the trusted Browser registry. */
export interface BrowserUiPresentationPatch {
  eyebrow?: string;
  title?: string;
  tilt?: number;
  paper?: "plain" | "sticky" | "grid" | "newsprint";
  offsetY?: number;
  tape?: BrowserUiTapePatch;
  clip?: boolean;
  dogear?: boolean;
}

/**
 * Closed UiSurfaceV2 input vocabulary. Component renderers and command
 * implementations remain host-owned; an Agent can only patch these fields.
 */
type BrowserUiActionComponentId = keyof typeof BROWSER_UI_EVENT_COMMANDS;

type AgentUiBindingOperation = {
  [ComponentId in BrowserUiActionComponentId]: {
    [Event in keyof (typeof BROWSER_UI_EVENT_COMMANDS)[ComponentId] & string]: {
      op: "bind_action";
      componentId: ComponentId;
      event: Event;
      commandId: (typeof BROWSER_UI_EVENT_COMMANDS)[ComponentId][Event] | null;
    }
  }[keyof (typeof BROWSER_UI_EVENT_COMMANDS)[ComponentId] & string]
}[BrowserUiActionComponentId];

export type AgentUiDraftOperation =
  | { op: "set_visibility"; componentId: BrowserUiComponentId; visible: boolean }
  | { op: "move" | "set_order"; componentId: BrowserUiCardId; order: number }
  | {
      op: "resize";
      componentId: BrowserUiCardId;
      columnSpan: 4 | 5 | 7 | 12;
      rowSpan: 1;
    }
  | { op: "set_span"; componentId: BrowserUiCardId; span: 4 | 5 | 7 | 12 }
  | {
      op: "set_props";
      componentId: BrowserUiCardId;
      presentation: BrowserUiPresentationPatch;
    }
  | { op: "set_title"; componentId: BrowserUiCardId; title: string }
  | AgentUiBindingOperation;

/**
 * Browser-safe projection of one successful ui_customize tool call.
 * Extra Domain receipt fields stay available for audit/rollback while the
 * browser consumes only the declarative card/order fields.
 */
export interface AgentUiChangeSetDraft {
  schemaVersion: 2;
  surfaceId: "latitude-browser-live";
  reason: string;
  operations: AgentUiDraftOperation[];
  /** Legacy projection retained for older Browser builds; V2 consumes operations. */
  cards?: Record<string, BrowserUiCardPatch>;
  orderedCardIds?: string[];
  sourceRunId: string;
  baseRevision: number;
  domainChangeSetId?: string;
  domainNodeId?: string;
}

export interface AgentSessionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  seq: number;
  explanation?: AgentResponseExplanation;
}

export interface AgentDailyCurationResult {
  dateKey: string;
  itemCount: number;
  resourceChangeId?: string;
  resourceNodeId?: string;
}

/**
 * User-facing explanation of one answer. This is an auditable summary of
 * evidence and completed actions, never a model chain-of-thought transcript.
 */
export interface AgentResponseExplanation {
  summary: string;
  steps: string[];
  uncertainty?: string;
}

export interface AgentRunResult {
  runId: string;
  sessionId: string;
  status: "completed" | "cancelled" | "budget_exhausted";
  assistantText: string;
  budgetStopReason?: BudgetStopReason;
  stepsUsed: number;
  toolCallsUsed: number;
  startedAt: string;
  finishedAt: string;
  usage: RunUsage;
  /** Safe, human-readable rationale for progressive disclosure in the Browser. */
  explanation?: AgentResponseExplanation;
  /** Present only after a successful, persisted ui_customize tool execution. */
  uiChangeSet?: AgentUiChangeSetDraft;
  /** Present only when the restricted daily curation tool persisted its resource. */
  dailyCuration?: AgentDailyCurationResult;
  /** Events produced by this run only. Full history stays in the session ledger. */
  events: SessionEvent[];
}

export type RunJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "budget_exhausted"
  | "failed"
  | "cancelled";

export interface PublicRunError {
  code: string;
  message: string;
}

export interface PublicRunJob {
  runId: string;
  status: RunJobStatus;
  request: AgentRunRequest & { budgets: AgentRunBudgets };
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancellationRequestedAt?: string;
  result?: AgentRunResult;
  error?: PublicRunError;
  /** Local retry key; safe metadata, never a model/provider credential. */
  idempotencyKey?: string;
  requestFingerprint?: string;
}

export function normalizeRunBudgets(
  input: Partial<AgentRunBudgets> | undefined,
): AgentRunBudgets {
  const budgets: AgentRunBudgets = {};
  for (const key of ["maxSteps", "maxToolCalls", "wallClockMs", "maxOutputTokens"] as const) {
    const value = input?.[key];
    // Omission, null and zero all mean "use the framework/provider default".
    if (value == null || value === 0) continue;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`budgets.${key} must be a non-negative safe integer`);
    }
    budgets[key] = value;
  }
  return budgets;
}

export function normalizeRunRequest(input: unknown): AgentRunRequest & {
  budgets: AgentRunBudgets;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("request body must be an object");
  }
  const record = input as Record<string, unknown>;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  if (!sessionId || sessionId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(sessionId)) {
    throw new TypeError(
      "sessionId must be 1-128 characters using letters, numbers, dot, underscore, colon, or dash",
    );
  }
  const text = typeof record.text === "string"
    ? record.text
    : typeof record.message === "string"
      ? record.message
      : undefined;
  if (typeof text !== "string" || !text.trim()) {
    throw new TypeError("text must be a non-empty string");
  }
  if (text.length > 200_000) {
    throw new TypeError("text must not exceed 200000 characters");
  }
  if (
    record.clientRequestId !== undefined &&
    (typeof record.clientRequestId !== "string" ||
      !record.clientRequestId.trim() ||
      record.clientRequestId.length > 200)
  ) {
    throw new TypeError("clientRequestId must be a non-empty string up to 200 characters");
  }
  if (record.systemPrompt !== undefined && typeof record.systemPrompt !== "string") {
    throw new TypeError("systemPrompt must be a string when provided");
  }
  if (record.useHistory !== undefined && typeof record.useHistory !== "boolean") throw new TypeError("useHistory must be a boolean");
  if (typeof record.systemPrompt === "string" && record.systemPrompt.length > 100_000) {
    throw new TypeError("systemPrompt must not exceed 100000 characters");
  }
  if (
    record.budgets !== undefined &&
    (!record.budgets || typeof record.budgets !== "object" || Array.isArray(record.budgets))
  ) {
    throw new TypeError("budgets must be an object when provided");
  }
  return {
    sessionId,
    text,
    ...(typeof record.useHistory === "boolean" ? {useHistory:record.useHistory} : {}),
    ...(typeof record.clientRequestId === "string"
      ? { clientRequestId: record.clientRequestId.trim() }
      : {}),
    ...(typeof record.systemPrompt === "string"
      ? { systemPrompt: record.systemPrompt }
      : {}),
    budgets: normalizeRunBudgets(record.budgets as Partial<AgentRunBudgets> | undefined),
  };
}

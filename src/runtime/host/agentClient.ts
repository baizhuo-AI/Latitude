import type { RuntimeJson, RuntimeRequestOptions } from "./DesktopRuntimePort";

export type AgentRunState =
  | "queued"
  | "running"
  | "completed"
  /** rc.6 Host 内部旧名；浏览器默认以 completed 为终态。 */
  | "succeeded"
  | "failed"
  | "cancelled";

export interface AgentHistoryMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
  seq?: number;
}

export interface AgentSessionMessagesResponse {
  sessionId: string;
  messages: AgentHistoryMessage[];
}

export interface SchedulerOutboxItem {
  receiptKey: string;
  runId: string;
  /**
   * Host may add durable delivery kinds (for example a curated web digest)
   * independently of a browser release. Keep the transport forward-compatible;
   * the UI gives known kinds tailored copy and still displays/acks unknown ones.
   */
  kind: string;
  /** Stable Domain entity id for typed follow-up actions. */
  domainId: string;
  dueAt: string;
  text: string;
  deliveryStatus: "pending" | "acknowledged";
  createdAt: string;
  acknowledgedAt?: string;
}

export interface SchedulerOutboxResponse {
  items: SchedulerOutboxItem[];
}

/** Credential-free snapshot of the Agent Host's durable local ledgers. */
export interface AgentHostSnapshot {
  schemaVersion: 1;
  exportedAt: string;
  checksum: string;
  files: Record<string, string>;
}

export interface AgentHostIntegrityReport {
  ok: boolean;
  checksum: string;
  fileCount: number;
  issues: string[];
}

export interface AgentPrepareDangerousRequest {
  operation: "restore" | "delete_all" | "purge_all";
  snapshot?: AgentHostSnapshot;
}

export interface AgentPreparedDangerousOperation {
  token: string;
  operation: "restore" | "delete_all" | "purge_all";
  confirmationPhrase: string;
  expiresAt: string;
  snapshot?: AgentHostSnapshot;
}

export interface AgentCommitDangerousRequest {
  token: string;
  confirmation: string;
}

export interface AgentDangerousCommitResult {
  ok: boolean;
  operation: "restore" | "delete_all" | "purge_all";
  /** Purge may consume its one-shot token while preserving unsafe/unowned paths. */
  status?: "complete" | "partial" | string;
  checksum: string;
  /** True means at least one Agent-owned recovery artifact still exists. */
  recoverable?: boolean;
  /** Exact Host readback for entries it refused or failed to remove. */
  preservedEntries?: string[];
  backupCleanup?: {
    removedEntries?: string[];
    preservedEntries?: string[];
    [key: string]: RuntimeJson | undefined;
  };
  /** purge_all is intentionally unrecoverable and therefore has no backup. */
  backupPath?: string;
  rawBackupPath?: string;
  /** The state swap is complete, but normal Agent routes must wait for restart. */
  restartRequired: boolean;
}

export interface AgentTurnBudgets {
  maxSteps?: number;
  maxToolCalls?: number;
  wallClockMs?: number;
  maxOutputTokens?: number;
}

export interface AgentTurnRequest {
  sessionId: string;
  text: string;
  systemPrompt?: string;
  budgets?: AgentTurnBudgets;
  /** 调用方生成，供 Host 去重 POST 重试。 */
  clientRequestId?: string;
}

export interface AgentRunAccepted {
  runId: string;
  status: AgentRunState;
  sessionId?: string;
  acceptedAt?: string;
  pollUrl?: string;
}

export interface AgentRunError {
  code?: string;
  message: string;
  retryable?: boolean;
}

export interface AgentExecutionResult {
  runId: string;
  sessionId: string;
  status: "completed" | "cancelled" | "budget_exhausted";
  assistantText: string;
  budgetStopReason?: "step" | "tool" | "wall_clock";
  stepsUsed: number;
  toolCallsUsed: number;
  startedAt: string;
  finishedAt: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
  };
  events?: RuntimeJson[];
  [key: string]: unknown;
}

/** GET /v1/agent/runs/:id 的持久任务快照。 */
export interface AgentRunResult {
  runId: string;
  status: AgentRunState;
  request?: AgentTurnRequest & { budgets?: AgentTurnBudgets };
  result?: AgentExecutionResult;
  /** 兼容 Host 将执行结果扁平化后的字段。 */
  assistantText?: string;
  content?: string;
  error?: AgentRunError;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  [key: string]: unknown;
}

export interface AgentWaitOptions extends RuntimeRequestOptions {
  /** 两次状态读取的间隔。 */
  pollIntervalMs?: number;
  /** 整个任务（含排队）的等待上限；到点只停止等待，不偷偷取消 Host 任务。 */
  waitTimeoutMs?: number;
  onStatus?: (run: AgentRunResult) => void;
}

export interface WebSearchRequest {
  query: string;
  maxResults?: number;
  freshnessDays?: number;
  /** 调用方生成，避免断线重试重复记账。 */
  clientRequestId?: string;
}

export interface WebSearchItem {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
  retrievedAt?: string;
  source?: string;
  provider?: string;
  query?: string;
  whyNow?: string;
  queryId?: string;
  contentHash?: string;
  evidenceNodeId?: string;
  evidenceRefId?: string;
  [key: string]: unknown;
}

export interface WebSearchResponse {
  query: string;
  results: WebSearchItem[];
  retrievedAt?: string;
  coverage?: WebSearchCoverage;
}

export interface WebSearchCoverage {
  mode: "provider_default" | "published_at_post_filter";
  providerSupportsFreshness: false;
  requestedFreshnessDays?: number;
  cutoff?: string;
  providerResultCount: number;
  datedResultCount: number;
  excludedUndatedCount: number;
  excludedStaleCount: number;
  returnedResultCount: number;
  /** Official provider retrieval is bounded/ranked, never an exhaustive corpus scan. */
  exhaustive: false;
}

export interface AgentClient {
  health(options?: RuntimeRequestOptions): Promise<Record<string, RuntimeJson>>;
  startTurn(
    request: AgentTurnRequest,
    options?: RuntimeRequestOptions
  ): Promise<AgentRunAccepted>;
  getRun(runId: string, options?: RuntimeRequestOptions): Promise<AgentRunResult>;
  waitForRun(runId: string, options?: AgentWaitOptions): Promise<AgentRunResult>;
  cancelRun(runId: string, options?: RuntimeRequestOptions): Promise<AgentRunResult>;
  listMessages(
    sessionId: string,
    options?: RuntimeRequestOptions
  ): Promise<AgentSessionMessagesResponse>;
  listSchedulerOutbox(
    options?: RuntimeRequestOptions
  ): Promise<SchedulerOutboxResponse>;
  acknowledgeSchedulerOutbox(
    receiptKey: string,
    options?: RuntimeRequestOptions
  ): Promise<SchedulerOutboxItem>;
  exportState(options?: RuntimeRequestOptions): Promise<AgentHostSnapshot>;
  checkIntegrity(
    options?: RuntimeRequestOptions
  ): Promise<AgentHostIntegrityReport>;
  prepareDangerousData(
    request: AgentPrepareDangerousRequest,
    options?: RuntimeRequestOptions
  ): Promise<AgentPreparedDangerousOperation>;
  commitDangerousData(
    request: AgentCommitDangerousRequest,
    options?: RuntimeRequestOptions
  ): Promise<AgentDangerousCommitResult>;
  search(
    request: WebSearchRequest,
    options?: RuntimeRequestOptions
  ): Promise<WebSearchResponse>;
}

export function isTerminalAgentRun(state: AgentRunState): boolean {
  return (
    state === "completed" ||
    state === "succeeded" ||
    state === "failed" ||
    state === "cancelled"
  );
}

/** UI 只在终态读取；不把任务快照结构泄漏进卡片组件。 */
export function assistantTextFromRun(run: AgentRunResult): string {
  return run.result?.assistantText ?? run.assistantText ?? run.content ?? "";
}

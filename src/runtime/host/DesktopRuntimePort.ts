import type {
  AgentClient,
  AgentRunResult,
  AgentTurnRequest,
  AgentWaitOptions,
  WebSearchRequest,
  WebSearchResponse
} from "./agentClient";

/**
 * 浏览器桌面与本机服务之间唯一允许依赖的可序列化值。
 *
 * Domain / Agent Host 的协议刻意不暴露 API key，也不允许把函数、Blob 等
 * 浏览器对象偷偷塞进请求；这样同一份契约以后也能被 Tauri adapter 复用。
 */
export type RuntimeJson =
  | null
  | boolean
  | number
  | string
  | RuntimeJson[]
  | { [key: string]: RuntimeJson };

export interface RuntimeRequestOptions {
  /** 调用方离开页面或主动停止时，中断等待和网络请求。 */
  signal?: AbortSignal;
  /** 单次 HTTP 尝试的上限；未传时使用 runtime 默认值。 */
  timeoutMs?: number;
  /** 断线 / 502 / 503 / 504 时的额外尝试次数。 */
  retries?: number;
  /** 写操作的幂等键；相同键重试不能产生两次事实。 */
  idempotencyKey?: string;
}

export type RuntimeServiceName = "agent" | "domain";
export type RuntimeServiceState = "ready" | "starting" | "unavailable";

export interface RuntimeServiceHealth {
  service: RuntimeServiceName;
  state: RuntimeServiceState;
  checkedAt: string;
  version?: string;
  /** 服务返回的非敏感诊断信息。 */
  details?: Record<string, RuntimeJson>;
}

export interface DesktopRuntimeHealth {
  state: RuntimeServiceState;
  checkedAt: string;
  agent: RuntimeServiceHealth;
  domain: RuntimeServiceHealth;
}

export interface KnowledgeContextQuery {
  /** 自然语言或全文检索词，由 Domain 解释。 */
  query?: string;
  limit?: number;
  kinds?: string[];
  /** 只约束 evidence_event；语义节点不受影响。 */
  evidenceTypes?: Array<"message" | "activity">;
  includeRetracted?: boolean;
  sensitivityCeiling?: "low" | "medium" | "high" | "highest";
}

export interface KnowledgeNode {
  id: string;
  kind: string;
  title?: string;
  content?: string;
  authority?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface KnowledgeEdge {
  id: string;
  sourceId?: string;
  targetId?: string;
  kind?: string;
  fromNodeId?: string;
  toNodeId?: string;
  relationType?: string;
  proximity?: string;
  strength?: string;
  [key: string]: unknown;
}

export interface KnowledgeContext {
  ok?: boolean;
  generatedAt?: string;
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  starStates?: RuntimeJson[];
  /** 兼容 Domain 在契约演进中增加的只读投影。 */
  [key: string]: unknown;
}

export interface AuditContext {
  actor?: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  authorizationMode?: "automatic" | "preauthorized";
}

export interface RememberChangeRequest {
  operation: "remember";
  label: string;
  statement?: string;
  kind?: string;
  payload?: RuntimeJson;
  scope?: RuntimeJson;
  sensitivity?: string;
  expectedOutcome?: string;
  reviewAt?: string;
  outcome?: string;
  audit?: AuditContext;
}

export interface UpdateChangeRequest {
  operation: "update";
  id: string;
  label?: string;
  statement?: string;
  payload?: RuntimeJson;
  status?: string;
  expectedOutcome?: string;
  reviewAt?: string;
  outcome?: string;
  audit?: AuditContext;
}

export interface RetractChangeRequest {
  operation: "retract";
  id: string;
  reason: string;
  audit?: AuditContext;
}

export interface RollbackChangeRequest {
  operation: "rollback";
  changeSetId: string;
  reason?: string;
  audit?: AuditContext;
}

export type ApplyChangeRequest =
  | RememberChangeRequest
  | UpdateChangeRequest
  | RetractChangeRequest
  | RollbackChangeRequest;

export interface MutationReceipt<T = RuntimeJson> {
  ok: boolean;
  changeSetId: string;
  value: T;
  [key: string]: unknown;
}

export type ChangeReceipt = MutationReceipt<RuntimeJson>;

export interface RecordActivityRequest {
  content: string;
  occurredAt: string;
  sensitivity?: "low" | "medium" | "high" | "highest";
  audit?: AuditContext;
}

export interface ActivityCaptureValue {
  sourceRecordId: string;
  evidenceRefId: string;
  nodeId: string;
  node: KnowledgeNode;
}

export interface ChangeSetRecord {
  id: string;
  status: string;
  reasonType?: string;
  rationale?: string;
  proposerActor?: string;
  authorizationMode?: string;
  reversible?: boolean;
  createdAt?: string;
  appliedAt?: string;
  inverseChangeSetId?: string;
  operations?: RuntimeJson[];
  [key: string]: unknown;
}

export interface CreateActionRequest {
  label: string;
  statement?: string;
  /** Concrete situation/cue that starts the experiment. */
  trigger: string;
  expectedOutcome: string;
  /** Duration or structured start/end window in which reality is observed. */
  observationWindow: string | Record<string, RuntimeJson>;
  reviewAt: string;
  payload?: RuntimeJson;
  scope?: RuntimeJson;
  sensitivity?: string;
  claimId?: string;
  audit?: AuditContext;
}

export interface ActionRecord {
  id: string;
  label?: string;
  title?: string;
  expectedOutcome?: string;
  trigger?: string;
  observationWindow?: string | Record<string, RuntimeJson>;
  reviewAt?: string;
  status?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export type CandidateState =
  | "proposed"
  | "touched"
  | "shaping"
  | "concluded"
  | "parked";

export type CandidateCommand =
  | "touch"
  | "shape"
  | "conclude"
  | "park"
  | "acknowledge_due";

export interface CreateCandidateRequest {
  label: string;
  statement: string;
  sourceNodeIds?: string[];
  evidenceRefs?: string[];
  payload?: RuntimeJson;
  scope?: RuntimeJson;
  sensitivity?: string;
  audit?: AuditContext;
}

export interface CommandCandidateRequest {
  candidateId: string;
  command: CandidateCommand;
  note?: string;
  evidenceRefs?: string[];
  audit?: AuditContext;
}

export interface CandidateRecord extends KnowledgeNode {
  label?: string;
  statement?: string;
  status?: string;
  payload?: RuntimeJson;
}

export interface CandidateCommandReceipt {
  command: CandidateCommand | "create";
  previousState?: CandidateState | null;
  state: CandidateState;
  dueKind?: "proposed_silence" | "shaping_followup" | null;
  recordedAt: string;
  changeSetId: string;
}

export interface CandidateMutationValue {
  candidate: CandidateRecord;
  receipt: CandidateCommandReceipt;
  sourceEdges?: RuntimeJson[];
  evidenceEdges?: RuntimeJson[];
}

export interface DueCandidateQuery {
  at?: string;
  limit?: number;
  sensitivityCeiling?: string;
}

export interface DueCandidateItem {
  candidate: CandidateRecord;
  dueKind: "proposed_silence" | "shaping_followup";
  dueAt: string;
  receiptKey: string;
  recommendedCommand: "park" | "acknowledge_due";
  prompt: string;
}

export interface DueCandidatesResponse {
  ok: boolean;
  dueBefore: string;
  sensitivityCeiling: string;
  items: DueCandidateItem[];
  mutationPolicy?: string;
}

export type OutcomeEffect = "confirms" | "contracts" | "revises" | "refutes" | "unknown";

export interface RecordOutcomeRequest {
  actionId: string;
  label?: string;
  outcome: string;
  observedAt?: string;
  effect?: OutcomeEffect;
  claimId?: string;
  revisedStatement?: string;
  payload?: RuntimeJson;
  audit?: AuditContext;
}

export type FeedbackType = "confirm" | "reject" | "correct" | "outcome";

export interface ApplyFeedbackRequest {
  feedbackType: FeedbackType;
  targetNodeId: string;
  evidenceRefs: string[];
  correctedStatement?: string;
  correctedScope?: RuntimeJson;
  outcome?: {
    actionId: string;
    outcome: string;
    observedAt?: string;
    effect: OutcomeEffect;
    claimId?: string;
    revisedStatement?: string;
    payload?: RuntimeJson;
  };
  audit?: AuditContext;
}

export interface FeedbackValue {
  targetNodeId?: string;
  feedbackType?: FeedbackType;
  [key: string]: unknown;
}

export interface OutcomeRecord {
  id: string;
  actionId: string;
  outcome?: string;
  result?: string;
  observedAt?: string;
  revisionChangeSetId?: string;
  [key: string]: unknown;
}

export interface WeeklyReviewRequest {
  /** 省略时由 Domain 按本地时区生成最近完整周。 */
  periodStart?: string;
  periodEnd?: string;
  audit?: AuditContext;
}

export interface ReviewRecord {
  id: string;
  periodStart?: string;
  periodEnd?: string;
  summary?: string;
  generatedAt?: string;
  [key: string]: unknown;
}

export interface WeeklyReviewValue {
  review?: ReviewRecord;
  node?: KnowledgeNode;
  dueActions?: RuntimeJson[];
  outcomes?: RuntimeJson[];
  pendingRevisions?: RuntimeJson[];
  sections?: {
    singleLoop: {
      dueActions: RuntimeJson[];
      outcomes: RuntimeJson[];
      noEvidenceActions: RuntimeJson[];
    };
    doubleLoop: {
      changedClaims: RuntimeJson[];
      contradictions: RuntimeJson[];
      pendingRevisions: RuntimeJson[];
      reframePrompts: RuntimeJson[];
      candidates?: {
        open: RuntimeJson[];
        concluded: RuntimeJson[];
        parked: RuntimeJson[];
      };
    };
  };
  [key: string]: unknown;
}

export interface DomainExportDocument {
  format: "latitude.constellation.export@0.1";
  schemaVersion: string;
  exportedAt: string;
  checksum: string;
  data: RuntimeJson;
}

export interface DomainIntegrityReport {
  ok: boolean;
  quickCheck?: string;
  foreignKeyViolations?: RuntimeJson[];
  migrationCount?: number;
  counts?: Record<string, RuntimeJson>;
  [key: string]: unknown;
}

export interface PrepareDangerousDataRequest {
  operation: "restore" | "delete_all" | "purge_all";
  snapshot?: DomainExportDocument;
}

export interface PreparedDangerousDataOperation {
  ok: boolean;
  operation: "restore" | "delete_all" | "purge_all";
  token: string;
  expiresAt: string;
  requiredConfirmation: string;
  snapshotChecksum?: string;
}

export interface CommitDangerousDataRequest {
  token: string;
  confirmation: string;
}

export interface DomainDangerousCommitResult {
  ok: boolean;
  operation?: "restore" | "delete_all" | "purge_all";
  status?: "complete" | "partial" | string;
  changeSetId?: string;
  value?: RuntimeJson;
  recoverable?: boolean;
  [key: string]: unknown;
}

/**
 * Living UI 只认这个端口，不直接 import Tauri IPC、fetch 或厂商 SDK。
 * P0 浏览器使用 HttpDesktopRuntime；桌面壳以后可提供同形的 Tauri adapter。
 */
export interface DesktopRuntimePort {
  readonly kind: "http" | "tauri";
  readonly agent: AgentClient;

  health(options?: RuntimeRequestOptions): Promise<DesktopRuntimeHealth>;
  getContext(
    query?: KnowledgeContextQuery,
    options?: RuntimeRequestOptions
  ): Promise<KnowledgeContext>;
  applyChange(
    request: ApplyChangeRequest,
    options?: RuntimeRequestOptions
  ): Promise<ChangeReceipt>;
  /** 把用户自己记下的已发生事项保存为带来源的 evidence_event。 */
  recordActivity(
    request: RecordActivityRequest,
    options?: RuntimeRequestOptions
  ): Promise<MutationReceipt<ActivityCaptureValue>>;
  listChangeSets(options?: RuntimeRequestOptions): Promise<ChangeSetRecord[]>;
  createAction(
    request: CreateActionRequest,
    options?: RuntimeRequestOptions
  ): Promise<MutationReceipt<ActionRecord>>;
  createCandidate(
    request: CreateCandidateRequest,
    options?: RuntimeRequestOptions
  ): Promise<MutationReceipt<CandidateMutationValue>>;
  commandCandidate(
    request: CommandCandidateRequest,
    options?: RuntimeRequestOptions
  ): Promise<MutationReceipt<CandidateMutationValue>>;
  listDueCandidates(
    query?: DueCandidateQuery,
    options?: RuntimeRequestOptions
  ): Promise<DueCandidatesResponse>;
  recordOutcome(
    request: RecordOutcomeRequest,
    options?: RuntimeRequestOptions
  ): Promise<MutationReceipt<OutcomeRecord>>;
  applyFeedback(
    request: ApplyFeedbackRequest,
    options?: RuntimeRequestOptions
  ): Promise<MutationReceipt<FeedbackValue>>;
  createWeeklyReview(
    request?: WeeklyReviewRequest,
    options?: RuntimeRequestOptions
  ): Promise<MutationReceipt<WeeklyReviewValue>>;

  /** Deep-entry data controls; destructive calls always require prepare+commit. */
  exportDomainData(options?: RuntimeRequestOptions): Promise<DomainExportDocument>;
  checkDomainIntegrity(options?: RuntimeRequestOptions): Promise<DomainIntegrityReport>;
  prepareDangerousData(
    request: PrepareDangerousDataRequest,
    options?: RuntimeRequestOptions
  ): Promise<PreparedDangerousDataOperation>;
  commitDangerousData(
    request: CommitDangerousDataRequest,
    options?: RuntimeRequestOptions
  ): Promise<DomainDangerousCommitResult>;

  runAgentTurn(
    request: AgentTurnRequest,
    options?: AgentWaitOptions
  ): Promise<AgentRunResult>;
  searchWeb(
    request: WebSearchRequest,
    options?: RuntimeRequestOptions
  ): Promise<WebSearchResponse>;
}

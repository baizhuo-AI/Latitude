import type {
  AgentClient,
  AgentCommitDangerousRequest,
  AgentDangerousCommitResult,
  AgentHostIntegrityReport,
  AgentHostSnapshot,
  AgentPreparedDangerousOperation,
  AgentPrepareDangerousRequest,
  AgentRunAccepted,
  AgentRunResult,
  AgentSessionMessagesResponse,
  SchedulerOutboxItem,
  SchedulerOutboxResponse,
  AgentTurnRequest,
  AgentWaitOptions,
  WebSearchRequest,
  WebSearchResponse
} from "./agentClient";
import { isTerminalAgentRun } from "./agentClient";
import type {
  ActionRecord,
  ApplyFeedbackRequest,
  ApplyChangeRequest,
  CandidateMutationValue,
  ChangeSetRecord,
  ChangeReceipt,
  CommandCandidateRequest,
  CommitDangerousDataRequest,
  CreateActionRequest,
  CreateCandidateRequest,
  DomainExportDocument,
  DomainDangerousCommitResult,
  DomainIntegrityReport,
  DesktopRuntimeHealth,
  DesktopRuntimePort,
  DueCandidateQuery,
  DueCandidatesResponse,
  FeedbackValue,
  KnowledgeContext,
  KnowledgeContextQuery,
  OutcomeRecord,
  PrepareDangerousDataRequest,
  PreparedDangerousDataOperation,
  RecordOutcomeRequest,
  MutationReceipt,
  RuntimeJson,
  RuntimeRequestOptions,
  RuntimeServiceHealth,
  WeeklyReviewRequest,
  WeeklyReviewValue
} from "./DesktopRuntimePort";
import {
  abortableDelay,
  createRuntimeRequestId,
  LocalJsonHttpClient,
  LocalRuntimeError,
  type LocalHttpOptions
} from "./localHttp";

export interface HttpDesktopRuntimeRoutes {
  agentHealth: string;
  agentTurns: string;
  agentRun: (runId: string) => string;
  agentCancel: (runId: string) => string;
  agentMessages: (sessionId: string) => string;
  schedulerOutbox: string;
  schedulerAck: (receiptKey: string) => string;
  agentExportData: string;
  agentIntegrity: string;
  agentPrepareDangerous: string;
  agentCommitDangerous: string;
  schedulerWake: string;
  webSearch: string;
  domainHealth: string;
  context: string;
  change: string;
  action: string;
  candidate: string;
  candidateDue: string;
  candidateCommand: (candidateId: string) => string;
  outcome: string;
  review: string;
  applyFeedback: string;
  exportData: string;
  integrity: string;
  prepareDangerous: string;
  commitDangerous: string;
}

export interface HttpDesktopRuntimeOptions extends LocalHttpOptions {
  agentBaseUrl?: string;
  domainBaseUrl?: string;
  routes?: Partial<HttpDesktopRuntimeRoutes>;
  pollIntervalMs?: number;
}

const DEFAULT_ROUTES: HttpDesktopRuntimeRoutes = {
  agentHealth: "/health",
  agentTurns: "/v1/agent/turns",
  agentRun: (runId) => `/v1/agent/runs/${encodeURIComponent(runId)}`,
  agentCancel: (runId) =>
    `/v1/agent/runs/${encodeURIComponent(runId)}/cancel`,
  agentMessages: (sessionId) =>
    `/v1/agent/sessions/${encodeURIComponent(sessionId)}/messages?limit=100`,
  schedulerOutbox: "/v1/scheduler/outbox",
  schedulerAck: (receiptKey) =>
    `/v1/scheduler/outbox/${encodeURIComponent(receiptKey)}/ack`,
  agentExportData: "/v1/agent/admin/export",
  agentIntegrity: "/v1/agent/admin/integrity",
  agentPrepareDangerous: "/v1/agent/admin/dangerous/prepare",
  agentCommitDangerous: "/v1/agent/admin/dangerous/commit",
  schedulerWake: "/v1/scheduler/wake",
  webSearch: "/v1/web/search",
  domainHealth: "/health",
  context: "/v1/context",
  change: "/v1/changes",
  action: "/v1/actions",
  candidate: "/v1/candidates",
  candidateDue: "/v1/candidates/due",
  candidateCommand: (candidateId) =>
    `/v1/candidates/${encodeURIComponent(candidateId)}/commands`,
  outcome: "/v1/outcomes",
  review: "/v1/reviews",
  applyFeedback: "/v1/star-map/apply-feedback",
  exportData: "/v1/admin/export",
  integrity: "/v1/admin/integrity",
  prepareDangerous: "/v1/admin/dangerous/prepare",
  commitDangerous: "/v1/admin/dangerous/commit"
};

export class HttpDesktopRuntime implements DesktopRuntimePort {
  readonly kind = "http" as const;
  readonly agent: AgentClient;
  private readonly agentHttp: LocalJsonHttpClient;
  private readonly domainHttp: LocalJsonHttpClient;
  private readonly routes: HttpDesktopRuntimeRoutes;
  private readonly pollIntervalMs: number;

  constructor(options: HttpDesktopRuntimeOptions = {}) {
    this.routes = { ...DEFAULT_ROUTES, ...options.routes };
    this.pollIntervalMs = positiveInt(options.pollIntervalMs, 300);
    this.agentHttp = new LocalJsonHttpClient(
      options.agentBaseUrl ??
        import.meta.env?.VITE_LATITUDE_AGENT_URL ??
        "http://127.0.0.1:43120",
      options
    );
    this.domainHttp = new LocalJsonHttpClient(
      options.domainBaseUrl ??
        import.meta.env?.VITE_LATITUDE_DOMAIN_URL ??
        "http://127.0.0.1:43121",
      options
    );
    this.agent = this.createAgentClient();
  }

  async health(options: RuntimeRequestOptions = {}): Promise<DesktopRuntimeHealth> {
    const checkedAt = new Date().toISOString();
    const [agent, domain] = await Promise.all([
      this.readHealth("agent", this.agentHttp, this.routes.agentHealth, options),
      this.readHealth("domain", this.domainHttp, this.routes.domainHealth, options)
    ]);
    const state =
      agent.state === "ready" && domain.state === "ready"
        ? "ready"
        : agent.state === "unavailable" || domain.state === "unavailable"
          ? "unavailable"
          : agent.state === "starting" || domain.state === "starting"
          ? "starting"
          : "unavailable";
    return { state, checkedAt, agent, domain };
  }

  async getContext(
    query: KnowledgeContextQuery = {},
    options: RuntimeRequestOptions = {}
  ): Promise<KnowledgeContext> {
    return this.domainHttp.json<KnowledgeContext>(this.routes.context, {
      ...options,
      method: "POST",
      retryable: true,
      idempotencyKey: options.idempotencyKey ?? createRuntimeRequestId("context"),
      body: query as unknown as RuntimeJson
    });
  }

  async applyChange(
    request: ApplyChangeRequest,
    options: RuntimeRequestOptions = {}
  ): Promise<ChangeReceipt> {
    return this.domainWrite<ChangeReceipt>(this.routes.change, request, options, "chg");
  }

  async listChangeSets(
    options: RuntimeRequestOptions = {}
  ): Promise<ChangeSetRecord[]> {
    const response = await this.domainHttp.json<{
      items?: ChangeSetRecord[];
      changeSets?: ChangeSetRecord[];
    }>(`${this.routes.change}?limit=100`, {
      ...options,
      retryable: true
    });
    return response.items ?? response.changeSets ?? [];
  }

  async createAction(
    request: CreateActionRequest,
    options: RuntimeRequestOptions = {}
  ): Promise<MutationReceipt<ActionRecord>> {
    return this.domainWrite<MutationReceipt<ActionRecord>>(
      this.routes.action,
      request,
      options,
      "act"
    );
  }

  async createCandidate(
    request: CreateCandidateRequest,
    options: RuntimeRequestOptions = {}
  ): Promise<MutationReceipt<CandidateMutationValue>> {
    return this.domainWrite<MutationReceipt<CandidateMutationValue>>(
      this.routes.candidate,
      request,
      options,
      "candidate"
    );
  }

  async commandCandidate(
    request: CommandCandidateRequest,
    options: RuntimeRequestOptions = {}
  ): Promise<MutationReceipt<CandidateMutationValue>> {
    const { candidateId, ...command } = request;
    return this.domainWrite<MutationReceipt<CandidateMutationValue>>(
      this.routes.candidateCommand(candidateId),
      command,
      options,
      `candidate_${request.command}`
    );
  }

  listDueCandidates(
    query: DueCandidateQuery = {},
    options: RuntimeRequestOptions = {}
  ): Promise<DueCandidatesResponse> {
    const search = new URLSearchParams();
    if (query.at) search.set("at", query.at);
    if (query.limit !== undefined) search.set("limit", String(query.limit));
    if (query.sensitivityCeiling) {
      search.set("sensitivityCeiling", query.sensitivityCeiling);
    }
    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    return this.domainHttp.json<DueCandidatesResponse>(
      `${this.routes.candidateDue}${suffix}`,
      { ...options, retryable: true }
    );
  }

  async recordOutcome(
    request: RecordOutcomeRequest,
    options: RuntimeRequestOptions = {}
  ): Promise<MutationReceipt<OutcomeRecord>> {
    return this.domainWrite<MutationReceipt<OutcomeRecord>>(
      this.routes.outcome,
      request,
      options,
      "out"
    );
  }

  async applyFeedback(
    request: ApplyFeedbackRequest,
    options: RuntimeRequestOptions = {}
  ): Promise<MutationReceipt<FeedbackValue>> {
    return this.domainWrite<MutationReceipt<FeedbackValue>>(
      this.routes.applyFeedback,
      request,
      options,
      "feedback"
    );
  }

  async createWeeklyReview(
    request: WeeklyReviewRequest = {},
    options: RuntimeRequestOptions = {}
  ): Promise<MutationReceipt<WeeklyReviewValue>> {
    return this.domainWrite<MutationReceipt<WeeklyReviewValue>>(
      this.routes.review,
      request,
      options,
      "rev"
    );
  }

  exportDomainData(
    options: RuntimeRequestOptions = {}
  ): Promise<DomainExportDocument> {
    return this.domainHttp.json<DomainExportDocument>(this.routes.exportData, {
      ...options,
      retryable: true
    });
  }

  checkDomainIntegrity(
    options: RuntimeRequestOptions = {}
  ): Promise<DomainIntegrityReport> {
    return this.domainHttp.json<DomainIntegrityReport>(this.routes.integrity, {
      ...options,
      retryable: true
    });
  }

  prepareDangerousData(
    request: PrepareDangerousDataRequest,
    options: RuntimeRequestOptions = {}
  ): Promise<PreparedDangerousDataOperation> {
    return this.domainHttp.json<PreparedDangerousDataOperation>(
      this.routes.prepareDangerous,
      {
        ...options,
        method: "POST",
        retryable: false,
        body: request as unknown as RuntimeJson
      }
    );
  }

  async commitDangerousData(
    request: CommitDangerousDataRequest,
    options: RuntimeRequestOptions = {}
  ): Promise<DomainDangerousCommitResult> {
    const result = await this.domainHttp.json<DomainDangerousCommitResult>(
      this.routes.commitDangerous,
      {
        ...options,
        method: "POST",
        retryable: false,
        body: request as unknown as RuntimeJson
      }
    );
    await this.wakeSchedulerBestEffort();
    return result;
  }

  async runAgentTurn(
    request: AgentTurnRequest,
    options: AgentWaitOptions = {}
  ): Promise<AgentRunResult> {
    const accepted = await this.agent.startTurn(request, options);
    return this.agent.waitForRun(accepted.runId, options);
  }

  searchWeb(
    request: WebSearchRequest,
    options: RuntimeRequestOptions = {}
  ): Promise<WebSearchResponse> {
    return this.agent.search(request, options);
  }

  private createAgentClient(): AgentClient {
    return {
      health: (options = {}) =>
        this.agentHttp.json<Record<string, RuntimeJson>>(
          this.routes.agentHealth,
          options
        ),
      startTurn: async (request, options = {}) => {
        const clientRequestId =
          request.clientRequestId ?? options.idempotencyKey ?? createRuntimeRequestId("turn");
        const accepted = await this.agentHttp.json<AgentRunAccepted>(this.routes.agentTurns, {
          ...options,
          method: "POST",
          retryable: true,
          idempotencyKey: clientRequestId,
          body: { ...request, clientRequestId } as unknown as RuntimeJson
        });
        assertRunIdentity(accepted);
        return accepted;
      },
      getRun: async (runId, options = {}) => {
        const run = await this.agentHttp.json<AgentRunResult>(
          this.routes.agentRun(runId),
          options
        );
        assertRunIdentity(run, runId);
        assertRunStatus(run.status);
        return run;
      },
      waitForRun: (runId, options = {}) => this.waitForRun(runId, options),
      cancelRun: (runId, options = {}) =>
        this.agentHttp.json<AgentRunResult>(this.routes.agentCancel(runId), {
          ...options,
          method: "POST",
          retryable: true,
          idempotencyKey:
            options.idempotencyKey ?? createRuntimeRequestId(`cancel_${runId}`),
          body: { runId }
        }),
      listMessages: (sessionId, options = {}) =>
        this.agentHttp.json<AgentSessionMessagesResponse>(
          this.routes.agentMessages(sessionId),
          options
        ),
      listSchedulerOutbox: (options = {}) =>
        this.agentHttp.json<SchedulerOutboxResponse>(
          this.routes.schedulerOutbox,
          options
        ),
      acknowledgeSchedulerOutbox: (receiptKey, options = {}) =>
        this.agentHttp.json<SchedulerOutboxItem>(
          this.routes.schedulerAck(receiptKey),
          {
            ...options,
            method: "POST",
            retryable: true,
            idempotencyKey:
              options.idempotencyKey ?? createRuntimeRequestId(`scheduler_ack_${receiptKey}`),
            body: { receiptKey }
          }
        ),
      exportState: (options = {}) =>
        this.agentHttp.json<AgentHostSnapshot>(this.routes.agentExportData, {
          ...options,
          retryable: true
        }),
      checkIntegrity: (options = {}) =>
        this.agentHttp.json<AgentHostIntegrityReport>(this.routes.agentIntegrity, {
          ...options,
          retryable: true
        }),
      prepareDangerousData: (
        request: AgentPrepareDangerousRequest,
        options = {}
      ) =>
        this.agentHttp.json<AgentPreparedDangerousOperation>(
          this.routes.agentPrepareDangerous,
          {
            ...options,
            method: "POST",
            retryable: false,
            body: request as unknown as RuntimeJson
          }
        ),
      commitDangerousData: (
        request: AgentCommitDangerousRequest,
        options = {}
      ) =>
        this.agentHttp.json<AgentDangerousCommitResult>(
          this.routes.agentCommitDangerous,
          {
            ...options,
            method: "POST",
            retryable: false,
            body: request as unknown as RuntimeJson
          }
        ),
      search: async (request, options = {}) => {
        const clientRequestId =
          request.clientRequestId ?? options.idempotencyKey ?? createRuntimeRequestId("search");
        return this.agentHttp.json<WebSearchResponse>(this.routes.webSearch, {
          ...options,
          method: "POST",
          retryable: true,
          idempotencyKey: clientRequestId,
          body: { ...request, clientRequestId } as unknown as RuntimeJson
        });
      }
    };
  }

  private async waitForRun(
    runId: string,
    options: AgentWaitOptions
  ): Promise<AgentRunResult> {
    const startedAt = Date.now();
    const waitTimeoutMs = positiveInt(options.waitTimeoutMs, 330_000);
    const pollIntervalMs = positiveInt(options.pollIntervalMs, this.pollIntervalMs);

    while (true) {
      if (options.signal?.aborted) throw new DOMException("操作已取消", "AbortError");
      if (Date.now() - startedAt >= waitTimeoutMs) {
        // 连接生命周期和任务生命周期分开：这里只停止浏览器等待，不替用户取消 Host 任务。
        throw new Error(`等待 Agent 任务超过 ${waitTimeoutMs}ms；任务可能仍在本机继续`);
      }
      const run = await this.agent.getRun(runId, options);
      options.onStatus?.(run);
      if (isTerminalAgentRun(run.status)) return run;
      await abortableDelay(pollIntervalMs, options.signal);
    }
  }

  private async readHealth(
    service: "agent" | "domain",
    client: LocalJsonHttpClient,
    path: string,
    options: RuntimeRequestOptions
  ): Promise<RuntimeServiceHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const raw = await client.json<Record<string, RuntimeJson>>(path, options);
      const rawState = typeof raw.status === "string" ? raw.status : raw.state;
      const state =
        raw.ok === false || rawState === "unavailable"
          ? "unavailable"
          : rawState === "starting"
            ? "starting"
            : "ready";
      return {
        service,
        state,
        checkedAt,
        version: typeof raw.version === "string" ? raw.version : undefined,
        details: withoutSensitiveHealthFields(raw)
      };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return { service, state: "unavailable", checkedAt };
    }
  }

  private async domainWrite<T>(
    path: string,
    request: object,
    options: RuntimeRequestOptions,
    idPrefix: string
  ): Promise<T> {
    const idempotencyKey = options.idempotencyKey ?? createRuntimeRequestId(idPrefix);
    const result = await this.domainHttp.json<T>(path, {
      ...options,
      method: "POST",
      retryable: true,
      idempotencyKey,
      body: { ...request, clientRequestId: idempotencyKey } as RuntimeJson
    });
    // Domain has already committed at this point. Event-clock delivery is
    // additive: a scheduler outage must not turn a successful fact write into
    // an apparent failure or cause the browser to replay it.
    await this.wakeSchedulerBestEffort();
    return result;
  }

  private async wakeSchedulerBestEffort(): Promise<void> {
    await this.agentHttp.json<Record<string, RuntimeJson>>(this.routes.schedulerWake, {
      method: "POST",
      retryable: false,
      timeoutMs: 1_000,
      body: {}
    }).catch(() => undefined);
  }
}

function withoutSensitiveHealthFields(
  raw: Record<string, RuntimeJson>
): Record<string, RuntimeJson> {
  const result: Record<string, RuntimeJson> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      /key|secret|token|authorization|credential/i.test(key) &&
      typeof value !== "boolean"
    ) {
      continue;
    }
    result[key] = redactNestedHealth(value);
  }
  return result;
}

function redactNestedHealth(value: RuntimeJson): RuntimeJson {
  if (Array.isArray(value)) return value.map(redactNestedHealth);
  if (value === null || typeof value !== "object") return value;
  const clean: Record<string, RuntimeJson> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (
      /key|secret|token|authorization|credential/i.test(key) &&
      typeof nested !== "boolean"
    ) {
      continue;
    }
    clean[key] = redactNestedHealth(nested);
  }
  return clean;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}

function assertRunIdentity(
  run: { runId?: unknown },
  expectedRunId?: string
): asserts run is { runId: string } {
  if (
    typeof run?.runId !== "string" ||
    !run.runId ||
    (expectedRunId !== undefined && run.runId !== expectedRunId)
  ) {
    throw new LocalRuntimeError("Agent Host 返回了无效的 runId", {
      code: "invalid_agent_response"
    });
  }
}

function assertRunStatus(status: unknown): void {
  if (
    status !== "queued" &&
    status !== "running" &&
    status !== "completed" &&
    status !== "succeeded" &&
    status !== "failed" &&
    status !== "cancelled"
  ) {
    throw new LocalRuntimeError("Agent Host 返回了未知的任务状态", {
      code: "invalid_agent_response"
    });
  }
}

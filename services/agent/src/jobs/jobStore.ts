import { createHash, randomUUID } from "node:crypto";
import type { AuditLedger } from "../persistence/auditLedger.js";
import { RunCancelledError } from "../runtime/dshRuntime.js";
import type {
  AgentRunBudgets,
  AgentRunRequest,
  PublicRunError,
  PublicRunJob,
  InternalAgentRunRequest,
  AgentRunResult,
} from "../types.js";

interface LiveJob {
  public: PublicRunJob;
  controller: AbortController;
}

export interface RunExecutor {
  runTurn(
    request: InternalAgentRunRequest,
    signal: AbortSignal,
  ): Promise<AgentRunResult>;
}

export class IdempotencyConflictError extends Error {
  readonly code = "idempotency_conflict";

  constructor() {
    super("Idempotency-Key was already used for a different request");
    this.name = "IdempotencyConflictError";
  }
}

export class RunJobStore {
  private readonly jobs = new Map<string, LiveJob>();
  private readonly idempotency = new Map<string, string>();
  private initialized = false;

  constructor(
    private readonly runtime: RunExecutor,
    private readonly ledger: AuditLedger,
  ) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.ledger.init();
    const restored = await this.ledger.loadLatestJobs();
    for (const [runId, persisted] of restored) {
      const job = structuredClone(persisted);
      if (job.error) {
        const code = normalizePublicErrorCode(job.error.code);
        job.error = { code, message: publicErrorMessage(code) };
      }
      if (job.status === "queued" || job.status === "running") {
        job.status = "failed";
        job.finishedAt = new Date().toISOString();
        job.error = {
          code: "host_restarted",
          message: "Agent Host restarted before this run reached a terminal state",
        };
        await this.ledger.appendJobSnapshot(job);
      }
      this.jobs.set(runId, { public: job, controller: new AbortController() });
      if (job.idempotencyKey) this.idempotency.set(job.idempotencyKey, runId);
    }
    this.initialized = true;
  }

  async create(
    request: AgentRunRequest & { budgets: AgentRunBudgets },
    idempotencyKey?: string,
  ): Promise<{ job: PublicRunJob; created: boolean }> {
    await this.init();
    if(request.useHistory===undefined){const prior=this.latestForSession(request.sessionId)?.request.useHistory;if(prior!==undefined)request={...request,useHistory:prior};}
    const effectiveKey = idempotencyKey?.trim() || request.clientRequestId?.trim();
    if (effectiveKey && (effectiveKey.length > 200 || effectiveKey.length === 0)) {
      throw new TypeError("Idempotency-Key must be from 1 to 200 characters");
    }
    const fingerprint = fingerprintRequest(request);
    if (effectiveKey) {
      const priorRunId = this.idempotency.get(effectiveKey);
      const prior = priorRunId ? this.jobs.get(priorRunId) : undefined;
      if (prior) {
        const priorFingerprint = prior.public.requestFingerprint
          ?? fingerprintRequest(prior.public.request);
        if (priorFingerprint !== fingerprint) throw new IdempotencyConflictError();
        return { job: structuredClone(prior.public), created: false };
      }
    }

    const runId = randomUUID();
    const now = new Date().toISOString();
    const job: PublicRunJob = {
      runId,
      status: "queued",
      request: structuredClone(request),
      createdAt: now,
      ...(effectiveKey ? { idempotencyKey: effectiveKey } : {}),
      requestFingerprint: fingerprint,
    };
    const live: LiveJob = { public: job, controller: new AbortController() };
    this.jobs.set(runId, live);
    if (effectiveKey) this.idempotency.set(effectiveKey, runId);
    await this.ledger.appendJobSnapshot(job);
    queueMicrotask(() => void this.execute(live));
    return { job: structuredClone(job), created: true };
  }

  get(runId: string): PublicRunJob | undefined {
    const job = this.jobs.get(runId)?.public;
    return job ? structuredClone(job) : undefined;
  }

  latestForSession(sessionId: string): PublicRunJob | undefined {
    const jobs = [...this.jobs.values()].filter(({ public: job }) => job.request.sessionId === sessionId);
    const latest = jobs.findLast(({ public: job }) => job.status === "queued" || job.status === "running") ?? jobs.at(-1);
    return latest ? structuredClone(latest.public) : undefined;
  }

  hasActiveJobs(): boolean {
    return [...this.jobs.values()].some(({ public: job }) =>
      job.status === "queued" || job.status === "running"
    );
  }

  async cancel(runId: string): Promise<PublicRunJob | undefined> {
    const live = this.jobs.get(runId);
    if (!live) return undefined;
    if (live.public.status === "queued" || live.public.status === "running") {
      live.public.cancellationRequestedAt ??= new Date().toISOString();
      live.controller.abort(new RunCancelledError("Run cancelled through the local API"));
      await this.ledger.appendJobSnapshot(live.public);
    }
    return structuredClone(live.public);
  }

  private async execute(live: LiveJob): Promise<void> {
    if (live.controller.signal.aborted) {
      await this.finishCancelled(live);
      return;
    }
    live.public.status = "running";
    live.public.startedAt = new Date().toISOString();
    await this.ledger.appendJobSnapshot(live.public);
    try {
      const result = await this.runtime.runTurn(
        {
          ...live.public.request,
          runId: live.public.runId,
          budgets: live.public.request.budgets,
        },
        live.controller.signal,
      );
      live.public.result = result;
      live.public.status = result.status;
      live.public.finishedAt = result.finishedAt;
      await this.ledger.appendJobSnapshot(live.public);
    } catch (error) {
      if (live.controller.signal.aborted || error instanceof RunCancelledError) {
        await this.finishCancelled(live);
        return;
      }
      live.public.status = "failed";
      live.public.finishedAt = new Date().toISOString();
      live.public.error = publicError(error);
      await this.ledger.appendJobSnapshot(live.public);
    }
  }

  private async finishCancelled(live: LiveJob): Promise<void> {
    live.public.status = "cancelled";
    live.public.finishedAt = new Date().toISOString();
    await this.ledger.appendJobSnapshot(live.public);
  }
}

function fingerprintRequest(request: AgentRunRequest & { budgets: AgentRunBudgets }): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function publicError(error: unknown): PublicRunError {
  if (error instanceof Error) {
    const code = normalizePublicErrorCode((error as Error & { code?: unknown }).code);
    return {
      code,
      message: publicErrorMessage(code),
    };
  }
  return { code: "agent_run_failed", message: publicErrorMessage("agent_run_failed") };
}

function normalizePublicErrorCode(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_:-]{1,80}$/.test(value)
    ? value
    : "agent_run_failed";
}

function publicErrorMessage(code: string): string {
  if (code === "AUTH") {
    return "Model provider authentication failed. Update the local credential, restart Agent Host, and retry.";
  }
  if (code === "MISSING_CREDENTIAL") {
    return "Model provider credential is not configured. Configure it locally, restart Agent Host, and retry.";
  }
  if (code === "web_evidence_ingestion_failed") {
    return "Web results were not persisted as evidence, so no digest was generated.";
  }
  if (code.startsWith("WEB_")) {
    return "Web search provider failed. No result was persisted.";
  }
  return "Agent run failed. Check the local Agent Host diagnostics and retry.";
}

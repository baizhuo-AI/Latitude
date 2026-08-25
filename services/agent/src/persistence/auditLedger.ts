import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type {
  AgentRunBudgets,
  AgentRunRequest,
  AgentSessionMessage,
  PublicRunJob,
} from "../types.js";
import { redactCredentialText } from "../security/credentialRedaction.js";

export const AGENT_STATE_MARKER_FILE = "agent-state.json";
export const AGENT_STATE_MARKER = Object.freeze({
  schemaVersion: 1,
  owner: "latitude-agent-host",
});

export interface PersistedSessionEvent {
  kind?: "session_event";
  sessionId: string;
  generation?: number;
  runId?: string;
  event: SessionEvent;
}

interface SessionGenerationStart {
  kind: "generation_start";
  sessionId: string;
  generation: number;
  at: string;
  reason: "context_compaction";
  /** Compact seed is committed in the same JSONL record as the generation edge. */
  seed: readonly SessionEvent[];
}

type PersistedSessionRecord = PersistedSessionEvent | SessionGenerationStart;

export interface PersistedSessionState {
  generation: number;
  events: SessionEvent[];
}

interface PersistedJobSnapshot {
  kind: "job_snapshot";
  at: string;
  job: PublicRunJob;
}

export interface SchedulerReceipt {
  receiptKey: string;
  kind:
    | "outcome_collection"
    | "weekly_review"
    | "revision_resolution"
    | "daily_curation";
  domainId: string;
  dueAt: string;
  runId: string;
  /** 1-based bounded execution attempt for this durable receipt key. */
  attempt?: number;
  /** Persisted low-sensitivity request allows retry even if Domain no longer lists the item. */
  request?: AgentRunRequest & { budgets: AgentRunBudgets };
  nextAttemptAt?: string;
  lastStatus?: "failed" | "cancelled";
  trigger: "event" | "calendar" | "startup" | "manual";
  createdAt: string;
  updatedAt?: string;
}

export interface SchedulerDeliveryAck {
  receiptKey: string;
  runId: string;
  acknowledgedAt: string;
}

function safeArtifactName(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function parseJsonLines<T>(raw: string, artifact: string): T[] {
  const lines = raw.split("\n");
  const values: T[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      values.push(JSON.parse(line) as T);
    } catch (error) {
      const hasLaterContent = lines.slice(index + 1).some((candidate) => candidate.trim());
      if (!hasLaterContent) break; // tolerate one torn crash tail only
      throw new Error(`Corrupt JSONL record in ${artifact} at line ${index + 1}`, {
        cause: error,
      });
    }
  }
  return values;
}

export class AuditLedger {
  readonly root: string;
  readonly sessionsDir: string;
  readonly jobsPath: string;
  readonly auditPath: string;
  readonly schedulerPath: string;
  readonly schedulerAcksPath: string;

  private readonly pending = new Map<string, Promise<void>>();
  private readonly writeFailures = new Map<string, unknown>();
  /**
   * One process-wide file-operation queue gives exports a real snapshot fence:
   * every ledger write registered before the fence finishes first, while every
   * write registered after it waits until the complete allowlisted read ends.
   */
  private barrierTail: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.root = root;
    this.sessionsDir = path.join(root, "sessions");
    this.jobsPath = path.join(root, "jobs.jsonl");
    this.auditPath = path.join(root, "audit.jsonl");
    this.schedulerPath = path.join(root, "scheduler-receipts.jsonl");
    this.schedulerAcksPath = path.join(root, "scheduler-acks.jsonl");
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.ensureStateMarker();
    await mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
  }

  private async ensureStateMarker(): Promise<void> {
    const markerPath = path.join(this.root, AGENT_STATE_MARKER_FILE);
    try {
      const existing = JSON.parse(await readFile(markerPath, "utf8")) as unknown;
      if (!isStateMarker(existing)) throw new Error("Agent state owner marker is invalid");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    for (const forbidden of ["package.json", ".git", "latitude-domain.db"]) {
      if (await pathExists(path.join(this.root, forbidden))) {
        throw new Error(
          `Refusing to claim a non-Agent directory containing ${forbidden}`,
        );
      }
    }
    try {
      await writeFile(markerPath, `${JSON.stringify(AGENT_STATE_MARKER)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = JSON.parse(await readFile(markerPath, "utf8")) as unknown;
      if (!isStateMarker(existing)) throw new Error("Agent state owner marker is invalid");
    }
  }

  private sessionPath(sessionId: string): string {
    return path.join(this.sessionsDir, `${safeArtifactName(sessionId)}.events.jsonl`);
  }

  private sessionMetaPath(sessionId: string): string {
    return path.join(this.sessionsDir, `${safeArtifactName(sessionId)}.meta.json`);
  }

  private serialize(value: unknown): string {
    // DSH contracts are credential-free by design. This final boundary also
    // removes masked suffixes occasionally echoed by upstream error messages.
    return redactCredentialText(JSON.stringify(value));
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.barrierTail.then(operation);
    this.barrierTail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  private queueWrite(file: string, operation: () => Promise<void>): Promise<void> {
    const current = this.runExclusive(async () => {
      try {
        await operation();
        this.writeFailures.delete(file);
      } catch (error) {
        this.writeFailures.set(file, error);
        throw error;
      }
    });
    // The map retains the observable Promise; this extra handler prevents a
    // fire-and-forget session notification from becoming an unhandled rejection.
    void current.catch(() => undefined);
    this.pending.set(file, current);
    return current;
  }

  private enqueue(file: string, value: unknown): Promise<void> {
    return this.queueWrite(file, async () => {
      await appendFile(file, `${this.serialize(value)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    });
  }

  async appendJobSnapshot(job: PublicRunJob): Promise<void> {
    // A queued/running job needs the message only in process memory. On restart
    // jobs are terminalized instead of replayed, so persisting raw request text
    // would create a Host-only copy when Domain evidence ingestion fails. Keep
    // only the stable fingerprint needed for retry/conflict semantics.
    const requestFingerprint = job.requestFingerprint ?? createHash("sha256")
      .update(JSON.stringify(job.request))
      .digest("hex");
    const { systemPrompt: _systemPrompt, ...safeRequest } = job.request;
    const persistedJob: PublicRunJob = {
      ...structuredClone(job),
      request: {
        ...structuredClone(safeRequest),
        text: "[NOT_PERSISTED]",
      },
      requestFingerprint,
    };
    await this.enqueue(this.jobsPath, {
      kind: "job_snapshot",
      at: new Date().toISOString(),
      job: persistedJob,
    } satisfies PersistedJobSnapshot);
  }

  async loadLatestJobs(): Promise<Map<string, PublicRunJob>> {
    await this.flushFile(this.jobsPath);
    let raw: string;
    try {
      raw = await readFile(this.jobsPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw error;
    }
    const snapshots = parseJsonLines<PersistedJobSnapshot>(raw, this.jobsPath);
    const jobs = new Map<string, PublicRunJob>();
    for (const snapshot of snapshots) {
      if (snapshot.kind === "job_snapshot" && snapshot.job?.runId) {
        jobs.set(snapshot.job.runId, snapshot.job);
      }
    }
    return jobs;
  }

  appendSessionEvent(
    sessionId: string,
    runId: string | undefined,
    event: SessionEvent,
    generation = 0,
  ): Promise<void> {
    const file = this.sessionPath(sessionId);
    return this.enqueue(file, {
      kind: "session_event",
      sessionId,
      generation,
      ...(runId ? { runId } : {}),
      event,
    } satisfies PersistedSessionEvent);
  }

  async startSessionGeneration(
    sessionId: string,
    generation: number,
    seed: readonly SessionEvent[],
  ): Promise<void> {
    if (!Number.isInteger(generation) || generation < 1) {
      throw new TypeError("session generation must be a positive integer");
    }
    await this.enqueue(this.sessionPath(sessionId), {
      kind: "generation_start",
      sessionId,
      generation,
      at: new Date().toISOString(),
      reason: "context_compaction",
      seed: structuredClone(seed),
    } satisfies SessionGenerationStart);
    await this.ensureSessionMetadata(sessionId, generation);
  }

  async ensureSessionMetadata(sessionId: string, generation = 0): Promise<void> {
    const file = this.sessionMetaPath(sessionId);
    await this.queueWrite(file, async () => {
      await writeFile(
        file,
        `${this.serialize({ sessionId, generation, updatedAt: new Date().toISOString() })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    });
  }

  async loadSessionEvents(sessionId: string): Promise<SessionEvent[]> {
    return (await this.loadSessionState(sessionId)).events;
  }

  async loadSessionState(sessionId: string): Promise<PersistedSessionState> {
    const file = this.sessionPath(sessionId);
    await this.flushFile(file);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { generation: 0, events: [] };
      }
      throw error;
    }
    const records = parseJsonLines<PersistedSessionRecord>(raw, file);
    let generation = 0;
    let events: SessionEvent[] = [];
    for (const record of records) {
      if (record.kind === "generation_start") {
        if (record.sessionId !== sessionId || record.generation <= generation) continue;
        generation = record.generation;
        events = structuredClone([...record.seed]);
        continue;
      }
      const recordGeneration = record.generation ?? 0;
      if (record.sessionId === sessionId && recordGeneration === generation) {
        events.push(record.event);
      }
    }
    return { generation, events };
  }

  async readSessionEvents(
    sessionId: string,
    afterSeq = -1,
    limit = 500,
  ): Promise<PersistedSessionEvent[]> {
    const file = this.sessionPath(sessionId);
    await this.flushFile(file);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const state = await this.loadSessionState(sessionId);
    return state.events
      .filter((event) => event.seq > afterSeq)
      .map((event) => ({
        kind: "session_event" as const,
        sessionId,
        generation: state.generation,
        event,
      }))
      .slice(0, Math.max(1, Math.min(limit, 2_000)));
  }

  /**
   * Browser conversation read model. It scans the append-only archive so a
   * reload can recover human-visible messages even after a context generation
   * was compacted. Synthetic plugin recalls, tool results, chunks, and system
   * events stay internal.
   */
  async readSessionMessages(
    sessionId: string,
    limit = 100,
  ): Promise<AgentSessionMessage[]> {
    const file = this.sessionPath(sessionId);
    await this.flushFile(file);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const records = parseJsonLines<PersistedSessionRecord>(raw, file);
    const events: SessionEvent[] = [];
    for (const record of records) {
      if (record.kind === "generation_start") events.push(...record.seed);
      else if (record.sessionId === sessionId) events.push(record.event);
    }

    const seen = new Set<string>();
    const messages: AgentSessionMessage[] = [];
    for (const event of events) {
      if (event.type === "user/message") {
        if (event.data.source.kind !== "user") continue;
        const content = textContent(event.data.content);
        const id = String(event.data.id);
        if (!content || seen.has(id)) continue;
        seen.add(id);
        messages.push({
          id,
          role: "user",
          content,
          createdAt: new Date(event.time).toISOString(),
          seq: event.seq,
        });
      } else if (event.type === "assistant/message") {
        const content = textContent(event.data.message.content);
        const id = String(event.data.message.id);
        if (!content || seen.has(id)) continue;
        seen.add(id);
        messages.push({
          id,
          role: "assistant",
          content,
          createdAt: new Date(event.time).toISOString(),
          seq: event.seq,
        });
      }
    }
    return messages.slice(-Math.max(1, Math.min(limit, 500)));
  }

  appendAudit(kind: string, data: Record<string, unknown>): Promise<void> {
    return this.enqueue(this.auditPath, {
      kind,
      at: new Date().toISOString(),
      data,
    });
  }

  async appendSchedulerReceipt(receipt: SchedulerReceipt): Promise<void> {
    await this.enqueue(this.schedulerPath, receipt);
  }

  async loadSchedulerReceipts(): Promise<Map<string, SchedulerReceipt>> {
    await this.flushFile(this.schedulerPath);
    let raw: string;
    try {
      raw = await readFile(this.schedulerPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw error;
    }
    const receipts = parseJsonLines<SchedulerReceipt>(raw, this.schedulerPath);
    return new Map(receipts.map((receipt) => [receipt.receiptKey, receipt]));
  }

  async readSchedulerReceipts(): Promise<SchedulerReceipt[]> {
    return [...(await this.loadSchedulerReceipts()).values()].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  async appendSchedulerAck(ack: SchedulerDeliveryAck): Promise<void> {
    await this.enqueue(this.schedulerAcksPath, ack);
  }

  async loadSchedulerAcks(): Promise<Map<string, SchedulerDeliveryAck>> {
    await this.flushFile(this.schedulerAcksPath);
    let raw: string;
    try {
      raw = await readFile(this.schedulerAcksPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw error;
    }
    const acks = parseJsonLines<SchedulerDeliveryAck>(raw, this.schedulerAcksPath);
    return new Map(acks.map((ack) => [ack.receiptKey, ack]));
  }

  async flushSession(sessionId: string): Promise<void> {
    await this.flushFile(this.sessionPath(sessionId));
  }

  private async flushFile(file: string): Promise<void> {
    const pending = this.pending.get(file);
    if (pending) await pending;
    const failure = this.writeFailures.get(file);
    if (failure) throw failure;
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((file) => this.flushFile(file)));
  }

  /**
   * Run one complete allowlisted snapshot read between ledger writes. Callers
   * must not call flushAll from inside the callback: writes already registered
   * before this method are ordered ahead of it by the same queue.
   */
  withSnapshotBarrier<T>(readSnapshot: () => Promise<T>): Promise<T> {
    return this.runExclusive(async () => {
      const failure = this.writeFailures.values().next().value;
      if (failure !== undefined) throw failure;
      return readSnapshot();
    });
  }
}

function textContent(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
}

function isStateMarker(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).schemaVersion === AGENT_STATE_MARKER.schemaVersion &&
    (value as Record<string, unknown>).owner === AGENT_STATE_MARKER.owner,
  );
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

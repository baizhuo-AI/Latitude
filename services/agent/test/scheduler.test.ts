// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLedger } from "../src/persistence/auditLedger.js";
import {
  DurableScheduler,
  type SchedulerJobStore,
} from "../src/scheduler/durableScheduler.js";
import type {
  AgentRunBudgets,
  AgentRunRequest,
  PublicRunJob,
} from "../src/types.js";
import { FakeDomain, waitUntil } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

class CompletedJobs implements SchedulerJobStore {
  readonly jobs = new Map<string, PublicRunJob>();
  readonly byKey = new Map<string, string>();
  createCalls = 0;

  constructor(private readonly dailyCurationPersisted = true) {}

  async create(
    request: AgentRunRequest & { budgets: AgentRunBudgets },
    idempotencyKey?: string,
  ): Promise<{ job: PublicRunJob; created: boolean }> {
    const priorId = idempotencyKey ? this.byKey.get(idempotencyKey) : undefined;
    const prior = priorId ? this.jobs.get(priorId) : undefined;
    if (prior) return { job: structuredClone(prior), created: false };
    this.createCalls += 1;
    const runId = `scheduled-run-${this.createCalls}`;
    const now = new Date().toISOString();
    const job: PublicRunJob = {
      runId,
      status: "completed",
      request: structuredClone(request),
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      result: {
        runId,
        sessionId: request.sessionId,
        status: "completed",
        assistantText: `scheduled:${request.clientRequestId}`,
        stepsUsed: 1,
        toolCallsUsed: 0,
        startedAt: now,
        finishedAt: now,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        ...(request.sessionId === "latitude:scheduler:daily-curation" &&
          this.dailyCurationPersisted
          ? {
              dailyCuration: {
                dateKey: "2026-08-24",
                itemCount: 3,
                resourceNodeId: "curation-node-1",
              },
            }
          : {}),
        events: [],
      },
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
    this.jobs.set(runId, job);
    if (idempotencyKey) this.byKey.set(idempotencyKey, runId);
    return { job: structuredClone(job), created: true };
  }

  get(runId: string): PublicRunJob | undefined {
    const job = this.jobs.get(runId);
    return job ? structuredClone(job) : undefined;
  }
}

class ScriptedRetryJobs implements SchedulerJobStore {
  readonly jobs = new Map<string, PublicRunJob>();
  readonly byKey = new Map<string, string>();
  readonly keys: string[] = [];
  createCalls = 0;

  constructor(private readonly statuses: Array<"failed" | "cancelled" | "completed">) {}

  async create(
    request: AgentRunRequest & { budgets: AgentRunBudgets },
    idempotencyKey?: string,
  ): Promise<{ job: PublicRunJob; created: boolean }> {
    const priorId = idempotencyKey ? this.byKey.get(idempotencyKey) : undefined;
    const prior = priorId ? this.jobs.get(priorId) : undefined;
    if (prior) return { job: structuredClone(prior), created: false };
    this.createCalls += 1;
    if (idempotencyKey) this.keys.push(idempotencyKey);
    const runId = `retry-run-${this.createCalls}`;
    const status = this.statuses[this.createCalls - 1] ?? this.statuses.at(-1) ?? "failed";
    const now = new Date().toISOString();
    const job: PublicRunJob = {
      runId,
      status,
      request: structuredClone(request),
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      ...(status === "completed"
        ? {
            result: {
              runId,
              sessionId: request.sessionId,
              status: "completed",
              assistantText: "retry completed",
              stepsUsed: 1,
              toolCallsUsed: 0,
              startedAt: now,
              finishedAt: now,
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                reasoningTokens: 0,
              },
              events: [],
            },
          }
        : status === "failed"
          ? { error: { code: "scripted_failure", message: "scripted failure" } }
          : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
    this.jobs.set(runId, job);
    if (idempotencyKey) this.byKey.set(idempotencyKey, runId);
    return { job: structuredClone(job), created: true };
  }

  get(runId: string): PublicRunJob | undefined {
    const job = this.jobs.get(runId);
    return job ? structuredClone(job) : undefined;
  }
}

describe("DurableScheduler", () => {
  it("deduplicates due action/review jobs across event wakes and restarts, with durable outbox ack", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "latitude-scheduler-"));
    roots.push(root);
    const domain = new FakeDomain();
    domain.due = [
      {
        kind: "outcome_collection",
        receiptKey: "outcome:action-1:event:event-1:edge-1",
        actionId: "action-1",
        label: "Ship local loop",
        dueAt: "2026-08-24T09:00:00.000Z",
        dueReason: "linked_event",
        triggerEventReceipt: {
          eventNodeId: "event-1",
          observedAt: "2026-08-24T08:55:00.000Z",
          linkedAt: "2026-08-24T09:00:00.000Z",
          relationKind: "tested_claim_edge",
          relationRef: "edge-1",
        },
      },
      {
        kind: "weekly_review",
        receiptKey: "review:2026-W34",
        reviewId: "2026-W34",
        label: "Weekly review",
        dueAt: "2026-08-24T09:00:00.000Z",
        periodStart: "2026-08-17T09:00:00.000Z",
        periodEnd: "2026-08-24T09:00:00.000Z",
      },
      {
        kind: "revision_resolution",
        receiptKey: "revision:revision-1",
        revisionId: "revision-1",
        claimNodeId: "claim-1",
        outcomeNodeId: "outcome-1",
        effect: "unknown",
        proposedStatement: "A replacement needing confirmation",
        dueAt: "2026-08-24T10:00:00.000Z",
      },
      {
        kind: "daily_curation",
        receiptKey: "curation:2026-08-24",
        dateKey: "2026-08-24",
        label: "Daily web curation",
        dueAt: "2026-08-24T16:00:00.000Z",
      },
    ];
    const jobs = new CompletedJobs();
    const first = new DurableScheduler(
      domain,
      jobs,
      new AuditLedger(root),
      300_000,
    );
    await first.start();
    await waitUntil(() => first.listReceipts().length === 4);
    expect(jobs.createCalls).toBe(4);
    const revisionJob = [...jobs.jobs.values()].find((job) =>
      job.request.sessionId === "latitude:scheduler:revisions"
    );
    expect(revisionJob?.request).toMatchObject({
      initiator: "scheduler",
      clientRequestId: "scheduler:revision:revision-1",
    });
    expect(revisionJob?.request.text).toMatch(/compile_context.*revision_queue_resolve/s);
    expect(revisionJob?.request.text).toMatch(/sensitivityPolicy.*low/s);
    const curationJob = [...jobs.jobs.values()].find((job) =>
      job.request.sessionId === "latitude:scheduler:daily-curation"
    );
    expect(curationJob?.request).toMatchObject({
      initiator: "scheduler",
      clientRequestId: "scheduler:curation:2026-08-24",
    });
    expect(curationJob?.request.text).toMatch(/goal.*tension.*curator_preference.*at most three/s);
    expect(curationJob?.request.text).toMatch(/sensitivityCeiling="low"/);
    const outcomeJob = [...jobs.jobs.values()].find((job) =>
      job.request.sessionId === "latitude:scheduler:outcomes"
    );
    expect(outcomeJob?.request.text).toMatch(/sensitivityCeiling "low"/);
    expect(outcomeJob?.request.text).toMatch(/related evidence event/);
    expect(outcomeJob?.request.text).not.toContain("event-1");
    expect(outcomeJob?.request.text).toMatch(/never call outcome_record/);
    const weeklyJob = [...jobs.jobs.values()].find((job) =>
      job.request.sessionId === "latitude:scheduler:weekly-review"
    );
    expect(weeklyJob?.request.text).toMatch(/sensitivityCeiling "low"/);

    domain.emitMutation();
    domain.emitMutation();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(jobs.createCalls).toBe(4);

    const pending = first.listOutbox();
    expect(pending).toHaveLength(4);
    expect(pending.every((item) => item.deliveryStatus === "pending")).toBe(true);
    expect(pending.find((item) => item.kind === "outcome_collection")).toMatchObject({
      domainId: "action-1",
    });
    const acknowledged = await first.acknowledge(pending[0]!.receiptKey);
    expect(acknowledged?.deliveryStatus).toBe("acknowledged");
    await first.close();

    const restored = new DurableScheduler(
      domain,
      jobs,
      new AuditLedger(root),
      300_000,
    );
    await restored.start();
    await waitUntil(() => restored.listReceipts().length === 4);
    domain.emitMutation();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(jobs.createCalls).toBe(4);
    expect(restored.listOutbox().find((item) =>
      item.receiptKey === pending[0]!.receiptKey
    )?.deliveryStatus).toBe("acknowledged");
    await restored.close();
  });

  it("does not push a daily digest when no curation resource/items were persisted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "latitude-scheduler-empty-curation-"));
    roots.push(root);
    const domain = new FakeDomain();
    domain.due = [{
      kind: "daily_curation",
      receiptKey: "curation:2026-08-24",
      dateKey: "2026-08-24",
      label: "Daily web curation",
      dueAt: "2026-08-24T16:00:00.000Z",
    }];
    const scheduler = new DurableScheduler(
      domain,
      new CompletedJobs(false),
      new AuditLedger(root),
      300_000,
    );
    await scheduler.start();
    await waitUntil(() => scheduler.listReceipts().length === 1);
    expect(scheduler.listOutbox()).toEqual([]);
    await scheduler.close();
  });

  it("persists failed attempt backoff and completes the same receipt after restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "latitude-scheduler-retry-"));
    roots.push(root);
    const domain = new FakeDomain();
    domain.due = [{
      kind: "outcome_collection",
      receiptKey: "outcome:retry-action:2026-08-24T09:00:00.000Z",
      actionId: "retry-action",
      label: "Retry the reminder",
      dueAt: "2026-08-24T09:00:00.000Z",
      dueReason: "calendar_fallback",
    }];
    const jobs = new ScriptedRetryJobs(["failed", "completed"]);
    const ledger = new AuditLedger(root);
    const first = new DurableScheduler(domain, jobs, ledger, 300_000, {
      retryBackoffMs: [20, 20],
      jobStatusPollMs: 2,
    });
    await first.start();
    await waitUntil(() => Boolean(first.listReceipts()[0]?.nextAttemptAt));
    expect(first.listReceipts()[0]).toMatchObject({
      attempt: 1,
      lastStatus: "failed",
      request: { initiator: "scheduler" },
    });
    await first.close();

    const restored = new DurableScheduler(domain, jobs, new AuditLedger(root), 300_000, {
      retryBackoffMs: [20, 20],
      jobStatusPollMs: 2,
    });
    await restored.start();
    await waitUntil(() => restored.listReceipts()[0]?.attempt === 2);
    expect(jobs.createCalls).toBe(2);
    expect(jobs.keys).toEqual([
      "scheduler:outcome:retry-action:2026-08-24T09:00:00.000Z:attempt:1",
      "scheduler:outcome:retry-action:2026-08-24T09:00:00.000Z:attempt:2",
    ]);
    expect(restored.listOutbox()).toHaveLength(1);
    await restored.close();
  });

  it("stops retrying a failed durable receipt after three attempts, including restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "latitude-scheduler-max-retry-"));
    roots.push(root);
    const domain = new FakeDomain();
    domain.due = [{
      kind: "weekly_review",
      receiptKey: "review:retry-max",
      reviewId: "retry-max",
      label: "Bounded retry review",
      dueAt: "2026-08-24T09:00:00.000Z",
    }];
    const jobs = new ScriptedRetryJobs(["failed", "failed", "failed", "completed"]);
    const scheduler = new DurableScheduler(domain, jobs, new AuditLedger(root), 300_000, {
      retryBackoffMs: [2, 2],
      jobStatusPollMs: 2,
    });
    await scheduler.start();
    await waitUntil(() => {
      const receipt = scheduler.listReceipts()[0];
      return receipt?.attempt === 3 && receipt.lastStatus === "failed";
    });
    expect(jobs.createCalls).toBe(3);
    await scheduler.close();

    const restored = new DurableScheduler(domain, jobs, new AuditLedger(root), 300_000, {
      retryBackoffMs: [2, 2],
      jobStatusPollMs: 2,
    });
    await restored.start();
    restored.wake("manual");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(jobs.createCalls).toBe(3);
    expect(restored.listReceipts()[0]).toMatchObject({ attempt: 3, lastStatus: "failed" });
    expect(restored.listOutbox()).toEqual([]);
    await restored.close();
  });
});

// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IdempotencyConflictError, RunJobStore, type RunExecutor } from "../src/jobs/jobStore.js";
import { AuditLedger } from "../src/persistence/auditLedger.js";
import {
  normalizeRunRequest,
  type AgentRunResult,
  type InternalAgentRunRequest,
  type PublicRunJob,
} from "../src/types.js";
import { waitUntil } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function storeWith(runner: RunExecutor) {
  const root = await mkdtemp(path.join(tmpdir(), "latitude-jobs-"));
  roots.push(root);
  const ledger = new AuditLedger(root);
  const jobs = new RunJobStore(runner, ledger);
  await jobs.init();
  return { jobs, ledger };
}

const runner: RunExecutor = {
  async runTurn(request: InternalAgentRunRequest): Promise<AgentRunResult> {
    const now = new Date().toISOString();
    return {
      runId: request.runId,
      sessionId: request.sessionId,
      status: "completed",
      assistantText: `reply:${request.text}`,
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
    };
  },
};

describe("RunJobStore", () => {
  it("returns the same runId for a retry and rejects key reuse with another payload", async () => {
    const { jobs } = await storeWith(runner);
    const request = normalizeRunRequest({ sessionId: "session-1", text: "hello" });
    const first = await jobs.create(request, "retry-key-1");
    const retry = await jobs.create(request, "retry-key-1");
    expect(retry.created).toBe(false);
    expect(retry.job.runId).toBe(first.job.runId);
    await expect(jobs.create(
      normalizeRunRequest({ sessionId: "session-1", text: "different" }),
      "retry-key-1",
    )).rejects.toBeInstanceOf(IdempotencyConflictError);
    await waitUntil(() => jobs.get(first.job.runId)?.status === "completed");
    expect(jobs.get(first.job.runId)?.result?.assistantText).toBe("reply:hello");
  });

  it("marks non-terminal persisted jobs failed after a host restart instead of replaying side effects", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "latitude-jobs-restart-"));
    roots.push(root);
    const ledger = new AuditLedger(root);
    await ledger.init();
    const persisted: PublicRunJob = {
      runId: "interrupted-run",
      status: "running",
      request: normalizeRunRequest({ sessionId: "session-2", text: "mutate" }),
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      idempotencyKey: "restart-key",
    };
    await ledger.appendJobSnapshot(persisted);
    await ledger.appendJobSnapshot({
      ...persisted,
      runId: "legacy-auth-failure",
      status: "failed",
      finishedAt: new Date().toISOString(),
      idempotencyKey: "legacy-auth-key",
      error: {
        code: "AUTH",
        message: "Authentication Fails, Your api key: ****7750 is invalid",
      },
    });

    const restored = new RunJobStore(runner, new AuditLedger(root));
    await restored.init();
    expect(restored.get("interrupted-run")).toMatchObject({
      status: "failed",
      error: { code: "host_restarted" },
    });
    expect(restored.get("legacy-auth-failure")?.error).toEqual({
      code: "AUTH",
      message: "Model provider authentication failed. Update the local credential, restart Agent Host, and retry.",
    });
    const retry = await restored.create(persisted.request, "restart-key");
    expect(retry.created).toBe(false);
    expect(retry.job.runId).toBe("interrupted-run");
  });

  it("publishes a stable AUTH error without provider credential fragments", async () => {
    const authRunner: RunExecutor = {
      async runTurn() {
        throw Object.assign(
          new Error("Authentication Fails, Your api key: ****7750 is invalid"),
          { code: "AUTH" },
        );
      },
    };
    const { jobs, ledger } = await storeWith(authRunner);
    const created = await jobs.create(
      normalizeRunRequest({ sessionId: "session-auth", text: "synthetic" }),
      "auth-failure-1",
    );
    await waitUntil(() => jobs.get(created.job.runId)?.status === "failed");

    expect(jobs.get(created.job.runId)?.error).toEqual({
      code: "AUTH",
      message: "Model provider authentication failed. Update the local credential, restart Agent Host, and retry.",
    });
    await ledger.flushAll();
    expect(await readFile(ledger.jobsPath, "utf8")).not.toContain("7750");
  });
});

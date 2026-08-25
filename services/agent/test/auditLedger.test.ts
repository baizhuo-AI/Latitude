// @vitest-environment node
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLedger } from "../src/persistence/auditLedger.js";
import { normalizeRunBudgets, type PublicRunJob } from "../src/types.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

async function ledger(): Promise<AuditLedger> {
  const root = await mkdtemp(path.join(tmpdir(), "latitude-ledger-"));
  temporaryRoots.push(root);
  const value = new AuditLedger(root);
  await value.init();
  return value;
}

describe("AuditLedger", () => {
  it("tolerates only a torn final JSONL record", async () => {
    const store = await ledger();
    const job: PublicRunJob = {
      runId: "run-1",
      status: "queued",
      request: { sessionId: "session-1", text: "hello", budgets: normalizeRunBudgets(undefined) },
      createdAt: new Date().toISOString(),
    };
    await store.appendJobSnapshot(job);
    const persisted = (await store.loadLatestJobs()).get("run-1")!;
    expect(persisted.request.text).toBe("[NOT_PERSISTED]");
    expect(persisted.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(store.jobsPath, "utf8")).not.toContain("hello");
    await appendFile(store.jobsPath, "{\"torn\"", "utf8");
    expect((await store.loadLatestJobs()).get("run-1")?.status).toBe("queued");
  });

  it("redacts the live DeepSeek credential at the final serialization boundary", async () => {
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "unit-test-secret-never-persist";
    try {
      const store = await ledger();
      const structuredMaskedSuffix = "z".repeat(6);
      await store.appendAudit("defensive_test", {
        accidental: "unit-test-secret-never-persist",
        providerError: "Authentication Fails, Your api key: ****7750 is invalid",
        structuredProviderError: {
          apiKey: `${"*".repeat(4)}${structuredMaskedSuffix}`,
        },
      });
      await store.flushAll();
      const raw = await readFile(store.auditPath, "utf8");
      expect(raw).not.toContain("unit-test-secret-never-persist");
      expect(raw).not.toContain("7750");
      expect(raw).not.toContain(structuredMaskedSuffix);
      expect(raw).toContain("[REDACTED]");
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
    }
  });

  it("holds concurrent ledger writes outside one complete snapshot read", async () => {
    const store = await ledger();
    await store.appendAudit("before_snapshot", { order: 1 });

    let announceSnapshot!: () => void;
    const snapshotStarted = new Promise<void>((resolve) => {
      announceSnapshot = resolve;
    });
    let releaseSnapshot!: () => void;
    const snapshotRelease = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const snapshot = store.withSnapshotBarrier(async () => {
      announceSnapshot();
      await snapshotRelease;
      return readFile(store.auditPath, "utf8");
    });
    await snapshotStarted;

    let concurrentWriteFinished = false;
    const concurrentWrite = store.appendAudit("after_snapshot", { order: 2 }).then(() => {
      concurrentWriteFinished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(concurrentWriteFinished).toBe(false);

    releaseSnapshot();
    const captured = await snapshot;
    expect(captured).toContain("before_snapshot");
    expect(captured).not.toContain("after_snapshot");
    await concurrentWrite;
    expect(await readFile(store.auditPath, "utf8")).toContain("after_snapshot");
  });

  it("keeps archived generations append-only while restoring only the active compact seed", async () => {
    const store = await ledger();
    const original = Session.create(SessionId("original"));
    original.append("user/message", createUserMessage({
      content: [{ type: "text", text: "old context" }],
      source: { kind: "user" },
    }), { surfaceOp: "append" });
    await store.appendSessionEvent("logical-session", "run-old", original.events[0]!, 0);

    const compact = Session.create(SessionId("compact"));
    compact.append("user/message", createUserMessage({
      content: [{ type: "text", text: "continuity summary" }],
      source: { kind: "plugin", plugin: "test", form: "recall" },
    }), { surfaceOp: "append" });
    await store.startSessionGeneration("logical-session", 1, compact.events);

    const state = await store.loadSessionState("logical-session");
    expect(state.generation).toBe(1);
    expect(JSON.stringify(state.events)).toContain("continuity summary");
    expect(JSON.stringify(state.events)).not.toContain("old context");
    const artifact = await readFile(
      path.join(store.sessionsDir, `${await sessionHash("logical-session")}.events.jsonl`),
      "utf8",
    );
    expect(artifact).toContain("old context");
    expect(artifact).toContain("continuity summary");
  });
});

async function sessionHash(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
}

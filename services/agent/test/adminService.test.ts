// @vitest-environment node
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentAdminError,
  AgentAdminService,
  type AgentHostSnapshot,
} from "../src/admin/adminService.js";
import { AuditLedger } from "../src/persistence/auditLedger.js";
import { normalizeRunBudgets, type PublicRunJob } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

async function fixture() {
  const parent = await mkdtemp(path.join(tmpdir(), "latitude-agent-admin-parent-"));
  roots.push(parent);
  const stateDir = path.join(parent, "agent");
  const ledger = new AuditLedger(stateDir);
  await ledger.init();
  const baseJob = job("run-base", "base");
  await ledger.appendJobSnapshot(baseJob);
  await ledger.appendAudit("base_audit", { value: "safe" });
  await ledger.appendSchedulerReceipt({
    receiptKey: "review:base",
    kind: "weekly_review",
    domainId: "review-base",
    dueAt: "2026-08-24T09:00:00.000Z",
    runId: "run-base",
    trigger: "calendar",
    createdAt: "2026-08-24T09:00:00.000Z",
  });
  await ledger.appendSchedulerAck({
    receiptKey: "review:base",
    runId: "run-base",
    acknowledgedAt: "2026-08-24T10:00:00.000Z",
  });
  const session = Session.create(SessionId("admin-fixture"));
  session.append("user/message", createUserMessage({
    content: [{ type: "text", text: "persist me" }],
    source: { kind: "user" },
  }), { surfaceOp: "append" });
  await ledger.appendSessionEvent("admin-fixture", "run-base", session.events[0]!);
  await ledger.ensureSessionMetadata("admin-fixture");
  await mkdir(path.join(stateDir, "dsh"), { recursive: true });
  await writeFile(
    path.join(stateDir, "dsh", ".anonymous-user-id"),
    "11111111-2222-4333-8444-555555555555\n",
    "utf8",
  );
  return { parent, stateDir, ledger, baseJob };
}

describe("AgentAdminService", () => {
  it("exports every credential-free Agent artifact with a stable checksum", async () => {
    const { stateDir, ledger } = await fixture();
    const previous = process.env.DEEPSEEK_API_KEY;
    const syntheticSecret = `sk-${"a".repeat(32)}`;
    process.env.DEEPSEEK_API_KEY = syntheticSecret;
    try {
      await ledger.appendAudit("credential_boundary", {
        accidental: syntheticSecret,
      });
      const snapshotBarrier = vi.spyOn(ledger, "withSnapshotBarrier");
      let quiescentChecks = 0;
      let quiescentWrappers = 0;
      const admin = new AgentAdminService({
        stateDir,
        ledger,
        assertQuiescent: () => {
          quiescentChecks += 1;
        },
        withQuiescentSnapshot: async (snapshot) => {
          quiescentWrappers += 1;
          return snapshot();
        },
      });
      const first = await admin.exportSnapshot();
      const second = await admin.exportSnapshot();
      expect(second.checksum).toBe(first.checksum);
      expect(Object.keys(first.files)).toEqual(expect.arrayContaining([
        "jobs.jsonl",
        "audit.jsonl",
        "scheduler-receipts.jsonl",
        "scheduler-acks.jsonl",
        "dsh/.anonymous-user-id",
      ]));
      expect(Object.keys(first.files).some((name) => name.startsWith("sessions/"))).toBe(true);
      expect(JSON.stringify(first)).not.toContain(syntheticSecret);
      expect(await admin.integrity()).toMatchObject({ ok: true, checksum: first.checksum });
      expect(snapshotBarrier).toHaveBeenCalledTimes(3);
      expect(quiescentChecks).toBe(3);
      expect(quiescentWrappers).toBe(3);
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
    }
  });

  it("restores only after the exact second-stage phrase and keeps a raw pre-write backup", async () => {
    const { stateDir, ledger } = await fixture();
    let quiesceCalls = 0;
    const admin = new AgentAdminService({
      stateDir,
      ledger,
      beforeSwap: () => { quiesceCalls += 1; },
    });
    const baseline = await admin.exportSnapshot();
    await ledger.appendJobSnapshot(job("run-extra", "extra"));
    expect((await ledger.loadLatestJobs()).has("run-extra")).toBe(true);

    const prepared = admin.prepare({ operation: "restore", snapshot: baseline });
    expect(prepared.confirmationPhrase).toBe("RESTORE LOCAL DATA");
    await expect(admin.commit({ token: prepared.token, confirmation: "RESTORE" }))
      .rejects.toMatchObject({ code: "confirmation_mismatch" });
    expect((await ledger.loadLatestJobs()).has("run-extra")).toBe(true);

    const receipt = await admin.commit({
      token: prepared.token,
      confirmation: prepared.confirmationPhrase,
    });
    expect(receipt).toMatchObject({
      ok: true,
      operation: "restore",
      checksum: baseline.checksum,
      restartRequired: true,
    });
    expect(quiesceCalls).toBe(1);
    await expect(stat(String(receipt.backupPath))).resolves.toBeDefined();
    await expect(stat(String(receipt.rawBackupPath))).resolves.toBeDefined();

    const restoredLedger = new AuditLedger(stateDir);
    const restoredJobs = await restoredLedger.loadLatestJobs();
    expect(restoredJobs.has("run-base")).toBe(true);
    expect(restoredJobs.has("run-extra")).toBe(false);
    expect(admin.isRestartRequired).toBe(true);
  });

  it("delete_all removes the entire isolated Agent root while preserving unknown state in raw backup", async () => {
    const { stateDir, ledger } = await fixture();
    await writeFile(path.join(stateDir, "future-agent-state.bin"), "future", "utf8");
    const admin = new AgentAdminService({ stateDir, ledger });
    expect((await admin.integrity()).ok).toBe(false);
    await expect(admin.exportSnapshot()).rejects.toMatchObject({
      code: "agent_export_incomplete",
    });

    const prepared = admin.prepare({ operation: "delete_all" });
    expect(prepared.confirmationPhrase).toBe("DELETE ALL LOCAL DATA");
    const receipt = await admin.commit({
      token: prepared.token,
      confirmation: prepared.confirmationPhrase,
    });
    expect(await readdir(stateDir)).toEqual([]);
    expect(await readFile(
      path.join(String(receipt.rawBackupPath), "future-agent-state.bin"),
      "utf8",
    )).toBe("future");
    expect((await new AuditLedger(stateDir).loadLatestJobs()).size).toBe(0);
  });

  it("rejects checksum corruption and Domain-root collisions without changing current data", async () => {
    const { stateDir, ledger } = await fixture();
    const admin = new AgentAdminService({ stateDir, ledger });
    const snapshot = await admin.exportSnapshot();
    const corrupted: AgentHostSnapshot = {
      ...snapshot,
      checksum: "0".repeat(64),
    };
    expect(() => admin.prepare({ operation: "restore", snapshot: corrupted }))
      .toThrowError(AgentAdminError);
    expect((await ledger.loadLatestJobs()).has("run-base")).toBe(true);

    await writeFile(path.join(stateDir, "latitude-domain.db"), "domain-owner", "utf8");
    await expect(admin.exportSnapshot()).rejects.toMatchObject({
      code: "agent_state_not_isolated",
    });
    const deletePrepared = admin.prepare({ operation: "delete_all" });
    await expect(admin.commit({
      token: deletePrepared.token,
      confirmation: deletePrepared.confirmationPhrase,
    })).rejects.toMatchObject({ code: "agent_state_not_isolated" });
    expect(await readFile(path.join(stateDir, "latitude-domain.db"), "utf8"))
      .toBe("domain-owner");
  });

  it("purge_all permanently removes the Agent root and every Agent backup", async () => {
    const { stateDir, ledger } = await fixture();
    const backupDir = `${stateDir}-backups`;
    await mkdir(backupDir, { recursive: true });
    await writeFile(
      path.join(backupDir, ".latitude-agent-backups.owner.json"),
      `${JSON.stringify({ schemaVersion: 1, owner: "latitude-agent-host-backups" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(
        backupDir,
        "2026-08-24T10-00-00-000Z-11111111-2222-4333-8444-555555555555.snapshot.json",
      ),
      "old-backup",
      "utf8",
    );
    const admin = new AgentAdminService({ stateDir, ledger });
    const prepared = admin.prepare({ operation: "purge_all" });
    expect(prepared.confirmationPhrase)
      .toBe("PERMANENTLY DELETE ALL LATITUDE DATA");
    const receipt = await admin.commit({
      token: prepared.token,
      confirmation: prepared.confirmationPhrase,
    });
    expect(receipt).toMatchObject({
      ok: true,
      operation: "purge_all",
      status: "complete",
      recoverable: false,
      restartRequired: true,
    });
    expect(receipt).not.toHaveProperty("backupPath");
    expect(receipt).not.toHaveProperty("rawBackupPath");
    expect(await readdir(stateDir)).toEqual([]);
    await expect(stat(backupDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("purge_all preserves unknown files, directories, and symlinks without following targets", async () => {
    const { parent, stateDir, ledger } = await fixture();
    const unknownFile = path.join(stateDir, "personal-notes.txt");
    const unknownDirectory = path.join(stateDir, "personal-folder");
    const outside = path.join(parent, "outside-target.txt");
    await writeFile(unknownFile, "preserve", "utf8");
    await mkdir(unknownDirectory);
    await writeFile(path.join(unknownDirectory, "inside.txt"), "preserve", "utf8");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, path.join(stateDir, "personal-link"));

    const backupDir = `${stateDir}-backups`;
    await mkdir(backupDir, { recursive: true });
    await writeFile(
      path.join(backupDir, ".latitude-agent-backups.owner.json"),
      `${JSON.stringify({ schemaVersion: 1, owner: "latitude-agent-host-backups" })}\n`,
      "utf8",
    );
    const managedBackup = path.join(
      backupDir,
      "2026-08-24T10-00-00-000Z-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.snapshot.json",
    );
    await writeFile(managedBackup, "owned", "utf8");
    await writeFile(path.join(backupDir, "personal-backup.txt"), "preserve", "utf8");
    const matchingSymlink = path.join(
      backupDir,
      "2026-08-24T11-00-00-000Z-ffffffff-1111-4222-8333-444444444444.snapshot.json",
    );
    await symlink(outside, matchingSymlink);

    const admin = new AgentAdminService({ stateDir, ledger });
    const prepared = admin.prepare({ operation: "purge_all" });
    const receipt = await admin.commit({
      token: prepared.token,
      confirmation: prepared.confirmationPhrase,
    });
    expect(receipt).toMatchObject({
      ok: true,
      operation: "purge_all",
      status: "partial",
      recoverable: true,
      restartRequired: true,
    });
    expect(receipt.preservedEntries).toEqual(expect.arrayContaining([
      "state/personal-notes.txt",
      "state/personal-folder",
      "state/personal-link",
      "backups/personal-backup.txt",
    ]));
    expect(await readFile(unknownFile, "utf8")).toBe("preserve");
    expect(await readFile(path.join(unknownDirectory, "inside.txt"), "utf8"))
      .toBe("preserve");
    expect(await readFile(outside, "utf8")).toBe("outside");
    expect(await readFile(path.join(backupDir, "personal-backup.txt"), "utf8"))
      .toBe("preserve");
    await expect(stat(managedBackup)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await new AuditLedger(stateDir).loadLatestJobs()).size).toBe(0);
  });
});

function job(runId: string, text: string): PublicRunJob {
  return {
    runId,
    status: "completed",
    request: {
      sessionId: "admin-fixture",
      text,
      budgets: normalizeRunBudgets(undefined),
    },
    createdAt: "2026-08-24T09:00:00.000Z",
  };
}

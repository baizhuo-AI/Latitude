import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  AGENT_STATE_MARKER,
  AGENT_STATE_MARKER_FILE,
  type AuditLedger,
} from "../persistence/auditLedger.js";
import {
  containsCredentialText,
  redactCredentialText,
} from "../security/credentialRedaction.js";
import { PROVIDER_SETTINGS_FILE } from "../provider/providerSettings.js";

const SNAPSHOT_SCHEMA_VERSION = 1 as const;
const PREPARE_TTL_MS = 5 * 60_000;
const ROOT_MANAGED_FILES = new Set([
  AGENT_STATE_MARKER_FILE,
  "jobs.jsonl",
  "audit.jsonl",
  "scheduler-receipts.jsonl",
  "scheduler-acks.jsonl",
  PROVIDER_SETTINGS_FILE,
]);
const SESSION_FILE = /^sessions\/[a-f0-9]{64}\.(?:events\.jsonl|meta\.json)$/;
const DSH_ID_FILE = "dsh/.anonymous-user-id";
const BACKUP_MARKER_FILE = ".latitude-agent-backups.owner.json";
const BACKUP_MARKER = Object.freeze({
  schemaVersion: 1,
  owner: "latitude-agent-host-backups",
});
const BACKUP_SNAPSHOT_FILE = /^[0-9TZ-]+-[0-9a-f-]{36}\.snapshot\.json$/i;
const BACKUP_RAW_DIRECTORY = /^[0-9TZ-]+-[0-9a-f-]{36}\.raw$/i;

export interface AgentHostSnapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  exportedAt: string;
  checksum: string;
  files: Record<string, string>;
}

export interface AgentHostIntegrity {
  ok: boolean;
  checksum: string;
  fileCount: number;
  issues: string[];
}

export type DangerousOperation = "restore" | "delete_all" | "purge_all";

interface PreparedDangerousOperation {
  token: string;
  operation: DangerousOperation;
  confirmationPhrase: string;
  expiresAt: string;
  snapshot?: AgentHostSnapshot;
}

export interface AgentAdminServiceOptions {
  stateDir: string;
  ledger: AuditLedger;
  assertQuiescent?: () => void | Promise<void>;
  withQuiescentSnapshot?: <T>(snapshot: () => Promise<T>) => Promise<T>;
  beforeSwap?: () => void | Promise<void>;
}

export class AgentAdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentAdminError";
  }
}

/**
 * Hidden local data-safety boundary for Agent Host state.
 *
 * Snapshots contain only credential-free, allowlisted ledger artifacts. A
 * dangerous mutation needs a short-lived in-memory token and the exact phrase
 * returned by prepare. State is staged beside the active directory, backed up
 * in both portable JSON and raw-directory form, then swapped while the runtime
 * is quiescent. A successful swap deliberately requires a Host restart.
 */
export class AgentAdminService {
  private readonly pending = new Map<string, PreparedDangerousOperation>();
  private mutationInProgress = false;
  private snapshotInProgress = false;
  private restartRequired = false;

  constructor(private readonly options: AgentAdminServiceOptions) {}

  get isMutationInProgress(): boolean {
    return this.mutationInProgress;
  }

  get isSnapshotInProgress(): boolean {
    return this.snapshotInProgress;
  }

  get isRestartRequired(): boolean {
    return this.restartRequired;
  }

  async exportSnapshot(): Promise<AgentHostSnapshot> {
    return this.runSnapshot(async () => {
      await assertNoDomainOwnership(this.options.stateDir);
      const unmanaged = await listUnmanagedPaths(this.options.stateDir);
      if (unmanaged.length) {
        throw new AgentAdminError(
          409,
          "agent_export_incomplete",
          `Unknown Agent state is not exportable: ${unmanaged.join(", ")}`,
        );
      }
      return this.captureSnapshot();
    });
  }

  async integrity(): Promise<AgentHostIntegrity> {
    return this.runSnapshot(async () => {
      const snapshot = await this.captureSnapshot();
      const issues = [
        ...validateManagedFiles(snapshot.files),
        ...(await domainOwnershipIssues(this.options.stateDir)),
        ...(await listUnmanagedPaths(this.options.stateDir)).map((value) =>
          `unmanaged Agent state: ${value}`
        ),
      ];
      return {
        ok: issues.length === 0,
        checksum: snapshot.checksum,
        fileCount: Object.keys(snapshot.files).length,
        issues,
      };
    });
  }

  prepare(input: unknown): PreparedDangerousOperation {
    if (this.snapshotInProgress) {
      throw new AgentAdminError(409, "admin_snapshot_in_progress", "A local snapshot is running");
    }
    if (this.restartRequired) {
      throw new AgentAdminError(503, "host_restart_required", "Restart Agent Host first");
    }
    const record = objectRecord(input, "dangerous prepare body");
    const operation = record.operation;
    if (
      operation !== "restore" &&
      operation !== "delete_all" &&
      operation !== "purge_all"
    ) {
      throw new AgentAdminError(
        400,
        "invalid_admin_operation",
        "operation must be restore, delete_all, or purge_all",
      );
    }
    let snapshot: AgentHostSnapshot | undefined;
    if (operation === "restore") {
      snapshot = parseSnapshot(record.snapshot);
    } else if (record.snapshot !== undefined) {
      throw new AgentAdminError(
        400,
        "invalid_admin_snapshot",
        `${operation} does not accept a snapshot`,
      );
    }

    this.pruneExpired();
    const token = randomUUID();
    const confirmationPhrase = operation === "restore"
      ? "RESTORE LOCAL DATA"
      : operation === "purge_all"
        ? "PERMANENTLY DELETE ALL LATITUDE DATA"
        : "DELETE ALL LOCAL DATA";
    const prepared: PreparedDangerousOperation = {
      token,
      operation,
      confirmationPhrase,
      expiresAt: new Date(Date.now() + PREPARE_TTL_MS).toISOString(),
      ...(snapshot ? { snapshot } : {}),
    };
    this.pending.set(token, prepared);
    return structuredClone(prepared);
  }

  async commit(input: unknown): Promise<Record<string, unknown>> {
    if (this.snapshotInProgress) {
      throw new AgentAdminError(409, "admin_snapshot_in_progress", "A local snapshot is running");
    }
    if (this.mutationInProgress) {
      throw new AgentAdminError(409, "admin_mutation_in_progress", "Another mutation is running");
    }
    if (this.restartRequired) {
      throw new AgentAdminError(503, "host_restart_required", "Restart Agent Host first");
    }
    const record = objectRecord(input, "dangerous commit body");
    const token = typeof record.token === "string" ? record.token : "";
    const confirmation = typeof record.confirmation === "string"
      ? record.confirmation
      : "";
    this.pruneExpired();
    const prepared = this.pending.get(token);
    if (!prepared) {
      throw new AgentAdminError(404, "admin_token_not_found", "Token is absent or expired");
    }
    if (confirmation !== prepared.confirmationPhrase) {
      throw new AgentAdminError(
        400,
        "confirmation_mismatch",
        "Confirmation phrase does not exactly match prepare",
      );
    }

    this.mutationInProgress = true;
    let quiesced = false;
    let stage: string | undefined;
    try {
      await this.options.assertQuiescent?.();
      if (prepared.operation === "purge_all") {
        await assertNoDomainOwnership(this.options.stateDir);
        await this.options.beforeSwap?.();
        quiesced = true;
        await this.options.ledger.flushAll();
        this.pending.delete(token);
        const stateCleanup = await purgeManagedAgentState(this.options.stateDir);
        const backupCleanup = await purgeOwnedAgentBackups(
          `${this.options.stateDir}-backups`,
        );
        this.restartRequired = true;
        const installed = createSnapshot(await readManagedFiles(this.options.stateDir));
        const preservedEntries = [
          ...stateCleanup.preservedEntries.map((entry) => `state/${entry}`),
          ...backupCleanup.preservedEntries.map((entry) => `backups/${entry}`),
        ];
        return {
          ok: true,
          operation: prepared.operation,
          status: preservedEntries.length ? "partial" : "complete",
          checksum: installed.checksum,
          recoverable: backupCleanup.preservedEntries.length > 0,
          preservedEntries,
          backupCleanup,
          restartRequired: true,
        };
      }
      const desiredFiles = prepared.operation === "restore"
        ? prepared.snapshot!.files
        : {};
      const desiredChecksum = checksumFiles(desiredFiles);
      stage = await this.buildStage(desiredFiles);
      await this.options.beforeSwap?.();
      quiesced = true;
      await this.options.ledger.flushAll();
      const backup = await this.writeBackup(await this.captureSnapshot());

      // The exact token becomes at-most-once only after validation and, for
      // recoverable operations, both backup forms are ready. purge_all is the
      // explicit exception: its contract is to retain no recovery copy.
      this.pending.delete(token);
      const swap = await this.swapStage(stage, backup?.rawDirectory);
      stage = undefined;
      this.restartRequired = true;
      const installed = createSnapshot(await readManagedFiles(this.options.stateDir));
      if (installed.checksum !== desiredChecksum) {
        if (swap.rawBackupPath) {
          await this.restoreRawBackup(swap.rawBackupPath);
        }
        throw new AgentAdminError(
          500,
          "post_commit_checksum_mismatch",
          "Installed state failed checksum verification",
        );
      }
      return {
        ok: true,
        operation: prepared.operation,
        checksum: installed.checksum,
        ...(backup ? { backupPath: backup.snapshotPath } : {}),
        ...(swap.rawBackupPath ? { rawBackupPath: swap.rawBackupPath } : {}),
        restartRequired: true,
      };
    } catch (error) {
      if (stage) {
        await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      }
      if (quiesced) this.restartRequired = true;
      if (error instanceof AgentAdminError) throw error;
      throw new AgentAdminError(
        500,
        "admin_commit_failed",
        "Agent Host state mutation failed; the pre-write state was retained or restored",
      );
    } finally {
      this.mutationInProgress = false;
    }
  }

  private async restoreRawBackup(rawBackupPath: string): Promise<void> {
    const failed = `${this.options.stateDir}.failed-${randomUUID()}`;
    await rename(this.options.stateDir, failed);
    try {
      await rename(rawBackupPath, this.options.stateDir);
      await rm(failed, { recursive: true, force: true });
    } catch (error) {
      await rename(failed, this.options.stateDir).catch(() => undefined);
      throw error;
    }
  }

  private async captureSnapshot(): Promise<AgentHostSnapshot> {
    return createSnapshot(await readManagedFiles(this.options.stateDir));
  }

  private async runSnapshot<T>(capture: () => Promise<T>): Promise<T> {
    if (this.mutationInProgress) {
      throw new AgentAdminError(409, "admin_mutation_in_progress", "A local mutation is running");
    }
    if (this.restartRequired) {
      throw new AgentAdminError(503, "host_restart_required", "Restart Agent Host first");
    }
    if (this.snapshotInProgress) {
      throw new AgentAdminError(409, "admin_snapshot_in_progress", "A local snapshot is running");
    }
    this.snapshotInProgress = true;
    const snapshot = async () => {
      await this.options.assertQuiescent?.();
      return this.options.ledger.withSnapshotBarrier(capture);
    };
    try {
      return this.options.withQuiescentSnapshot
        ? await this.options.withQuiescentSnapshot(snapshot)
        : await snapshot();
    } finally {
      this.snapshotInProgress = false;
    }
  }

  private async buildStage(files: Record<string, string>): Promise<string> {
    const parent = path.dirname(this.options.stateDir);
    const stage = path.join(
      parent,
      `.${path.basename(this.options.stateDir)}-stage-${randomUUID()}`,
    );
    try {
      await assertNoDomainOwnership(this.options.stateDir);
      // A restore is exact and a delete is complete: no unexported DSH or
      // future Agent state is silently carried forward. The raw pre-write
      // directory backup remains available if an unknown future artifact needs
      // manual recovery.
      await mkdir(stage, { recursive: true, mode: 0o700 });
      for (const [relative, content] of Object.entries(files)) {
        assertManagedPath(relative);
        const destination = path.join(stage, relative);
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, content, { encoding: "utf8", mode: 0o600 });
      }
      const staged = await readManagedFiles(stage);
      const issues = validateManagedFiles(staged);
      if (issues.length) {
        throw new AgentAdminError(
          400,
          "invalid_admin_snapshot",
          `Snapshot artifacts are invalid: ${issues.join("; ")}`,
        );
      }
      if (checksumFiles(staged) !== checksumFiles(files)) {
        throw new AgentAdminError(500, "stage_checksum_mismatch", "Staged state checksum differs");
      }
      return stage;
    } catch (error) {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async writeBackup(snapshot: AgentHostSnapshot): Promise<{
    snapshotPath: string;
    rawDirectory: string;
  }> {
    const backupDir = `${this.options.stateDir}-backups`;
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    await ensureBackupOwnerMarker(backupDir);
    const id = `${safeTimestamp()}-${randomUUID()}`;
    const snapshotPath = path.join(backupDir, `${id}.snapshot.json`);
    const temporary = `${snapshotPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, snapshotPath);
    return {
      snapshotPath,
      rawDirectory: path.join(backupDir, `${id}.raw`),
    };
  }

  private async swapStage(
    stage: string,
    rawBackupPath?: string,
  ): Promise<{ rawBackupPath?: string }> {
    const displaced = `${this.options.stateDir}.displaced-${randomUUID()}`;
    let oldMoved = false;
    let newInstalled = false;
    try {
      if (await exists(this.options.stateDir)) {
        await rename(this.options.stateDir, displaced);
        oldMoved = true;
      }
      await rename(stage, this.options.stateDir);
      newInstalled = true;
      if (oldMoved) {
        if (rawBackupPath) await rename(displaced, rawBackupPath);
        else await rm(displaced, { recursive: true, force: true });
        oldMoved = false;
      }
      return { ...(rawBackupPath ? { rawBackupPath } : {}) };
    } catch (error) {
      // No live runtime observes this boundary. If the second rename or the raw
      // backup move fails, put the original directory back before surfacing it.
      if (newInstalled) {
        const failed = `${stage}.failed`;
        await rename(this.options.stateDir, failed).catch(() => undefined);
        await rm(failed, { recursive: true, force: true }).catch(() => undefined);
      }
      if (oldMoved) {
        await rename(displaced, this.options.stateDir).catch(() => undefined);
      }
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [token, prepared] of this.pending) {
      if (Date.parse(prepared.expiresAt) <= now) this.pending.delete(token);
    }
  }
}

function createSnapshot(files: Record<string, string>): AgentHostSnapshot {
  const sorted = sortedFiles(files);
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    checksum: checksumFiles(sorted),
    files: sorted,
  };
}

function parseSnapshot(value: unknown): AgentHostSnapshot {
  const record = objectRecord(value, "snapshot");
  if (record.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new AgentAdminError(400, "invalid_admin_snapshot", "Unsupported snapshot schema");
  }
  if (typeof record.exportedAt !== "string" || !Number.isFinite(Date.parse(record.exportedAt))) {
    throw new AgentAdminError(400, "invalid_admin_snapshot", "snapshot.exportedAt is invalid");
  }
  if (typeof record.checksum !== "string" || !/^[a-f0-9]{64}$/.test(record.checksum)) {
    throw new AgentAdminError(400, "invalid_admin_snapshot", "snapshot.checksum is invalid");
  }
  const rawFiles = objectRecord(record.files, "snapshot.files");
  const files: Record<string, string> = {};
  for (const [relative, content] of Object.entries(rawFiles)) {
    assertManagedPath(relative);
    if (typeof content !== "string") {
      throw new AgentAdminError(400, "invalid_admin_snapshot", `${relative} must be text`);
    }
    if (containsCredential(content)) {
      throw new AgentAdminError(400, "snapshot_contains_credential", "Snapshot contains a credential");
    }
    files[relative] = content;
  }
  const sorted = sortedFiles(files);
  if (checksumFiles(sorted) !== record.checksum) {
    throw new AgentAdminError(400, "snapshot_checksum_mismatch", "Snapshot checksum differs");
  }
  const issues = validateManagedFiles(sorted);
  if (issues.length) {
    throw new AgentAdminError(
      400,
      "invalid_admin_snapshot",
      `Snapshot artifacts are invalid: ${issues.join("; ")}`,
    );
  }
  if (!(AGENT_STATE_MARKER_FILE in sorted)) {
    throw new AgentAdminError(
      400,
      "invalid_admin_snapshot",
      "Restore snapshot is missing its Agent owner marker",
    );
  }
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    exportedAt: record.exportedAt,
    checksum: record.checksum,
    files: sorted,
  };
}

async function readManagedFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of [...ROOT_MANAGED_FILES].sort()) {
    const content = await readManagedTextFile(root, name);
    if (content !== undefined) files[name] = sanitizeContent(content);
  }
  const sessions = path.join(root, "sessions");
  if (await safeDirectoryExists(sessions)) {
    for (const entry of (await readdir(sessions, { withFileTypes: true }))
      .filter((candidate) => candidate.isFile())
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = `sessions/${entry.name}`;
      if (!SESSION_FILE.test(relative)) continue;
      const content = await readManagedTextFile(root, relative);
      if (content !== undefined) files[relative] = sanitizeContent(content);
    }
  }
  const dshDirectory = path.join(root, "dsh");
  if (await safeDirectoryExists(dshDirectory)) {
    const dshId = await readManagedTextFile(root, DSH_ID_FILE);
    if (dshId !== undefined) files[DSH_ID_FILE] = sanitizeContent(dshId);
  }
  return sortedFiles(files);
}

function validateManagedFiles(files: Record<string, string>): string[] {
  const issues: string[] = [];
  for (const [relative, content] of Object.entries(files)) {
    try {
      assertManagedPath(relative);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : `invalid path ${relative}`);
      continue;
    }
    if (containsCredential(content)) issues.push(`${relative} contains a credential`);
    if (relative.endsWith(".jsonl")) {
      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!.trim();
        if (!line) continue;
        try {
          JSON.parse(line);
        } catch {
          issues.push(`${relative}:${index + 1} is invalid JSONL`);
        }
      }
    } else if (relative.endsWith(".json")) {
      try {
        const parsed = JSON.parse(content);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          issues.push(`${relative} must contain a JSON object`);
        }
        if (
          relative === AGENT_STATE_MARKER_FILE &&
          (!parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            (parsed as Record<string, unknown>).schemaVersion !== AGENT_STATE_MARKER.schemaVersion ||
            (parsed as Record<string, unknown>).owner !== AGENT_STATE_MARKER.owner)
        ) {
          issues.push(`${relative} has the wrong Agent owner`);
        }
      } catch {
        issues.push(`${relative} is invalid JSON`);
      }
    } else if (relative === DSH_ID_FILE) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*$/i.test(content)) {
        issues.push(`${relative} must contain one anonymous UUID`);
      }
    }
  }
  return issues;
}

function checksumFiles(files: Record<string, string>): string {
  return createHash("sha256")
    .update(JSON.stringify({ schemaVersion: SNAPSHOT_SCHEMA_VERSION, files: sortedFiles(files) }))
    .digest("hex");
}

function sortedFiles(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function assertManagedPath(relative: string): void {
  if (
    !ROOT_MANAGED_FILES.has(relative) &&
    !SESSION_FILE.test(relative) &&
    relative !== DSH_ID_FILE
  ) {
    throw new AgentAdminError(
      400,
      "invalid_admin_snapshot_path",
      `Snapshot path is not managed: ${relative}`,
    );
  }
}

async function assertNoDomainOwnership(root: string): Promise<void> {
  const issues = await domainOwnershipIssues(root);
  if (issues.length) {
    throw new AgentAdminError(409, "agent_state_not_isolated", issues.join("; "));
  }
}

async function domainOwnershipIssues(root: string): Promise<string[]> {
  const markers = [
    "latitude-domain.db",
    "latitude-domain.db-wal",
    "latitude-domain.db-shm",
  ];
  const issues: string[] = [];
  const rootMetadata = await safeLstat(root);
  if (rootMetadata && (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink())) {
    issues.push("Agent state root must be a regular non-symlink directory");
    return issues;
  }
  if (path.basename(root) === ".latitude") {
    issues.push("Agent state root cannot be the shared .latitude Domain owner root");
  }
  for (const marker of markers) {
    if (await exists(path.join(root, marker))) {
      issues.push(`Agent state root contains Domain-owned ${marker}`);
    }
  }
  for (const marker of ["package.json", ".git"]) {
    if (await exists(path.join(root, marker))) {
      issues.push(`Agent state root contains project owner marker ${marker}`);
    }
  }
  const stateMarkerPath = path.join(root, AGENT_STATE_MARKER_FILE);
  const markerMetadata = await safeLstat(stateMarkerPath);
  if (!markerMetadata) {
    issues.push("Agent state root is missing its owner marker");
  } else if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink()) {
    issues.push("Agent state root owner marker must be a regular non-symlink file");
  } else {
    try {
      const value = JSON.parse(await readFile(stateMarkerPath, "utf8")) as Record<string, unknown>;
      if (
        value.schemaVersion !== AGENT_STATE_MARKER.schemaVersion ||
        value.owner !== AGENT_STATE_MARKER.owner
      ) issues.push("Agent state root owner marker is invalid");
    } catch {
      issues.push("Agent state root owner marker is invalid");
    }
  }
  return issues;
}

async function listUnmanagedPaths(root: string): Promise<string[]> {
  if (!(await exists(root))) return [];
  const unmanaged: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && ROOT_MANAGED_FILES.has(entry.name)) continue;
    if (entry.isDirectory() && entry.name === "sessions") {
      for (const child of await readdir(path.join(root, entry.name), { withFileTypes: true })) {
        const relative = `sessions/${child.name}`;
        if (!child.isFile() || !SESSION_FILE.test(relative)) unmanaged.push(relative);
      }
      continue;
    }
    if (entry.isDirectory() && entry.name === "dsh") {
      for (const child of await readdir(path.join(root, entry.name), { withFileTypes: true })) {
        const relative = `dsh/${child.name}`;
        if (!child.isFile() || relative !== DSH_ID_FILE) unmanaged.push(relative);
      }
      continue;
    }
    unmanaged.push(entry.name);
  }
  return unmanaged.sort();
}

interface PurgeCleanupResult {
  removedEntries: string[];
  preservedEntries: string[];
}

async function purgeManagedAgentState(root: string): Promise<PurgeCleanupResult> {
  const removedEntries: string[] = [];
  const preserved = new Set(await listUnmanagedPaths(root));
  const removeRegular = async (relative: string) => {
    const target = path.join(root, relative);
    const metadata = await safeLstat(target);
    if (!metadata) return;
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      preserved.add(relative);
      return;
    }
    try {
      await rm(target, { force: true });
      removedEntries.push(relative);
    } catch {
      preserved.add(`${relative} (delete failed)`);
    }
  };

  for (const relative of [...ROOT_MANAGED_FILES]
    .filter((name) => name !== AGENT_STATE_MARKER_FILE)
    .sort()) {
    await removeRegular(relative);
  }
  await purgeManagedChildren(root, "sessions", SESSION_FILE, removedEntries, preserved);
  await purgeManagedChildren(
    root,
    "dsh",
    (relative) => relative === DSH_ID_FILE,
    removedEntries,
    preserved,
  );
  // Delete the ownership marker last. If any earlier managed deletion failed,
  // the failure is visible in the partial receipt before a restart recreates it.
  await removeRegular(AGENT_STATE_MARKER_FILE);
  return {
    removedEntries: removedEntries.sort(),
    preservedEntries: [...preserved].sort(),
  };
}

async function purgeManagedChildren(
  root: string,
  directoryName: string,
  managed: RegExp | ((relative: string) => boolean),
  removed: string[],
  preserved: Set<string>,
): Promise<void> {
  const directory = path.join(root, directoryName);
  const metadata = await safeLstat(directory);
  if (!metadata) return;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    preserved.add(directoryName);
    return;
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${directoryName}/${entry.name}`;
    const isManaged = managed instanceof RegExp ? managed.test(relative) : managed(relative);
    if (!isManaged || !entry.isFile() || entry.isSymbolicLink()) {
      preserved.add(relative);
      continue;
    }
    try {
      await rm(path.join(directory, entry.name), { force: true });
      removed.push(relative);
    } catch {
      preserved.add(`${relative} (delete failed)`);
    }
  }
  try {
    if ((await readdir(directory)).length === 0) await rmdir(directory);
  } catch {
    preserved.add(directoryName);
  }
}

async function purgeOwnedAgentBackups(backupDir: string): Promise<PurgeCleanupResult> {
  const removedEntries: string[] = [];
  const preserved = new Set<string>();
  const metadata = await safeLstat(backupDir);
  if (!metadata) return { removedEntries, preservedEntries: [] };
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    return { removedEntries, preservedEntries: ["<unsafe-backup-root>"] };
  }
  if (!(await validBackupOwnerMarker(backupDir))) {
    const entries = await readdir(backupDir);
    return {
      removedEntries,
      preservedEntries: ["<unowned-backup-directory>", ...entries].sort(),
    };
  }

  for (const entry of await readdir(backupDir, { withFileTypes: true })) {
    if (entry.name === BACKUP_MARKER_FILE) continue;
    const target = path.join(backupDir, entry.name);
    if (BACKUP_SNAPSHOT_FILE.test(entry.name) && entry.isFile() && !entry.isSymbolicLink()) {
      try {
        await rm(target, { force: true });
        removedEntries.push(entry.name);
      } catch {
        preserved.add(`${entry.name} (delete failed)`);
      }
      continue;
    }
    if (
      BACKUP_RAW_DIRECTORY.test(entry.name) &&
      entry.isDirectory() &&
      !entry.isSymbolicLink()
    ) {
      const ownershipIssues = await domainOwnershipIssues(target);
      const unmanaged = await listUnmanagedPaths(target);
      if (ownershipIssues.length || unmanaged.length) {
        preserved.add(entry.name);
        continue;
      }
      try {
        await rm(target, { recursive: true, force: true });
        removedEntries.push(entry.name);
      } catch {
        preserved.add(`${entry.name} (delete failed)`);
      }
      continue;
    }
    preserved.add(entry.name);
  }

  if (preserved.size === 0) {
    await rm(path.join(backupDir, BACKUP_MARKER_FILE), { force: true });
    removedEntries.push(BACKUP_MARKER_FILE);
    try {
      await rmdir(backupDir);
    } catch {
      preserved.add("<backup-directory-not-empty>");
    }
  }
  return {
    removedEntries: removedEntries.sort(),
    preservedEntries: [...preserved].sort(),
  };
}

async function ensureBackupOwnerMarker(backupDir: string): Promise<void> {
  const rootMetadata = await safeLstat(backupDir);
  if (!rootMetadata?.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new AgentAdminError(
      409,
      "agent_backup_root_unsafe",
      "Agent backup root must be a regular non-symlink directory",
    );
  }
  const marker = path.join(backupDir, BACKUP_MARKER_FILE);
  const markerMetadata = await safeLstat(marker);
  if (!markerMetadata) {
    await writeFile(marker, `${JSON.stringify(BACKUP_MARKER)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return;
  }
  if (!(await validBackupOwnerMarker(backupDir))) {
    throw new AgentAdminError(
      409,
      "agent_backup_root_unsafe",
      "Agent backup root owner marker is invalid or unsafe",
    );
  }
}

async function validBackupOwnerMarker(backupDir: string): Promise<boolean> {
  const marker = path.join(backupDir, BACKUP_MARKER_FILE);
  const metadata = await safeLstat(marker);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) return false;
  try {
    const value = JSON.parse(await readFile(marker, "utf8")) as Record<string, unknown>;
    return value.owner === BACKUP_MARKER.owner &&
      value.schemaVersion === BACKUP_MARKER.schemaVersion;
  } catch {
    return false;
  }
}

async function readManagedTextFile(
  root: string,
  relative: string,
): Promise<string | undefined> {
  const target = path.join(root, relative);
  const metadata = await safeLstat(target);
  if (!metadata) return undefined;
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new AgentAdminError(
      409,
      "agent_state_unsafe_entry",
      `Managed Agent path must be a regular non-symlink file: ${relative}`,
    );
  }
  return readFile(target, "utf8");
}

async function safeDirectoryExists(target: string): Promise<boolean> {
  const metadata = await safeLstat(target);
  if (!metadata) return false;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new AgentAdminError(
      409,
      "agent_state_unsafe_entry",
      `Managed Agent directory must be a regular non-symlink directory: ${path.basename(target)}`,
    );
  }
  return true;
}

async function safeLstat(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function objectRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentAdminError(400, "invalid_admin_request", `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function sanitizeContent(content: string): string {
  return redactCredentialText(content);
}

function containsCredential(content: string): boolean {
  return containsCredentialText(content);
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

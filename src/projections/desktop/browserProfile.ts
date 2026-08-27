import type {
  AgentDangerousCommitResult,
  AgentHostIntegrityReport,
  AgentHostSnapshot,
  DesktopRuntimePort,
  DomainDangerousCommitResult,
  DomainExportDocument,
  DomainIntegrityReport,
} from "../../runtime/host";
import { createRuntimeRequestId } from "../../runtime/host/localHttp";
import {
  clearBrowserUiCompositionBackup,
  exportBrowserUiCompositionBackup,
  restoreBrowserUiCompositionBackup,
  type BrowserUiCompositionBackup,
  validateBrowserUiCompositionBackup,
} from "./browserUiComposition";

export const BROWSER_PROFILE_FORMAT = "latitude.browser-profile@1" as const;
export const BROWSER_SESSION_STORAGE_KEY = "latitude.browser-agent.session.v1";

type DangerousMode = "restore" | "delete_all" | "purge_all";

export interface BrowserProfileState {
  agentSessionId: string;
  /** Explicit allowlist only; unknown origin keys are never exported. */
  localStorage: Record<string, string>;
}

export interface BrowserProfileV1 {
  format: typeof BROWSER_PROFILE_FORMAT;
  schemaVersion: 1;
  exportedAt: string;
  checksum: string;
  domain: DomainExportDocument;
  agent: AgentHostSnapshot;
  uiComposition: BrowserUiCompositionBackup;
  browserState: BrowserProfileState;
}

export interface BrowserProfileIntegrityReport {
  format: "latitude.browser-profile-integrity@1";
  checkedAt: string;
  ok: boolean;
  domain: DomainIntegrityReport | FailedIntegrityCheck;
  agent: AgentHostIntegrityReport | FailedIntegrityCheck;
  browser: { ok: boolean; issues: string[] };
}

export interface BrowserDangerousPreparation {
  token: string;
  confirmation: string;
  expiresAt: string;
  /** Present when delete_all has durably read back its IndexedDB recovery copy. */
  recoveryBackupSavedAt?: string;
}

export interface BrowserDangerousCommitResult {
  ok: boolean;
  status: "complete" | "partial";
  operation: DangerousMode;
  restartRequired: boolean;
  reloadRequired: boolean;
  message: string;
  services: {
    domain: {
      committed: true;
      complete: boolean;
      receipt: DomainDangerousCommitResult;
    };
    agent: {
      committed: true;
      complete: boolean;
      receipt: AgentDangerousCommitResult;
    };
    browser: { committed: true; complete: true };
  };
  preservedEntries?: unknown[];
}

export interface BrowserRecoveryBackup {
  format: "latitude.browser-recovery@1";
  savedAt: string;
  profile: BrowserProfileV1;
}

/** Durable, origin-owned recovery storage. Production uses IndexedDB, not localStorage. */
export interface BrowserRecoveryStore {
  saveLatest(backup: BrowserRecoveryBackup): Promise<void>;
  loadLatest(): Promise<BrowserRecoveryBackup | null>;
  clear(): Promise<void>;
}

interface FailedIntegrityCheck {
  ok: false;
  error: string;
}

interface PendingCompositeOperation {
  compositeToken: string;
  operation: DangerousMode;
  confirmation: string;
  expiresAt: string;
  domainToken: string;
  agentToken: string;
  profile?: BrowserProfileV1;
  recoveryBackupChecksum?: string;
  recoveryBackupSavedAt?: string;
  progress: {
    domain?: DomainDangerousCommitResult;
    agent?: AgentDangerousCommitResult;
    browser: boolean;
  };
}

export class BrowserProfileMutationError extends Error {
  readonly code = "browser_profile_partial_commit";

  constructor(
    message: string,
    readonly progress: {
      domainCommitted: boolean;
      agentCommitted: boolean;
      browserCommitted: boolean;
    },
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "BrowserProfileMutationError";
    if (options?.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        configurable: true,
      });
    }
  }
}

/**
 * Coordinates the two local owners without pretending they share a transaction.
 * A composite token only wraps the two short-lived server tokens; progress is
 * retained in memory so retry never replays a service that already committed.
 */
export class BrowserProfileCoordinator {
  private pending?: PendingCompositeOperation;

  constructor(
    private readonly runtime: DesktopRuntimePort,
    private readonly currentSessionId: () => string,
    private readonly recoveryStore: BrowserRecoveryStore = createIndexedDbBrowserRecoveryStore(),
  ) {}

  async exportAll(): Promise<BrowserProfileV1> {
    const uiComposition = exportBrowserUiCompositionBackup();
    const agentSessionId = assertSessionId(this.currentSessionId());
    const [domain, agent] = await Promise.all([
      this.runtime.exportDomainData(),
      this.runtime.agent.exportState(),
    ]);
    return createBrowserProfile({
      domain,
      agent,
      uiComposition,
      browserState: {
        agentSessionId,
        localStorage: collectAllowlistedBrowserStorage(),
      },
    });
  }

  async checkIntegrity(): Promise<BrowserProfileIntegrityReport> {
    const [domain, agent] = await Promise.allSettled([
      this.runtime.checkDomainIntegrity(),
      this.runtime.agent.checkIntegrity(),
    ]);
    const issues: string[] = [];
    try {
      validateBrowserUiCompositionBackup(exportBrowserUiCompositionBackup());
    } catch (error) {
      issues.push(errorMessage(error));
    }
    try {
      assertSessionId(this.currentSessionId());
      validateAllowlistedBrowserStorage(collectAllowlistedBrowserStorage());
    } catch (error) {
      issues.push(errorMessage(error));
    }
    const domainReport = domain.status === "fulfilled"
      ? domain.value
      : { ok: false as const, error: errorMessage(domain.reason) };
    const agentReport = agent.status === "fulfilled"
      ? agent.value
      : { ok: false as const, error: errorMessage(agent.reason) };
    return {
      format: "latitude.browser-profile-integrity@1",
      checkedAt: new Date().toISOString(),
      ok: domainReport.ok === true && agentReport.ok === true && issues.length === 0,
      domain: domainReport,
      agent: agentReport,
      browser: { ok: issues.length === 0, issues },
    };
  }

  async prepareDangerous(input: {
    operation: DangerousMode;
    snapshot?: unknown;
  }): Promise<BrowserDangerousPreparation> {
    const profile = input.operation === "restore"
      ? await validateBrowserProfile(input.snapshot)
      : undefined;
    if (input.operation !== "restore" && input.snapshot !== undefined) {
      throw new TypeError(`${input.operation} does not accept a profile`);
    }

    // delete_all is recoverable only if all three owners have already exported
    // one credential-free, checksum-verified profile. Persist and read it back
    // before either service is even allowed to mint a destructive token.
    const recoveryBackup = input.operation === "delete_all"
      ? await this.persistRecoveryBackup()
      : undefined;

    const [domain, agent] = await Promise.all([
      this.runtime.prepareDangerousData({
        operation: input.operation,
        ...(profile ? { snapshot: profile.domain } : {}),
      }),
      this.runtime.agent.prepareDangerousData({
        operation: input.operation,
        ...(profile ? { snapshot: profile.agent } : {}),
      }),
    ]);
    if (domain.operation !== input.operation || agent.operation !== input.operation) {
      throw new Error("本地服务返回了不同的危险操作类型；没有生成组合提交令牌。");
    }
    if (domain.requiredConfirmation !== agent.confirmationPhrase) {
      throw new Error(
        "两个服务的确认短语不一致，本次没有提交。请等待凭证过期后重试。",
      );
    }
    const expiresAt = earliestExpiry(domain.expiresAt, agent.expiresAt);
    const compositeToken = createRuntimeRequestId("profile-danger");
    this.pending = {
      compositeToken,
      operation: input.operation,
      confirmation: domain.requiredConfirmation,
      expiresAt,
      domainToken: domain.token,
      agentToken: agent.token,
      ...(profile ? { profile } : {}),
      ...(recoveryBackup
        ? {
            recoveryBackupChecksum: recoveryBackup.profile.checksum,
            recoveryBackupSavedAt: recoveryBackup.savedAt,
          }
        : {}),
      progress: { browser: false },
    };
    return {
      token: compositeToken,
      confirmation: domain.requiredConfirmation,
      expiresAt,
      ...(recoveryBackup
        ? { recoveryBackupSavedAt: recoveryBackup.savedAt }
        : {}),
    };
  }

  /**
   * Restart-safe restore path for the latest recoverable clear. The record is
   * revalidated from IndexedDB before Domain or Agent receives a restore stage.
   */
  async prepareRecentRecovery(): Promise<BrowserDangerousPreparation> {
    const backup = await this.loadVerifiedRecoveryBackup();
    if (!backup) {
      throw new Error("这个浏览器里没有最近一次可恢复清空的完整备份。");
    }
    const prepared = await this.prepareDangerous({
      operation: "restore",
      snapshot: backup.profile,
    });
    return { ...prepared, recoveryBackupSavedAt: backup.savedAt };
  }

  async commitDangerous(input: {
    token: string;
    confirmation: string;
  }): Promise<BrowserDangerousCommitResult> {
    const pending = this.pending;
    if (!pending || pending.compositeToken !== input.token) {
      throw new Error("组合确认令牌不存在或已被新的准备操作替代，请重新执行第一步。");
    }
    if (pending.confirmation !== input.confirmation) {
      throw new Error("确认短语与两个本地服务准备的短语不完全一致。");
    }
    if (Date.parse(pending.expiresAt) <= Date.now()) {
      this.pending = undefined;
      throw new Error("组合确认令牌已过期，请重新执行第一步。");
    }

    if (
      pending.operation === "delete_all" &&
      !pending.progress.domain &&
      !pending.progress.agent
    ) {
      try {
        const backup = await this.loadVerifiedRecoveryBackup();
        if (
          !backup ||
          !pending.recoveryBackupChecksum ||
          backup.profile.checksum !== pending.recoveryBackupChecksum
        ) {
          throw new Error("最近可恢复备份已缺失或被替换");
        }
      } catch (error) {
        throw this.partialError(
          "恢复备份未通过校验；本次没有清空任何数据",
          pending,
          error,
        );
      }
    }

    if (!pending.progress.domain) {
      try {
        const receipt = await this.runtime.commitDangerousData({
          token: pending.domainToken,
          confirmation: input.confirmation,
        });
        // A 200 receipt consumes the single-use Domain token even when purge
        // reports partial cleanup. Record it before any interpretation so a
        // retry can never replay already-cleared active data.
        pending.progress.domain = receipt;
      } catch (error) {
        throw this.partialError("数据服务尚未确认完成", pending, error);
      }
    }

    if (!pending.progress.agent) {
      try {
        const receipt = await this.runtime.agent.commitDangerousData({
          token: pending.agentToken,
          confirmation: input.confirmation,
        });
        if (receipt.operation !== pending.operation) {
          throw new Error("助手服务返回了不匹配的处理结果");
        }
        // A partial purge still consumes the one-shot Agent token. Retain the
        // exact receipt so retries continue Browser cleanup without replaying it.
        pending.progress.agent = receipt;
      } catch (error) {
        throw this.partialError(
          "数据服务已返回结果，但助手服务还没有返回。当前进度会保留，重试不会重复提交已完成的步骤",
          pending,
          error,
        );
      }
    }

    if (!pending.progress.browser) {
      try {
        await this.commitBrowserState(pending);
        pending.progress.browser = true;
      } catch (error) {
        throw this.partialError(
          "两个本地服务已完成，但页面还没有同步。请保持本窗口并重试",
          pending,
          error,
        );
      }
    }

    const domainComplete = isDomainCommitComplete(
      pending.progress.domain,
      pending.operation,
    );
    const agentComplete = isAgentCommitComplete(
      pending.progress.agent,
      pending.operation,
    );
    const browserComplete = pending.progress.browser;
    const complete = domainComplete && agentComplete && browserComplete;
    const preservedEntries = [
      ...domainPreservedEntries(pending.progress.domain),
      ...agentPreservedEntries(pending.progress.agent),
    ];
    const result: BrowserDangerousCommitResult = {
      ok: complete,
      status: complete ? "complete" : "partial",
      operation: pending.operation,
      restartRequired: pending.progress.agent.restartRequired,
      reloadRequired: true,
      message: !complete
        ? "本次只完成了一部分：仍有未清理、可恢复或无法处理的内容。请查看处理结果和保留项，处理后重新准备。服务仍需重启，页面仍需重新加载。"
        : pending.operation === "purge_all"
          ? "永久删除已完成。请重启助手服务并重新加载页面。外部导出副本不受影响。"
          : pending.operation === "restore"
            ? "数据已完整恢复。请重启助手服务并重新加载页面。"
            : "可恢复清空已完成。请重启助手服务并重新加载页面；安全备份仍保留。",
      services: {
        domain: {
          committed: true,
          complete: domainComplete,
          receipt: pending.progress.domain,
        },
        agent: {
          committed: true,
          complete: agentComplete,
          receipt: pending.progress.agent,
        },
        browser: { committed: true, complete: browserComplete },
      },
      ...(preservedEntries.length > 0 ? { preservedEntries } : {}),
    };
    this.pending = undefined;
    return result;
  }

  private async commitBrowserState(pending: PendingCompositeOperation): Promise<void> {
    if (pending.operation === "restore") {
      const profile = pending.profile;
      if (!profile) throw new Error("恢复 profile 已丢失");
      // validateBrowserProfile already validated both values before either service staged.
      window.localStorage.setItem(
        BROWSER_SESSION_STORAGE_KEY,
        assertSessionId(profile.browserState.agentSessionId),
      );
      // Position/legacy hidden is restored first so a five-card V2 profile can
      // seed the deterministic companion overlay migration without losing x/y.
      restoreAllowlistedBrowserStorage(profile.browserState.localStorage);
      restoreBrowserUiCompositionBackup(profile.uiComposition);
      return;
    }
    if (pending.operation === "purge_all") {
      // Clear the durable recovery copy before erasing ordinary Browser state.
      // If IndexedDB refuses, the Browser layer remains incomplete and retryable.
      await this.recoveryStore.clear();
      if (await this.recoveryStore.loadLatest()) {
        throw new Error("浏览器最近可恢复备份没有被永久删除");
      }
    }
    window.localStorage.removeItem(BROWSER_SESSION_STORAGE_KEY);
    clearAllowlistedBrowserStorage();
    // UI reset emits the shared restored event; fire it only after companion
    // position storage is gone so the mounted overlay reloads the clean state.
    clearBrowserUiCompositionBackup();
  }

  private async persistRecoveryBackup(): Promise<BrowserRecoveryBackup> {
    const profile = await this.exportAll();
    assertCredentialFreeProfile(profile);
    const backup: BrowserRecoveryBackup = {
      format: "latitude.browser-recovery@1",
      savedAt: new Date().toISOString(),
      profile,
    };
    await this.recoveryStore.saveLatest(backup);
    const readback = await this.loadVerifiedRecoveryBackup();
    if (
      !readback ||
      readback.savedAt !== backup.savedAt ||
      readback.profile.checksum !== profile.checksum
    ) {
      throw new Error("可恢复完整备份写入后未能原样读回；清空已被阻止。");
    }
    return readback;
  }

  private async loadVerifiedRecoveryBackup(): Promise<BrowserRecoveryBackup | null> {
    const candidate = await this.recoveryStore.loadLatest();
    if (!candidate) return null;
    if (
      candidate.format !== "latitude.browser-recovery@1" ||
      typeof candidate.savedAt !== "string" ||
      !Number.isFinite(Date.parse(candidate.savedAt))
    ) {
      throw new TypeError("最近可恢复备份的元数据无效");
    }
    const profile = await validateBrowserProfile(candidate.profile);
    assertCredentialFreeProfile(profile);
    return { format: candidate.format, savedAt: candidate.savedAt, profile };
  }

  private partialError(
    summary: string,
    pending: PendingCompositeOperation,
    cause: unknown,
  ): BrowserProfileMutationError {
    const progress = {
      domainCommitted: Boolean(pending.progress.domain),
      agentCommitted: Boolean(pending.progress.agent),
      browserCommitted: pending.progress.browser,
    };
    return new BrowserProfileMutationError(
      `${summary}。当前状态：数据服务 ${progress.domainCommitted ? "已返回" : "未返回"}，` +
        `助手服务 ${progress.agentCommitted ? "已返回" : "未返回"}，浏览器 ${progress.browserCommitted ? "已同步" : "未同步"}。` +
        `原因：${errorMessage(cause)}。若服务令牌已过期，请重新执行第一步；不要把当前状态当成全部成功。`,
      progress,
      { cause },
    );
  }
}

export async function createBrowserProfile(input: {
  domain: DomainExportDocument;
  agent: AgentHostSnapshot;
  uiComposition: BrowserUiCompositionBackup;
  browserState: BrowserProfileState;
  exportedAt?: string;
}): Promise<BrowserProfileV1> {
  assertDomainSnapshot(input.domain);
  assertAgentSnapshot(input.agent);
  const uiComposition = validateBrowserUiCompositionBackup(input.uiComposition);
  const browserState = {
    agentSessionId: assertSessionId(input.browserState.agentSessionId),
    localStorage: validateAllowlistedBrowserStorage(input.browserState.localStorage),
  };
  const exportedAt = input.exportedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(exportedAt))) throw new TypeError("Profile exportedAt is invalid");
  const unsigned = {
    format: BROWSER_PROFILE_FORMAT,
    schemaVersion: 1 as const,
    exportedAt,
    domain: input.domain,
    agent: input.agent,
    uiComposition,
    browserState,
  };
  return { ...unsigned, checksum: await checksum(unsigned) };
}

export async function validateBrowserProfile(value: unknown): Promise<BrowserProfileV1> {
  if (!isRecord(value) || value.format !== BROWSER_PROFILE_FORMAT || value.schemaVersion !== 1) {
    throw new TypeError(
      `恢复需要 ${BROWSER_PROFILE_FORMAT} 完整导出文件；旧版导出不包含助手会话。`,
    );
  }
  if (typeof value.exportedAt !== "string" || !Number.isFinite(Date.parse(value.exportedAt))) {
    throw new TypeError("Profile exportedAt is invalid");
  }
  if (typeof value.checksum !== "string" || !/^[a-f0-9]{64}$/.test(value.checksum)) {
    throw new TypeError("Profile checksum is invalid");
  }
  assertDomainSnapshot(value.domain);
  assertAgentSnapshot(value.agent);
  const uiComposition = validateBrowserUiCompositionBackup(value.uiComposition);
  if (!isRecord(value.browserState)) throw new TypeError("Profile browserState is missing");
  const browserState = {
    agentSessionId: assertSessionId(value.browserState.agentSessionId),
    localStorage: validateAllowlistedBrowserStorage(value.browserState.localStorage),
  };
  const profile: BrowserProfileV1 = {
    format: BROWSER_PROFILE_FORMAT,
    schemaVersion: 1,
    exportedAt: value.exportedAt,
    checksum: value.checksum,
    domain: value.domain as unknown as DomainExportDocument,
    agent: value.agent as unknown as AgentHostSnapshot,
    uiComposition,
    browserState,
  };
  const { checksum: supplied, ...unsigned } = profile;
  const actual = await checksum(unsigned);
  if (actual !== supplied) throw new TypeError("Profile checksum differs; restore was not staged");
  return profile;
}

function assertDomainSnapshot(value: unknown): asserts value is DomainExportDocument {
  if (!isRecord(value) || value.format !== "latitude.constellation.export@0.1") {
    throw new TypeError("数据快照格式不支持");
  }
  if (
    typeof value.schemaVersion !== "string" ||
    typeof value.exportedAt !== "string" ||
    !Number.isFinite(Date.parse(value.exportedAt)) ||
    typeof value.checksum !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.checksum) ||
    !("data" in value)
  ) {
    throw new TypeError("数据快照不完整");
  }
}

function assertAgentSnapshot(value: unknown): asserts value is AgentHostSnapshot {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.exportedAt !== "string" ||
    !Number.isFinite(Date.parse(value.exportedAt)) ||
    typeof value.checksum !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.checksum) ||
    !isRecord(value.files) ||
    Object.values(value.files).some((content) => typeof content !== "string")
  ) {
    throw new TypeError("助手数据不完整");
  }
}

function assertSessionId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{5,199}$/.test(value)
  ) {
    throw new TypeError("对话标识无效");
  }
  return value;
}

const EXACT_BROWSER_STORAGE_KEYS = new Set([
  "latitude.secretary-companion.v1",
  "dim-rail-collapsed",
  "dim-clue-positions-v1",
  "dim-clue-connections-v1",
]);
const BROWSER_STORAGE_PREFIXES = ["dim-card-edits-", "dim-desk-offsets-"] as const;
const MAX_BROWSER_STORAGE_ITEM_BYTES = 2 * 1_048_576;
const MAX_BROWSER_STORAGE_TOTAL_BYTES = 8 * 1_048_576;

export function collectAllowlistedBrowserStorage(): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key || !isAllowlistedBrowserStorageKey(key)) continue;
    const value = window.localStorage.getItem(key);
    if (value !== null) values[key] = value;
  }
  return validateAllowlistedBrowserStorage(values);
}

export function validateAllowlistedBrowserStorage(
  value: unknown,
): Record<string, string> {
  if (!isRecord(value)) throw new TypeError("Profile browser localStorage map is missing");
  const validated: Record<string, string> = {};
  let totalBytes = 0;
  for (const [key, raw] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    if (!isAllowlistedBrowserStorageKey(key)) {
      throw new TypeError(`Profile contains a non-allowlisted browser key: ${key}`);
    }
    if (typeof raw !== "string") throw new TypeError(`Browser storage ${key} must be text`);
    const bytes = new TextEncoder().encode(raw).byteLength;
    if (bytes > MAX_BROWSER_STORAGE_ITEM_BYTES) {
      throw new TypeError(`Browser storage ${key} exceeds the item limit`);
    }
    totalBytes += bytes;
    if (totalBytes > MAX_BROWSER_STORAGE_TOTAL_BYTES) {
      throw new TypeError("Browser storage exceeds the profile limit");
    }
    validateBrowserStorageItem(key, raw);
    validated[key] = raw;
  }
  return validated;
}

export function restoreAllowlistedBrowserStorage(value: unknown): void {
  const validated = validateAllowlistedBrowserStorage(value);
  clearAllowlistedBrowserStorage();
  for (const [key, raw] of Object.entries(validated)) {
    window.localStorage.setItem(key, raw);
  }
}

export function clearAllowlistedBrowserStorage(): void {
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key && isAllowlistedBrowserStorageKey(key)) keys.push(key);
  }
  keys.forEach((key) => window.localStorage.removeItem(key));
}

function isAllowlistedBrowserStorageKey(key: string): boolean {
  if (EXACT_BROWSER_STORAGE_KEYS.has(key)) return true;
  return BROWSER_STORAGE_PREFIXES.some((prefix) => {
    if (!key.startsWith(prefix)) return false;
    const suffix = key.slice(prefix.length);
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(suffix);
  });
}

function validateBrowserStorageItem(key: string, raw: string): void {
  if (key === "dim-rail-collapsed") {
    if (raw !== "0" && raw !== "1") throw new TypeError("dim-rail-collapsed must be 0 or 1");
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError(`Browser storage ${key} is not valid JSON`);
  }
  if (!isRecord(parsed)) throw new TypeError(`Browser storage ${key} must contain an object`);
  if (key === "latitude.secretary-companion.v1") {
    if (
      typeof parsed.x !== "number" || !Number.isFinite(parsed.x) ||
      typeof parsed.y !== "number" || !Number.isFinite(parsed.y) ||
      typeof parsed.hidden !== "boolean"
    ) {
      throw new TypeError("Secretary companion position is invalid");
    }
    return;
  }
  if (key === "dim-clue-connections-v1") {
    if (
      Object.values(parsed).some(
        (relation) => !["support", "verify", "related", "none"].includes(String(relation)),
      )
    ) {
      throw new TypeError("Clue connection state is invalid");
    }
    return;
  }
  if (key === "dim-clue-positions-v1" || key.startsWith("dim-desk-offsets-")) {
    if (
      Object.values(parsed).some(
        (position) =>
          !isRecord(position) ||
          typeof position.x !== "number" || !Number.isFinite(position.x) ||
          typeof position.y !== "number" || !Number.isFinite(position.y),
      )
    ) {
      throw new TypeError(`Browser position state is invalid: ${key}`);
    }
  }
  // dim-card-edits-* deliberately accepts nested product payloads, but only as
  // a bounded JSON object under the exact prefix. It may contain user text.
}

function isDomainCommitComplete(
  receipt: DomainDangerousCommitResult,
  operation: DangerousMode,
): boolean {
  return Boolean(
    receipt.ok &&
    receipt.status !== "partial" &&
    (receipt.operation === undefined || receipt.operation === operation) &&
    (operation !== "purge_all" || receipt.recoverable !== true) &&
    domainPreservedEntries(receipt).length === 0,
  );
}

function isAgentCommitComplete(
  receipt: AgentDangerousCommitResult,
  operation: DangerousMode,
): boolean {
  return Boolean(
    receipt.ok &&
    receipt.operation === operation &&
    receipt.status !== "partial" &&
    (operation !== "purge_all" || receipt.recoverable !== true) &&
    agentPreservedEntries(receipt).length === 0,
  );
}

function domainPreservedEntries(receipt: DomainDangerousCommitResult): unknown[] {
  const entries: unknown[] = [];
  for (const field of ["backupCleanup", "sidecarCleanup"] as const) {
    const section = receipt[field];
    if (!isRecord(section)) continue;
    for (const list of [section.refused, section.errors]) {
      if (Array.isArray(list)) entries.push(...list);
    }
  }
  return entries;
}

function agentPreservedEntries(receipt: AgentDangerousCommitResult): unknown[] {
  const direct = Array.isArray(receipt.preservedEntries)
    ? receipt.preservedEntries
    : [];
  const nested = receipt.backupCleanup?.preservedEntries;
  return [...new Set([
    ...direct,
    ...(Array.isArray(nested) ? nested : []),
  ])];
}

const RECOVERY_DATABASE = "latitude-browser-recovery-v1";
const RECOVERY_OBJECT_STORE = "profiles";
const RECOVERY_LATEST_KEY = "latest-recoverable-delete";

export function createIndexedDbBrowserRecoveryStore(): BrowserRecoveryStore {
  return {
    async saveLatest(backup) {
      const database = await openRecoveryDatabase();
      try {
        const transaction = database.transaction(RECOVERY_OBJECT_STORE, "readwrite");
        transaction.objectStore(RECOVERY_OBJECT_STORE).put(
          JSON.stringify(backup),
          RECOVERY_LATEST_KEY,
        );
        await indexedDbTransactionDone(transaction);
      } finally {
        database.close();
      }
    },
    async loadLatest() {
      const database = await openRecoveryDatabase();
      try {
        const transaction = database.transaction(RECOVERY_OBJECT_STORE, "readonly");
        const raw = await indexedDbRequest<unknown>(
          transaction.objectStore(RECOVERY_OBJECT_STORE).get(RECOVERY_LATEST_KEY),
        );
        await indexedDbTransactionDone(transaction);
        if (raw === undefined) return null;
        if (typeof raw !== "string") {
          throw new TypeError("最近可恢复备份不是受支持的 JSON 记录");
        }
        return JSON.parse(raw) as BrowserRecoveryBackup;
      } finally {
        database.close();
      }
    },
    async clear() {
      const database = await openRecoveryDatabase();
      try {
        const transaction = database.transaction(RECOVERY_OBJECT_STORE, "readwrite");
        transaction.objectStore(RECOVERY_OBJECT_STORE).delete(RECOVERY_LATEST_KEY);
        await indexedDbTransactionDone(transaction);
      } finally {
        database.close();
      }
    },
  };
}

function openRecoveryDatabase(): Promise<IDBDatabase> {
  const factory = globalThis.indexedDB;
  if (!factory) {
    return Promise.reject(
      new Error("当前浏览器无法保存可恢复备份，本次清空已取消。"),
    );
  }
  return new Promise((resolve, reject) => {
    const request = factory.open(RECOVERY_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(RECOVERY_OBJECT_STORE)) {
        request.result.createObjectStore(RECOVERY_OBJECT_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("本机备份无法打开"));
    request.onblocked = () => reject(new Error("另一个页面正在使用备份，请关闭后重试"));
  });
}

function indexedDbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("本机备份读取失败"));
  });
}

function indexedDbTransactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(
      transaction.error ?? new Error("本机备份操作已中止"),
    );
    transaction.onerror = () => {
      // The abort event owns the final rejection; retaining this handler keeps
      // browser consoles from treating the transaction error as unobserved.
    };
  });
}

function assertCredentialFreeProfile(profile: BrowserProfileV1): void {
  if (/\bsk-[A-Za-z0-9_-]{20,}\b/.test(canonicalJson(profile))) {
    throw new TypeError("完整 profile 含有模型凭证形态的内容；可恢复清空已被阻止。");
  }
}

function earliestExpiry(left: string, right: string): string {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) {
    throw new TypeError("本地服务返回了无效的确认令牌有效期");
  }
  return leftMs <= rightMs ? left : right;
}

async function checksum(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("当前浏览器不支持本地 SHA-256，无法生成可校验的完整 profile");
  }
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Profile contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Profile contains a non-JSON value");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

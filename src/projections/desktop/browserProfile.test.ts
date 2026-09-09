import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentHostSnapshot,
  DesktopRuntimePort,
  DomainExportDocument,
} from "../../runtime/host";
import {
  BROWSER_PRODUCT_LAYOUT_DOCUMENT as SEED_LAYOUT_DOCUMENT,
  layoutV1ToUiSurfaceV2,
} from "../../runtime/composition/browserProduction";
import {
  BROWSER_PROFILE_FORMAT,
  BROWSER_SESSION_STORAGE_KEY,
  BrowserProfileCoordinator,
  BrowserProfileMutationError,
  type BrowserRecoveryBackup,
  type BrowserRecoveryStore,
  createBrowserProfile,
  validateBrowserProfile,
} from "./browserProfile";

const SESSION_ID = "latitude-browser-profile-test";

class MemoryRecoveryStore implements BrowserRecoveryStore {
  backup: BrowserRecoveryBackup | null = null;
  failSave = false;
  failClear = false;

  async saveLatest(backup: BrowserRecoveryBackup) {
    if (this.failSave) throw new Error("recovery quota exceeded");
    this.backup = structuredClone(backup);
  }

  async loadLatest() {
    return this.backup ? structuredClone(this.backup) : null;
  }

  async clear() {
    if (this.failClear) throw new Error("recovery delete failed");
    this.backup = null;
  }
}

function profileCoordinator(
  runtime: DesktopRuntimePort,
  recoveryStore: BrowserRecoveryStore = new MemoryRecoveryStore(),
) {
  return new BrowserProfileCoordinator(runtime, () => SESSION_ID, recoveryStore);
}

function domainSnapshot(): DomainExportDocument {
  return {
    format: "latitude.constellation.export@0.1",
    schemaVersion: "2",
    exportedAt: "2026-08-24T12:00:00Z",
    checksum: `sha256:${"d".repeat(64)}`,
    data: { nodes: [], edges: [] },
  };
}

function agentSnapshot(): AgentHostSnapshot {
  return {
    schemaVersion: 1,
    exportedAt: "2026-08-24T12:00:00Z",
    checksum: "a".repeat(64),
    files: {
      "sessions/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.meta.json":
        JSON.stringify({ sessionId: SESSION_ID }),
    },
  };
}

function fakeRuntime() {
  const runtime: DesktopRuntimePort = {
    kind: "http",
    health: vi.fn(),
    getContext: vi.fn(),
    applyChange: vi.fn(),
    recordActivity: vi.fn(),
    listChangeSets: vi.fn(),
    createAction: vi.fn(),
    createCandidate: vi.fn(),
    commandCandidate: vi.fn(),
    listDueCandidates: vi.fn(),
    recordOutcome: vi.fn(),
    applyFeedback: vi.fn(),
    createWeeklyReview: vi.fn(),
    exportDomainData: vi.fn(async () => domainSnapshot()),
    checkDomainIntegrity: vi.fn(async () => ({ ok: true, quickCheck: "ok" })),
    prepareDangerousData: vi.fn(async (request) => ({
      ok: true,
      operation: request.operation,
      token: `domain-${request.operation}`,
      expiresAt: "2099-08-24T12:10:00Z",
      requiredConfirmation:
        request.operation === "restore"
          ? "RESTORE LOCAL DATA"
          : request.operation === "purge_all"
            ? "PERMANENTLY DELETE ALL LATITUDE DATA"
            : "DELETE ALL LOCAL DATA",
    })),
    commitDangerousData: vi.fn(async () => ({
      ok: true,
      changeSetId: "domain-change",
      value: null,
    })),
    runAgentTurn: vi.fn(),
    searchWeb: vi.fn(),
    agent: {
      getLatestRun: vi.fn(), getProgress: vi.fn(), getPersona: vi.fn(), updatePersona: vi.fn(),
      health: vi.fn(),
      getProviderSettings: vi.fn(),
      updateProviderSettings: vi.fn(),
      startTurn: vi.fn(),
      getRun: vi.fn(),
      waitForRun: vi.fn(),
      cancelRun: vi.fn(),
      listMessages: vi.fn(),
      listSchedulerOutbox: vi.fn(),
      acknowledgeSchedulerOutbox: vi.fn(),
      exportState: vi.fn(async () => agentSnapshot()),
      checkIntegrity: vi.fn(async () => ({
        ok: true,
        checksum: "a".repeat(64),
        fileCount: 1,
        issues: [],
      })),
      prepareDangerousData: vi.fn(async (request) => ({
        operation: request.operation,
        token: `agent-${request.operation}`,
        expiresAt: "2099-08-24T12:05:00Z",
        confirmationPhrase:
          request.operation === "restore"
            ? "RESTORE LOCAL DATA"
            : request.operation === "purge_all"
              ? "PERMANENTLY DELETE ALL LATITUDE DATA"
              : "DELETE ALL LOCAL DATA",
        ...(request.snapshot ? { snapshot: request.snapshot } : {}),
      })),
      commitDangerousData: vi.fn(async (request) => ({
        ok: true,
        operation: request.confirmation.startsWith("RESTORE")
          ? "restore" as const
          : request.confirmation.startsWith("PERMANENTLY")
            ? "purge_all" as const
            : "delete_all" as const,
        checksum: "0".repeat(64),
        backupPath: "/local/backup",
        restartRequired: true,
      })),
      search: vi.fn(),
    },
  };
  return runtime;
}

async function fullProfile() {
  return createBrowserProfile({
    domain: domainSnapshot(),
    agent: agentSnapshot(),
    uiComposition: {
      format: "latitude.browser-ui-composition@0.1",
      exportedAt: "2026-08-24T12:00:00Z",
      documents: {},
    },
    browserState: { agentSessionId: SESSION_ID, localStorage: {} },
    exportedAt: "2026-08-24T12:00:00Z",
  });
}

describe("完整 browser profile", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(BROWSER_SESSION_STORAGE_KEY, SESSION_ID);
  });

  it("完整导出同时包含 Domain、Agent Host、组件状态和会话身份，并校验根 checksum", async () => {
    const runtime = fakeRuntime();
    const coordinator = profileCoordinator(runtime);

    const profile = await coordinator.exportAll();

    expect(profile).toMatchObject({
      format: BROWSER_PROFILE_FORMAT,
      schemaVersion: 1,
      domain: { checksum: `sha256:${"d".repeat(64)}` },
      agent: { checksum: "a".repeat(64) },
      uiComposition: { format: "latitude.browser-ui-composition@0.2" },
      browserState: { agentSessionId: SESSION_ID },
    });
    expect(profile.checksum).toMatch(/^[a-f0-9]{64}$/);
    await expect(validateBrowserProfile(profile)).resolves.toEqual(profile);

    const tampered = structuredClone(profile);
    tampered.browserState.agentSessionId = "latitude-browser-tampered";
    await expect(validateBrowserProfile(tampered)).rejects.toThrow(/checksum differs/);
  });

  it("只导出明确 allowlist 的浏览器产品状态，恢复时替换这些键但保留未知 origin 键", async () => {
    const allowlisted = {
      "latitude.secretary-companion.v1": JSON.stringify({ x: 12, y: 34, hidden: false }),
      "dim-rail-collapsed": "1",
      "dim-card-edits-dimension-seed-desktop": JSON.stringify({
        bindings: { "seed-feed": { kind: "feed", rows: [] } },
      }),
      "dim-clue-positions-v1": JSON.stringify({ "thread-work": { x: 20, y: 30 } }),
      "dim-clue-connections-v1": JSON.stringify({ "thread-work": "support" }),
      "dim-desk-offsets-dimension-seed-desktop": JSON.stringify({
        "seed-feed": { x: 8, y: -4 },
      }),
      "dim-desk-sizes-latitude-browser-live": JSON.stringify({
        "browser-feed": { width: 766, height: 181 },
        "compact-note": { width: 180, height: 140 },
      }),
      "dim-desk-locks-latitude-browser-live": JSON.stringify(["seed-feed", "area-reference:delivery"]),
      "dim-desk-arranged-latitude-browser-live": "true",
      "dim-desk-zoom-latitude-browser-live": "0.75",
      "dim-desk-camera-latitude-browser-live": JSON.stringify({ version: 1,
        camera: { x: 1800, y: -240, zoom: 0.75 }, home: { x: 0, y: 0, zoom: 1 },
        previous: { x: 600, y: 280, zoom: 0.5 } }),
      "dim-desk-workspace-latitude-browser-live": JSON.stringify({ version: 1, areas: {
        delivery: { id: "delivery", title: "客户交付", x: 1800, y: 40, legacyLayoutIds: ["latitude-browser-live--clue-abc"] },
      }, activeAreaId: "delivery", cardAreaIds: { "custom-card-profile-test": "delivery" } }),
      "dim-desk-frames-latitude-browser-live": JSON.stringify({ version: 1, frames: {
        "browser-feed": { x: -40, y: 22, width: 420, height: 440 },
        "compact-note": { x: 470, y: 0, width: 300, height: 210 },
      } }),
      "dim-custom-cards-latitude-browser-live": JSON.stringify({ version: 1, cards: [{
        id: "custom-card-profile-test", title: "离线便签", body: "需要随备份保留的文字", template: "note", hidden: false,
        createdAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-05T00:00:00.000Z", revision: 1,
        syncedRevision: 0, syncState: "local",
      }] }),
    };
    for (const [key, value] of Object.entries(allowlisted)) {
      window.localStorage.setItem(key, value);
    }
    window.localStorage.setItem("third-party-unknown-key", "leave-me-alone");
    window.localStorage.setItem("dim-desk-arrangement-undo-latitude-browser-live", "old-layout-snapshot");
    const runtime = fakeRuntime();
    const coordinator = profileCoordinator(runtime);
    const profile = await coordinator.exportAll();

    expect(profile.browserState.localStorage).toEqual(allowlisted);
    expect(profile.browserState.localStorage).not.toHaveProperty("third-party-unknown-key");
    expect(profile.browserState.localStorage).not.toHaveProperty("dim-desk-arrangement-undo-latitude-browser-live");
    for (const key of Object.keys(allowlisted)) window.localStorage.removeItem(key);
    window.localStorage.setItem("dim-rail-collapsed", "0");

    const prepared = await coordinator.prepareDangerous({
      operation: "restore",
      snapshot: profile,
    });
    await coordinator.commitDangerous({
      token: prepared.token,
      confirmation: prepared.confirmation,
    });

    for (const [key, value] of Object.entries(allowlisted)) {
      expect(window.localStorage.getItem(key)).toBe(value);
    }
    expect(window.localStorage.getItem("third-party-unknown-key")).toBe("leave-me-alone");
    expect(window.localStorage.getItem("dim-desk-arrangement-undo-latitude-browser-live")).toBeNull();
  });

  it.each([
    '{"feed":{"width":0,"height":240}}',
    '{"feed":{"width":320,"height":139}}',
    '{"feed":{"width":"320","height":240}}',
    '{"feed":{"width":1e309,"height":240}}',
    '{"feed":{"width":320,"height":1e309}}',
  ])("无效尺寸不进入完整 profile：%s", async (raw) => {
    window.localStorage.setItem("dim-desk-sizes-latitude-browser-live", raw);
    await expect(profileCoordinator(fakeRuntime()).exportAll())
      .rejects.toThrow("Browser card size state is invalid");
  });

  it.each(['{}', 'null', '["a","a"]', '[""]', '["a",2]'])("无效卡片锁定状态不进入完整 profile：%s", async (raw) => {
    window.localStorage.setItem("dim-desk-locks-latitude-browser-live", raw);
    await expect(profileCoordinator(fakeRuntime()).exportAll()).rejects.toThrow("card locks");
  });

  it.each(["1", "{}", "null", "false "])("无效桌面整理状态不进入完整 profile：%s", async (raw) => {
    window.localStorage.setItem("dim-desk-arranged-latitude-browser-live", raw);
    await expect(profileCoordinator(fakeRuntime()).exportAll()).rejects.toThrow("arrangement");
  });

  it.each([
    '{"version":2,"frames":{}}',
    '{"version":1,"frames":{"feed":{"x":0,"y":0,"width":420,"height":139}}}',
    '{"version":1,"frames":{"feed":{"x":"0","y":0,"width":420,"height":440}}}',
    '{"version":1,"frames":{"feed":{"x":0,"y":1e309,"width":420,"height":440}}}',
    '{"version":1,"frames":{}}' + " ".repeat(128_000),
  ])("无效独立卡片坐标不进入完整 profile", async (raw) => {
    window.localStorage.setItem("dim-desk-frames-latitude-browser-live", raw);
    await expect(profileCoordinator(fakeRuntime()).exportAll()).rejects.toThrow(/frame/);
  });

  it.each(["0", "0.249", "2.001", "-1", "1e309", "NaN", '"1"', "{}", "null", ""])("无效桌面缩放不进入完整 profile：%s", async (raw) => {
    window.localStorage.setItem("dim-desk-zoom-latitude-browser-live", raw);
    await expect(profileCoordinator(fakeRuntime()).exportAll()).rejects.toThrow("desktop zoom");
  });

  it.each(["0.25", "1", "2"])("完整 profile 保留有效桌面缩放边界：%s", async (raw) => {
    window.localStorage.setItem("dim-desk-zoom-latitude-browser-live", raw);
    const profile = await profileCoordinator(fakeRuntime()).exportAll();
    expect(profile.browserState.localStorage["dim-desk-zoom-latitude-browser-live"]).toBe(raw);
  });

  it.each([
    { version: 2, camera: { x: 0, y: 0, zoom: 1 }, home: { x: 0, y: 0, zoom: 1 } },
    { version: 1, camera: { x: "0", y: 0, zoom: 1 }, home: { x: 0, y: 0, zoom: 1 } },
    { version: 1, camera: { x: 0, y: 0, zoom: 2.1 }, home: { x: 0, y: 0, zoom: 1 } },
    { version: 1, camera: { x: 0, y: 0, zoom: 1 }, home: { x: 0, y: 0, zoom: 0 } },
    { version: 1, camera: { x: 0, y: 0, zoom: 1 }, home: { x: 0, y: 0, zoom: 1 }, previous: { x: 10 } },
  ])("无效桌面相机不进入完整 profile", async (value) => {
    window.localStorage.setItem("dim-desk-camera-latitude-browser-live", JSON.stringify(value));
    await expect(profileCoordinator(fakeRuntime()).exportAll()).rejects.toThrow(/camera/i);
  });

  it.each([
    { version: 2, areas: {}, activeAreaId: null },
    { version: 1, areas: { a: { id: "b", title: "标题", x: 0, y: 0 } }, activeAreaId: null },
    { version: 1, areas: { a: { id: "a", title: "标题", x: "0", y: 0 } }, activeAreaId: null },
    { version: 1, areas: { a: { id: "a", title: "标题", x: 0, y: 0, legacyLayoutIds: [10] } }, activeAreaId: null },
    { version: 1, areas: { a: { id: "a", title: "标题", x: 0, y: 0 } }, activeAreaId: null, cardAreaIds: [] },
    { version: 1, areas: { a: { id: "a", title: "标题", x: 0, y: 0 } }, activeAreaId: null, cardAreaIds: { card: "missing-area" } },
  ])("无效桌面板块不进入完整 profile", async (value) => {
    window.localStorage.setItem("dim-desk-workspace-latitude-browser-live", JSON.stringify(value));
    await expect(profileCoordinator(fakeRuntime()).exportAll()).rejects.toThrow(/workspace|area/i);
  });

  it("恢复准备把各自 snapshot 同时交给两个服务，并只暴露组合 token", async () => {
    const runtime = fakeRuntime();
    const coordinator = profileCoordinator(runtime);
    const profile = await fullProfile();

    const prepared = await coordinator.prepareDangerous({
      operation: "restore",
      snapshot: profile,
    });

    expect(prepared).toMatchObject({
      confirmation: "RESTORE LOCAL DATA",
      expiresAt: "2099-08-24T12:05:00Z",
    });
    expect(prepared.token).not.toBe("domain-restore");
    expect(prepared.token).not.toBe("agent-restore");
    expect(runtime.prepareDangerousData).toHaveBeenCalledWith({
      operation: "restore",
      snapshot: profile.domain,
    });
    expect(runtime.agent.prepareDangerousData).toHaveBeenCalledWith({
      operation: "restore",
      snapshot: profile.agent,
    });
  });

  it("两个服务的确认短语只要不完全一致，就拒绝生成可提交的组合状态", async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.agent.prepareDangerousData).mockResolvedValue({
      token: "agent-bad",
      operation: "delete_all",
      confirmationPhrase: "DELETE LOCAL DATA",
      expiresAt: "2099-08-24T12:05:00Z",
    });
    const coordinator = profileCoordinator(runtime);

    await expect(
      coordinator.prepareDangerous({ operation: "delete_all" }),
    ).rejects.toThrow(/确认短语不一致/);
    expect(runtime.commitDangerousData).not.toHaveBeenCalled();
    expect(runtime.agent.commitDangerousData).not.toHaveBeenCalled();
  });

  it("完整恢复备份写入或读回失败时，在服务准备之前阻止可恢复清空", async () => {
    const runtime = fakeRuntime();
    const recoveryStore = new MemoryRecoveryStore();
    recoveryStore.failSave = true;
    const coordinator = profileCoordinator(runtime, recoveryStore);

    await expect(
      coordinator.prepareDangerous({ operation: "delete_all" }),
    ).rejects.toThrow(/recovery quota exceeded/);
    expect(runtime.prepareDangerousData).not.toHaveBeenCalled();
    expect(runtime.agent.prepareDangerousData).not.toHaveBeenCalled();
    expect(runtime.commitDangerousData).not.toHaveBeenCalled();
    expect(runtime.agent.commitDangerousData).not.toHaveBeenCalled();
  });

  it("完整 profile 出现模型凭证形态时不写恢复 store，也不准备清空", async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.exportDomainData).mockResolvedValue({
      ...domainSnapshot(),
      data: { leaked: `sk-${"x".repeat(32)}` },
    });
    const recoveryStore = new MemoryRecoveryStore();
    const coordinator = profileCoordinator(runtime, recoveryStore);

    await expect(
      coordinator.prepareDangerous({ operation: "delete_all" }),
    ).rejects.toThrow(/含有模型凭证形态/);
    expect(recoveryStore.backup).toBeNull();
    expect(runtime.prepareDangerousData).not.toHaveBeenCalled();
    expect(runtime.agent.prepareDangerousData).not.toHaveBeenCalled();
  });

  it("可恢复清空把完整 profile 留在持久 store，新 Coordinator 可在重启后两阶段恢复", async () => {
    const recoveryStore = new MemoryRecoveryStore();
    const sizesKey = "dim-desk-sizes-latitude-browser-live";
    const sizes = JSON.stringify({ "browser-feed": { width: 766, height: 181 } });
    const zoomKey = "dim-desk-zoom-latitude-browser-live";
    const framesKey = "dim-desk-frames-latitude-browser-live";
    const frames = JSON.stringify({ version: 1, frames: { "browser-feed": { x: 20, y: 40, width: 420, height: 440 } } });
    window.localStorage.setItem(sizesKey, sizes);
    window.localStorage.setItem(zoomKey, "0.65");
    window.localStorage.setItem(framesKey, frames);
    window.localStorage.setItem(
      "latitude.secretary-companion.v1",
      JSON.stringify({ x: 84, y: 126, hidden: false }),
    );
    const clearingRuntime = fakeRuntime();
    const clearing = profileCoordinator(clearingRuntime, recoveryStore);

    const preparedClear = await clearing.prepareDangerous({ operation: "delete_all" });
    expect(preparedClear.recoveryBackupSavedAt).toBeTruthy();
    expect(recoveryStore.backup?.profile).toMatchObject({
      format: BROWSER_PROFILE_FORMAT,
      browserState: {
        agentSessionId: SESSION_ID,
        localStorage: {
          [sizesKey]: sizes,
          [zoomKey]: "0.65",
          [framesKey]: frames,
          "latitude.secretary-companion.v1": JSON.stringify({
            x: 84,
            y: 126,
            hidden: false,
          }),
        },
      },
    });
    await clearing.commitDangerous({
      token: preparedClear.token,
      confirmation: preparedClear.confirmation,
    });
    expect(window.localStorage.getItem(BROWSER_SESSION_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem("latitude.secretary-companion.v1")).toBeNull();
    expect(window.localStorage.getItem(sizesKey)).toBeNull();
    expect(window.localStorage.getItem(zoomKey)).toBeNull();
    expect(window.localStorage.getItem(framesKey)).toBeNull();
    expect(recoveryStore.backup).not.toBeNull();

    // A new coordinator models a full page/service restart: no in-memory
    // pending token survives, only the durable recovery record does.
    const restoreRuntime = fakeRuntime();
    const afterRestart = profileCoordinator(restoreRuntime, recoveryStore);
    const preparedRestore = await afterRestart.prepareRecentRecovery();
    expect(preparedRestore.recoveryBackupSavedAt).toBe(preparedClear.recoveryBackupSavedAt);
    expect(restoreRuntime.prepareDangerousData).toHaveBeenCalledWith({
      operation: "restore",
      snapshot: recoveryStore.backup?.profile.domain,
    });
    expect(restoreRuntime.agent.prepareDangerousData).toHaveBeenCalledWith({
      operation: "restore",
      snapshot: recoveryStore.backup?.profile.agent,
    });
    await afterRestart.commitDangerous({
      token: preparedRestore.token,
      confirmation: preparedRestore.confirmation,
    });
    expect(window.localStorage.getItem(BROWSER_SESSION_STORAGE_KEY)).toBe(SESSION_ID);
    expect(JSON.parse(window.localStorage.getItem(
      "latitude.secretary-companion.v1",
    )!)).toEqual({ x: 84, y: 126, hidden: false });
    expect(window.localStorage.getItem(sizesKey)).toBe(sizes);
    expect(window.localStorage.getItem(zoomKey)).toBe("0.65");
    expect(window.localStorage.getItem(framesKey)).toBe(frames);
  });

  it("Agent 第二段失败时保留 Domain 已完成进度；同一组合 token 重试不重放 Domain", async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.agent.commitDangerousData)
      .mockRejectedValueOnce(new Error("Agent temporarily unavailable"))
      .mockResolvedValueOnce({
        ok: true,
        operation: "delete_all",
        checksum: "0".repeat(64),
        backupPath: "/local/backup",
        restartRequired: true,
      });
    const coordinator = profileCoordinator(runtime);
    const prepared = await coordinator.prepareDangerous({ operation: "delete_all" });

    let partial: unknown;
    try {
      await coordinator.commitDangerous({
        token: prepared.token,
        confirmation: prepared.confirmation,
      });
    } catch (error) {
      partial = error;
    }
    expect(partial).toBeInstanceOf(BrowserProfileMutationError);
    expect((partial as BrowserProfileMutationError).progress).toEqual({
      domainCommitted: true,
      agentCommitted: false,
      browserCommitted: false,
    });
    expect(window.localStorage.getItem(BROWSER_SESSION_STORAGE_KEY)).toBe(SESSION_ID);

    const completed = await coordinator.commitDangerous({
      token: prepared.token,
      confirmation: prepared.confirmation,
    });
    expect(completed).toMatchObject({
      ok: true,
      operation: "delete_all",
      restartRequired: true,
      reloadRequired: true,
    });
    expect(runtime.commitDangerousData).toHaveBeenCalledTimes(1);
    expect(runtime.agent.commitDangerousData).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem(BROWSER_SESSION_STORAGE_KEY)).toBeNull();
  });

  it("永久删除的 Domain receipt 若报告 partial，三层各自完成清理但组合结果仍明确保留未完成状态", async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.commitDangerousData).mockResolvedValueOnce({
      ok: true,
      operation: "purge_all",
      status: "partial",
      recoverable: false,
      backupCleanup: {
        status: "partial",
        refused: [{ name: "unknown-copy", reason: "unknown_artifact" }],
        errors: [],
      },
    });
    const coordinator = profileCoordinator(runtime);
    window.localStorage.setItem("dim-card-edits-sensitive", JSON.stringify({ title: "private" }));
    window.localStorage.setItem("third-party-unknown-key", "leave-me-alone");
    const prepared = await coordinator.prepareDangerous({ operation: "purge_all" });

    await expect(
      coordinator.commitDangerous({
        token: prepared.token,
        confirmation: prepared.confirmation,
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: "partial",
      operation: "purge_all",
      restartRequired: true,
      services: {
        domain: { committed: true, complete: false },
        agent: { committed: true },
        browser: { committed: true },
      },
      preservedEntries: [{ name: "unknown-copy", reason: "unknown_artifact" }],
    });
    expect(runtime.commitDangerousData).toHaveBeenCalledTimes(1);
    expect(runtime.agent.commitDangerousData).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(BROWSER_SESSION_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem("dim-card-edits-sensitive")).toBeNull();
    expect(window.localStorage.getItem("third-party-unknown-key")).toBe("leave-me-alone");
  });

  it("Agent purge partial 会贯穿组合 receipt、聚合保留项并清除 Browser 恢复副本", async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.agent.commitDangerousData).mockResolvedValueOnce({
      ok: true,
      operation: "purge_all",
      status: "partial",
      checksum: "0".repeat(64),
      recoverable: true,
      preservedEntries: ["state/unowned-file"],
      backupCleanup: {
        removedEntries: ["owner.json"],
        preservedEntries: ["backups/manual-copy"],
      },
      restartRequired: true,
    });
    const recoveryStore = new MemoryRecoveryStore();
    recoveryStore.backup = {
      format: "latitude.browser-recovery@1",
      savedAt: "2026-08-24T12:00:00Z",
      profile: await fullProfile(),
    };
    const coordinator = profileCoordinator(runtime, recoveryStore);
    const prepared = await coordinator.prepareDangerous({ operation: "purge_all" });

    await expect(coordinator.commitDangerous({
      token: prepared.token,
      confirmation: prepared.confirmation,
    })).resolves.toMatchObject({
      ok: false,
      status: "partial",
      services: {
        domain: { complete: true },
        agent: {
          complete: false,
          receipt: {
            status: "partial",
            recoverable: true,
            preservedEntries: ["state/unowned-file"],
          },
        },
        browser: { complete: true },
      },
      preservedEntries: expect.arrayContaining([
        "state/unowned-file",
        "backups/manual-copy",
      ]),
    });
    expect(recoveryStore.backup).toBeNull();
    expect(runtime.agent.commitDangerousData).toHaveBeenCalledTimes(1);
  });

  it("完整性检查并行报告 Domain、Agent 和浏览器层，不用单边成功掩盖另一边失败", async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.agent.checkIntegrity).mockRejectedValue(new Error("Agent ledger invalid"));
    const coordinator = profileCoordinator(runtime);

    await expect(coordinator.checkIntegrity()).resolves.toMatchObject({
      ok: false,
      domain: { ok: true },
      agent: { ok: false, error: "Agent ledger invalid" },
      browser: { ok: true },
    });
  });

  it.each([
    ["V1", "latitude.browser-ui-composition.v1:latitude-browser-live"],
    ["V2", "latitude.browser-ui-composition.v2:latitude-browser-live"],
  ])("损坏的 owned %s UI 状态让完整导出和完整性检查显式失败", async (version, key) => {
    const runtime = fakeRuntime();
    const coordinator = profileCoordinator(runtime);
    window.localStorage.setItem("third-party-unknown-ui-key", "{also broken");
    await expect(coordinator.exportAll()).resolves.toMatchObject({
      uiComposition: { format: "latitude.browser-ui-composition@0.2" },
    });

    window.localStorage.setItem(key, "{broken owned json");
    await expect(coordinator.exportAll()).rejects.toThrow(
      new RegExp(`Invalid owned ${version} UI composition`),
    );
    await expect(coordinator.checkIntegrity()).resolves.toMatchObject({
      ok: false,
      browser: {
        ok: false,
        issues: [expect.stringMatching(new RegExp(`Invalid owned ${version} UI composition`))],
      },
    });
  });

  it("完整 profile 导出包含同一 surface 的 companion overlay", async () => {
    const layout = structuredClone(SEED_LAYOUT_DOCUMENT);
    layout.id = "latitude-browser-live";
    layout.revision = 3;
    window.localStorage.setItem(
      "latitude.browser-ui-composition.v2:latitude-browser-live",
      JSON.stringify({ document: layoutV1ToUiSurfaceV2(layout), changes: [] }),
    );
    const coordinator = profileCoordinator(fakeRuntime());

    const profile = await coordinator.exportAll();
    expect(profile.uiComposition).toMatchObject({
      format: "latitude.browser-ui-composition@0.2",
      documents: {
        "latitude-browser-live": {
          document: {
            components: expect.arrayContaining([
              expect.objectContaining({
                id: "secretary-companion",
                type: "latitude.secretary-companion",
                slot: "overlay",
              }),
              expect.objectContaining({
                id: "data-safety-dialog",
                type: "latitude.data-safety-dialog",
                slot: "modal-data-safety",
              }),
            ]),
          },
        },
      },
    });
    if (profile.uiComposition.format !== "latitude.browser-ui-composition@0.2") {
      throw new Error("expected V2 browser composition");
    }
    expect(profile.uiComposition.documents["latitude-browser-live"].document.components)
      .toHaveLength(16);
  });

  it("伪造 companion move 的 owned history 让导出和 integrity 失败", async () => {
    const layout = structuredClone(SEED_LAYOUT_DOCUMENT);
    layout.id = "latitude-browser-live";
    layout.revision = 4;
    const document = layoutV1ToUiSurfaceV2(layout);
    window.localStorage.setItem(
      "latitude.browser-ui-composition.v2:latitude-browser-live",
      JSON.stringify({
        document,
        changes: [{
          id: "forged-companion-move",
          actor: "model",
          authorization: "preauthorized",
          reason: "伪造桌宠位置 receipt",
          beforeRevision: 3,
          afterRevision: 4,
          operations: [{
            op: "move",
            componentId: "secretary-companion",
            slot: "overlay",
            order: 1,
          }],
          inverse: [{
            op: "move",
            componentId: "secretary-companion",
            slot: "overlay",
            order: 0,
          }],
          appliedAt: "2026-08-24T12:00:00Z",
        }],
      }),
    );
    const coordinator = profileCoordinator(fakeRuntime());

    await expect(coordinator.exportAll()).rejects.toThrow(/only allows visibility/);
    await expect(coordinator.checkIntegrity()).resolves.toMatchObject({
      ok: false,
      browser: {
        ok: false,
        issues: [expect.stringMatching(/only allows visibility/)],
      },
    });
  });
});

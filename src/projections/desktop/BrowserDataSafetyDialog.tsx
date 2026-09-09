import { MotionSurface } from "../../dimension/SurfaceMotion";
import { useEffect, useState } from "react";

export interface DangerousPreparation {
  token: string;
  confirmation: string;
  expiresAt?: string;
  recoveryBackupSavedAt?: string;
}

export interface ChangeSetSummary {
  id: string;
  title?: string;
  summary?: string;
  status?: string;
  actor?: string;
  createdAt?: string;
  reversible?: boolean;
}

/**
 * Typed deep-entry boundary. The panel never calls fetch or opens SQLite; the
 * injected local runtime adapter owns transport, idempotency and audit.
 */
export interface BrowserDataSafetyActions {
  exportAll: () => Promise<unknown>;
  checkIntegrity: () => Promise<unknown>;
  prepareDangerous: (request: {
    operation: "restore" | "delete_all" | "purge_all";
    snapshot?: unknown;
  }) => Promise<DangerousPreparation>;
  /** Restart-safe restore of the latest IndexedDB backup created before delete_all. */
  prepareRecentRecovery?: () => Promise<DangerousPreparation>;
  commitDangerous: (request: {
    token: string;
    confirmation: string;
  }) => Promise<unknown>;
  listChangeSets: () => Promise<ChangeSetSummary[]>;
  rollbackChangeSet: (changeSetId: string) => Promise<unknown>;
}

export interface BrowserDataSafetyActionAvailability {
  export: boolean;
  integrity: boolean;
  restore: boolean;
  delete: boolean;
  purge: boolean;
  rollback: boolean;
  close: boolean;
}

const DEFAULT_ACTION_AVAILABILITY: BrowserDataSafetyActionAvailability = {
  export: true,
  integrity: true,
  restore: true,
  delete: true,
  purge: true,
  rollback: true,
  close: true,
};

type DangerousMode = "restore" | "delete_all" | "purge_all";

export function BrowserDataSafetyDialog({
  actions,
  actionAvailability = DEFAULT_ACTION_AVAILABILITY,
  onChanged,
  onClose,
  zIndex = 100,
  onActivate,
  windowMode = false,
}: {
  actions?: BrowserDataSafetyActions;
  actionAvailability?: BrowserDataSafetyActionAvailability;
  onChanged: () => Promise<void>;
  onClose: () => void;
  zIndex?: number;
  onActivate?: () => void;
  windowMode?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<unknown>();
  const [snapshotName, setSnapshotName] = useState<string | null>(null);
  const [preparation, setPreparation] = useState<{
    mode: DangerousMode;
    value: DangerousPreparation;
  } | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [changeSets, setChangeSets] = useState<ChangeSetSummary[]>([]);

  useEffect(() => {
    if (!actions) return;
    setBusy("history");
    void actions.listChangeSets()
      .then(setChangeSets)
      .catch((error) => setNotice(readableError(error, "变更记录读取失败")))
      .finally(() => setBusy(null));
  }, [actions]);

  async function exportAll() {
    if (!actions) return;
    setBusy("export");
    try {
      const document = await actions.exportAll();
      downloadJson(document, `latitude-full-export-${new Date().toISOString().slice(0, 10)}.json`);
      setNotice("导出已下载。原数据没有改动，文件未加密，请妥善保管。");
    } catch (error) {
      setNotice(readableError(error, "完整导出失败"));
    } finally {
      setBusy(null);
    }
  }

  async function checkIntegrity() {
    if (!actions) return;
    setBusy("integrity");
    try {
      const report = await actions.checkIntegrity();
      const ok = Boolean(
        report && typeof report === "object" && !Array.isArray(report) &&
        (report as Record<string, unknown>).ok,
      );
      setNotice(ok ? "完整性检查通过。" : "完整性检查返回异常，请先导出并查看诊断。");
    } catch (error) {
      setNotice(readableError(error, "完整性检查失败"));
    } finally {
      setBusy(null);
    }
  }

  async function prepare(mode: DangerousMode) {
    const enabled = mode === "restore"
      ? actionAvailability.restore
      : mode === "purge_all"
        ? actionAvailability.purge
        : actionAvailability.delete;
    if (!actions || !enabled || (mode === "restore" && snapshot === undefined)) return;
    setBusy(`prepare-${mode}`);
    setConfirmation("");
    try {
      const value = await actions.prepareDangerous({
        operation: mode,
        ...(mode === "restore" ? { snapshot } : {}),
      });
      setPreparation({ mode, value });
      setNotice(value.recoveryBackupSavedAt
        ? `完整可恢复备份已写入并读回（${formatTime(value.recoveryBackupSavedAt)}）；第一阶段已准备。只有输入下方完整确认短语才会提交。`
        : "第一阶段已准备；只有输入下方完整确认短语才会提交。");
    } catch (error) {
      setNotice(readableError(error, "危险操作准备失败"));
    } finally {
      setBusy(null);
    }
  }

  async function prepareRecentRecovery() {
    if (!actions?.prepareRecentRecovery || !actionAvailability.restore) return;
    setBusy("prepare-recent-restore");
    setConfirmation("");
    try {
      const value = await actions.prepareRecentRecovery();
      setPreparation({ mode: "restore", value });
      setNotice(
        `已读回最近一次可恢复清空前的完整备份${value.recoveryBackupSavedAt
          ? `（${formatTime(value.recoveryBackupSavedAt)}）`
          : ""}；只有输入下方完整确认短语才会恢复。`,
      );
    } catch (error) {
      setNotice(readableError(error, "最近可恢复备份没有通过校验"));
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    const enabled = preparation?.mode === "restore"
      ? actionAvailability.restore
      : preparation?.mode === "purge_all"
        ? actionAvailability.purge
        : actionAvailability.delete;
    if (!actions || !preparation || !enabled || confirmation !== preparation.value.confirmation) return;
    setBusy(`commit-${preparation.mode}`);
    try {
      const result = await actions.commitDangerous({
        token: preparation.value.token,
        confirmation,
      });
      const resultRecord = result && typeof result === "object" && !Array.isArray(result)
        ? result as Record<string, unknown>
        : undefined;
      const partial = resultRecord?.ok === false || resultRecord?.status === "partial";
      const message =
        typeof resultRecord?.message === "string"
          ? resultRecord.message
          : partial
            ? "本次只完成了一部分；请检查处理结果和保留项。"
            : preparation.mode === "restore"
            ? "数据已完整恢复，请重启助手服务并刷新页面。"
            : preparation.mode === "purge_all"
              ? "永久删除已完成，请重启助手服务并刷新页面。"
              : "可恢复清空已完成，请重启助手服务并刷新页面。";
      setNotice(message);
      setPreparation(null);
      setConfirmation("");
      try {
        await onChanged();
      } catch (error) {
        // The commit receipt is already final. A failed readback must never be
        // relabelled as "not submitted" after one or both services changed.
        setNotice(`${message} 当前页面重新读取失败：${readableError(error, "请重启后再检查")}`);
      }
    } catch (error) {
      setNotice(readableError(error, "危险操作没有提交"));
    } finally {
      setBusy(null);
    }
  }

  async function rollback(id: string) {
    if (!actions || !actionAvailability.rollback) return;
    setBusy(`rollback-${id}`);
    try {
      await actions.rollbackChangeSet(id);
      setNotice("桌面变更已撤销。");
      setChangeSets(await actions.listChangeSets());
      await onChanged();
    } catch (error) {
      setNotice(readableError(error, "这次变更无法撤销"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <MotionSurface
      className="dimension-root"
      style={{
        ...backdropStyle,
        zIndex,
        ...(windowMode ? windowStyle : {}),
      }}
      role="dialog"
      aria-modal={!windowMode}
      aria-label="数据与安全"
      onPointerDown={onActivate}
    >
      <section
        className="dim-paper"
        style={{
          ...paperStyle,
          ...(windowMode ? windowPaperStyle : {}),
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div>
            <p className="dim-eyebrow">数据管理</p>
            <h2 style={{ margin: "5px 0 0", fontSize: 21 }}>数据与安全</h2>
            <p className="dim-body" style={{ marginTop: 7 }}>
              你可以导出、恢复或清空数据。恢复和删除需要再次确认。
            </p>
          </div>
          <button
            type="button"
            className="dim-btn"
            onClick={onClose}
            disabled={!actionAvailability.close}
            aria-disabled={!actionAvailability.close}
          >
            合上
          </button>
        </div>

        {!actions && (
          <p role="status" className="dim-body">
            数据服务尚未提供这些操作。
          </p>
        )}

        <section className="dim-paper" style={sectionStyle}>
          <p className="dim-eyebrow">完整导出</p>
          <p className="dim-body">导出认知图谱、助手对话与运行记录、桌面设置。便签业务库中的待办、日历和每日整理需另行备份，不包含在此文件中。下载文件未加密，请妥善保管。</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="dim-btn dim-btn--accent"
              disabled={!actions || !actionAvailability.export || busy !== null}
              onClick={() => void exportAll()}
            >
              {busy === "export" ? "导出中…" : "下载完整导出"}
            </button>
            <button
              type="button"
              className="dim-btn"
              disabled={!actions || !actionAvailability.integrity || busy !== null}
              onClick={() => void checkIntegrity()}
            >
              {busy === "integrity" ? "检查中…" : "检查数据完整性"}
            </button>
          </div>
        </section>

        <section className="dim-paper" style={sectionStyle}>
          <p className="dim-eyebrow">导入 / 完整恢复</p>
          <label className="dim-body">
            选择 Latitude 导出文件
            <input
              aria-label="选择恢复文件"
              type="file"
              accept="application/json,.json"
              disabled={!actions || !actionAvailability.restore || busy !== null}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                setSnapshotName(file.name);
                void file.text()
                  .then((text) => setSnapshot(JSON.parse(text)))
                  .then(() => setNotice(`文件已检查：${file.name}。还没有改动任何数据。`))
                  .catch((error) => {
                    setSnapshot(undefined);
                    setNotice(readableError(error, "这个恢复文件无法读取"));
                  });
              }}
            />
          </label>
          {snapshotName && <span className="dim-meta">待恢复 · {snapshotName}</span>}
          <button
            type="button"
            className="dim-btn"
            disabled={!actions || !actionAvailability.restore || snapshot === undefined || busy !== null}
            onClick={() => void prepare("restore")}
          >
            第一步：准备完整恢复
          </button>
          <div style={{ borderTop: "1px solid var(--dim-line)", paddingTop: 9 }}>
            <p className="dim-body" style={{ marginTop: 0 }}>
              可恢复清空会先在本机保存一份备份，重启后仍可恢复。永久删除会同时删除这份备份。
            </p>
            <button
              type="button"
              className="dim-btn"
              disabled={
                !actions?.prepareRecentRecovery ||
                !actionAvailability.restore ||
                busy !== null
              }
              onClick={() => void prepareRecentRecovery()}
            >
              第一步：恢复最近可恢复备份
            </button>
          </div>
        </section>

        <section className="dim-paper" style={{ ...sectionStyle, borderColor: "var(--dim-rust)" }}>
          <p className="dim-eyebrow">危险区 · 可恢复清空</p>
          <p className="dim-body">清空当前本地数据，但保留可恢复的备份。备份失败时不会清空。</p>
          <button
            type="button"
            className="dim-btn"
            disabled={!actions || !actionAvailability.delete || busy !== null}
            onClick={() => void prepare("delete_all")}
          >
            第一步：准备可恢复清空
          </button>
          <details style={{ width: "100%", marginTop: 4 }}>
            <summary className="dim-eyebrow">更深一层 · 永久删除（不可恢复）</summary>
            <p className="dim-body">
              永久清空应用数据、助手数据、组件与会话身份，并删除本产品控制的服务侧备份。
              外部保存的导出文件不受影响，也无法由本产品代为删除。
            </p>
            <button
              type="button"
              className="dim-btn"
              disabled={!actions || !actionAvailability.purge || busy !== null}
              onClick={() => void prepare("purge_all")}
            >
              第一步：准备永久删除
            </button>
          </details>
        </section>

        {preparation && (
          <section className="dim-paper" style={{ ...sectionStyle, borderColor: "var(--dim-rust)" }}>
            <p className="dim-eyebrow">
              第二阶段确认 · {preparation.mode === "restore"
                ? "完整恢复"
                : preparation.mode === "purge_all"
                  ? "永久删除"
                  : "可恢复清空"}
            </p>
            <p className="dim-body">
              请输入完整短语：<strong>{preparation.value.confirmation}</strong>
            </p>
            {preparation.value.expiresAt && (
              <p className="dim-meta">请在 {preparation.value.expiresAt} 前完成确认</p>
            )}
            <input
              className="dim-input"
              aria-label="危险操作确认短语"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="dim-btn"
                onClick={() => {
                  setPreparation(null);
                  setConfirmation("");
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="dim-btn dim-btn--accent"
                disabled={
                  busy !== null ||
                  confirmation !== preparation.value.confirmation ||
                  (preparation.mode === "restore"
                    ? !actionAvailability.restore
                    : preparation.mode === "purge_all"
                      ? !actionAvailability.purge
                      : !actionAvailability.delete)
                }
                onClick={() => void commit()}
              >
                第二步：确认执行
              </button>
            </div>
          </section>
        )}

        <details>
          <summary className="dim-eyebrow">桌面变更记录</summary>
          {changeSets.length === 0 ? (
            <p className="dim-meta">{busy === "history" ? "读取中…" : "还没有桌面变更。"}</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 10 }}>
              {changeSets.map((changeSet) => (
                <div key={changeSet.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="dim-meta" style={{ flex: 1 }}>
                    {changeSet.title || changeSet.summary || changeSet.id}
                    {changeSet.createdAt ? ` · ${formatTime(changeSet.createdAt)}` : ""}
                    {changeSet.status ? ` · ${changeSet.status}` : ""}
                    {changeSet.reversible === false ? " · 不可回滚" : ""}
                  </span>
                  <button
                    type="button"
                    className="dim-btn dim-btn--quiet"
                    disabled={
                      busy !== null ||
                      !actionAvailability.rollback ||
                      changeSet.status !== "applied" ||
                      changeSet.reversible !== true
                    }
                    onClick={() => void rollback(changeSet.id)}
                  >
                    {changeSet.reversible === true ? "回滚" : "不可回滚"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </details>

        {notice && <p className="dim-body" role="status">{notice}</p>}
      </section>
    </MotionSurface>
  );
}

const backdropStyle = {
  position: "fixed",
  inset: 0,
  // The independent secretary uses z-index 90; destructive controls must not
  // be partially covered by her bubble.
  zIndex: 100,
  display: "grid",
  placeItems: "center",
  padding: 24,
  background: "rgb(43 39 31 / 52%)",
} as const;

const paperStyle = {
  width: "min(760px, 100%)",
  maxHeight: "min(860px, 92vh)",
  overflow: "auto",
  resize: "both",
  minWidth: "min(300px, calc(100vw - 48px))",
  minHeight: 220,
  maxWidth: "calc(100vw - 48px)",
  boxSizing: "border-box",
  padding: 22,
  display: "flex",
  flexDirection: "column",
  gap: 13,
  color: "var(--dim-ink)",
} as const;

const windowStyle = {
  inset: "auto",
  top: "50%",
  left: "50%",
  width: "max-content",
  maxWidth: "calc(100vw - 48px)",
  padding: 0,
  display: "block",
  background: "transparent",
  transform: "translate(-50%, -50%)",
} as const;

const windowPaperStyle = {
  width: "min(760px, calc(100vw - 48px))",
  boxShadow: "0 26px 64px rgb(55 48 34 / 24%), 0 3px 10px rgb(55 48 34 / 12%)",
} as const;

const sectionStyle = {
  padding: 12,
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 8,
} as const;

function downloadJson(value: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function readableError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? `${fallback}：${error.message}` : fallback;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

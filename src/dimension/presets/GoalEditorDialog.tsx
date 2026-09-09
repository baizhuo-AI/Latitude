import { useEffect, useRef, useState } from "react";
import type { ClueThread } from "./ClueBoardPreset";
import "../card-editor.css";

export interface GoalChange {
  id?: string;
  title: string;
  detail: string;
  remove?: boolean;
}

export function GoalEditorDialog({ goal, onSave, onClose, initialMode = "edit" }: {
  goal: ClueThread | null;
  initialMode?: "edit" | "delete";
  onSave: (change: GoalChange) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(goal?.title ?? "");
  const [detail, setDetail] = useState(goal?.detail ?? "");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [confirmDelete, setConfirmDelete] = useState(initialMode === "delete" && Boolean(goal));
  const [error, setError] = useState("");
  useEffect(() => {
    const previousFocus = document.activeElement;
    dialog.current?.showModal();
    dialog.current?.querySelector("input")?.focus();
    return () => { if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus(); };
  }, []);

  async function save(remove = false) {
    if (saving.current || (!remove && !title.trim())) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      await onSave({ id: goal?.lineage?.entityId, title: title.trim(), detail: detail.trim(), remove });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "没有保存成功，请重试。");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="dim-card-editor clue-goal-editor" aria-labelledby="clue-goal-editor-title"
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={(event) => { event.preventDefault(); void save(confirmDelete); }}>
      <header className="dim-editor-header">
        <h2 id="clue-goal-editor-title">{confirmDelete ? "删除中期目标" : goal ? "编辑中期目标" : "新增中期目标"}</h2>
        <button type="button" aria-label="关闭目标编辑" disabled={busy} onClick={onClose}>×</button>
      </header>
      <div className="dim-editor-scroll">
        {confirmDelete ? <p>删除“{goal?.title}”？关联的行动和记录会保留。</p> : <>
          <label className="dim-editor-field">目标名称
            <input autoFocus required maxLength={120} value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="dim-editor-field">目标说明
            <textarea rows={4} maxLength={4000} value={detail} disabled={busy} onChange={(e) => setDetail(e.target.value)} />
          </label>
        </>}
        {error && <p role="alert">{error}</p>}
      </div>
      <footer className="dim-editor-actions">
        {goal && !confirmDelete && <button type="button" disabled={busy} onClick={() => setConfirmDelete(true)}>删除目标</button>}
        <span />
        <button type="button" disabled={busy} onClick={() => confirmDelete ? setConfirmDelete(false) : onClose()}>取消</button>
        <button type="submit" disabled={busy || (!confirmDelete && !title.trim())}>{busy ? "正在保存…" : confirmDelete ? "确认删除" : "保存目标"}</button>
      </footer>
    </form>
  </dialog>;
}

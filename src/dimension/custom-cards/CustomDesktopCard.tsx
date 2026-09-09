import { useContext, useEffect, useId, useRef, useState } from "react";
import { normalizeCustomDesktopCardInput, type CustomDesktopCard, type CustomDesktopCardInput } from "./model";
import { CardReadingContext } from "../cards/CardShell";
import "../card-editor.css";
import "./customCards.css";
import "../cards/cardShell.css";

export function CustomDesktopCardContent({ card, onEdit, onRetrySync }: {
  card: CustomDesktopCard;
  onEdit: () => void;
  onRetrySync?: () => void;
}) {
  const reading = useContext(CardReadingContext);
  const syncLabel = card.syncState === "synced" ? "已保存" : card.syncState === "syncing" ? "已存本机 · 正在同步" :
    card.syncState === "error" ? "已存本机 · 同步未完成" : "已存本机";
  return (
    <section className={`dim-paper dim-card-shell dim-custom-card ${card.template === "note" ? "dim-custom-card--note" : ""}`} data-custom-card-id={card.id}>
      <header className="dim-card-header">
        <p className="dim-eyebrow">{card.template === "note" ? "我的便签" : "文字／链接"}</p>
        <h3 className="dim-title">{card.title}</h3>
      </header>
      <div className="dim-card-body dim-custom-card-body" data-no-drag data-deck-scroll="contain" tabIndex={0} role="region" aria-label={`${card.title}正文`}>
        {card.body ? <p className="dim-body">{card.body}</p> : <p className="dim-custom-card-placeholder">右键编辑，写下想留在主页的内容。</p>}
        {card.url && <a className="dim-custom-card-link" href={card.url} target="_blank" rel="noopener noreferrer">{card.url}<span aria-hidden="true"> ↗</span></a>}
      </div>
      <footer className="dim-card-footer dim-custom-card-footer" data-no-drag>
        <small aria-live="polite">{syncLabel}</small>
        {card.syncState === "error" && onRetrySync && <button className="dim-btn dim-btn--quiet" type="button" onClick={onRetrySync}>重试同步</button>}
        {!reading && <button className="dim-btn dim-btn--quiet" type="button" onClick={onEdit} aria-label={`编辑${card.title}`}>编辑</button>}
      </footer>
    </section>
  );
}

export function CustomDesktopCardForm({ initial, onSubmit, onCancel, submitLabel, error }: {
  initial?: CustomDesktopCardInput;
  onSubmit: (input: CustomDesktopCardInput) => boolean | void;
  onCancel: () => void;
  submitLabel?: string;
  error?: string | null;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [template, setTemplate] = useState<CustomDesktopCardInput["template"]>(initial?.template ?? "note");
  const [validation, setValidation] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dialog = useRef<HTMLFormElement>(null);
  const continueEditing = useRef<HTMLButtonElement>(null);
  const dirty = title !== (initial?.title ?? "") || body !== (initial?.body ?? "") ||
    url !== (initial?.url ?? "") || template !== (initial?.template ?? "note");
  const requestCancel = () => {
    if (confirmDiscard) setConfirmDiscard(false);
    else if (dirty) setConfirmDiscard(true);
    else onCancel();
  };
  const cancelRef = useRef(requestCancel);
  cancelRef.current = requestCancel;
  const headingId = useId();
  const errorId = useId();

  useEffect(() => {
    if (confirmDiscard) continueEditing.current?.focus();
  }, [confirmDiscard]);

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLInputElement>('input[name="card-title"]')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelRef.current(); return; }
      if (event.key !== "Tab" || !dialog.current) return;
      const elements = Array.from(dialog.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex='0']"));
      const first = elements[0]; const last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) {
        event.preventDefault(); first?.focus();
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, []);

  return (
    <form className="dim-card-editor dim-custom-card-form" role="dialog" aria-modal="true" aria-labelledby={headingId}
      aria-describedby={validation || error ? errorId : undefined} ref={dialog}
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const input = normalizeCustomDesktopCardInput({ title, body, url, template });
          setValidation(null);
          onSubmit(input);
        } catch (failure) { setValidation(failure instanceof Error ? failure.message : "卡片内容还需要调整。"); }
      }}>
      <header className="dim-editor-header">
        <div><p>留在桌面，随时接着写</p><h2 id={headingId}>{initial ? "编辑卡片" : "新建卡片"}</h2></div>
        <button type="button" onClick={requestCancel} aria-label="关闭卡片编辑">×</button>
      </header>
      <div className="dim-editor-scroll">
        <fieldset className="dim-custom-card-types"><legend>卡片类型</legend>
          <label><input type="radio" name="card-template" value="note" checked={template === "note"} onChange={() => setTemplate("note")} />便签</label>
          <label><input type="radio" name="card-template" value="text" checked={template === "text"} onChange={() => setTemplate("text")} />文字／链接</label>
        </fieldset>
        <label className="dim-editor-field"><span>标题</span><input name="card-title" value={title} maxLength={100} placeholder="给这张卡起个名字" onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="dim-editor-field"><span>正文</span><textarea value={body} maxLength={20_000} rows={6} placeholder="一个想法、一段文字，或接下来想做的事……" onChange={(event) => setBody(event.target.value)} /></label>
        <label className="dim-editor-field"><span>链接（选填）</span><input type="text" inputMode="url" value={url} maxLength={2048} placeholder="https://" onChange={(event) => setUrl(event.target.value)} /></label>
        {(validation || error) && <p className="dim-custom-card-error" role="alert" id={errorId}>{validation || error}</p>}
      </div>
      <footer className="dim-editor-actions"><small role={confirmDiscard ? "status" : undefined}>{confirmDiscard ? "还有未保存的内容，要放弃吗？" : "先存到本机，服务连接后自动同步。"}</small><span />
        {confirmDiscard ? <>
          <button className="dim-btn dim-btn--quiet" type="button" onClick={onCancel}>放弃修改</button>
          <button className="dim-btn dim-btn--accent" type="button" ref={continueEditing} onClick={() => setConfirmDiscard(false)}>继续编辑</button>
        </> : <>
          <button className="dim-btn dim-btn--quiet" type="button" onClick={requestCancel}>取消</button>
          <button className="dim-btn dim-btn--accent" type="submit">{submitLabel ?? (initial ? "保存修改" : "创建卡片")}</button>
        </>}
      </footer>
    </form>
  );
}

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ArrowUp, Mic, Paperclip, Square, X } from "lucide-react";
import { ATTACHMENT_ACCEPT, bufferFromBase64, buildSubmission, isNativeComposer, parseAttachment, parseBrowserFile, type ComposerAttachment, type ComposerSubmission, type NativeAttachment } from "./attachments";
import { readDraft, updateDraft, useComposerDraft } from "./draftStore";
import { startSpeechCapture, type SpeechCapture } from "./speechInput";
import "./composer.css";

export type SendComposerMessage = (text: string, submission?: ComposerSubmission) => void | boolean | Promise<void | boolean>;
export interface MessageComposerProps {
  sessionId: string;
  onSend: SendComposerMessage;
  loading?: boolean;
  sendEnabled?: boolean;
  onCancel?: () => void | Promise<void>;
  autoFocus?: boolean;
}

export const MessageComposer = forwardRef<HTMLTextAreaElement, MessageComposerProps>(function MessageComposer({
  sessionId, onSend, loading = false, sendEnabled = true, onCancel, autoFocus = false,
}, forwardedRef) {
  const draft = useComposerDraft(sessionId);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const compositionEnded = useRef(0);
  const sendInFlight = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [reading, setReading] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState(false);
  const [voice, setVoice] = useState<"idle" | "requesting" | "recording" | "transcribing">("idle");
  const [partial, setPartial] = useState("");
  const [seconds, setSeconds] = useState(0);
  const capture = useRef<SpeechCapture | null>(null);
  const voiceSession = useRef<string | null>(null);
  const mounted = useRef(true);
  useImperativeHandle(forwardedRef, () => input.current!, []);
  useEffect(() => { if (autoFocus) input.current?.focus(); }, [autoFocus]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; capture.current?.cancel(); capture.current = null; };
  }, []);
  useEffect(() => {
    if (voice !== "recording") return;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [voice]);
  useEffect(() => { setError(null); }, [sessionId]);

  const appendAttachment = useCallback((key: string, attachment: ComposerAttachment) => {
    const saved = updateDraft(key, (value) => ({ ...value, attachments: [...value.attachments, attachment] }));
    if (mounted.current) setStorageError(!saved);
  }, []);

  const readFiles = useCallback(async (items: Array<{ name: string; read: () => Promise<ComposerAttachment> }>) => {
    const key = sessionId;
    setError(null);
    setReading((value) => [...value, ...items.map((item) => item.name)]);
    for (const item of items) {
      try { appendAttachment(key, await item.read()); }
      catch (failure) {
        if (mounted.current) setError(`${item.name}：${failure instanceof Error ? failure.message : String(failure)}`);
      } finally {
        if (mounted.current) setReading((value) => { const index = value.indexOf(item.name); return value.filter((_, position) => position !== index); });
      }
    }
  }, [appendAttachment, sessionId]);

  const readPaths = useCallback(async (paths: string[]) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await readFiles(paths.map((path) => ({
      name: path.split(/[\\/]/).pop() || "附件",
      read: async () => {
        const attachment = await invoke<NativeAttachment>("pet_read_attachment", { path });
        return parseAttachment(attachment.name, attachment.mimeType, bufferFromBase64(attachment.base64));
      },
    })));
  }, [readFiles]);

  useEffect(() => {
    if (!isNativeComposer()) return;
    let cancelled = false;
    const disposers: Array<() => void> = [];
    const register = (dispose: () => void) => { if (cancelled) dispose(); else disposers.push(dispose); };
    void import("@tauri-apps/api/webviewWindow").then(({ getCurrentWebviewWindow }) => getCurrentWebviewWindow().onDragDropEvent(({ payload }) => {
      setDragging(payload.type === "enter" || payload.type === "over");
      if (payload.type === "drop") void readPaths(payload.paths);
    })).then(register).catch(() => undefined);
    void import("@tauri-apps/api/event").then(({ listen }) => listen<string[]>("latitude://composer-files", ({ payload }) => { void readPaths(payload); })).then(register).catch(() => undefined);
    return () => { cancelled = true; disposers.forEach((dispose) => dispose()); };
  }, [readPaths]);

  async function chooseFiles() {
    if (!isNativeComposer()) { fileInput.current?.click(); return; }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await readPaths(await invoke<string[]>("pet_pick_attachments"));
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  }

  async function send() {
    if (sendInFlight.current || loading || !sendEnabled || reading.length || voice !== "idle") return;
    const key = sessionId;
    const sentDraft = readDraft(key);
    if (!sentDraft.text.trim() && !sentDraft.attachments.length) return;
    const built = buildSubmission(sentDraft.text, sentDraft.attachments);
    sendInFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const accepted = built.submission ? await onSend(built.text, built.submission) : await onSend(built.text);
      if (accepted === false) { setError("消息没有发送，草稿已保留。请稍后重试。"); return; }
      const persisted = updateDraft(key, (latest) => ({
        // A user can keep writing while the previous submission is in flight.
        text: latest.text === sentDraft.text ? "" : latest.text,
        attachments: latest.attachments.filter((attachment) => !sentDraft.attachments.some((sent) => sent.id === attachment.id)),
      }));
      if (mounted.current) setStorageError(!persisted);
    } catch (failure) {
      setError(`消息没有发送，草稿已保留。${failure instanceof Error ? failure.message : "请稍后重试。"}`);
    } finally { sendInFlight.current = false; if (mounted.current) setSubmitting(false); }
  }

  async function startVoice() {
    setError(null);
    setPartial("");
    setSeconds(0);
    voiceSession.current = sessionId;
    setVoice("requesting");
    try {
      const started = await startSpeechCapture(setPartial);
      if (!mounted.current || voiceSession.current === null) { started.cancel(); return; }
      capture.current = started;
      setVoice("recording");
    } catch (failure) { if (mounted.current) { setError(failure instanceof Error ? failure.message : String(failure)); setVoice("idle"); } }
  }

  async function stopVoice() {
    const active = capture.current;
    const key = voiceSession.current;
    if (!active || !key) return;
    setVoice("transcribing");
    try {
      const text = (await active.stop()).trim();
      if (text) updateDraft(key, (value) => ({ ...value, text: value.text ? `${value.text}\n${text}` : text }));
      else setError("没有识别到说话内容，请重试或继续打字。");
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { capture.current = null; voiceSession.current = null; if (mounted.current) { setVoice("idle"); input.current?.focus(); } }
  }

  function cancelVoice() {
    voiceSession.current = null;
    capture.current?.cancel();
    capture.current = null;
    setVoice("idle");
    setPartial("");
  }

  return <div className={`dim-thread__composer dim-composer${dragging ? " is-dropping" : ""}`}
    onDragOver={(event) => { if (!isNativeComposer()) { event.preventDefault(); setDragging(true); } }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={(event) => {
      event.preventDefault(); setDragging(false);
      if (isNativeComposer()) return;
      const files = Array.from(event.dataTransfer.files);
      if (files.length) void readFiles(files.map((file) => ({ name: file.name, read: () => parseBrowserFile(file) })));
      else {
        const text = event.dataTransfer.getData("text/plain") || event.dataTransfer.getData("text/uri-list");
        if (text) updateDraft(sessionId, (value) => ({ ...value, text: value.text ? `${value.text}\n${text}` : text }));
      }
    }}>
    {dragging && <div className="dim-composer__drop-hint">松开加入附件</div>}
    {(draft.attachments.length > 0 || reading.length > 0) && <ul className="dim-composer__attachments" aria-label="待发送附件">
      {draft.attachments.map((attachment) => <li key={attachment.id}>
        <details><summary title={attachment.name}>{attachment.name}<span>{attachment.range}</span></summary>
          {attachment.warning && <p>{attachment.warning}</p>}<pre>{attachment.text.slice(0, 1200)}{attachment.text.length > 1200 ? "\n…（预览节选，发送时包含全部已读取文字）" : ""}</pre>
        </details>
        <button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => updateDraft(sessionId, (value) => ({ ...value, attachments: value.attachments.filter((item) => item.id !== attachment.id) }))}><X size={14} /></button>
      </li>)}
      {reading.map((name, index) => <li key={`${name}-${index}`} role="status">正在读取 {name}…</li>)}
    </ul>}
    <textarea ref={input} value={draft.text} rows={2} aria-label="给秘书发消息"
      placeholder={loading ? "可以先写下一条，处理完成后再发送…" : "说点什么…（Enter 发送，Shift + Enter 换行）"}
      onChange={(event) => setStorageError(!updateDraft(sessionId, (value) => ({ ...value, text: event.target.value })))}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; compositionEnded.current = Date.now(); }}
      onKeyDown={(event) => {
        const selecting = composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || Date.now() - compositionEnded.current < 50;
        if (selecting) { if (event.key === "Escape") event.stopPropagation(); return; }
        if (event.key === "Escape" && voice !== "idle") { event.stopPropagation(); cancelVoice(); return; }
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
      }}
      onPaste={(event) => {
        const images = Array.from(event.clipboardData.files);
        if (images.length) { event.preventDefault(); void readFiles(images.map((file) => ({ name: file.name, read: () => parseBrowserFile(file) }))); }
      }}
    />
    {voice !== "idle" && <div className="dim-composer__voice" role="status">
      <span className="dim-composer__recording-dot" />
      <span>{voice === "requesting" ? "正在请求麦克风权限…" : voice === "transcribing" ? "正在整理成文字…" : `正在录音 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}</span>
      {voice === "recording" && <button type="button" onClick={() => void stopVoice()}>完成录音</button>}
      {voice !== "transcribing" && <button type="button" onClick={cancelVoice}>取消</button>}
      {partial && <p>{partial}</p>}
    </div>}
    {error && <p className="dim-composer__error" role="alert">{error}</p>}
    {storageError && <p className="dim-composer__error" role="status">本机储存空间不足，这份草稿暂时只保留在当前窗口。请先发送或复制备份。</p>}
    <div className="dim-composer__toolbar">
      <div className="dim-composer__tools">
        <button type="button" aria-label="添加附件" title="TXT、Markdown、CSV、PDF、DOCX；macOS 支持图片文字识别" onClick={() => void chooseFiles()}><Paperclip size={17} /></button>
        <button type="button" aria-label="语音输入" title="说完后先转为草稿，再由你发送" disabled={voice !== "idle"} onClick={() => void startVoice()}><Mic size={17} /></button>
        <input ref={fileInput} className="dim-composer__file" type="file" multiple accept={ATTACHMENT_ACCEPT} aria-label="选择附件" onChange={(event) => {
          const files = Array.from(event.target.files ?? []); event.target.value = "";
          void readFiles(files.map((file) => ({ name: file.name, read: () => parseBrowserFile(file) })));
        }} />
      </div>
      <div className="dim-thread__composer-actions">
        {loading && onCancel && <button type="button" className="dim-btn dim-btn--quiet" onClick={() => void onCancel()}><Square size={11} /> 停止</button>}
        <button type="button" className="dim-btn dim-btn--accent" onClick={() => void send()} disabled={loading || submitting || !sendEnabled || reading.length > 0 || voice !== "idle" || (!draft.text.trim() && !draft.attachments.length)}><ArrowUp size={14} /> {submitting ? "发送中" : "发送"}</button>
      </div>
    </div>
  </div>;
});

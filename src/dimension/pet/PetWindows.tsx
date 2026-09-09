import { useCallback, useEffect, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { DeskThread } from "../DeskThread";
import { PetArtwork } from "./PetArtwork";
import { INITIAL_PET_STATE, type PetSnapshot, type PetState } from "./types";
import { petCommand, sendPetAction, subscribePetSnapshot, subscribePetState } from "./nativePet";
import { DEFAULT_NOTICE_PREFERENCES, PetNoticeBubble, useNoticeVisibility } from "../pet-notices";
import type { ComposerSubmission } from "../composer/attachments";
import { usePetPose } from "./usePetPose";
import "./pet.css";

function useNativeMirror() {
  const [snapshot, setSnapshot] = useState<PetSnapshot | null>(null);
  const [state, setState] = useState<PetState>(INITIAL_PET_STATE);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    const disposers: Array<() => void> = [];
    for (const subscription of [subscribePetSnapshot(setSnapshot), subscribePetState(setState)]) {
      void subscription.then((dispose) => { if (disposed) dispose(); else disposers.push(dispose); })
        .catch((error) => setError(String(error)));
    }
    return () => { disposed = true; disposers.forEach((dispose) => dispose()); };
  }, []);
  return { snapshot, state, error, setError };
}

/** Include only image alpha and the actual controls; blank pixels let other apps receive clicks. */
async function publishHitMask(image: HTMLImageElement) {
  const width = 55, height = 65;
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d")!;
  const box = image.getBoundingClientRect();
  const scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
  const renderedWidth = image.naturalWidth * scale, renderedHeight = image.naturalHeight * scale;
  context.drawImage(image, (box.x + (box.width - renderedWidth) / 2) / 4,
    (box.y + (box.height - renderedHeight) / 2) / 4, renderedWidth / 4, renderedHeight / 4);
  context.fillStyle = "black";
  document.querySelectorAll(".latitude-pet-controls button").forEach((button) => {
    const bounds = button.getBoundingClientRect();
    context.fillRect(bounds.x / 4, bounds.y / 4, bounds.width / 4, bounds.height / 4);
  });
  const pixels = context.getImageData(0, 0, width, height).data;
  const alpha = Array.from({ length: width * height }, (_, index) => pixels[index * 4 + 3] > 20 ? 255 : 0);
  await petCommand("pet_set_hit_mask", { width, height, alpha });
}

export function NativePetWindow() {
  const { snapshot, state, error, setError } = useNativeMirror();
  const pose = usePetPose(state);
  const press = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  const report = (error: unknown) => setError(String(error));
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const paths = event.payload.paths;
      void petCommand("pet_show_chat")
        .then(() => emitTo("chatbar", "latitude://composer-files", paths))
        .catch((error) => setError(String(error)));
    }).then((dispose) => { if (disposed) dispose(); else unlisten = dispose; });
    return () => { disposed = true; unlisten?.(); };
  }, [setError]);
  if (!snapshot) return error ? <p className="latitude-pet-native-error">{error}</p> : null;
  return <div className="latitude-pet-native" aria-label="桌面秘书">
    <button type="button" className="latitude-pet-grab" aria-label="点击与秘书说话，按住移动"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        press.current = { x: event.clientX, y: event.clientY, dragging: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = press.current;
        if (!current || current.dragging || Math.hypot(event.clientX - current.x, event.clientY - current.y) < 5) return;
        current.dragging = true;
        void petCommand("pet_begin_drag", { source: "pet", grabX: event.clientX, grabY: event.clientY }).catch(report);
      }}
      onPointerUp={(event) => {
        const current = press.current; press.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (current && !current.dragging) void petCommand("pet_show_chat").catch(report);
      }}
      onPointerCancel={() => { press.current = null; void petCommand("pet_cancel_drag").catch(report); }}
      onKeyDown={(event) => { if (event.key === "Escape") void petCommand("pet_cancel_drag").catch(report); }}
      onClick={(event) => { if (event.detail === 0) void petCommand("pet_show_chat").catch(report); }}>
      {/* Connection errors belong in chat; local idle actions keep playing. */}
      <PetArtwork secretary={snapshot.secretary} expression={pose}
        notice={snapshot.notice} preferences={snapshot.noticePreferences}
        onLoad={(event) => void publishHitMask(event.currentTarget).catch(report)} />
    </button>
    <div className="latitude-pet-controls">
      <button type="button" onClick={() => void petCommand("pet_dock").catch(report)}>回到框里</button>
      <button type="button" onClick={() => void petCommand("pet_hide").catch(report)}>隐藏</button>
    </div>
    {error && <p role="alert" className="latitude-pet-native-error">{error}</p>}
  </div>;
}

async function sendFromPet(text: string, submission?: ComposerSubmission): Promise<boolean> {
  const requestId = crypto.randomUUID();
  let finish!: (result: { ok: boolean; error?: string }) => void;
  const result = new Promise<{ ok: boolean; error?: string }>((resolve) => { finish = resolve; });
  const unlisten = await listen<{ requestId: string; ok: boolean; error?: string }>("latitude://pet-send-result", (event) => {
    if (event.payload.requestId === requestId) finish(event.payload);
  });
  const timer = window.setTimeout(() => finish({ ok: false, error: "暂时未收到提交结果，请先查看任务状态。草稿已保留。" }), 15_000);
  try {
    await sendPetAction({ type: "send", text, submission, requestId });
    const response = await result;
    if (!response.ok) throw new Error(response.error);
    return true;
  } finally { window.clearTimeout(timer); unlisten(); }
}

export function NativePetChat() {
  const { snapshot, error, setError } = useNativeMirror();
  if (!snapshot) return <div className="latitude-pet-chat"><p>{error ?? "正在连接秘书…"}</p></div>;
  return <div className="latitude-pet-chat dimension-root">
    <DeskThread variant="native" messages={snapshot.messages} conversations={[snapshot.conversation]} currentId={snapshot.sessionId}
      streaming="" loading={snapshot.loading} progress={snapshot.progress} progressRunId={snapshot.progressRunId}
      onSelectConversation={() => undefined} onNewConversation={() => void sendPetAction({ type: "new-conversation" })}
      newConversationEnabled={!snapshot.loading}
      onClose={() => void petCommand("pet_hide_chat")} onSend={sendFromPet} sendEnabled={snapshot.sendEnabled}
      status={snapshot.status} historyError={error ?? snapshot.error} proactivePrompt={snapshot.proactivePrompt}
      onProactivePromptAction={snapshot.proactiveActionEnabled ? () => void sendPetAction({ type: "handle-prompt" }) : undefined}
      onCancel={() => void sendPetAction({ type: "cancel" }).catch((error) => setError(String(error)))}
      onReconnect={() => void sendPetAction({ type: "reconnect" })} />
  </div>;
}

export function NativePetNotice() {
  const { snapshot, state, error, setError } = useNativeMirror();
  const preferences = snapshot?.noticePreferences ?? DEFAULT_NOTICE_PREFERENCES;
  const notice = state.mode === "floating" && !state.hidden && !state.dragging ? snapshot?.notice ?? null : null;
  const visibility = useNoticeVisibility(notice, preferences);
  const dismiss = useCallback(() => {
    if (notice) void sendPetAction({ type: "dismiss-notice", id: notice.id }).catch((error) => setError(String(error)));
  }, [notice, setError]);
  useEffect(() => {
    const show = visibility.visible && state.mode === "floating" && !state.hidden && !state.dragging;
    void petCommand(show ? "pet_show_notice" : "pet_hide_notice").catch((error) => setError(String(error)));
  }, [visibility.visible, state.mode, state.hidden, state.dragging, setError]);
  return <div className="latitude-pet-native-notice dimension-root">
    {notice && <PetNoticeBubble notice={notice} preferences={preferences} visibility={visibility}
      onOpen={(item) => { void sendPetAction({ type: "open-notice", notice: item }); }} onDismiss={dismiss} />}
    {error && <p role="alert">{error}</p>}
  </div>;
}

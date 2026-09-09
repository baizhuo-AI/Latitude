import { useCallback, useEffect, useRef, useState } from "react";
import type { NoticePreferences, PetNotice } from "./types";

/** One presentation timer, shared by the bubble and (when needed) its native window. */
export function useNoticeVisibility(
  notice: PetNotice | null | undefined,
  preferences: NoticePreferences,
) {
  const noticeId = notice?.id ?? null;
  const [dismissed, setDismissed] = useState(() => new Set<string>());
  const [finishedExpressions, setFinishedExpressions] = useState(() => new Set<string>());
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const visible = noticeId !== null && !dismissed.has(noticeId);
  const expressionActive = visible && (preferences.animation === "loop" ||
    !finishedExpressions.has(noticeId!));
  const countdown = useRef({ id: null as string | null, duration: null as number | null, remaining: 0 });

  const dismiss = useCallback(() => {
    if (noticeId === null) return;
    setDismissed((current) => new Set(current).add(noticeId));
  }, [noticeId]);

  useEffect(() => {
    if (!visible) return;
    const duration = preferences.dismissAfterSeconds;
    if (countdown.current.id !== noticeId || countdown.current.duration !== duration) {
      countdown.current = { id: noticeId, duration, remaining: (duration ?? 0) * 1000 };
    }
    if (duration === null || paused) return;

    const startedAt = Date.now();
    const timer = window.setTimeout(dismiss, countdown.current.remaining);
    return () => {
      window.clearTimeout(timer);
      countdown.current.remaining = Math.max(0, countdown.current.remaining - (Date.now() - startedAt));
    };
  }, [noticeId, preferences.dismissAfterSeconds, paused, visible, dismiss]);

  useEffect(() => {
    if (!visible || noticeId === null || preferences.animation === "loop") return;
    const timer = window.setTimeout(() => {
      setFinishedExpressions((current) => new Set(current).add(noticeId));
    }, preferences.expressionSeconds * 1000);
    return () => window.clearTimeout(timer);
  }, [noticeId, preferences.animation, preferences.expressionSeconds, visible]);

  return { visible, expressionActive, dismiss, setHovered, setFocused };
}

export type NoticeVisibility = ReturnType<typeof useNoticeVisibility>;

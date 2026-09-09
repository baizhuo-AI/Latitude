import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { NoticePreferences, PetNotice } from "./types";
import { useNoticeVisibility, type NoticeVisibility } from "./useNoticeVisibility";
import "./petNotices.css";

export interface PetNoticeBubbleProps {
  notice: PetNotice;
  preferences: NoticePreferences;
  onOpen: (notice: PetNotice) => void;
  /** Presentation ended; this does not mean the associated task is complete. */
  onDismiss: (notice: PetNotice) => void;
  /** Pass the native window's controller to keep hover/focus and its timer shared. */
  visibility?: NoticeVisibility;
}

const KIND_LABELS: Record<PetNotice["kind"], string> = {
  discovery: "新发现",
  completed: "已完成",
  action: "等你处理",
  reminder: "提醒",
};

export function PetNoticeBubble(props: PetNoticeBubbleProps) {
  return props.visibility
    ? <BubbleContent {...props} visibility={props.visibility} />
    : <ManagedBubble {...props} />;
}

function ManagedBubble(props: PetNoticeBubbleProps) {
  const visibility = useNoticeVisibility(props.notice, props.preferences);
  return <BubbleContent {...props} visibility={visibility} />;
}

function BubbleContent({
  notice,
  onOpen,
  onDismiss,
  visibility,
}: PetNoticeBubbleProps & { visibility: NoticeVisibility }) {
  const announcedDismissals = useRef(new Set<string>());
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (visibility.visible || announcedDismissals.current.has(notice.id)) return;
    announcedDismissals.current.add(notice.id);
    onDismissRef.current(notice);
  }, [visibility.visible, notice]);

  if (!visibility.visible) return null;
  return (
    <section
      className="pet-notice-bubble"
      aria-label="秘书提醒"
      data-notice-kind={notice.kind}
      onPointerEnter={() => visibility.setHovered(true)}
      onPointerLeave={() => visibility.setHovered(false)}
      onFocus={() => visibility.setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          visibility.setFocused(false);
        }
      }}
    >
      <div className="pet-notice-bubble-header">
        <span>{KIND_LABELS[notice.kind]}</span>
        <button type="button" aria-label="收起这条提醒" onClick={visibility.dismiss}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <p className="pet-notice-bubble-text" role="status" aria-live="polite" aria-atomic="true">
        {notice.text}
      </p>
      <button
        className="pet-notice-open"
        type="button"
        onClick={() => {
          onOpen(notice);
          visibility.dismiss();
        }}
      >
        看全文
      </button>
    </section>
  );
}

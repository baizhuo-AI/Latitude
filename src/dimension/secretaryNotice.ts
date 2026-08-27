const DEFAULT_NOTICE = "有件事需要你看看。";

const INTERNAL_NOTICE_MARKERS = [
  /\b(?:action|agent|domain|outcome(?:_collection|_record)?|receipt|reviewAt|sensitivity|typed)\b/i,
  /\bdemo\s+profile\b/i,
  /\bnode_[a-z0-9_-]+\b/i,
  /(?:^|\s)#{1,6}\s/,
  /\*\*|```/,
];

/**
 * The secretary rail is a glanceable product surface, not a scheduler log.
 * Keep short human copy, and fail closed when a host/model response looks like
 * internal reasoning, Markdown, or an accidentally forwarded payload.
 */
export function compactSecretaryNotice(
  notice: string | null | undefined,
  fallback = DEFAULT_NOTICE,
): string {
  const raw = notice?.trim();
  if (!raw) return fallback;

  const normalized = raw.replace(/\s+/g, " ");
  if (
    raw.includes("\n") ||
    normalized.length > 72 ||
    INTERNAL_NOTICE_MARKERS.some((marker) => marker.test(normalized))
  ) {
    return fallback;
  }

  return normalized;
}

const FULL_PROVIDER_KEY = /\bsk-[A-Za-z0-9_-]{20,}\b/g;
const MASKED_JSON_PROVIDER_CREDENTIAL =
  /("(?:api[\s_-]?key|access[\s_-]?token|credential)"\s*:\s*)"\*{2,}[A-Za-z0-9_-]{2,}"/gi;
const MASKED_PROVIDER_CREDENTIAL =
  /\b(api[\s_-]?key|access[\s_-]?token|credential)\s*[:=]\s*\*{2,}[A-Za-z0-9_-]{2,}\b/gi;

/**
 * Final text boundary for Agent-owned artifacts. Provider errors sometimes
 * echo a masked credential suffix; even that suffix is unnecessary in UI,
 * logs, backups, or restore documents.
 */
export function redactCredentialText(content: string): string {
  let sanitized = content;
  for (const name of ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
    const activeSecret = process.env[name]?.trim();
    if (activeSecret) sanitized = sanitized.split(activeSecret).join("[REDACTED]");
  }
  sanitized = sanitized.replace(FULL_PROVIDER_KEY, "[REDACTED]");
  // Audit/admin boundaries call this after JSON.stringify. Preserve the JSON
  // key and quotes while removing a structured masked value.
  sanitized = sanitized.replace(
    MASKED_JSON_PROVIDER_CREDENTIAL,
    '$1"[REDACTED]"',
  );
  return sanitized.replace(
    MASKED_PROVIDER_CREDENTIAL,
    (_match, label: string) => `${label}: [REDACTED]`,
  );
}

export function containsCredentialText(content: string): boolean {
  return redactCredentialText(content) !== content;
}

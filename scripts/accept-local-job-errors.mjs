const STABLE_MESSAGES = Object.freeze({
  AUTH:
    "Model provider authentication failed. Update the local credential, restart Agent Host, and retry.",
  MISSING_CREDENTIAL:
    "Model provider credential is not configured. Configure it locally, restart Agent Host, and retry.",
  WEB_PROVIDER_ERROR:
    "Web search provider failed. No result was persisted.",
  host_restarted:
    "Agent Host restarted before this run reached a terminal state.",
  run_cancelled:
    "Agent run was cancelled before completion.",
  agent_run_failed:
    "Agent run failed. Check the local Agent Host diagnostics and retry.",
});

/**
 * Acceptance output is a public diagnostic boundary. Never echo a provider or
 * transport error body, even if a caller accidentally supplies one here.
 */
export function stableRunFailure(job) {
  const rawCode = typeof job?.error?.code === "string" ? job.error.code : "";
  const code = rawCode === "AUTH" || rawCode === "MISSING_CREDENTIAL"
    ? rawCode
    : rawCode.startsWith("WEB_")
      ? "WEB_PROVIDER_ERROR"
      : rawCode === "host_restarted" || rawCode === "run_cancelled"
        ? rawCode
        : job?.status === "cancelled"
          ? "run_cancelled"
          : "agent_run_failed";
  return { code, message: STABLE_MESSAGES[code] };
}

export function assertCompletedRun(job, label) {
  if (job?.status === "completed") return job;
  const { code, message } = stableRunFailure(job);
  throw new Error(`${label} failed (${code}): ${message}`);
}

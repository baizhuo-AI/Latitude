import path from "node:path";
import { chmod, lstat } from "node:fs/promises";

export interface AgentHostConfig {
  host: "127.0.0.1";
  port: number;
  domainBaseUrl: string;
  stateDir: string;
  provider: string;
  model: string;
  allowedOrigins: ReadonlySet<string>;
  domainTimeoutMs: number;
  schedulerPollMs: number;
  compactionEventThreshold: number;
}

function parsePort(
  raw: string | undefined,
  fallback: number,
  name = "LATITUDE_AGENT_PORT",
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new TypeError(`${name} must be an integer from 1 to 65535`);
  }
  return value;
}

function parsePositiveMs(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function parsePollMs(raw: string | undefined): number {
  const value = parsePositiveMs(raw, 60_000, "LATITUDE_SCHEDULER_POLL_MS");
  if (value < 5_000 || value > 300_000) {
    throw new TypeError("LATITUDE_SCHEDULER_POLL_MS must be from 5000 to 300000");
  }
  return value;
}

function parseCompactionThreshold(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 800;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 100 || value > 20_000) {
    throw new TypeError(
      "LATITUDE_COMPACTION_EVENT_THRESHOLD must be from 100 to 20000",
    );
  }
  return value;
}

export function loadAgentHostConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): AgentHostConfig {
  const stateDir = path.resolve(
    env.LATITUDE_STATE_DIR?.trim() || path.join(cwd, ".latitude", "agent"),
  );
  const workspaceRoot = path.resolve(cwd);
  const domainOwnerRoot = path.join(workspaceRoot, ".latitude");
  const defaultAgentRoot = path.join(domainOwnerRoot, "agent");
  if (isSameOrAncestor(stateDir, workspaceRoot)) {
    throw new TypeError(
      "LATITUDE_STATE_DIR cannot be the workspace root or one of its ancestors",
    );
  }
  if (
    isWithin(domainOwnerRoot, stateDir) &&
    !isWithin(defaultAgentRoot, stateDir)
  ) {
    throw new TypeError(
      "LATITUDE_STATE_DIR inside .latitude must live under .latitude/agent; Domain and backup roots are excluded",
    );
  }
  if (
    !isWithin(defaultAgentRoot, stateDir) &&
    path.basename(stateDir) !== "agent" &&
    !/^latitude-agent(?:[-_.].+)?$/.test(path.basename(stateDir))
  ) {
    throw new TypeError(
      "An external LATITUDE_STATE_DIR must use an agent or latitude-agent-* owner directory",
    );
  }
  const domainBaseUrl = loopbackHttpUrl(
    env.LATITUDE_DOMAIN_URL?.trim() || "http://127.0.0.1:43121",
    "LATITUDE_DOMAIN_URL",
  );
  const webPort = parsePort(env.LATITUDE_WEB_PORT, 1_420, "LATITUDE_WEB_PORT");
  const allowedOrigins = new Set([
    `http://127.0.0.1:${webPort}`,
    `http://localhost:${webPort}`,
  ]);
  const publicWebOrigin = env.LATITUDE_WEB_ORIGIN?.trim();
  if (publicWebOrigin) {
    allowedOrigins.add(httpsOrigin(publicWebOrigin, "LATITUDE_WEB_ORIGIN"));
  }
  return {
    // Deliberately not configurable: the P0 host is never exposed to the LAN.
    host: "127.0.0.1",
    port: parsePort(env.LATITUDE_AGENT_PORT, 43_120),
    domainBaseUrl,
    stateDir,
    provider: "deepseek-official",
    model: env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash",
    allowedOrigins,
    domainTimeoutMs: parsePositiveMs(
      env.LATITUDE_DOMAIN_TIMEOUT_MS,
      15_000,
      "LATITUDE_DOMAIN_TIMEOUT_MS",
    ),
    schedulerPollMs: parsePollMs(env.LATITUDE_SCHEDULER_POLL_MS),
    compactionEventThreshold: parseCompactionThreshold(
      env.LATITUDE_COMPACTION_EVENT_THRESHOLD,
    ),
  };
}

function httpsOrigin(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`${name} must be a valid HTTPS origin`);
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.search ||
    url.hash || (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new TypeError(`${name} must be an origin-only HTTPS URL`);
  }
  return url.origin;
}

function loopbackHttpUrl(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`${name} must be a valid loopback HTTP URL`);
  }
  const loopback = url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  if (
    url.protocol !== "http:" ||
    !loopback ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new TypeError(`${name} must be an origin-only loopback HTTP URL`);
  }
  return url.origin;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isSameOrAncestor(candidate: string, target: string): boolean {
  return isWithin(candidate, target);
}

/** Credential health is a boolean only; the value must never enter config or logs. */
export function isDeepSeekConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.DEEPSEEK_API_KEY?.trim() ?? "";
  if (!value) return false;
  return ![
    "replace-with-local-server-key",
    "your-api-key",
    "your-deepseek-api-key",
    "changeme",
  ].includes(value.toLowerCase());
}

/**
 * Harden the conventional local credential file without ever reading it.
 * Symlinks are rejected so startup cannot chmod or implicitly trust a target
 * outside the workspace. Permission failures are best-effort because an
 * already-secure read-only mount must not obscure the service diagnostics.
 */
export async function hardenLocalEnvFile(
  cwd = process.cwd(),
): Promise<"missing" | "hardened" | "unchanged"> {
  const file = path.join(cwd, ".env.local");
  let metadata;
  try {
    metadata = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    throw new TypeError(".env.local must be a regular file, not a symlink");
  }
  if (!metadata.isFile()) {
    throw new TypeError(".env.local must be a regular file");
  }
  // A no-op chmod still changes inode metadata and makes Vite restart its env
  // watcher. Leave an already-private file completely untouched.
  if ((metadata.mode & 0o777) === 0o600) return "unchanged";
  try {
    await chmod(file, 0o600);
    return "hardened";
  } catch {
    return "unchanged";
  }
}

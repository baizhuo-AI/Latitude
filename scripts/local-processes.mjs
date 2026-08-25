import { spawn } from "node:child_process";
import net from "node:net";
import process from "node:process";

/**
 * Bind and immediately release each product port before any child starts. This
 * keeps a stale Browser process from producing a half-started Domain/Agent
 * stack and, importantly, never kills a process the launcher does not own.
 */
export async function assertLoopbackPortsAvailable(entries, options = {}) {
  const probe = options.probe ?? probeLoopbackPort;
  const conflicts = [];
  for (const entry of entries) {
    try {
      await probe(entry.host, entry.port);
    } catch (error) {
      if (error?.code === "EADDRINUSE") {
        conflicts.push(entry);
        continue;
      }
      const code = typeof error?.code === "string" ? ` (${error.code})` : "";
      throw new Error(
        `Cannot inspect ${entry.name} port ${entry.host}:${entry.port}${code}: ${errorMessage(error)}`,
      );
    }
  }
  if (conflicts.length > 0) {
    const detail = conflicts
      .map((entry) => `${entry.name} ${entry.host}:${entry.port}`)
      .join(", ");
    const error = new Error(
      `Local product port already in use: ${detail}. Stop the existing process and retry; Latitude will not terminate an unowned process.`,
    );
    error.code = "LATITUDE_PORT_IN_USE";
    error.conflicts = conflicts;
    throw error;
  }
}

export function spawnManagedProcess(command, args, options = {}) {
  return spawn(command, args, {
    ...options,
    // A dedicated process group lets the launcher stop npm/cargo and every
    // descendant they create. Windows uses ChildProcess.kill as a fallback.
    detached: process.platform !== "win32",
  });
}

/** Signal only the process group created by spawnManagedProcess. */
export function signalManagedProcess(
  child,
  signal = "SIGTERM",
  options = {},
) {
  if (!child?.pid) return false;
  const platform = options.platform ?? process.platform;
  const kill = options.kill ?? process.kill;
  if (platform !== "win32") {
    try {
      kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
      return false;
    }
  }
  return child.kill(signal);
}

export function waitForProcessExit(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once("exit", resolve));
}

/**
 * Health polling is for transient boot work, not for configuration errors that
 * cannot heal with time. Returning a message lets the launcher fail fast while
 * keeping service-specific policy out of the generic polling loop.
 */
export function terminalLocalHealthFailure(serviceName, body) {
  if (
    serviceName === "agent" &&
    body?.status === "unavailable" &&
    body?.model?.configured === false
  ) {
    return "DeepSeek is not configured. Set DEEPSEEK_API_KEY in .env.local and retry.";
  }
  if (
    serviceName === "agent" &&
    body?.status === "unavailable" &&
    body?.model?.authentication === "failed"
  ) {
    return "DeepSeek authentication was rejected. Replace DEEPSEEK_API_KEY in .env.local and restart.";
  }
  if (
    serviceName === "agent" &&
    body?.status === "unavailable" &&
    body?.state?.restartRequired === true
  ) {
    return "Agent data maintenance completed and requires a fresh restart.";
  }
  return null;
}

function probeLoopbackPort(host, port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

import process from "node:process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  assertLoopbackPortsAvailable,
  signalManagedProcess,
  spawnManagedProcess,
  terminalLocalHealthFailure,
  waitForProcessExit,
} from "./local-processes.mjs";

const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
if (major !== 22) {
  console.error(
    `[latitude] Local product runtime requires Node 22.x; current ${process.versions.node}.`,
  );
  process.exit(1);
}

const agentPort = validPort(process.env.LATITUDE_AGENT_PORT, 43120, "LATITUDE_AGENT_PORT");
const webPort = validPort(process.env.LATITUDE_WEB_PORT, 1420, "LATITUDE_WEB_PORT");
const domainAddress = process.env.LATITUDE_DOMAIN_ADDR?.trim() || "127.0.0.1:43121";
const domainUrl = loopbackOrigin(
  process.env.LATITUDE_DOMAIN_URL?.trim() || `http://${domainAddress}`,
  "LATITUDE_DOMAIN_URL",
);
const domainEndpoint = new URL(domainUrl);
const computerHistoryRoot = process.env.LATITUDE_COMPUTER_HISTORY_ROOT?.trim() || path.join(
  homedir(),
  "Library",
  "Group Containers",
  "2DC432GLL2.com.openai.sky.CUAService",
  "Library",
  "Caches",
  "ComputerUse",
  "Skysight",
);
const computerHistoryAvailable = existsSync(path.join(computerHistoryRoot, "segments"));
const services = [
  {
    name: "domain",
    script: "dev:domain",
    health: `${domainUrl}/health`,
    secretFree: true,
    requireReadyStatus: true,
  },
  {
    name: "agent",
    script: "dev:agent",
    health: `http://127.0.0.1:${agentPort}/health`,
    // A listening Host remains useful when no provider is configured yet: the
    // Browser Settings surface is the recovery path. Health still reports the
    // model unavailable and turns remain blocked by the provider adapter.
    requireReadyStatus: false,
  },
  {
    name: "web",
    script: "dev:web",
    args: ["run", "dev:web", "--", "--port", String(webPort)],
    health: `http://127.0.0.1:${webPort}`,
    secretFree: true,
  },
];

let stopping = false;
ignoreClosedPipe(process.stdout);
ignoreClosedPipe(process.stderr);
try {
  await assertLoopbackPortsAvailable([
    {
      name: "domain",
      host: loopbackBindHost(domainEndpoint.hostname),
      port: Number(domainEndpoint.port || 80),
    },
    { name: "agent", host: "127.0.0.1", port: agentPort },
    { name: "web", host: "127.0.0.1", port: webPort },
  ]);
} catch (error) {
  console.error(`[latitude] Startup preflight failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const children = services.map((service) => {
  const childEnvironment = service.name === "agent"
    ? agentEnvironment(process.env)
    : service.name === "web"
      ? browserEnvironment(process.env, agentPort, domainUrl)
      : withoutModelCredentials(process.env);
  const child = spawnManagedProcess("npm", service.args ?? ["run", service.script], {
    cwd: process.cwd(),
    env: childEnvironment,
    stdio: ["inherit", "pipe", "pipe"],
  });
  prefix(child.stdout, service.name, process.stdout);
  prefix(child.stderr, service.name, process.stderr);
  child.once("exit", (code, signal) => {
    if (stopping) return;
    console.error(
      `[latitude] ${service.name} stopped unexpectedly (${signal ?? code ?? "unknown"}).`,
    );
    void shutdown(code && code > 0 ? code : 1);
  });
  return child;
});

// Last synchronous safety net for an npm wrapper closing the PTY or an
// unexpected exception during async cleanup. It cannot wait, but signalling
// the already-owned groups prevents orphan services in every non-SIGKILL exit.
process.on("exit", () => {
  for (const child of children) {
    try {
      signalManagedProcess(child, "SIGTERM");
    } catch {
      // The async shutdown path reports failures; exit cleanup must not throw.
    }
  }
});

// npm itself is the foreground PTY process. Some terminals close that wrapper
// immediately after Ctrl+C, which delivers SIGHUP while the Node supervisor is
// still draining its detached child groups. Persistent handlers keep cleanup
// alive through repeated terminal signals until every owned group is stopped.
process.on("SIGINT", () => void shutdown(130));
process.on("SIGTERM", () => void shutdown(143));
process.on("SIGHUP", () => void shutdown(129));

try {
  await Promise.all(services.map((service) => waitForHealth(service)));
  console.log(`\n[latitude] Product loop is ready: http://127.0.0.1:${webPort}\n`);
} catch (error) {
  console.error(`[latitude] Startup failed: ${error instanceof Error ? error.message : String(error)}`);
  await shutdown(1);
}

function prefix(stream, name, output) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    for (const line of lines) output.write(`[${name}] ${line}\n`);
  });
  stream.on("end", () => {
    if (pending) output.write(`[${name}] ${pending}\n`);
  });
}

function ignoreClosedPipe(stream) {
  stream.on("error", (error) => {
    if (error?.code !== "EPIPE") {
      process.exitCode = 1;
    }
  });
}

async function waitForHealth(service) {
  const deadline = Date.now() + 90_000;
  let lastError = "not started";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(service.health, { signal: AbortSignal.timeout(1_500) });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
      } else if (!service.requireReadyStatus) {
        return;
      } else {
        const body = await response.json();
        if (
          body &&
          typeof body === "object" &&
          !Array.isArray(body) &&
          body.status === "ready" &&
          body.ok !== false
        ) {
          return;
        }
        const terminalFailure = terminalLocalHealthFailure(service.name, body);
        if (terminalFailure) {
          const error = new Error(terminalFailure);
          error.code = "LATITUDE_TERMINAL_HEALTH";
          throw error;
        }
        lastError = `HTTP ${response.status}, status=${String(body?.status ?? "missing")}`;
      }
    } catch (error) {
      if (error?.code === "LATITUDE_TERMINAL_HEALTH") {
        throw error;
      }
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(`${service.name} health check timed out: ${lastError}`);
}

async function shutdown(exitCode) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    signalManagedProcess(child, "SIGTERM");
  }
  let timer;
  const graceExpired = new Promise((resolve) => {
    timer = setTimeout(resolve, 3_000, "timeout");
  });
  const graceful = Promise.all(children.map(waitForProcessExit));
  if (await Promise.race([graceful, graceExpired]) === "timeout") {
    for (const child of children) {
      signalManagedProcess(child, "SIGKILL");
    }
    await Promise.race([
      Promise.all(children.map(waitForProcessExit)),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }
  clearTimeout(timer);
  process.exit(exitCode);
}

function validPort(raw, fallback, name) {
  if (!raw?.trim()) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[latitude] ${name} must be an integer from 1 to 65535.`);
    process.exit(1);
  }
  return port;
}

function withoutModelCredentials(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) =>
      !/(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)$/iu.test(name)
    ),
  );
}

/**
 * DSH plugins execute inside the Agent Host process. Keep the ordinary runtime
 * environment (PATH, HOME, proxy settings, locale), but do not give those
 * plugins unrelated developer credentials that happened to be present in the
 * parent shell. Latitude providers receive only this explicit allowlist.
 */
function agentEnvironment(environment) {
  const safe = withoutModelCredentials(environment);
  for (const name of [
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "DEEPSEEK_SEARCH_BASE_URL",
    "DEEPSEEK_MODEL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
  ]) {
    if (environment[name] !== undefined) safe[name] = environment[name];
  }
  return safe;
}

/**
 * Vite receives only two non-secret, loopback-only origins. Deriving them in
 * the supervisor keeps Browser transport aligned with the ports that passed
 * startup preflight without exposing credentials to the bundle.
 */
function browserEnvironment(environment, resolvedAgentPort, resolvedDomainUrl) {
  const safe = withoutModelCredentials(environment);
  safe.VITE_LATITUDE_AGENT_URL = `http://127.0.0.1:${resolvedAgentPort}`;
  safe.VITE_LATITUDE_DOMAIN_URL = resolvedDomainUrl;
  return safe;
}

function loopbackOrigin(raw, name) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    console.error(`[latitude] ${name} must be a valid loopback HTTP URL.`);
    process.exit(1);
  }
  const loopback = url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  if (url.protocol !== "http:" || !loopback || url.username || url.password) {
    console.error(`[latitude] ${name} must use an unauthenticated loopback HTTP origin.`);
    process.exit(1);
  }
  return url.origin;
}

function loopbackBindHost(hostname) {
  if (hostname === "localhost") return "127.0.0.1";
  return hostname === "[::1]" ? "::1" : hostname;
}

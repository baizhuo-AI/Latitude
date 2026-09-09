import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, statfs } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const MIN_FREE_BYTES = 64 * 1024 * 1024;

const DEFAULT_DEPS = {
  access,
  lstat,
  statfs,
  probePort: probeLoopbackPort,
  commandAvailable,
};

export async function runLocalDoctor(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const deps = { ...DEFAULT_DEPS, ...(options.deps ?? {}) };
  const checks = [];

  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0] ?? "0", 10);
  checks.push(check(
    "node",
    nodeMajor === 22,
    nodeMajor === 22
      ? `Node ${nodeVersion} matches the required 22.x runtime`
      : `Node 22.x is required; current runtime is ${nodeVersion}`,
  ));

  for (const command of ["cargo", "rustc"]) {
    const available = deps.commandAvailable(command, env);
    checks.push(check(
      `toolchain_${command}`,
      available,
      available
        ? `${command} is available`
        : `${command} is unavailable on PATH`,
    ));
  }

  await inspectEnvFile(cwd, env, deps, checks);

  let config;
  try {
    config = resolveDoctorConfig(env, cwd);
    checks.push(check("configuration", true, "Loopback service and local storage configuration is valid"));
  } catch (error) {
    checks.push(check("configuration", false, safeConfigurationError(error)));
  }

  if (config) {
    const pathIssues = storagePathIssues(config, cwd);
    checks.push(check(
      "storage_isolation",
      pathIssues.length === 0,
      pathIssues.length === 0
        ? "Agent, Domain, and backup paths are pairwise isolated"
        : pathIssues.join("; "),
      { paths: config.paths },
    ));

    for (const endpoint of config.ports) {
      try {
        await deps.probePort(endpoint.host, endpoint.port);
        checks.push(check(
          `port_${endpoint.name}`,
          true,
          `${endpoint.name} loopback port ${endpoint.host}:${endpoint.port} is available`,
        ));
      } catch (error) {
        const code = safeErrorCode(error);
        checks.push(check(
          `port_${endpoint.name}`,
          false,
          code === "EADDRINUSE"
            ? `${endpoint.name} loopback port ${endpoint.host}:${endpoint.port} is already in use`
            : `${endpoint.name} loopback port ${endpoint.host}:${endpoint.port} could not be inspected (${code})`,
        ));
      }
    }

    for (const [name, target] of Object.entries(config.paths)) {
      checks.push(await inspectWritableTarget(
        name,
        target,
        name === "domainDatabase" ? "file" : "directory",
        deps,
      ));
    }
  }

  return {
    service: "latitude-local-doctor",
    ok: checks.every((entry) => entry.status === "pass"),
    checkedAt: new Date().toISOString(),
    checks,
  };
}

export function resolveDoctorConfig(env, cwd) {
  const agentPort = parsePort(env.LATITUDE_AGENT_PORT, 43_120, "LATITUDE_AGENT_PORT");
  const webPort = parsePort(env.LATITUDE_WEB_PORT, 1_420, "LATITUDE_WEB_PORT");
  const domainAddress = parseDomainAddress(
    env.LATITUDE_DOMAIN_ADDR?.trim() || "127.0.0.1:43121",
  );
  const domainUrl = parseLoopbackOrigin(
    env.LATITUDE_DOMAIN_URL?.trim() ||
      `http://${formatHost(domainAddress.host)}:${domainAddress.port}`,
    "LATITUDE_DOMAIN_URL",
  );
  if (domainUrl.port !== domainAddress.port) {
    throw new TypeError(
      `LATITUDE_DOMAIN_URL port ${domainUrl.port} does not match LATITUDE_DOMAIN_ADDR port ${domainAddress.port}`,
    );
  }
  const distinctPorts = new Set([agentPort, webPort, domainAddress.port]);
  if (distinctPorts.size !== 3) {
    throw new TypeError("Browser, Agent, and Domain ports must be distinct");
  }

  const stateDir = path.resolve(
    cwd,
    env.LATITUDE_STATE_DIR?.trim() || path.join(".latitude", "agent"),
  );
  return {
    ports: [
      { name: "browser", host: "127.0.0.1", port: webPort },
      { name: "agent", host: "127.0.0.1", port: agentPort },
      { name: "domain", host: domainAddress.host, port: domainAddress.port },
    ],
    paths: {
      agentState: stateDir,
      agentBackups: `${stateDir}-backups`,
      domainDatabase: path.resolve(
        cwd,
        env.LATITUDE_DB_PATH?.trim() || path.join(".latitude", "latitude-domain.db"),
      ),
      domainBackups: path.resolve(
        cwd,
        env.LATITUDE_BACKUP_DIR?.trim() || path.join(".latitude", "backups"),
      ),
    },
  };
}

export function storagePathIssues(config, cwd) {
  const issues = [];
  const paths = Object.entries(config.paths);
  const workspace = path.resolve(cwd);
  const stateDir = config.paths.agentState;
  const domainRoot = path.join(workspace, ".latitude");
  const defaultAgentRoot = path.join(domainRoot, "agent");

  if (isSameOrAncestor(stateDir, workspace)) {
    issues.push("Agent state cannot be the workspace root or one of its ancestors");
  }
  if (isWithin(domainRoot, stateDir) && !isWithin(defaultAgentRoot, stateDir)) {
    issues.push("Agent state inside .latitude must stay below .latitude/agent");
  }
  if (
    !isWithin(defaultAgentRoot, stateDir) &&
    path.basename(stateDir) !== "agent" &&
    !/^latitude-agent(?:[-_.].+)?$/u.test(path.basename(stateDir))
  ) {
    issues.push("External Agent state must use an agent or latitude-agent-* owner directory");
  }

  for (let leftIndex = 0; leftIndex < paths.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < paths.length; rightIndex += 1) {
      const [leftName, leftPath] = paths[leftIndex];
      const [rightName, rightPath] = paths[rightIndex];
      if (isWithin(leftPath, rightPath) || isWithin(rightPath, leftPath)) {
        issues.push(`${leftName} and ${rightName} overlap`);
      }
    }
  }
  return issues;
}

export function formatDoctorReport(report) {
  const lines = report.checks.map((entry) =>
    `[${entry.status.toUpperCase()}] ${entry.id}: ${entry.summary}`
  );
  const passed = report.checks.filter((entry) => entry.status === "pass").length;
  lines.push(
    `[latitude-doctor] ${report.ok ? "READY" : "NOT READY"}: ${passed}/${report.checks.length} checks passed`,
  );
  return `${lines.join("\n")}\n`;
}

async function inspectEnvFile(cwd, env, deps, checks) {
  const localEnv = path.join(cwd, ".env.local");
  try {
    const metadata = await deps.lstat(localEnv);
    const regular = metadata.isFile() && !metadata.isSymbolicLink();
    checks.push(check(
      "env_file_type",
      regular,
      regular
        ? ".env.local is a regular non-symlink file"
        : ".env.local must be a regular non-symlink file",
    ));
    const mode = metadata.mode & 0o777;
    checks.push(check(
      "env_file_permissions",
      regular && mode === 0o600,
      regular && mode === 0o600
        ? ".env.local permissions are 0600"
        : `.env.local permissions must be 0600 (found ${mode.toString(8).padStart(4, "0")})`,
    ));
  } catch (error) {
    const missing = safeErrorCode(error) === "ENOENT";
    checks.push(check(
      "env_file_type",
      false,
      missing ? ".env.local is missing" : `.env.local could not be inspected (${safeErrorCode(error)})`,
    ));
    checks.push(check(
      "env_file_permissions",
      false,
      ".env.local permissions could not be verified",
    ));
  }

  const credentialNames = [
    "DEEPSEEK_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
  ].filter((name) => typeof env[name] === "string" && env[name].trim().length > 0);
  const credentialPresent = credentialNames.length > 0;
  checks.push(check(
    "credential_presence",
    credentialPresent,
    credentialPresent
      ? `${credentialNames.join(", ")} is present; values were not printed`
      : "No supported model provider credential is configured",
  ));
}

async function inspectWritableTarget(name, target, expectedType, deps) {
  let current = target;
  let metadata;
  while (true) {
    try {
      metadata = await deps.lstat(current);
      break;
    } catch (error) {
      if (safeErrorCode(error) !== "ENOENT") {
        return check(
          `storage_${name}`,
          false,
          `${name} could not be inspected (${safeErrorCode(error)})`,
        );
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return check(`storage_${name}`, false, `${name} has no existing writable ancestor`);
      }
      current = parent;
    }
  }

  if (metadata.isSymbolicLink()) {
    return check(`storage_${name}`, false, `${name} resolves through a symlink target`);
  }
  if (
    current === target &&
    ((expectedType === "file" && !metadata.isFile()) ||
      (expectedType === "directory" && !metadata.isDirectory()))
  ) {
    return check(
      `storage_${name}`,
      false,
      `${name} exists but is not a regular non-symlink ${expectedType}`,
    );
  }
  try {
    await deps.access(current, constants.W_OK);
    const disk = await deps.statfs(current);
    const availableBytes = numericFsValue(disk.bavail) * numericFsValue(disk.bsize);
    const enoughSpace = Number.isFinite(availableBytes) && availableBytes >= MIN_FREE_BYTES;
    return check(
      `storage_${name}`,
      enoughSpace,
      enoughSpace
        ? `${name} has a writable ancestor and at least 64 MiB available`
        : `${name} has less than 64 MiB available`,
      { target, inspectedAt: current },
    );
  } catch (error) {
    return check(
      `storage_${name}`,
      false,
      `${name} is not writable or disk capacity could not be checked (${safeErrorCode(error)})`,
      { target, inspectedAt: current },
    );
  }
}

function parsePort(raw, fallback, name) {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new TypeError(`${name} must be an integer from 1 to 65535`);
  }
  return value;
}

function parseDomainAddress(raw) {
  const ipv4 = raw.match(/^127\.0\.0\.1:(\d{1,5})$/u);
  const ipv6 = raw.match(/^\[::1\]:(\d{1,5})$/u);
  const match = ipv4 ?? ipv6;
  if (!match) {
    throw new TypeError("LATITUDE_DOMAIN_ADDR must be 127.0.0.1:port or [::1]:port");
  }
  return {
    host: ipv4 ? "127.0.0.1" : "::1",
    port: parsePort(match[1], 43_121, "LATITUDE_DOMAIN_ADDR port"),
  };
}

function parseLoopbackOrigin(raw, name) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`${name} must be a valid loopback HTTP origin`);
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
    throw new TypeError(`${name} must be an unauthenticated loopback HTTP origin`);
  }
  return { port: Number(url.port || 80) };
}

function formatHost(host) {
  return host === "::1" ? "[::1]" : host;
}

function check(id, passed, summary, details) {
  return {
    id,
    status: passed ? "pass" : "fail",
    summary,
    ...(details ? { details } : {}),
  };
}

function safeConfigurationError(error) {
  return error instanceof TypeError
    ? error.message
    : `Local configuration could not be inspected (${safeErrorCode(error)})`;
}

function safeErrorCode(error) {
  const code = error && typeof error === "object" ? error.code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/u.test(code)
    ? code
    : "UNKNOWN";
}

function numericFsValue(value) {
  return Number(value);
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isSameOrAncestor(candidate, target) {
  return isWithin(candidate, target);
}

function commandAvailable(command, env) {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
    env: {
      PATH: env.PATH ?? "",
      ...(env.SystemRoot ? { SystemRoot: env.SystemRoot } : {}),
    },
  });
  return result.status === 0;
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

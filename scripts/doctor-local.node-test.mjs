import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  formatDoctorReport,
  resolveDoctorConfig,
  runLocalDoctor,
  storagePathIssues,
} from "./doctor-local-core.mjs";

const CWD = "/workspace/latitude";

function enoent() {
  return Object.assign(new Error("missing"), { code: "ENOENT" });
}

function regularFile(mode = 0o600) {
  return {
    mode,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  };
}

function directory() {
  return {
    mode: 0o700,
    isFile: () => false,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
}

function passingDeps(portVisits = []) {
  return {
    commandAvailable: (name) => name === "cargo" || name === "rustc",
    probePort: async (host, port) => {
      portVisits.push(`${host}:${port}`);
    },
    lstat: async (target) => {
      if (target === path.join(CWD, ".env.local")) return regularFile();
      if (target === CWD) return directory();
      throw enoent();
    },
    access: async () => undefined,
    statfs: async () => ({ bavail: 1_000_000, bsize: 4_096 }),
  };
}

test("doctor passes a safe isolated local profile without retaining the credential", async () => {
  const visits = [];
  const credential = "doctor-private-fixture-value";
  const report = await runLocalDoctor({
    cwd: CWD,
    nodeVersion: "22.18.0",
    env: {
      PATH: "/usr/bin",
      DEEPSEEK_API_KEY: credential,
      LATITUDE_AGENT_PORT: "51001",
      LATITUDE_WEB_PORT: "51002",
      LATITUDE_DOMAIN_ADDR: "127.0.0.1:51003",
      LATITUDE_DOMAIN_URL: "http://127.0.0.1:51003",
    },
    deps: passingDeps(visits),
  });
  assert.equal(report.ok, true);
  assert.deepEqual(visits, [
    "127.0.0.1:51002",
    "127.0.0.1:51001",
    "127.0.0.1:51003",
  ]);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(credential, "u"));
  assert.match(formatDoctorReport(report), /READY/u);
});

test("doctor reports env symlinks, missing credentials, and occupied ports without secret text", async () => {
  const deps = passingDeps();
  deps.lstat = async (target) => {
    if (target === path.join(CWD, ".env.local")) {
      return {
        mode: 0o777,
        isFile: () => false,
        isDirectory: () => false,
        isSymbolicLink: () => true,
      };
    }
    if (target === CWD) return directory();
    throw enoent();
  };
  deps.probePort = async (_host, port) => {
    if (port === 1420) throw Object.assign(new Error("occupied private detail"), {
      code: "EADDRINUSE",
    });
  };
  const report = await runLocalDoctor({
    cwd: CWD,
    nodeVersion: "22.0.0",
    env: { PATH: "/usr/bin" },
    deps,
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((entry) => entry.id === "env_file_type")?.status, "fail");
  assert.equal(report.checks.find((entry) => entry.id === "credential_presence")?.status, "fail");
  assert.match(
    report.checks.find((entry) => entry.id === "port_browser")?.summary ?? "",
    /already in use/u,
  );
  assert.doesNotMatch(JSON.stringify(report), /occupied private detail/u);
});

test("doctor rejects port drift and overlapping Agent/Domain ownership", () => {
  assert.throws(() => resolveDoctorConfig({
    LATITUDE_DOMAIN_ADDR: "127.0.0.1:52001",
    LATITUDE_DOMAIN_URL: "http://127.0.0.1:52002",
  }, CWD), /does not match/u);

  const config = resolveDoctorConfig({
    LATITUDE_STATE_DIR: ".latitude/backups",
    LATITUDE_BACKUP_DIR: ".latitude/backups",
  }, CWD);
  const issues = storagePathIssues(config, CWD);
  assert.ok(issues.some((issue) => /below \.latitude\/agent/u.test(issue)));
  assert.ok(issues.some((issue) => /agentState and domainBackups overlap/u.test(issue)));
});

test("doctor checks free space without creating probe files", async () => {
  let writes = 0;
  const deps = passingDeps();
  deps.statfs = async () => ({ bavail: 1, bsize: 4_096 });
  deps.writeFile = async () => {
    writes += 1;
  };
  const report = await runLocalDoctor({
    cwd: CWD,
    nodeVersion: "22.0.0",
    env: { PATH: "/usr/bin", DEEPSEEK_API_KEY: "present" },
    deps,
  });
  assert.equal(report.ok, false);
  assert.equal(writes, 0);
  assert.ok(report.checks.some((entry) =>
    entry.id.startsWith("storage_") && /less than 64 MiB/u.test(entry.summary)
  ));
});

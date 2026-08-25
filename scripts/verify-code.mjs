import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
if (nodeMajor !== 22) {
  console.error(`[latitude] Verification requires Node 22.x; current ${process.versions.node}.`);
  process.exit(1);
}

const domainManifest = "src-tauri/domain-service/Cargo.toml";
const cargoEnvironment = {
  ...process.env,
  CARGO_TARGET_DIR:
    process.env.LATITUDE_VERIFY_CARGO_TARGET_DIR?.trim() ||
    path.join(tmpdir(), "latitude-domain-target"),
};

const checks = [
  {
    label: "Local launcher, doctor, and acceptance safety tests",
    command: process.execPath,
    args: [
      "--test",
      "scripts/local-processes.node-test.mjs",
      "scripts/doctor-local.node-test.mjs",
      "scripts/accept-local-job-errors.node-test.mjs",
      "scripts/scan-credential-artifacts.node-test.mjs",
    ],
  },
  {
    label: "Browser and deterministic offline acceptance safety tests",
    command: process.execPath,
    args: [
      "--test",
      "scripts/browser-cdp.node-test.mjs",
      "scripts/accept-browser.node-test.mjs",
      "scripts/accept-offline.node-test.mjs",
    ],
  },
  { label: "TypeScript and production browser build", command: "npm", args: ["run", "build"] },
  {
    label: "Production artifact credential scan",
    command: "npm",
    args: ["run", "scan:artifacts"],
  },
  { label: "CSS contract", command: "npm", args: ["run", "lint:styles"] },
  { label: "Agent Host types", command: "npm", args: ["run", "typecheck:agent"] },
  { label: "Full Vitest suite", command: "npm", args: ["test"] },
  {
    label: "Domain formatting",
    command: "cargo",
    args: ["fmt", "--manifest-path", domainManifest, "--", "--check"],
  },
  {
    label: "Domain Clippy",
    command: "cargo",
    args: [
      "clippy",
      "--locked",
      "--manifest-path",
      domainManifest,
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ],
    env: cargoEnvironment,
  },
  {
    label: "Domain integration tests",
    command: "cargo",
    args: ["test", "--locked", "--manifest-path", domainManifest],
    env: cargoEnvironment,
  },
];

for (const [index, check] of checks.entries()) {
  console.log(`\n[latitude] ${index + 1}/${checks.length} ${check.label}`);
  const exitCode = await run(check.command, check.args, check.env ?? process.env);
  if (exitCode !== 0) {
    console.error(`\n[latitude] Verification stopped at: ${check.label}`);
    process.exit(exitCode || 1);
  }
}

console.log("\n[latitude] All code verification gates passed.\n");

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        console.error(`[latitude] ${command} stopped by ${signal}.`);
        resolve(1);
      } else {
        resolve(code ?? 1);
      }
    });
  });
}

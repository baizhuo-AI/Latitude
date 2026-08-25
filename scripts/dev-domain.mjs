import { spawn } from "node:child_process";
import process from "node:process";

const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    !/(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)$/iu.test(name)
  ),
);
env.CARGO_TARGET_DIR ||= "/private/tmp/latitude-domain-target";

const child = spawn(
  "cargo",
  [
    "run",
    "--manifest-path",
    "src-tauri/domain-service/Cargo.toml",
    "--bin",
    "latitude-domain",
  ],
  { cwd: process.cwd(), env, stdio: "inherit" },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  process.stderr.write(`[latitude-domain] failed to start: ${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : code ?? 1;
});

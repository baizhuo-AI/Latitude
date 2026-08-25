import process from "node:process";
import {
  formatDoctorReport,
  runLocalDoctor,
} from "./doctor-local-core.mjs";

try {
  const report = await runLocalDoctor();
  process.stdout.write(formatDoctorReport(report));
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  const code = error && typeof error === "object" &&
      typeof error.code === "string" && /^[A-Z0-9_]{1,40}$/u.test(error.code)
    ? error.code
    : "UNKNOWN";
  process.stderr.write(`[latitude-doctor] unexpected local diagnostic failure (${code})\n`);
  process.exitCode = 1;
}

import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_ROOTS = ["dist", "build"];
const REQUIRED_ROOTS = new Set(["dist"]);
const DETECTORS = [
  {
    id: "sk-prefixed-credential",
    // Match a credential token, not the suffix of identifiers such as dim-desk-arranged-undo.
    pattern: /(?<![A-Za-z0-9_])sk-[A-Za-z0-9][A-Za-z0-9_-]{15,}/gu,
  },
];

/**
 * Fail closed when a production artifact contains a key-shaped credential.
 * Findings intentionally contain only detector ids, relative file paths, and
 * counts. Matched bytes are never returned, printed, or included in errors.
 */
export async function scanCredentialArtifacts(options = {}) {
  const workspace = path.resolve(options.workspace ?? process.cwd());
  const roots = options.roots ?? DEFAULT_ROOTS;
  const requiredRoots = new Set(options.requiredRoots ?? REQUIRED_ROOTS);
  const findings = [];
  let filesScanned = 0;
  let rootsScanned = 0;

  for (const configuredRoot of roots) {
    const root = resolveContainedPath(workspace, configuredRoot);
    let metadata;
    try {
      metadata = await lstat(root);
    } catch (error) {
      if (error?.code === "ENOENT" && !requiredRoots.has(configuredRoot)) continue;
      if (error?.code === "ENOENT") {
        throw new Error(`Required artifact root is missing: ${configuredRoot}`);
      }
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Artifact root must be a real directory: ${configuredRoot}`);
    }
    rootsScanned += 1;

    for (const file of await collectArtifactFiles(root)) {
      filesScanned += 1;
      const bytes = await readFile(file);
      // latin1 preserves every ASCII credential byte even in otherwise binary files.
      const content = bytes.toString("latin1");
      for (const detector of DETECTORS) {
        detector.pattern.lastIndex = 0;
        let count = 0;
        while (detector.pattern.exec(content)) count += 1;
        if (count > 0) {
          findings.push({
            detector: detector.id,
            file: path.relative(workspace, file),
            count,
          });
        }
      }
    }
  }

  if (findings.length > 0) {
    const summary = findings
      .map((finding) => `${finding.file} (${finding.detector}, ${finding.count} match(es))`)
      .join("; ");
    throw new Error(
      `Credential-shaped value found in production artifact(s): ${summary}. ` +
        "Matched values are intentionally redacted.",
    );
  }

  return { ok: true, rootsScanned, filesScanned };
}

async function collectArtifactFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Artifact tree contains a symlink and will not be followed: ${target}`);
      }
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  return files.sort();
}

function resolveContainedPath(workspace, configuredRoot) {
  if (typeof configuredRoot !== "string" || configuredRoot.trim() === "") {
    throw new Error("Artifact root must be a non-empty relative path");
  }
  const resolved = path.resolve(workspace, configuredRoot);
  const relative = path.relative(workspace, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Artifact root must stay inside the workspace: ${configuredRoot}`);
  }
  return resolved;
}

async function main() {
  try {
    const result = await scanCredentialArtifacts();
    process.stdout.write(
      `[latitude] Credential artifact scan passed (${result.rootsScanned} root(s), ` +
        `${result.filesScanned} file(s)); no credential values were read from .env.local or printed.\n`,
    );
  } catch (error) {
    process.stderr.write(
      `[latitude] Credential artifact scan failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}

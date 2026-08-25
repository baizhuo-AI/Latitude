import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanCredentialArtifacts } from "./scan-credential-artifacts.mjs";

test("artifact scan accepts clean dist and optional build trees", async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(path.join(workspace, "dist", "assets"), { recursive: true });
    await mkdir(path.join(workspace, "build"), { recursive: true });
    await writeFile(path.join(workspace, "dist", "assets", "app.js"), "const status='ready';");
    await writeFile(path.join(workspace, "build", "index.html"), "<title>Latitude</title>");
    await writeFile(path.join(workspace, ".env.local"), `DEEPSEEK_API_KEY=sk-${"z".repeat(32)}\n`);

    const result = await scanCredentialArtifacts({ workspace });
    assert.deepEqual(result, { ok: true, rootsScanned: 2, filesScanned: 2 });
  });
});

test("artifact scan rejects key-shaped bytes without returning the matched value", async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(path.join(workspace, "dist"), { recursive: true });
    const fixture = `sk-${"x".repeat(32)}`;
    await writeFile(path.join(workspace, "dist", "app.js"), `window.fixture=${JSON.stringify(fixture)}`);

    await assert.rejects(
      scanCredentialArtifacts({ workspace }),
      (error) => {
        assert.match(error.message, /dist\/app\.js \(sk-prefixed-credential, 1 match\(es\)\)/u);
        assert.match(error.message, /intentionally redacted/u);
        assert.equal(error.message.includes(fixture), false);
        return true;
      },
    );
  });
});

test("artifact scan requires dist, ignores a missing optional build, and never follows symlinks", async () => {
  await withWorkspace(async (workspace) => {
    await assert.rejects(
      scanCredentialArtifacts({ workspace }),
      /Required artifact root is missing: dist/u,
    );

    await mkdir(path.join(workspace, "dist"), { recursive: true });
    await writeFile(path.join(workspace, "outside.txt"), "clean");
    await symlink(path.join(workspace, "outside.txt"), path.join(workspace, "dist", "linked.txt"));
    await assert.rejects(
      scanCredentialArtifacts({ workspace }),
      /Artifact tree contains a symlink and will not be followed/u,
    );
  });
});

async function withWorkspace(run) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "latitude-artifact-scan-test-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

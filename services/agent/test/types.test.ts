// @vitest-environment node
import { chmod, lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  hardenLocalEnvFile,
  isDeepSeekConfigured,
  loadAgentHostConfig,
} from "../src/config.js";
import {
  MAX_RUN_BUDGETS,
  normalizeRunBudgets,
  normalizeRunRequest,
} from "../src/types.js";

describe("Agent Host request contract", () => {
  it("does not report empty or template credentials as configured", () => {
    expect(isDeepSeekConfigured({})).toBe(false);
    expect(isDeepSeekConfigured({ DEEPSEEK_API_KEY: "" })).toBe(false);
    expect(isDeepSeekConfigured({ DEEPSEEK_API_KEY: "replace-with-local-server-key" }))
      .toBe(false);
    expect(isDeepSeekConfigured({ DEEPSEEK_API_KEY: "sk-test-real-shape" })).toBe(true);
  });

  it("hardens .env.local permissions without reading it and rejects symlinks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "latitude-env-permissions-"));
    try {
      const localEnv = path.join(root, ".env.local");
      await writeFile(localEnv, "DEEPSEEK_API_KEY=do-not-read\n", { mode: 0o644 });
      await chmod(localEnv, 0o644);
      expect(await hardenLocalEnvFile(root)).toBe("hardened");
      const hardened = await lstat(localEnv);
      expect(hardened.mode & 0o777).toBe(0o600);

      // Even chmod(0600) on an already-0600 file changes inode metadata and
      // wakes Vite. A second hardening pass must be watcher-neutral.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await hardenLocalEnvFile(root)).toBe("unchanged");
      const unchanged = await lstat(localEnv);
      expect(unchanged.ctimeMs).toBe(hardened.ctimeMs);

      await rm(localEnv);
      const outside = path.join(root, "outside-secret");
      await writeFile(outside, "not-read\n", { mode: 0o600 });
      await symlink(outside, localEnv);
      await expect(hardenLocalEnvFile(root)).rejects.toThrow(/symlink/);
      expect((await lstat(outside)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes the canonical text shape and accepts legacy message", () => {
    expect(normalizeRunRequest({ sessionId: "demo:1", text: "hello" })).toMatchObject({
      sessionId: "demo:1",
      text: "hello",
    });
    expect(normalizeRunRequest({ sessionId: "demo:2", message: "legacy" }).text)
      .toBe("legacy");
  });

  it("applies explicit bounded step/tool/wall/output budgets", () => {
    expect(normalizeRunBudgets({
      maxSteps: 2,
      maxToolCalls: 3,
      wallClockMs: 4_000,
      maxOutputTokens: 512,
    })).toEqual({
      maxSteps: 2,
      maxToolCalls: 3,
      wallClockMs: 4_000,
      maxOutputTokens: 512,
    });
    expect(() => normalizeRunBudgets({ maxSteps: MAX_RUN_BUDGETS.maxSteps + 1 }))
      .toThrow(/must not exceed/);
  });

  it("rejects unsafe session ids and oversized retry ids", () => {
    expect(() => normalizeRunRequest({ sessionId: "../escape", text: "x" }))
      .toThrow(/sessionId/);
    expect(() => normalizeRunRequest({
      sessionId: "safe",
      text: "x",
      clientRequestId: "x".repeat(201),
    })).toThrow(/clientRequestId/);
  });

  it("isolates default Agent state below the Domain-owned .latitude root", () => {
    const cwd = "/workspace/latitude-product";
    const config = loadAgentHostConfig({}, cwd);
    expect(config.model).toBe("deepseek-v4-flash");
    expect(config.stateDir).toBe(path.join(cwd, ".latitude", "agent"));
    expect(config.stateDir).not.toBe(path.join(cwd, ".latitude"));
    for (const unsafe of [
      cwd,
      path.dirname(cwd),
      path.join(cwd, ".latitude"),
      path.join(cwd, ".latitude", "backups"),
      path.join(cwd, ".latitude", "other-agentish"),
      "/tmp/arbitrary-state",
    ]) {
      expect(() => loadAgentHostConfig({ LATITUDE_STATE_DIR: unsafe }, cwd))
        .toThrow(/LATITUDE_STATE_DIR/);
    }
    expect(loadAgentHostConfig({
      LATITUDE_STATE_DIR: path.join(cwd, ".latitude", "agent", "profile-a"),
    }, cwd).stateDir).toBe(path.join(cwd, ".latitude", "agent", "profile-a"));
    expect(loadAgentHostConfig({
      LATITUDE_STATE_DIR: "/tmp/latitude-agent-test-profile",
    }, cwd).stateDir).toBe("/tmp/latitude-agent-test-profile");
  });

  it("refuses to send Latitude Domain traffic to a non-loopback or credentialed URL", () => {
    for (const unsafe of [
      "https://example.com",
      "http://192.168.1.20:43121",
      "http://user:pass@127.0.0.1:43121",
      "http://127.0.0.1:43121/v1",
    ]) {
      expect(() => loadAgentHostConfig({ LATITUDE_DOMAIN_URL: unsafe }, "/workspace/app"))
        .toThrow(/LATITUDE_DOMAIN_URL/);
    }
    expect(loadAgentHostConfig({
      LATITUDE_DOMAIN_URL: "http://localhost:43121",
    }, "/workspace/app").domainBaseUrl).toBe("http://localhost:43121");
  });

  it("keeps Agent CORS aligned with the configured local Browser port", () => {
    const config = loadAgentHostConfig({ LATITUDE_WEB_PORT: "51234" }, "/workspace/app");
    expect(config.allowedOrigins).toEqual(new Set([
      "http://127.0.0.1:51234",
      "http://localhost:51234",
    ]));
    expect(() => loadAgentHostConfig({ LATITUDE_WEB_PORT: "0" }, "/workspace/app"))
      .toThrow(/LATITUDE_WEB_PORT/);
  });

  it("adds only an exact HTTPS production Browser origin", () => {
    const config = loadAgentHostConfig({
      LATITUDE_WEB_ORIGIN: "https://latitude.baizhuo.online",
    }, "/workspace/app");
    expect(config.allowedOrigins).toContain("https://latitude.baizhuo.online");
    for (const unsafe of [
      "http://latitude.baizhuo.online",
      "https://latitude.baizhuo.online/path",
      "https://user:pass@latitude.baizhuo.online",
    ]) {
      expect(() => loadAgentHostConfig({
        LATITUDE_WEB_ORIGIN: unsafe,
      }, "/workspace/app")).toThrow(/HTTPS (origin|URL)/u);
    }
  });
});

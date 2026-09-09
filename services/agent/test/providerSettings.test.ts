// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLedger } from "../src/persistence/auditLedger.js";
import {
  PROVIDER_SETTINGS_FILE,
  ProviderSelectionStore,
} from "../src/provider/providerSettings.js";
import { DshRuntime } from "../src/runtime/dshRuntime.js";
import { FakeDomain, testConfig } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Agent model provider settings", () => {
  it("persists only the provider/model preference and restores it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "latitude-provider-store-"));
    roots.push(root);
    const allowed = new Set(["deepseek-official", "openai"]);
    const store = new ProviderSelectionStore(root, allowed, {
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
    });

    await store.save({ provider: "openai", model: "gpt-5.4-mini" });

    const raw = await readFile(path.join(root, PROVIDER_SETTINGS_FILE), "utf8");
    expect(JSON.parse(raw)).toMatchObject({
      schemaVersion: 1,
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    expect(raw).not.toMatch(/api.?key|credential|secret/i);

    const restored = new ProviderSelectionStore(root, allowed, {
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
    });
    await restored.init();
    expect(restored.selection).toEqual({ provider: "openai", model: "gpt-5.4-mini" });
  });

  it("keeps the explicit deployment fallback when the saved preference is invalid", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "latitude-provider-invalid-"));
    roots.push(root);
    await writeFile(
      path.join(root, PROVIDER_SETTINGS_FILE),
      JSON.stringify({ schemaVersion: 1, provider: "removed", model: "unknown" }),
      "utf8",
    );
    const store = new ProviderSelectionStore(root, new Set(["deepseek-official"]), {
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
    });

    await store.init();

    expect(store.selection).toEqual({
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
    });
  });

  it("switches the production Agent route without exposing provider keys", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "latitude-provider-runtime-"));
    roots.push(root);
    const config = testConfig(root);
    config.model = "deepseek-v4-flash";
    const previousDeepSeek = process.env.DEEPSEEK_API_KEY;
    const previousOpenAi = process.env.OPENAI_API_KEY;
    process.env.DEEPSEEK_API_KEY = "sk-test-deepseek-provider-setting";
    process.env.OPENAI_API_KEY = "sk-test-openai-provider-setting";
    const runtime = new DshRuntime({
      config,
      ledger: new AuditLedger(root),
      domain: new FakeDomain(),
      installOfficialWebSearch: false,
    });
    try {
      const before = await runtime.getProviderSettings();
      expect(before.active).toEqual({
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
      });
      expect(before.options).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "openai", configured: true }),
        expect.objectContaining({ id: "anthropic", configured: false }),
      ]));

      const after = await runtime.updateProviderSettings({
        provider: "openai",
        model: "gpt-5.4-mini",
      });

      expect(after.active).toEqual({ provider: "openai", model: "gpt-5.4-mini" });
      expect(runtime.provider).toBe("openai");
      expect(runtime.model).toBe("gpt-5.4-mini");
      expect(runtime.providerAuthentication).toBe("unverified");
      const persisted = await readFile(path.join(root, PROVIDER_SETTINGS_FILE), "utf8");
      expect(persisted).not.toContain(process.env.OPENAI_API_KEY);
    } finally {
      await runtime.close();
      if (previousDeepSeek === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previousDeepSeek;
      if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAi;
    }
  });
});

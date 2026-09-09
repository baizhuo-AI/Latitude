import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const PROVIDER_SETTINGS_FILE = "provider-settings.json";

export interface ProviderSelection {
  provider: string;
  model: string;
}

interface PersistedProviderSelection extends ProviderSelection {
  schemaVersion: 1;
  updatedAt: string;
}

/**
 * Credential-free Agent model selection owned by the local Host.
 *
 * API keys remain environment/credential-service concerns. This file is safe
 * to include in the ordinary Agent export and never crosses into localStorage.
 */
export class ProviderSelectionStore {
  private current: ProviderSelection;

  constructor(
    private readonly stateDir: string,
    private readonly allowedProviders: ReadonlySet<string>,
    fallback: ProviderSelection,
  ) {
    this.assertSelection(fallback);
    this.current = structuredClone(fallback);
  }

  get selection(): ProviderSelection {
    return structuredClone(this.current);
  }

  async init(): Promise<void> {
    const file = path.join(this.stateDir, PROVIDER_SETTINGS_FILE);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // A corrupt preference must not prevent the local Agent from starting.
      // Keep the explicit deployment fallback; integrity/export will still
      // surface malformed managed JSON instead of silently rewriting it.
      return;
    }
    if (!isRecord(parsed) || parsed.schemaVersion !== 1) return;
    try {
      const next = {
        provider: parsed.provider,
        model: parsed.model,
      } as ProviderSelection;
      this.assertSelection(next);
      this.current = structuredClone(next);
    } catch {
      // Removed/invalid provider selections fall back to deployment defaults.
    }
  }

  async save(selection: ProviderSelection): Promise<ProviderSelection> {
    this.assertSelection(selection);
    const next = {
      provider: selection.provider.trim(),
      model: selection.model.trim(),
    };
    const document: PersistedProviderSelection = {
      schemaVersion: 1,
      ...next,
      updatedAt: new Date().toISOString(),
    };
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(
      path.join(this.stateDir, PROVIDER_SETTINGS_FILE),
      `${JSON.stringify(document, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    this.current = next;
    return this.selection;
  }

  private assertSelection(selection: ProviderSelection): void {
    if (
      !selection ||
      typeof selection.provider !== "string" ||
      !this.allowedProviders.has(selection.provider.trim())
    ) {
      throw new TypeError("provider is not available in this Agent Host");
    }
    if (
      typeof selection.model !== "string" ||
      !selection.model.trim() ||
      selection.model.trim().length > 200
    ) {
      throw new TypeError("model must be a non-empty string up to 200 characters");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

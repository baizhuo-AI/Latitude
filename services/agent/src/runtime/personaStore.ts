import type { PersonaChange, PersonaState, PersonaVersion } from "../../../../src/shared/agentExperience.js";
import type { AuditLedger } from "../persistence/auditLedger.js";
import { LATITUDE_PERSONA } from "./latitudePolicy.js";

export class PersonaError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** Persona is Host configuration, versioned in the existing exportable audit ledger. */
export class PersonaStore {
  private versions: PersonaVersion[] = [{
    version: 0, persona: LATITUDE_PERSONA, preferences: "", actor: "system",
    reason: "维度默认人设", createdAt: "2026-09-04T00:00:00.000Z",
  }];
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly ledger: AuditLedger) {}

  async init() {
    const records = await this.ledger.readAuditData<PersonaVersion>("persona_changed");
    this.versions = [this.versions[0], ...records];
  }

  get state(): PersonaState {
    return structuredClone({ current: this.versions[this.versions.length - 1], history: this.versions });
  }

  change(request: PersonaChange, source: Pick<PersonaVersion, "actor" | "sessionId" | "runId" | "evidenceRefId">): Promise<PersonaState> {
    const operation = this.tail.then(async () => {
      const current = this.versions[this.versions.length - 1];
      if (request.baseVersion !== current.version) {
        throw new PersonaError(409, "persona_version_conflict", "人设已更新，请重新读取后再保存。");
      }
      if (typeof request.reason !== "string" || !request.reason.trim()) {
        throw new PersonaError(400, "invalid_persona", "请说明这次调整的原因。");
      }
      const restored = request.restoreVersion === undefined ? undefined
        : this.versions.find((version) => version.version === request.restoreVersion);
      if (request.restoreVersion !== undefined && !restored) {
        throw new PersonaError(404, "persona_version_not_found", "找不到要恢复的人设版本。");
      }
      const persona = restored?.persona ?? request.persona ?? current.persona;
      const preferences = restored?.preferences ?? request.preferences ?? current.preferences;
      if (typeof persona !== "string" || !persona.trim() || typeof preferences !== "string") {
        throw new PersonaError(400, "invalid_persona", "人设正文不能为空，补充偏好须为文字。");
      }
      const version: PersonaVersion = {
        version: current.version + 1, persona, preferences, reason: request.reason.trim(),
        ...source, createdAt: new Date().toISOString(),
        ...(restored ? { restoredFrom: restored.version } : {}),
      };
      await this.ledger.appendAudit("persona_changed", { ...version });
      this.versions.push(version);
      return this.state;
    });
    // Serialize compare-and-append; a rejected edit must not poison the next edit.
    this.tail = operation.catch(() => undefined);
    return operation;
  }
}

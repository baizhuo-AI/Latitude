/** Public presentation contracts. Raw prompts and tool arguments stay on the Host. */
export interface PersonaVersion {
  version: number;
  persona: string;
  preferences: string;
  reason: string;
  actor: "user" | "model" | "system";
  createdAt: string;
  sessionId?: string;
  runId?: string;
  evidenceRefId?: string;
  restoredFrom?: number;
}

export interface PersonaState {
  current: PersonaVersion;
  history: PersonaVersion[];
}

export interface PersonaChange {
  baseVersion: number;
  persona?: string;
  preferences?: string;
  restoreVersion?: number;
  reason: string;
}

export interface AgentProgressItem {
  seq: number;
  kind: "reasoning" | "tool" | "status";
  text: string;
  callId?: string;
  state?: "running" | "completed" | "failed";
}

export interface AgentProgressPage {
  runId: string;
  after: number;
  next: number;
  hasMore: boolean;
  phase: "working" | "presenting" | "finished";
  items: AgentProgressItem[];
}

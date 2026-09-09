import type { Secretary } from "../types";
import type { ChatMessageRow, ConversationRow } from "../../lib/db";
import type { AgentProgressItem } from "../../shared/agentExperience";
import type { NoticePreferences, PetNotice } from "../pet-notices";
import type { ComposerSubmission } from "../composer/attachments";

export interface PetState {
  mode: "docked" | "floating";
  dragging: boolean;
  overDock: boolean;
  x: number;
  y: number;
  hidden?: boolean;
}

export interface PetSnapshot {
  secretary: Secretary;
  sessionId: string;
  messages: ChatMessageRow[];
  conversation: ConversationRow;
  loading: boolean;
  progress: AgentProgressItem[];
  progressRunId?: string | null;
  status: string | null;
  error: string | null;
  sendEnabled: boolean;
  notice: PetNotice | null;
  proactivePrompt: string | null;
  proactiveActionEnabled: boolean;
  noticePreferences: NoticePreferences;
}

export type PetAction =
  | { type: "send"; text: string; requestId: string; submission?: ComposerSubmission }
  | { type: "cancel" | "reconnect" | "new-conversation" | "open-main" | "settings" | "handle-prompt" }
  | { type: "open-notice"; notice: PetNotice }
  | { type: "dismiss-notice"; id: string };

export const INITIAL_PET_STATE: PetState = {
  mode: "docked", dragging: false, overDock: false, x: 0, y: 0,
};

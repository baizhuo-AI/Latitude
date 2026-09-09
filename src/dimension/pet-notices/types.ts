export interface PetNotice {
  id: string;
  text: string;
  kind: "discovery" | "completed" | "action" | "reminder";
  createdAt: number;
}

export interface NoticePreferences {
  dismissAfterSeconds: number | null;
  animation: "once" | "loop";
  expressionSeconds: number;
}

export const DEFAULT_NOTICE_PREFERENCES: NoticePreferences = {
  dismissAfterSeconds: 30,
  animation: "once",
  expressionSeconds: 8,
};

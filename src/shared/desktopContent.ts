/** Published business records, not a projection of the Agent's knowledge graph. */
export interface DesktopTodo {
  id: string;
  title: string;
  status: "todo" | "doing" | "done" | "dropped";
  scheduledDate: string | null;
  scheduledTime: string | null;
  updatedAt: string;
  sourceNodeIds: string[];
}
export interface DesktopCalendarEvent {
  id: string;
  title: string;
  scheduledDate: string | null;
  scheduledTime: string | null;
  startTs: number | null;
  endTs: number | null;
  status: string;
}
export interface DesktopDigest {
  date: string;
  summary: string;
  sourceNodeIds: string[];
}
export interface DesktopContent {
  todos: DesktopTodo[];
  events: DesktopCalendarEvent[];
  digests: DesktopDigest[];
  /** Date queried in the user's local timezone; historical digests retain their date. */
  date: string;
}
export interface DesktopTodoUpdate {
  id: string;
  expectedUpdatedAt: string;
  title?: string;
  status?: DesktopTodo["status"];
}

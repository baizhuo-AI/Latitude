import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { JsonValue } from "@deepseek-ai/dsh-session";
import type { DomainToolContext } from "../domain/domainClient.js";
import type { DesktopStore } from "./desktopStore.js";

/** Knowledge is a basis for generation. Publication is a durable business action. */
export function desktopTools(store: DesktopStore, context: () => DomainToolContext | undefined): ToolDefinition[] {
  const output: ToolDefinition["output"] = {
    schema: { type: "object", additionalProperties: true },
    render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
  };
  return [{
    name: "desktop_read",
    description: "Read saved desktop todos, local calendar events and recent daily digests from the business database. Read before publishing/updating; a knowledge node is not a saved sticky note.",
    parameters: { type: "object", properties: { date: { type: "string", description: "Local YYYY-MM-DD; omit for today" } }, additionalProperties: false },
    output,
    execute: async args => {
      const date = (args as { date?: string }).date;
      return store.read(date) as unknown as JsonValue;
    },
  }, {
    name: "desktop_publish",
    description: "Save generated todo, daily digest/report or local calendar content to the existing business database for sticky notes. Generate from relevant knowledge and the user request first. This does not create knowledge or turn every graph action into a todo. Stable publicationKey identifies ONE output across retries; changed content conflicts instead of overwriting. Never invent another key to bypass a conflict. Calendar saves locally, never to external calendars.",
    parameters: { type: "object", properties: {
      kind: { type: "string", enum: ["todo", "digest", "calendar"] },
      publicationKey: { type: "string", description: "Stable semantic key for one output; reuse on retries" },
      sourceNodeIds: { type: "array", items: { type: "string" }, description: "Knowledge IDs actually used; [] for direct instructions without graph basis" },
      title: { type: "string", description: "Required for todo/calendar" },
      summary: { type: "string", description: "Full generated text, required for digest" },
      date: { type: "string", description: "Actual YYYY-MM-DD of the digest" },
      scheduledDate: { type: "string", description: "Local YYYY-MM-DD; required for calendar" },
      scheduledTime: { type: "string", description: "HH:mm, optional" },
      startTs: { type: "integer", description: "Calendar start, Unix seconds" },
      endTs: { type: "integer", description: "Calendar end, Unix seconds" },
    }, required: ["kind", "publicationKey", "sourceNodeIds"], additionalProperties: false },
    output,
    execute: async (args, exec) => {
      const active = context();
      if (!active) throw new Error("No active publication attribution context");
      exec.signal?.throwIfAborted();
      return store.publish(args, { sessionId: active.sessionId, runId: active.runId, toolCallId: String(exec.callId) });
    },
  }, {
    name: "desktop_todo_update",
    description: "Rename or change the status of a saved business todo as requested. Read its updatedAt first; stale writes fail. Completing a todo does not invent a cognitive action outcome.",
    parameters: { type: "object", properties: {
      id: { type: "string" }, expectedUpdatedAt: { type: "string" }, title: { type: "string" },
      status: { type: "string", enum: ["todo", "doing", "done", "dropped"] },
    }, required: ["id", "expectedUpdatedAt"], additionalProperties: false },
    output,
    execute: async (args, exec) => {
      if (!context()) throw new Error("No active todo attribution context");
      exec.signal?.throwIfAborted();
      return store.updateTodo(args);
    },
  }];
}

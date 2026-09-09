import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { AgentProgressItem, AgentProgressPage } from "../../../../src/shared/agentExperience.js";
import { redactCredentialText } from "../security/credentialRedaction.js";

const TOOL_LABELS: Record<string, string> = {
  knowledge_context: "查阅已有知识", evidence_search: "查找原始记录", evidence_read: "阅读原始证据",
  local_file_read: "阅读本地资料", local_file_list: "查找本地文件", session_archive_read: "查阅历史对话",
  session_archive_list: "查找历史对话", compile_context: "梳理相关依据", locate_event: "关联已有记录",
  candidate_propose: "整理待确认的判断", candidate_command: "处理你的反馈", apply_feedback: "修正已有认识",
  knowledge_remember: "记录新的认识", knowledge_update: "更新已有认识", knowledge_retract: "撤回已有认识",
  action_create: "安排下一步行动", outcome_record: "记录实际结果", revision_queue_resolve: "复核已有判断",
  weekly_review_create: "整理回顾", ui_customize: "调整桌面", web_search: "搜索相关资料", web_fetch: "阅读网页",
  daily_web_curate: "整理今日阅读", persona_read: "查看当前人设", persona_update: "调整相处方式",
};

/** Project actual DSH events. Never generate a synthetic reasoning narrative. */
export function projectRunProgress(
  runId: string, events: readonly SessionEvent[], after: number, phase: AgentProgressPage["phase"],
): AgentProgressPage {
  const calls = new Map<string, string>();
  const items: AgentProgressItem[] = [];
  // This page size is transport pagination, not a limit on the task or readable history.
  const page = events.filter((event) => event.seq > after).slice(0, 500);
  const end = page.at(-1)?.seq ?? after;
  for (const event of events) {
    if (event.seq > end) break;
    if (event.type === "tool/call") calls.set(String(event.data.callId), TOOL_LABELS[event.data.name] ?? "调用工具");
    if (event.seq <= after) continue;
    if (event.type === "assistant/chunk" && event.data.chunk.type === "reasoning-delta") {
      items.push({ seq: event.seq, kind: "reasoning", text: redactCredentialText(event.data.chunk.text) });
    } else if (event.type === "tool/call") {
      items.push({ seq: event.seq, kind: "tool", callId: String(event.data.callId), text: calls.get(String(event.data.callId))!, state: "running" });
    } else if (event.type === "tool/result") {
      const result = event.data.message.content.find((block) => block.type === "tool-result")!;
      const callId = String(result.toolCallId);
      items.push({ seq: event.seq, kind: "tool", callId,
        text: calls.get(callId) ?? "调用工具", state: result.isError ? "failed" : "completed" });
    } else if (event.type === "llm/retry") {
      items.push({ seq: event.seq, kind: "status", text: "模型请求遇到问题，正在重试" });
    } else if (event.type.includes("compaction") && !event.type.includes("chunk")) {
      items.push({ seq: event.seq, kind: "status", text: "正在整理较长的上下文" });
    }
  }
  return { runId, after, next: end, hasMore: events.some((event) => event.seq > end), phase, items };
}

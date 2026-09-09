// Opt-in live-provider smoke test. Uses an isolated session and synthetic data;
// no test messages or model-created knowledge are written into the user's graph.
// Run: node --env-file-if-exists=.env.local --import tsx scripts/accept-dsh-unrestricted.mjs
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadAgentHostConfig } from "../services/agent/src/config.ts";
import { DomainClient } from "../services/agent/src/domain/domainClient.ts";
import { AuditLedger } from "../services/agent/src/persistence/auditLedger.ts";
import { DshRuntime } from "../services/agent/src/runtime/dshRuntime.ts";

const root = await mkdtemp(path.join(tmpdir(), "latitude-agent-test-native-"));
// Keep the ordinary read fixture outside the protected session archive.
const stateDir = path.join(root, "agent");
const file = path.join(root, "full-source.txt");
const marker = "全文读取成功-739251";
await writeFile(file, `${"这是合成的回归测试资料，不是关于用户的事实。\n".repeat(900)}末尾标记：${marker}\n`);
const config = loadAgentHostConfig({ ...process.env, LATITUDE_STATE_DIR: stateDir });
class ReadOnlyAcceptanceDomain extends DomainClient {
  createToolDefinitions(context) {
    return super.createToolDefinitions(context).filter((tool) => tool.isConcurrencySafe?.({}) === true);
  }
}
const runtime = new DshRuntime({ config, ledger: new AuditLedger(stateDir), domain: new ReadOnlyAcceptanceDomain(config.domainBaseUrl, config.domainTimeoutMs), presentResponses: true });
const started = Date.now();
try {
  const result = await runtime.runTurn({
    runId: "live-native-read", sessionId: "latitude:acceptance:native-read",
    initiator: "scheduler", budgets: {},
    text: `这是只读程序验收，不是用户事实或偏好。请调用 local_file_read 读取 ${file}，不要根据文件名猜测。只报告文件真正的末尾标记，并说明原文是否读完；不要调用写入工具，不要记录任何长期知识。`,
  }, new AbortController().signal);
  const headers = result.events.filter((event) => event.type === "request/header").map((event) => event.data.header.config);
  const tools = result.events.filter((event) => event.type === "tool/call").map((event) => event.data.name);
  assert.equal(result.status, "completed");
  assert.ok(result.assistantText.includes(marker), "The live answer must identify the actual file tail");
  assert.ok(tools.includes("local_file_read"), "The model must use the real full-text read tool");
  assert.ok(headers.every((header) => header.reasoningEffort !== "off"), "No wrapper-forced reasoning off");
  console.log(JSON.stringify({ status: result.status, elapsedMs: Date.now() - started, steps: result.stepsUsed, tools, headers, answer: result.assistantText, explanation: result.explanation, isolated: true, knowledgeWrites: 0 }, null, 2));
} finally {
  await runtime.close();
  await rm(root, { recursive: true, force: true });
}

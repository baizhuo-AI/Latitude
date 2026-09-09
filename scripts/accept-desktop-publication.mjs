// Explicit opt-in acceptance: real configured model, fictional knowledge,
// temporary Agent state and business database. Never touches user records.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadAgentHostConfig } from "../services/agent/src/config.ts";
import { DshRuntime } from "../services/agent/src/runtime/dshRuntime.ts";
import { AuditLedger } from "../services/agent/src/persistence/auditLedger.ts";
import { DesktopStore, localDateKey } from "../services/agent/src/desktop/desktopStore.ts";
import { FakeDomain } from "../services/agent/test/helpers.ts";

const root = await mkdtemp(path.join(tmpdir(), "latitude-publication-accept-"));
const desktop = new DesktopStore(path.join(root, "latitude.db"));
const domain = new FakeDomain();
const knowledge = { nodes: [{ id: "fixture-goal", kind: "goal", label: "虚构验收：写一份园艺笔记", statement: "这是完全虚构的测试记录。下一步是列出三种耐阴植物，整理成一段笔记。" }], edges: [] };
domain.getPersonalContext = async () => knowledge;
domain.createToolDefinitions = () => [{
  name: "knowledge_context", description: "Read the isolated fictional test knowledge",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  output: { schema: { type: "object", additionalProperties: true }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
  execute: async () => knowledge,
}];
const runtime = new DshRuntime({ config: { ...loadAgentHostConfig(), stateDir: path.join(root, "agent") },
  ledger: new AuditLedger(path.join(root, "agent")), domain, desktop, installOfficialWebSearch: false });
try {
  const date = localDateKey();
  const result = await runtime.runTurn({ runId: "publication-accept", sessionId: "publication-accept", initiator: "user",
    text: `这是一场隔离验收。只使用 knowledge_context 中的虚构目标，不读取本机文件，也不联网搜索。请依据它生成一条下一步待办和一段今天(${date})的每日整理，并保存到桌面业务库。两个成品的 publicationKey 分别固定为 accept:todo 和 accept:digest，sourceNodeIds 使用实际依据。不需要询问，完成后简短说明。`,
    budgets: { maxSteps: 8, maxToolCalls: 8 },
  }, AbortSignal.timeout(90_000));
  desktop.close();
  const content = desktop.read(date);
  const ok = result.status === "completed" && content.todos.length === 1 && content.digests.length === 1
    && content.todos[0].sourceNodeIds.includes("fixture-goal") && content.digests[0].sourceNodeIds.includes("fixture-goal");
  console.log(JSON.stringify({ ok, runStatus: result.status, todoCount: content.todos.length, digestCount: content.digests.length, sourceLinked: ok, reopened: true }));
  if (!ok) process.exitCode = 1;
} finally {
  await runtime.close(); desktop.close();
  await rm(root, { recursive: true, force: true });
}

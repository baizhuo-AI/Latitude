// Opt-in real-provider/UI acceptance. Agent state and message evidence are
// isolated; no synthetic fact is written to the user's Domain database.
// node --env-file-if-exists=.env.local --import tsx scripts/accept-dsh-experience.mjs [--serve]
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadAgentHostConfig } from "../services/agent/src/config.ts";
import { AuditLedger } from "../services/agent/src/persistence/auditLedger.ts";
import { DshRuntime } from "../services/agent/src/runtime/dshRuntime.ts";
import { RunJobStore } from "../services/agent/src/jobs/jobStore.ts";
import { AgentHttpServer } from "../services/agent/src/http/server.ts";
import { AgentAdminService } from "../services/agent/src/admin/adminService.ts";
import { DurableScheduler } from "../services/agent/src/scheduler/durableScheduler.ts";
import { FakeDomain } from "../services/agent/test/helpers.ts";

const serve = process.argv.includes("--serve");
const root = await mkdtemp(path.join(tmpdir(), "latitude-agent-experience-"));
const config = loadAgentHostConfig({ ...process.env, LATITUDE_STATE_DIR: root, LATITUDE_AGENT_PORT: "43122", LATITUDE_WEB_PORT: "1430" });
const ledger = new AuditLedger(root);
const domain = new FakeDomain();
const runtime = new DshRuntime({ config, ledger, domain, presentResponses: true });
const jobs = new RunJobStore(runtime, ledger);
const scheduler = new DurableScheduler(domain, jobs, ledger, config.schedulerPollMs);
const admin = new AgentAdminService({ stateDir: root, ledger });
const server = new AgentHttpServer({ config, runtime, jobs, domain, scheduler, admin });
const { url } = await server.start();
console.log(JSON.stringify({ url, stateDir: root, isolated: true, provider: runtime.provider, model: runtime.model }));
async function close() { await server.close(); await scheduler.close(); await runtime.close(); }

if (serve) {
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());
} else {
  try {
    const response = await fetch(`${url}/v1/agent/turns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "experience-acceptance", text: "这是隔离验收。请把你的长期相处偏好补充为：先说结论，再讲必要的依据，保持温和直接。请真的保存，之后告诉我。" }) });
    const accepted = await response.json();
    assert.equal(response.status, 202);
    let after = -1;
    let liveReasoning = false;
    let liveTools = 0;
    let finished;
    while (true) {
      const run = await (await fetch(`${url}/v1/agent/runs/${accepted.runId}`)).json();
      const page = await (await fetch(`${url}/v1/agent/runs/${accepted.runId}/events?after=${after}`)).json();
      after = page.next;
      liveReasoning ||= ["queued", "running"].includes(run.status) && page.items.some((item) => item.kind === "reasoning");
      liveTools += page.items.filter((item) => item.kind === "tool" && item.state === "running").length;
      if (!["queued", "running"].includes(run.status)) { finished = run; break; }
      await delay(250);
    }
    assert.equal(finished.status, "completed");
    assert.equal(liveReasoning, true, "real provider reasoning must be available before completion");
    assert.ok(runtime.persona.state.current.version > 0, "the real model must persist the requested preference");
    assert.ok(liveTools > 0);
    assert.ok(finished.result.assistantText.length > 0);
    const { version } = runtime.persona.state.current;
    await runtime.persona.change({ baseVersion: version, restoreVersion: 0, reason: "隔离验收恢复默认" }, { actor: "user" });
    console.log(JSON.stringify({ passed: true, liveReasoning, liveTools, savedVersion: version, restoredVersion: runtime.persona.state.current.version, answer: finished.result.assistantText, presentation: finished.result.presentation, stateDir: root, userKnowledgeWrites: 0 }, null, 2));
  } finally { await close(); }
}

// Offline browser acceptance: real DSH/HTTP/session loop, synthetic model
// stream, isolated message evidence/persona state, no external model request.
// node --import tsx scripts/serve-dsh-experience-fixture.mjs
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CallId, LlmAdapter } from "@deepseek-ai/dsh-llm";
import { AuditLedger } from "../services/agent/src/persistence/auditLedger.ts";
import { DshRuntime } from "../services/agent/src/runtime/dshRuntime.ts";
import { RunJobStore } from "../services/agent/src/jobs/jobStore.ts";
import { AgentHttpServer } from "../services/agent/src/http/server.ts";
import { AgentAdminService } from "../services/agent/src/admin/adminService.ts";
import { DurableScheduler } from "../services/agent/src/scheduler/durableScheduler.ts";
import { FakeDomain, testConfig } from "../services/agent/test/helpers.ts";

class FixtureAdapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: "离线界面验收" }; }
  async *stream(options) {
    const presenting = options.system.includes("表达整理器");
    if (presenting) {
      await delay(1500, undefined, { signal: options.signal });
      yield { type: "block-start", index: 0, blockType: "text" };
      const text = JSON.stringify({ answer: "这是离线界面验收：本轮处理已结束，没有修改你的个人知识。", why: "使用合成模型事件检查界面，不代表真实模型的回答质量。", uncertainty: "" });
      yield { type: "text-delta", index: 0, text };
      yield { type: "block-end", index: 0, block: { type: "text", text } };
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    const userIndex = options.messages.findLastIndex((message) => message.role === "user" && message.source?.kind === "user");
    const lastUser = options.messages[userIndex];
    const afterTool = options.messages.slice(userIndex + 1).some((message) => message.source?.kind === "tool");
    if (!afterTool) {
      yield { type: "block-start", index: 0, blockType: "reasoning" };
      const part = "合成过程：核对界面的实时显示、滚动位置和重新连接。\n";
      let text = "";
      for (let index = 0; index < 35; index += 1) {
        text += part;
        yield { type: "reasoning-delta", index: 0, text: part };
        await delay(500, undefined, { signal: options.signal });
      }
      yield { type: "block-end", index: 0, block: { type: "reasoning", text } };
      const callId = CallId(`fixture-${lastUser?.id ?? "read"}`);
      yield { type: "block-start", index: 1, blockType: "tool-call" };
      yield { type: "tool-call-delta", index: 1, id: callId, name: "persona_read", argumentsDelta: "{}" };
      yield { type: "block-end", index: 1, block: { type: "tool-call", id: callId, name: "persona_read", arguments: "{}" } };
      yield { type: "finish", reason: { kind: "tool-calls" } };
    } else {
      yield { type: "block-start", index: 0, blockType: "text" };
      const text = "离线界面验收结束，没有修改个人知识。";
      yield { type: "text-delta", index: 0, text };
      yield { type: "block-end", index: 0, block: { type: "text", text } };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  }
}

const root = await mkdtemp(path.join(tmpdir(), "latitude-agent-ui-fixture-"));
const config = { ...testConfig(root), port: 43122, allowedOrigins: new Set(["http://127.0.0.1:1430"]) };
const ledger = new AuditLedger(root);
const domain = new FakeDomain();
const adapter = { provider: "fake", install(ctx) { ctx.llm.registerAdapter(["fake"], new FixtureAdapter()); } };
// Fake provider's configured health uses this sentinel, never a real secret.
process.env.DEEPSEEK_API_KEY = "offline-fixture-not-a-credential";
const runtime = new DshRuntime({ config, ledger, domain, adapter, presentResponses: true, installOfficialWebSearch: false });
const jobs = new RunJobStore(runtime, ledger);
const scheduler = new DurableScheduler(domain, jobs, ledger, config.schedulerPollMs);
const admin = new AgentAdminService({ stateDir: root, ledger });
const server = new AgentHttpServer({ config, runtime, jobs, domain, scheduler, admin });
console.log(JSON.stringify({ ...(await server.start()), root, syntheticModel: true, externalRequests: false }));
async function close() { await server.close(); await scheduler.close(); await runtime.close(); }
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());

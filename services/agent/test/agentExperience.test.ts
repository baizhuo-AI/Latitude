// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LlmAdapter, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { createToolResultMessage, CallId } from "@deepseek-ai/dsh-llm";
import { AuditLedger } from "../src/persistence/auditLedger.js";
import { PersonaStore } from "../src/runtime/personaStore.js";
import { DshRuntime } from "../src/runtime/dshRuntime.js";
import { projectRunProgress } from "../src/runtime/runProgress.js";
import { publicExecutionSteps } from "../src/runtime/responsePresenter.js";
import { FakeDomain, testConfig, textAdapter, toolThenTextAdapter } from "./helpers.js";

const roots: string[] = [];
const runtimes: DshRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup(adapter = textAdapter("已完成")) {
  const root = await mkdtemp(path.join(tmpdir(), "latitude-experience-")); roots.push(root);
  const ledger = new AuditLedger(root);
  const runtime = new DshRuntime({ config: testConfig(root), ledger, domain: new FakeDomain(), adapter, installOfficialWebSearch: false });
  runtimes.push(runtime); await runtime.boot();
  return { root, ledger, runtime, adapter };
}

describe("DSH persona and live experience", () => {
  it("paginates long native traces without dropping or duplicating reasoning", () => {
    const session = Session.create(SessionId("long-progress"));
    for (let index = 0; index < 1100; index += 1) {
      session.append("assistant/chunk", { turn: 0, step: 0, chunk: { type: "reasoning-delta", index: 0, text: `${index},` } });
    }
    let after = -1;
    let combined = "";
    let page;
    do {
      page = projectRunProgress("long-run", session.events, after, "finished");
      expect(page.next).toBeGreaterThan(after);
      combined += page.items.map((item) => item.text).join("");
      after = page.next;
    } while (page.hasMore);
    expect(combined).toBe(Array.from({ length: 1100 }, (_, index) => `${index},`).join(""));
  });

  it("versions persona, rejects stale edits, restores defaults and survives restart using the audit ledger", async () => {
    const { ledger, runtime } = await setup();
    expect(runtime.persona.state.current.persona).toContain("INFJ");
    await runtime.persona.change({ baseVersion: 0, preferences: "称呼我小林；工作时先说结果。", reason: "用户补充" }, { actor: "user" });
    await expect(runtime.persona.change({ baseVersion: 0, preferences: "覆盖", reason: "过时编辑" }, { actor: "user" })).rejects.toMatchObject({ code: "persona_version_conflict" });
    await runtime.persona.change({ baseVersion: 1, restoreVersion: 0, reason: "恢复默认" }, { actor: "user" });
    const restored = new PersonaStore(ledger); await restored.init();
    expect(restored.state.current).toMatchObject({ version: 2, preferences: "", restoredFrom: 0 });
    expect(restored.state.history[1].preferences).toContain("小林");
    await restored.change({ baseVersion: 2, restoreVersion: 1, reason: "恢复补充" }, { actor: "user" });
    expect(restored.state.current.preferences).toContain("小林");
  });

  it("injects persona variables safely, keeps dynamic context separate, and updates an existing DSH session", async () => {
    const { runtime, adapter } = await setup();
    const run = (id: string) => runtime.runTurn({ runId: id, sessionId: "same", text: "你好", budgets: {} }, new AbortController().signal);
    await run("first");
    await runtime.persona.change({ baseVersion: 0, preferences: "请叫我 {{小林}}；少说套话。", reason: "用户要求" }, { actor: "user" });
    await run("second");
    expect(adapter.requests[1].system).toContain("{{小林}}");
    expect(adapter.requests[1].system).toContain("INFJ");
    expect(adapter.requests[1].system).not.toContain("Current time is");
    expect(JSON.stringify(adapter.requests[1].messages)).toContain("Current time is");
    expect(JSON.stringify(adapter.requests[1].messages)).toContain("personalContext");
    expect((await runtime.readSessionMessages("same", 100)).filter((message) => message.role === "user")).toHaveLength(2);
  });

  it("lets the real DSH loop save persona preferences with the current feedback source", async () => {
    const adapter = toolThenTextAdapter("persona_update", { baseVersion: 0, preferences: "先给结论，再给依据", reason: "用户明确补充工作偏好" }, "以后先给结论。");
    const { runtime, ledger } = await setup(adapter as ReturnType<typeof textAdapter>);
    const result = await runtime.runTurn({ runId: "persona-tool", sessionId: "persona-session", text: "以后先给结论，再给依据，记住这个偏好。", budgets: {} }, new AbortController().signal);
    expect(runtime.persona.state.current).toMatchObject({ version: 1, actor: "model", preferences: "先给结论，再给依据", runId: "persona-tool" });
    expect(runtime.persona.state.current.evidenceRefId).toBeTruthy();
    expect((await ledger.readAuditData("persona_changed"))).toHaveLength(1);
    expect(publicExecutionSteps(result.events, true)).toContain("更新了人设或相处偏好，并保留了可恢复的版本");
    expect(publicExecutionSteps(result.events, true)).not.toContain("这轮只回答了问题，没有改动你的长期记录");
  });

  it("projects native reasoning and actual tool failures without exposing arguments or duplicating completed blocks", () => {
    const session = Session.create(SessionId("progress"));
    session.append("assistant/chunk", { turn: 0, step: 0, chunk: { type: "reasoning-delta", index: 0, text: "先核对记录。" } });
    const call = session.append("tool/call", { turn: 0, step: 0, callId: CallId("read-1"), name: "evidence_read", arguments: '{"secret":"hidden"}' });
    session.append("tool/result", { turn: 0, step: 0, message: createToolResultMessage({ callId: CallId("read-1"), isError: true, content: [{ type: "text", text: "raw private error" }] }) }, { surfaceOp: "append", sourceEventSeqs: [call.seq] });
    const page = projectRunProgress("run", session.events, -1, "working");
    expect(page.items.map((item) => item.text)).toEqual(["先核对记录。", "阅读原始证据", "阅读原始证据"]);
    expect(page.items[2]).toMatchObject({ callId: "read-1", state: "failed" });
    expect(JSON.stringify(page)).not.toMatch(/hidden|private error/);
    expect(projectRunProgress("run", session.events, page.next, "finished").items).toEqual([]);
  });

  it("makes real DSH reasoning events readable before whenIdle and preserves them after completion", async () => {
    let release!: () => void; let began!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { began = resolve; });
    class Streaming extends LlmAdapter {
      async resolveModel(provider: string, model: string) { return { provider, id: model, name: model }; }
      async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        yield { type: "block-start", index: 0, blockType: "reasoning" };
        yield { type: "reasoning-delta", index: 0, text: "正在核对合成记录。" };
        began(); await gate;
        yield { type: "block-end", index: 0, block: { type: "reasoning", text: "正在核对合成记录。" } };
        yield { type: "block-start", index: 1, blockType: "text" };
        yield { type: "text-delta", index: 1, text: "核对完成。" };
        yield { type: "block-end", index: 1, block: { type: "text", text: "核对完成。" } };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
    const adapter = { ...textAdapter("unused"), install: (ctx: Parameters<ReturnType<typeof textAdapter>["install"]>[0]) => { ctx.llm.registerAdapter(["fake"], new Streaming()); } };
    const { runtime } = await setup(adapter);
    const pending = runtime.runTurn({ runId: "stream-run", sessionId: "stream-session", text: "合成验收", budgets: {} }, new AbortController().signal);
    await started;
    const during = await runtime.readRunProgress("stream-session", "stream-run", -1);
    expect(during.phase).toBe("working"); expect(during.items[0]?.text).toBe("正在核对合成记录。");
    release(); await pending;
    const final = await runtime.readRunProgress("stream-session", "stream-run", -1);
    expect(final.phase).toBe("finished"); expect(final.items).toEqual(during.items);
  });
});

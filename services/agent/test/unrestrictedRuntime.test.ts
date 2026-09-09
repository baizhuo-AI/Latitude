// @vitest-environment node
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { CallId, LlmAdapter, LlmError, ReasoningEffortId, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { assertSupportedJsonSchema, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLedger } from "../src/persistence/auditLedger.js";
import { DshRuntime } from "../src/runtime/dshRuntime.js";
import { scheduleExplicitDeadline } from "../src/runtime/explicitDeadline.js";
import { localReadTools } from "../src/runtime/localReadTools.js";
import { DomainClient } from "../src/domain/domainClient.js";
import { FakeDomain, testConfig, toolSequenceThenTextAdapter } from "./helpers.js";

const roots: string[] = [];
const runtimes: DshRuntime[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup(adapter: LlmAdapter, options: { domain?: FakeDomain; presentResponses?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "latitude-unrestricted-"));
  roots.push(root);
  const ledger = new AuditLedger(root);
  const runtime = new DshRuntime({ config: testConfig(root), ledger, domain: options.domain ?? new FakeDomain(),
    adapter: { provider: "fake", install: (ctx) => { ctx.llm.registerAdapter(["fake"], adapter); } },
    installOfficialWebSearch: false, presentResponses: options.presentResponses });
  runtimes.push(runtime);
  return { runtime, ledger, root };
}
async function* answer(text: string): AsyncIterable<StreamChunk> {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text };
  yield { type: "block-end", index: 0, block: { type: "text", text } };
  yield { type: "finish", reason: { kind: "stop" } };
}
const request = (runId: string) => ({ runId, sessionId: "regression", text: "只读检查", budgets: {} });

describe("removed wrapper restrictions", () => {
  it("creates no implicit 90-second timer and honors explicit long deadlines and cancellation", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const clear = scheduleExplicitDeadline(undefined, onExpire);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(900_000);
    expect(onExpire).not.toHaveBeenCalled();
    clear();
    const stop = scheduleExplicitDeadline(400_000, onExpire);
    vi.advanceTimersByTime(399_999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledOnce();
    stop();
    const cancel = scheduleExplicitDeadline(2_147_483_648, onExpire);
    cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps full local text, supports Unicode continuation and exposes only supported read-only tool schemas", async () => {
    class Adapter extends LlmAdapter { async *stream() { yield* answer("unused"); } }
    const { ledger, root } = await setup(new Adapter());
    await ledger.init();
    const source = "原始内容😀".repeat(4_000) + "TAIL_MARKER";
    // Ordinary user documents live outside the managed session/history store.
    // Placing this fixture beneath ledger.root would test a prohibited raw read.
    const documents = await mkdtemp(path.join(tmpdir(), "latitude-local-document-"));
    roots.push(documents);
    const file = path.join(documents, "source.jsonl");
    await writeFile(file, source);
    const definitions = localReadTools(ledger, "regression");
    for (const tool of definitions) expect(() => assertSupportedJsonSchema(tool.parameters)).not.toThrow();
    const read = definitions.find((tool) => tool.name === "local_file_read")!;
    const context = { callId: CallId("read"), signal: new AbortController().signal } as ToolRunContext;
    const managed = path.join(root, "protected-session.jsonl");
    const alias = path.join(documents, "managed-alias.jsonl");
    await writeFile(managed, source);
    await symlink(managed, alias);
    for (const protectedPath of [managed, alias]) {
      await expect(read.execute({ path: protectedPath }, context)).rejects.toThrow("记录与会话存储请通过 history 或 session_archive 工具读取");
    }
    expect(await read.execute({ path: file }, context)).toMatchObject({ content: source, nextOffset: null });
    const offset = Array.from(source).length - 11;
    expect(await read.execute({ path: file, offset, length: 4 }, context)).toMatchObject({ content: "TAIL", nextOffset: offset + 4 });
    expect(await read.execute({ path: file, offset: offset + 4 }, context)).toMatchObject({ content: "_MARKER", nextOffset: null });
    const domainTools = new DomainClient("http://127.0.0.1:43121", 1000).createToolDefinitions(() => undefined);
    for (const name of ["knowledge_context", "evidence_search", "evidence_read", "compile_context"]) {
      expect(domainTools.find((tool) => tool.name === name)?.isConcurrencySafe?.({})).toBe(true);
    }
    expect(domainTools.find((tool) => tool.name === "knowledge_remember")?.isConcurrencySafe?.({})).toBe(false);
  });

  it("continues beyond the former step/tool defaults and preserves a long answer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "latitude-many-steps-"));
    roots.push(root);
    const ledger = new AuditLedger(root);
    const adapter = toolSequenceThenTextAdapter(Array.from({ length: 16 }, () => ({ name: "session_archive_list", args: {} })), "完整答案".repeat(4_000) + "TAIL_MARKER");
    const runtime = new DshRuntime({ config: testConfig(root), ledger, domain: new FakeDomain(), adapter, installOfficialWebSearch: false });
    runtimes.push(runtime);
    const result = await runtime.runTurn(request("many-steps"), new AbortController().signal);
    expect(result).toMatchObject({ status: "completed", stepsUsed: 17, toolCallsUsed: 16 });
    expect(result.assistantText).toHaveLength(16_011);
    expect(result.assistantText).toContain("TAIL_MARKER");
  });

  it("recovers a transient transport failure through native DSH request retry", async () => {
    let calls = 0;
    class Adapter extends LlmAdapter {
      async *stream() {
        if (++calls === 1) throw new LlmError("synthetic transient transport", "TRANSPORT");
        yield* answer("Recovered answer");
      }
    }
    const { runtime } = await setup(new Adapter());
    const result = await runtime.runTurn(request("retry"), new AbortController().signal);
    expect(calls).toBe(2);
    expect(result).toMatchObject({ status: "completed", assistantText: "Recovered answer" });
    expect(result.events.some((event) => event.type === "llm/retry")).toBe(true);
  });

  it("clears legacy persisted off/8192 overrides and re-resolves provider defaults", async () => {
    const calls: GenerateOptions[] = [];
    class Adapter extends LlmAdapter {
      async resolveModel(provider: string, model: string) {
        return { provider, id: model, name: model, defaultMaxTokens: 100_000,
          reasoning: { defaultEffort: ReasoningEffortId("high"), efforts: [{ id: ReasoningEffortId("high"), name: "High" }, { id: ReasoningEffortId("off"), name: "Off" }] } };
      }
      async *stream(options: GenerateOptions) { calls.push(options); yield* answer("Resumed normally"); }
    }
    const { runtime, ledger } = await setup(new Adapter());
    await ledger.init();
    const old = Session.create(SessionId("regression"));
    old.append("request/header", { header: { config: { provider: "fake", model: "fake-model", reasoningEffort: ReasoningEffortId("off"), maxTokens: 8192 } }, reason: "initial" });
    await ledger.appendSessionEvent("regression", "legacy", old.events[0]!);
    await runtime.runTurn(request("resumed"), new AbortController().signal);
    expect(calls[0]).toMatchObject({ reasoningEffort: "high", maxTokens: 100_000 });
  });

  it("reads webpage text through the enabled native HTTP fetch provider", async () => {
    const server = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end("<html><body><h1>REALFETCHBODYMARKER</h1></body></html>"); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No local fixture address");
    let calls = 0;
    class Adapter extends LlmAdapter {
      async *stream() {
        if (++calls === 1) {
          yield { type: "block-start", index: 0, blockType: "tool-call" } as const;
          yield { type: "block-end", index: 0, block: { type: "tool-call", id: CallId("fetch-body"), name: "web_fetch", arguments: JSON.stringify({ url: `http://127.0.0.1:${(address as { port: number }).port}/` }) } } as const;
          yield { type: "finish", reason: { kind: "tool-calls" } } as const;
        } else yield* answer("Read the webpage body");
      }
    }
    try {
      const { runtime } = await setup(new Adapter());
      const result = await runtime.runTurn(request("fetch"), new AbortController().signal);
      expect(result.status).toBe("completed");
      expect(JSON.stringify(result.events.filter((event) => event.type === "tool/result"))).toContain("REALFETCHBODYMARKER");
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("compacts under native context pressure while keeping original messages readable", async () => {
    let normal = 0, summaries = 0;
    const original = "原始材料应完整保留用于核对。".repeat(3_000) + "ARCHIVE_TAIL";
    class Adapter extends LlmAdapter {
      async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 12_000 } }; }
      async *stream(options: GenerateOptions) {
        if (options.purpose === "compaction") { summaries++; yield* answer("Previous material discussed preserving complete source evidence."); }
        else { yield* answer(++normal === 1 ? "最近的说明。".repeat(1_500) : "Continued from evidence"); }
      }
    }
    const { runtime, ledger } = await setup(new Adapter());
    await runtime.runTurn({ ...request("pressure-first"), text: original }, new AbortController().signal);
    const result = await runtime.runTurn(request("pressure-second"), new AbortController().signal);
    expect(result.status).toBe("completed");
    expect(summaries).toBeGreaterThan(0);
    const compactions = (await ledger.loadSessionEvents("regression")).filter((event) => event.type.startsWith("compaction/"));
    expect(compactions.map((event) => event.type), JSON.stringify(compactions)).toContain("compaction/summary");
    expect(JSON.stringify(await ledger.readSessionArchive("regression"))).toContain(original);
  });

  it.each(["user", "deadline"] as const)("reports %s cancellation during presentation instead of completed", async (mode) => {
    let announce!: () => void;
    const presenting = new Promise<void>((resolve) => { announce = resolve; });
    let calls = 0;
    class Adapter extends LlmAdapter {
      async *stream(options: GenerateOptions) {
        if (++calls === 1) { yield* answer("Main answer"); return; }
        announce();
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve();
          else options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        options.signal?.throwIfAborted();
      }
    }
    const { runtime } = await setup(new Adapter(), { presentResponses: true });
    const controller = new AbortController();
    const pending = runtime.runTurn({ ...request("cancel-presenter"), budgets: mode === "deadline" ? { wallClockMs: 100 } : {} }, controller.signal);
    await presenting;
    if (mode === "user") controller.abort();
    const result = await pending;
    expect(result.status).toBe(mode === "user" ? "cancelled" : "budget_exhausted");
    expect(result.budgetStopReason).toBe(mode === "user" ? undefined : "wall_clock");
  });
});

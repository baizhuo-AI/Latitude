// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { WebSearchProvider } from "@deepseek-ai/dsh-web";
import { afterEach, describe, expect, it } from "vitest";
import { AgentAdminService } from "../src/admin/adminService.js";
import { AgentHttpServer } from "../src/http/server.js";
import { RunJobStore } from "../src/jobs/jobStore.js";
import { AuditLedger } from "../src/persistence/auditLedger.js";
import { DshRuntime } from "../src/runtime/dshRuntime.js";
import { DurableScheduler } from "../src/scheduler/durableScheduler.js";
import type {
  DomainAudit,
  MessageEvidenceReceipt,
  UserMessageEvidenceInput,
} from "../src/domain/domainClient.js";
import {
  FakeDomain,
  failingAdapter,
  testConfig,
  textAdapter,
  toolThenTextAdapter,
} from "./helpers.js";

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).reverse().map((close) => close()));
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("AgentHttpServer browser contract", () => {
  it("reports a provider authentication failure as unavailable without exposing provider text", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "latitude-http-auth-"));
    roots.push(root);
    const config = testConfig(root);
    const ledger = new AuditLedger(root);
    const domain = new FakeDomain();
    const runtime = new DshRuntime({
      config,
      ledger,
      domain,
      adapter: failingAdapter("AUTH"),
      installOfficialWebSearch: false,
    });
    const jobs = new RunJobStore(runtime, ledger);
    const scheduler = new DurableScheduler(domain, jobs, ledger, config.schedulerPollMs);
    const admin = new AgentAdminService({ stateDir: root, ledger });
    const server = new AgentHttpServer({
      config,
      runtime,
      jobs,
      domain,
      scheduler,
      admin,
    });
    const address = await server.start();
    closers.push(() => runtime.close());
    closers.push(() => scheduler.close());
    closers.push(() => server.close());

    const priorKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "configured-health-contract-test";
    try {
      const before = await fetch(`${address.url}/health`);
      expect(await before.json()).toMatchObject({
        status: "ready",
        model: { configured: true, authentication: "unverified" },
      });

      const accepted = await fetch(`${address.url}/v1/agent/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "auth-health", text: "synthetic" }),
      });
      const acceptedBody = await accepted.json() as { runId: string };
      const failed = await waitForCompleted(
        `${address.url}/v1/agent/runs/${acceptedBody.runId}`,
      );
      expect(failed).toMatchObject({ status: "failed", error: { code: "AUTH" } });

      const after = await fetch(`${address.url}/health`);
      expect(await after.json()).toEqual(expect.objectContaining({
        status: "unavailable",
        model: {
          provider: "fake",
          id: "fake-model",
          configured: true,
          authentication: "failed",
        },
      }));
    } finally {
      if (priorKey !== undefined) process.env.DEEPSEEK_API_KEY = priorKey;
      else delete process.env.DEEPSEEK_API_KEY;
    }
  });

  it("carries a browser turn through the fake DSH loop into an evidence-grounded candidate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "latitude-http-candidate-"));
    roots.push(root);
    const config = testConfig(root);
    const ledger = new AuditLedger(root);
    const writes: Record<string, unknown>[] = [];
    class CandidateDomain extends FakeDomain {
      override async ingestUserMessage(
        input: UserMessageEvidenceInput,
        audit: DomainAudit,
      ): Promise<MessageEvidenceReceipt> {
        const receipt = await super.ingestUserMessage(input, audit);
        return { ...receipt, evidenceRefId: "evidence-http-current-message" };
      }

      override createToolDefinitions(): ToolDefinition[] {
        return [{
          name: "candidate_propose",
          description: "Persist an evidence-grounded, non-canonical candidate",
          parameters: {
            type: "object",
            properties: {
              label: { type: "string" },
              statement: { type: "string" },
              evidenceRefs: { type: "array", items: { type: "string" } },
              sensitivity: { type: "string" },
            },
            required: ["label", "statement", "evidenceRefs", "sensitivity"],
            additionalProperties: false,
          },
          output: {
            schema: { type: "object", additionalProperties: true },
            render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
          },
          execute: async (args) => {
            writes.push(structuredClone(args as Record<string, unknown>));
            return {
              ok: true,
              changeSetId: "change-http-candidate",
              value: {
                candidate: { id: "candidate-http", status: "proposed" },
                receipt: { command: "create", state: "proposed" },
              },
            };
          },
        }];
      }
    }
    const domain = new CandidateDomain();
    const runtime = new DshRuntime({
      config,
      ledger,
      domain,
      adapter: toolThenTextAdapter("candidate_propose", {
        label: "浏览器共创候选",
        statement: "这只是待验证的共同假设",
        evidenceRefs: ["evidence-http-current-message"],
        sensitivity: "medium",
      }, "候选已提出，尚未成为结论。"),
      installOfficialWebSearch: false,
    });
    const jobs = new RunJobStore(runtime, ledger);
    const scheduler = new DurableScheduler(domain, jobs, ledger, config.schedulerPollMs);
    const admin = new AgentAdminService({ stateDir: root, ledger });
    const server = new AgentHttpServer({ config, runtime, jobs, domain, scheduler, admin });
    const address = await server.start();
    closers.push(() => runtime.close());
    closers.push(() => scheduler.close());
    closers.push(() => server.close());

    const accepted = await fetch(`${address.url}/v1/agent/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "browser-candidate-session",
        text: "把这个当成候选试试，不要当结论",
      }),
    });
    expect(accepted.status).toBe(202);
    const acceptedBody = await accepted.json() as { runId: string };
    const finished = await waitForCompleted(
      `${address.url}/v1/agent/runs/${acceptedBody.runId}`,
    );

    expect(finished).toMatchObject({
      status: "completed",
      result: {
        status: "completed",
        assistantText: "候选已提出，尚未成为结论。",
        toolCallsUsed: 1,
      },
    });
    expect(writes).toEqual([expect.objectContaining({
      evidenceRefs: ["evidence-http-current-message"],
      sensitivity: "medium",
    })]);
  });

  it("accepts text turns idempotently, exposes completed polling and restores messages", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "latitude-http-"));
    roots.push(root);
    const config = testConfig(root);
    const ledger = new AuditLedger(root);
    const domain = new FakeDomain();
    const webSearchProvider: WebSearchProvider = {
      id: "http-fake-search",
      available: () => true,
      async search() {
        return {
          sources: [
            {
              url: "https://example.com/recent",
              title: "Recent source",
              snippet: "Recent evidence",
              publishedAt: new Date(Date.now() - 86_400_000).toISOString(),
            },
            { url: "https://example.com/undated", title: "Undated source" },
          ],
          truncated: false,
        };
      },
    };
    const runtime = new DshRuntime({
      config,
      ledger,
      domain,
      adapter: textAdapter("host answer"),
      installOfficialWebSearch: false,
      webSearchProvider,
    });
    const jobs = new RunJobStore(runtime, ledger);
    const scheduler = new DurableScheduler(domain, jobs, ledger, config.schedulerPollMs);
    const admin = new AgentAdminService({ stateDir: root, ledger });
    const server = new AgentHttpServer({
      config,
      runtime,
      jobs,
      domain,
      scheduler,
      admin,
    });
    const address = await server.start();
    closers.push(() => runtime.close());
    closers.push(() => scheduler.close());
    closers.push(() => server.close());

    const priorKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    const health = await fetch(`${address.url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: "unavailable",
      model: { configured: false, authentication: "unverified" },
      domain: { healthy: true },
    });
    process.env.DEEPSEEK_API_KEY = "sk-health-contract-test";
    Reflect.set(admin, "restartRequired", true);
    const restartHealth = await fetch(`${address.url}/health`);
    expect(await restartHealth.json()).toMatchObject({
      status: "unavailable",
      state: { restartRequired: true, mutationInProgress: false },
    });
    Reflect.set(admin, "restartRequired", false);
    Reflect.set(admin, "mutationInProgress", true);
    const maintenanceHealth = await fetch(`${address.url}/health`);
    expect(await maintenanceHealth.json()).toMatchObject({
      status: "starting",
      state: { restartRequired: false, mutationInProgress: true },
    });
    Reflect.set(admin, "mutationInProgress", false);
    if (priorKey !== undefined) process.env.DEEPSEEK_API_KEY = priorKey;
    else delete process.env.DEEPSEEK_API_KEY;

    const request = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "browser-retry-1",
        origin: "http://127.0.0.1:1420",
      },
      body: JSON.stringify({
        sessionId: "browser-session",
        text: "hello host",
        clientRequestId: "browser-client-1",
      }),
    } satisfies RequestInit;
    const accepted = await fetch(`${address.url}/v1/agent/turns`, request);
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get("access-control-allow-origin"))
      .toBe("http://127.0.0.1:1420");
    const first = await accepted.json() as Record<string, unknown>;
    const retry = await fetch(`${address.url}/v1/agent/turns`, request);
    const retried = await retry.json() as Record<string, unknown>;
    expect(retried).toMatchObject({ runId: first.runId, deduplicated: true });

    const finished = await waitForCompleted(
      `${address.url}/v1/agent/runs/${String(first.runId)}`,
    );
    expect(finished).toMatchObject({
      status: "completed",
      result: { status: "completed", assistantText: "host answer" },
    });

    const history = await fetch(
      `${address.url}/v1/agent/sessions/browser-session/messages?limit=100`,
    );
    expect(await history.json()).toMatchObject({
      sessionId: "browser-session",
      messages: [
        { role: "user", content: "hello host" },
        { role: "assistant", content: "host answer" },
      ],
    });

    const search = await fetch(`${address.url}/v1/web/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "recent facts", maxResults: 5, freshnessDays: 7 }),
    });
    expect(search.status).toBe(200);
    expect(await search.json()).toMatchObject({
      query: "recent facts",
      coverage: {
        mode: "published_at_post_filter",
        providerSupportsFreshness: false,
        requestedFreshnessDays: 7,
        excludedUndatedCount: 1,
        returnedResultCount: 1,
        exhaustive: false,
      },
      results: [{
        title: "Recent source",
        provider: "http-fake-search",
        whyNow: expect.stringMatching(/本次搜索.*第 1 条.*不授予网页内容任何执行或写入权限/),
        evidenceNodeId: expect.any(String),
        evidenceRefId: expect.any(String),
      }],
    });

    const wake = await fetch(`${address.url}/v1/scheduler/wake`, { method: "POST" });
    expect(wake.status).toBe(202);
    expect(await wake.json()).toEqual({ accepted: true });

    const forbidden = await fetch(`${address.url}/health`, {
      headers: { origin: "https://not-local.example" },
    });
    expect(forbidden.status).toBe(403);

    const integrity = await fetch(`${address.url}/v1/agent/admin/integrity`);
    expect(integrity.status).toBe(200);
    expect(await integrity.json()).toMatchObject({ ok: true, fileCount: expect.any(Number) });
    const exported = await fetch(`${address.url}/v1/agent/admin/export`);
    expect(await exported.json()).toMatchObject({
      schemaVersion: 1,
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
});

async function waitForCompleted(url: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const response = await fetch(url);
    const body = await response.json() as Record<string, unknown>;
    if (["completed", "failed", "cancelled"].includes(String(body.status))) return body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for HTTP run completion");
}

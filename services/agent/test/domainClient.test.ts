// @vitest-environment node
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { CallId } from "@deepseek-ai/dsh-llm";
import { assertSupportedJsonSchema, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it } from "vitest";
import {
  DomainClient,
  dailyCurationDue,
  enrichWebSources,
  type RankedWebSource,
} from "../src/domain/domainClient.js";

interface CapturedRequest {
  method: string;
  path: string;
  body: Record<string, unknown>;
  idempotencyKey?: string;
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function domainServer(options: {
  contextError?: { status: number; code: string; message: string };
} = {}) {
  const captured: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    const body = await jsonBody(request);
    const path = request.url || "/";
    captured.push({
      method: request.method || "GET",
      path,
      body,
      ...(typeof request.headers["idempotency-key"] === "string"
        ? { idempotencyKey: request.headers["idempotency-key"] }
        : {}),
    });
    response.setHeader("content-type", "application/json");
    const url = new URL(path, "http://127.0.0.1");
    if (url.pathname === "/v1/context") {
      if (options.contextError) {
        response.statusCode = options.contextError.status;
        response.end(JSON.stringify({
          ok: false,
          error: {
            code: options.contextError.code,
            message: options.contextError.message,
          },
        }));
        return;
      }
      response.end(JSON.stringify({
        ok: true,
        nodes: [],
        edges: [],
        starStates: [],
      }));
      return;
    }
    if (url.pathname === "/v1/evidence/message") {
      response.end(JSON.stringify({
        ok: true,
        changeSetId: "change-message",
        value: {
          sourceRecordId: "source-message",
          evidenceRefId: "evidence-message",
          nodeId: "event-message",
          node: { id: "event-message" },
        },
      }));
      return;
    }
    if (url.pathname === "/v1/evidence/web") {
      response.end(JSON.stringify({
        ok: true,
        changeSetId: "change-web",
        value: {
          sourceRecordId: "source-1",
          evidenceRefId: "evidence-1",
          node: { id: "node-web" },
        },
      }));
      return;
    }
    if (url.pathname === "/v1/actions/due") {
      response.end(JSON.stringify({
        ok: true,
        dueBefore: url.searchParams.get("at"),
        items: [{
          id: "action-1",
          kind: "action",
          label: "Ship loop",
          status: "active",
          expectedOutcome: "closed loop works",
          reviewAt: "2026-08-20T00:00:00.000Z",
          dueAt: "2026-08-24T10:30:00.000Z",
          dueReason: "linked_event",
          triggerEventReceipt: {
            eventNodeId: "event-completion-1",
            observedAt: "2026-08-24T10:00:00.000Z",
            linkedAt: "2026-08-24T10:30:00.000Z",
            relationKind: "tested_claim_edge",
            relationRef: "edge-evidence-1",
          },
          trigger: "after local validation",
          observationWindow: { days: 7 },
        }],
      }));
      return;
    }
    if (url.pathname === "/v1/reviews") {
      response.end(JSON.stringify({
        ok: true,
        items: [{
          receiptKey: "review:2026-W34",
          periodStart: "2026-08-17T09:00:00.000Z",
          periodEnd: "2026-08-24T09:00:00.000Z",
          reviewAt: "2026-08-24T09:00:00.000Z",
          status: "due",
        }],
      }));
      return;
    }
    if (url.pathname === "/v1/revisions" && request.method === "GET") {
      response.end(JSON.stringify({
        items: [{
          id: "revision-1",
          claimNodeId: "claim-1",
          outcomeNodeId: "outcome-1",
          effect: "unknown",
          proposedStatement: "Needs explicit resolution",
          status: "pending",
          createdAt: "2026-08-24T10:00:00.000Z",
        }],
      }));
      return;
    }
    response.end(JSON.stringify({
      ok: true,
      changeSetId: "change-1",
      value: { node: { id: "node-1" } },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const close = () => new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  );
  closers.push(close);
  return {
    client: new DomainClient(`http://127.0.0.1:${address.port}`, 2_000),
    captured,
  };
}

describe("DomainClient flat contract", () => {
  it("uses the service local 09:00 boundary for the durable daily receipt", () => {
    const before = dailyCurationDue(new Date(2026, 7, 24, 8, 59, 59).toISOString());
    const after = dailyCurationDue(new Date(2026, 7, 24, 9, 0, 1).toISOString());
    expect(before.dateKey).toBe("2026-08-23");
    expect(before.receiptKey).toBe("curation:2026-08-23");
    expect(after.dateKey).toBe("2026-08-24");
    expect(after.receiptKey).toBe("curation:2026-08-24");
    expect(new Date(after.dueAt).getHours()).toBe(9);
  });

  it("registers only enforced DSH JSON schemas, including closed ui_customize ops", async () => {
    const { client } = await domainServer();
    const tools = client.createToolDefinitions(() => ({ runId: "run-1", sessionId: "session-1" }));
    for (const tool of tools) {
      expect(() => assertSupportedJsonSchema(tool.parameters)).not.toThrow();
      expect(() => assertSupportedJsonSchema(tool.output.schema)).not.toThrow();
    }
    const ui = tools.find((tool) => tool.name === "ui_customize");
    const schema = JSON.stringify(ui?.parameters);
    expect(schema).not.toMatch(/javascript|html|set_kind/i);
    expect(schema).not.toContain("dimension-seed-desktop");
    expect(schema).toContain("latitude-browser-live");
    expect(schema).toContain("baseRevision");
    expect(schema).toContain("set_props");
    expect(schema).toContain("bind_action");
    expect(schema).toContain("latitude.feed.feedback");
    expect(schema).toContain("latitude.anchor.complete");
    expect(schema).toContain("secretary-companion");
    expect(schema).toContain("latitude.companion.outcome");
    const livingUiBindings = [
      ["browser-control-strip", "latitude.control.search-web"],
      ["browser-control-strip", "latitude.control.refresh"],
      ["browser-control-strip", "latitude.companion.review"],
      ["browser-control-strip", "latitude.agent.cancel"],
      ["candidate-intervention-strip", "latitude.candidate.touch"],
      ["candidate-intervention-strip", "latitude.candidate.shape"],
      ["candidate-intervention-strip", "latitude.candidate.conclude"],
      ["candidate-intervention-strip", "latitude.candidate.park"],
      ["browser-thread", "latitude.thread.close"],
      ["outcome-dialog", "latitude.outcome.submit"],
      ["outcome-dialog", "latitude.outcome.close"],
      ["diagnostics-dialog", "latitude.diagnostics.data-safety"],
      ["diagnostics-dialog", "latitude.diagnostics.close"],
      ["data-safety-dialog", "latitude.data-safety.export"],
      ["data-safety-dialog", "latitude.data-safety.integrity"],
      ["data-safety-dialog", "latitude.data-safety.restore"],
      ["data-safety-dialog", "latitude.data-safety.delete"],
      ["data-safety-dialog", "latitude.data-safety.purge"],
      ["data-safety-dialog", "latitude.data-safety.rollback"],
      ["data-safety-dialog", "latitude.data-safety.close"],
      ["command-bar", "latitude.agent.send"],
      ["dimension-navigation", "latitude.navigation.paper"],
      ["dimension-navigation", "latitude.navigation.clue"],
      ["dimension-navigation", "latitude.navigation.constellation"],
      ["source-inspector-dialog", "latitude.inspector.close"],
    ] as const;
    for (const [componentId, commandId] of livingUiBindings) {
      expect(schema).toContain(componentId);
      expect(schema).toContain(commandId);
    }
    expect(schema).not.toMatch(/"const":"(?:add|remove)"/);
  });

  it("keeps context reads flat without injecting unsupported audit fields", async () => {
    const { client, captured } = await domainServer();
    const tool = client
      .createToolDefinitions(() => ({ runId: "run-context", sessionId: "session-context" }))
      .find((candidate) => candidate.name === "knowledge_context")!;
    await tool.execute({
      kinds: ["claim"],
      query: "focus",
      sensitivityCeiling: "low",
    }, runContext("tool-context"));
    expect(captured.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/context",
      body: { kinds: ["claim"], query: "focus", sensitivityCeiling: "low" },
    });
    expect(tool.description).toContain(
      "does not prove the whole graph or user profile is empty",
    );
    expect(tool.description).toContain("Omit query for a complete bounded inventory");
    expect(JSON.stringify(tool.parameters)).toContain('"enum":["evidence_event"');
    const rendered = tool.output.render(
      { kinds: ["claim"] },
      { nodes: [], edges: [] },
    );
    expect(rendered.map((block) => block.type === "text" ? block.text : "").join(" "))
      .toContain("this page covers only the requested query and kinds");

    const oversized = tool.output.render(
      { kinds: ["claim"] },
      {
        nodes: Array.from({ length: 100 }, (_, index) => ({
          id: `node-${index}`,
          kind: "claim",
          label: `认识 ${index}`,
          statement: `${"很长的内容".repeat(800)}-${index}`,
          status: "active",
          authority: "system_inferred",
        })),
        edges: [],
        starStates: [],
        coverage: { returnedNodeCount: 100 },
      },
    );
    const oversizedText = oversized
      .map((block) => block.type === "text" ? block.text : "")
      .join("");
    expect(oversizedText).toContain(`${"很长的内容".repeat(800)}-99`);
    expect(oversizedText).not.toContain('"presentationTruncated"');
  });

  it("exposes raw evidence search without a sensitivity gate and supports node lineage", async () => {
    const { client, captured } = await domainServer();
    const tool = client
      .createToolDefinitions(() => ({ runId: "run-evidence", sessionId: "session-evidence" }))
      .find((candidate) => candidate.name === "evidence_search")!;
    expect(tool).toBeDefined();
    expect(tool.description).toContain("original evidence layer");
    expect(tool.description).toContain("No sensitivity filter");
    expect(JSON.stringify(tool.parameters)).not.toContain("sensitivityCeiling");

    await tool.execute({
      query: "原始记录",
      sourceTypes: ["computer_history"],
      nodeIds: ["node-derived-1"],
      limit: 200,
    }, runContext("tool-evidence"));
    expect(captured.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/evidence/query",
      body: {
        query: "原始记录",
        sourceTypes: ["computer_history"],
        nodeIds: ["node-derived-1"],
        limit: 200,
      },
    });

    await tool.execute({
      sourceTypes: ["computer_history", "chat"],
      from: "2026-09-01T00:00:00Z",
      limit: 40,
    }, runContext("tool-evidence-broad"));
    expect(captured.at(-1)?.body.samplingMode).toBeUndefined();
    expect(captured.at(-1)?.body.eventsPerSource).toBeUndefined();

    const before = captured.length;
    await expect(tool.execute({
      sourceTypes: ["private_guess"],
    }, runContext("tool-evidence-invalid"))).rejects.toThrow(
      /evidence_search\.sourceTypes must use/,
    );
    expect(captured).toHaveLength(before);
    const rendered = tool.output.render(
      { sourceTypes: ["chat"] },
      { items: [], coverage: { possiblyTruncated: false } },
    );
    expect(rendered.map((block) => block.type === "text" ? block.text : "").join(" "))
      .toContain("other AI conversations are not the current Latitude conversation");
    expect(tool.description).toContain("distinguish conversations with different AI assistants");

    const oversized = tool.output.render(
      { sourceTypes: ["computer_history"] },
      {
        items: Array.from({ length: 80 }, (_, index) => ({
          evidenceRef: {
            id: `evidence-${index}`,
            sourceRecordId: `source-${index}`,
            excerpt: `${"原始屏幕内容".repeat(1_000)}-${index}`,
            rawEventIds: Array.from({ length: 100 }, (__, eventIndex) =>
              `event-${index}-${eventIndex}`
            ),
          },
          source: {
            id: `source-${index}`,
            sourceType: "computer_history",
            metadata: {
              sourceLabel: "Computer History",
              conversationContext: "unknown",
            },
          },
          linkedNodes: [],
        })),
        coverage: { returnedEvidenceCount: 80, possiblyTruncated: true },
      },
    );
    const oversizedText = oversized
      .map((block) => block.type === "text" ? block.text : "")
      .join("");
    expect(oversizedText).toContain(`${"原始屏幕内容".repeat(1_000)}-79`);
    expect(oversizedText).toContain("event-79-99");
    expect(oversizedText).not.toContain("[excerpt truncated]");
    expect(oversizedText).not.toContain('"fullDataStillQueryable"');
  });

  it("normalizes common plural context kinds and rejects unknown kinds before Domain", async () => {
    const { client, captured } = await domainServer();
    const tool = client
      .createToolDefinitions(() => ({ runId: "run-context-kinds", sessionId: "session-context" }))
      .find((candidate) => candidate.name === "knowledge_context")!;
    await tool.execute({
      kinds: ["goals", "projects", "values", "goals"],
      sensitivityCeiling: "medium",
    }, runContext("tool-context-alias"));
    expect(captured.at(-1)?.body.kinds).toEqual(["goal", "project", "value"]);

    const before = captured.length;
    await expect(tool.execute({
      kinds: ["personality"],
    }, runContext("tool-context-invalid"))).rejects.toThrow(
      /knowledge_context\.kinds must use:.*goal.*project.*value/,
    );
    expect(captured).toHaveLength(before);
  });

  it("surfaces Domain's public 400 detail so the Agent can repair a context call", async () => {
    const { client } = await domainServer({
      contextError: {
        status: 400,
        code: "invalid_request",
        message: "invalid request: kind must be one of: goal, project, value",
      },
    });
    const tool = client
      .createToolDefinitions(() => ({ runId: "run-context-error", sessionId: "session-context" }))
      .find((candidate) => candidate.name === "knowledge_context")!;
    await expect(tool.execute({ kinds: ["goal"] }, runContext("tool-context-error")))
      .rejects.toThrow(
        "Latitude domain request failed (400): invalid_request: invalid request: kind must be one of: goal, project, value",
      );
  });

  it("persists ui_customize provenance and CAS base revision in a reversible resource", async () => {
    const { client, captured } = await domainServer();
    const tool = client
      .createToolDefinitions(() => ({ runId: "run-ui", sessionId: "session-ui" }))
      .find((candidate) => candidate.name === "ui_customize")!;
    await tool.execute({
      schemaVersion: 2,
      surfaceId: "latitude-browser-live",
      baseRevision: 4,
      rationale: "突出日程",
      operations: [
        {
          op: "set_props",
          componentId: "seed-schedule",
          presentation: { title: "本周行动", eyebrow: "ANCHORS", tilt: -0.4 },
        },
        {
          op: "bind_action",
          componentId: "seed-schedule",
          event: "complete",
          commandId: "latitude.anchor.complete",
        },
        {
          op: "set_visibility",
          componentId: "secretary-companion",
          visible: false,
        },
        {
          op: "bind_action",
          componentId: "secretary-companion",
          event: "chat",
          commandId: "latitude.companion.chat",
        },
        {
          op: "set_visibility",
          componentId: "browser-control-strip",
          visible: false,
        },
        {
          op: "bind_action",
          componentId: "browser-control-strip",
          event: "review",
          commandId: "latitude.companion.review",
        },
        {
          op: "bind_action",
          componentId: "candidate-intervention-strip",
          event: "park",
          commandId: "latitude.candidate.park",
        },
        {
          op: "bind_action",
          componentId: "data-safety-dialog",
          event: "purge",
          commandId: null,
        },
        {
          op: "bind_action",
          componentId: "dimension-navigation",
          event: "constellation",
          commandId: "latitude.navigation.constellation",
        },
      ],
    }, runContext("tool-ui"));
    expect(captured.at(-1)).toMatchObject({
      path: "/v1/changes",
      body: {
        operation: "remember",
        kind: "resource",
        payload: {
          resourceType: "ui_change_set",
          schemaVersion: 2,
          surfaceId: "latitude-browser-live",
          baseLayoutId: "latitude-browser-live",
          baseRevision: 4,
          actor: "model",
          authorization: "preauthorized",
          operations: [
            {
              op: "set_props",
              componentId: "seed-schedule",
              presentation: { title: "本周行动", eyebrow: "ANCHORS", tilt: -0.4 },
            },
            {
              op: "bind_action",
              componentId: "seed-schedule",
              event: "complete",
              commandId: "latitude.anchor.complete",
            },
            {
              op: "set_visibility",
              componentId: "secretary-companion",
              visible: false,
            },
            {
              op: "bind_action",
              componentId: "secretary-companion",
              event: "chat",
              commandId: "latitude.companion.chat",
            },
            {
              op: "set_visibility",
              componentId: "browser-control-strip",
              visible: false,
            },
            {
              op: "bind_action",
              componentId: "browser-control-strip",
              event: "review",
              commandId: "latitude.companion.review",
            },
            {
              op: "bind_action",
              componentId: "candidate-intervention-strip",
              event: "park",
              commandId: "latitude.candidate.park",
            },
            {
              op: "bind_action",
              componentId: "data-safety-dialog",
              event: "purge",
              commandId: null,
            },
            {
              op: "bind_action",
              componentId: "dimension-navigation",
              event: "constellation",
              commandId: "latitude.navigation.constellation",
            },
          ],
        },
        audit: {
          sessionId: "session-ui",
          turnId: "run-ui",
          toolCallId: "tool-ui",
        },
      },
    });
    expect((captured.at(-1)!.body.payload as Record<string, unknown>).createdAt)
      .toEqual(expect.any(String));

    await expect(tool.execute({
      schemaVersion: 2,
      surfaceId: "latitude-browser-live",
      baseRevision: 4,
      rationale: "尝试越权绑定",
      operations: [{
        op: "bind_action",
        componentId: "seed-feed",
        event: "feedback",
        commandId: "latitude.anchor.complete",
      }],
    }, runContext("tool-ui-bad-command"))).rejects.toThrow(/cannot bind/);
    await expect(tool.execute({
      schemaVersion: 2,
      surfaceId: "latitude-browser-live",
      baseRevision: 4,
      rationale: "尝试写业务 payload",
      operations: [{
        op: "set_props",
        componentId: "seed-feed",
        presentation: { title: "安全标题" },
        props: { payload: "forbidden" },
      }],
    }, runContext("tool-ui-bad-props"))).rejects.toThrow(/forbidden field props/);
    await expect(tool.execute({
      schemaVersion: 2,
      surfaceId: "latitude-browser-live",
      baseRevision: 4,
      rationale: "尝试改桌宠任意属性",
      operations: [{
        op: "set_props",
        componentId: "secretary-companion",
        presentation: { title: "不允许" },
      }],
    }, runContext("tool-ui-bad-companion-props"))).rejects.toThrow(/desktop cards/);
    await expect(tool.execute({
      schemaVersion: 2,
      surfaceId: "latitude-browser-live",
      baseRevision: 4,
      rationale: "尝试移动固定模块",
      operations: [{
        op: "move",
        componentId: "browser-control-strip",
        order: 0,
      }],
    }, runContext("tool-ui-bad-fixed-move"))).rejects.toThrow(/desktop cards/);
    await expect(tool.execute({
      schemaVersion: 2,
      surfaceId: "latitude-browser-live",
      baseRevision: 4,
      rationale: "尝试伪造固定模块命令",
      operations: [{
        op: "bind_action",
        componentId: "browser-control-strip",
        event: "review",
        commandId: "latitude.control.refresh",
      }],
    }, runContext("tool-ui-bad-fixed-command"))).rejects.toThrow(/cannot bind/);
    await expect(tool.execute({
      schemaVersion: 2,
      surfaceId: "latitude-browser-live",
      baseRevision: 4,
      rationale: "尝试使用未知组件",
      operations: [{
        op: "set_visibility",
        componentId: "invented-widget",
        visible: true,
      }],
    }, runContext("tool-ui-unknown-component"))).rejects.toThrow(/unregistered componentId/);
    const persistedUiResources = captured.filter((request) =>
      request.path === "/v1/changes" &&
      (request.body.payload as Record<string, unknown> | undefined)?.resourceType ===
        "ui_change_set"
    );
    expect(persistedUiResources).toHaveLength(1);
    expect((persistedUiResources[0]!.body.payload as Record<string, unknown>).operations)
      .toHaveLength(9);
  });

  it("sends flat remember payload and exact run/session/tool audit attribution", async () => {
    const { client, captured } = await domainServer();
    const tool = client
      .createToolDefinitions(() => ({ runId: "run-7", sessionId: "session-7" }))
      .find((candidate) => candidate.name === "knowledge_remember")!;
    await tool.execute({
      label: "A claim",
      statement: "Evidence suggests this",
      kind: "claim",
      confidence: 0.7,
      evidenceRefs: ["evidence-1"],
      reason: "new observation",
      scope: { project: "latitude" },
      sensitivity: "medium",
    }, runContext("tool-7"));
    const request = captured.at(-1)!;
    expect(request.path).toBe("/v1/changes");
    expect(request.body).toMatchObject({
      operation: "remember",
      label: "A claim",
      statement: "Evidence suggests this",
      kind: "claim",
      scope: { project: "latitude" },
      sensitivity: "medium",
      evidenceRefs: ["evidence-1"],
      payload: {
        confidence: 0.7,
        evidenceRefs: ["evidence-1"],
        reason: "new observation",
      },
      audit: {
        actor: "model",
        sessionId: "session-7",
        turnId: "run-7",
        toolCallId: "tool-7",
        authorizationMode: "preauthorized",
      },
    });
    expect(request.body).not.toHaveProperty("meta");
    expect(request.body).not.toHaveProperty("input");
  });

  it("refuses to turn runtime debugging conclusions into user knowledge", async () => {
    const { client, captured } = await domainServer();
    const tool = client
      .createToolDefinitions(() => ({ runId: "run-debug-memory", sessionId: "session-debug" }))
      .find((candidate) => candidate.name === "knowledge_remember")!;
    await expect(tool.execute({
      label: "knowledge_context contract",
      statement: "The tool returned 400",
      kind: "observation",
      sensitivity: "medium",
      scope: { domain: "system", topic: "tool-contract" },
    }, runContext("tool-debug-memory"))).rejects.toThrow(
      /cannot persist tool, runtime, API, or debugging contracts/,
    );
    expect(captured.some((request) => request.path === "/v1/changes")).toBe(false);
  });

  it("persists a user-authored message idempotently before model execution", async () => {
    const { client, captured } = await domainServer();
    const receipt = await client.ingestUserMessage({
      clientRequestId: "message-evidence:request-1",
      messageId: "message-1",
      content: "User-authored statement",
      occurredAt: "2026-08-24T10:00:00.000Z",
    }, {
      actor: "user",
      sessionId: "session-1",
      turnId: "run-1",
      authorizationMode: "automatic",
    });
    expect(receipt).toEqual({
      clientRequestId: "message-evidence:request-1",
      messageId: "message-1",
      changeId: "change-message",
      sourceRecordId: "source-message",
      evidenceRefId: "evidence-message",
      eventNodeId: "event-message",
    });
    expect(captured.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/evidence/message",
      idempotencyKey: "message-evidence:request-1",
      body: {
        clientRequestId: "message-evidence:request-1",
        messageId: "message-1",
        content: "User-authored statement",
        audit: { actor: "user", turnId: "run-1" },
      },
    });
  });

  it("uses exact bounded star-map, feedback, action, outcome, and revision contracts", async () => {
    const { client, captured } = await domainServer();
    const tools = client.createToolDefinitions(() => ({
      runId: "run-tools",
      sessionId: "session-tools",
    }));
    const execute = (name: string, args: Record<string, unknown>) =>
      tools.find((tool) => tool.name === name)!.execute(args, runContext(`call-${name}`));

    await execute("locate_event", {
      eventNodeId: "event-1",
      evidenceRefs: ["evidence-1"],
      queryPolicy: { maxCandidates: 4, allowSemanticOnly: true },
    });
    await execute("compile_context", {
      seedNodeIds: ["claim-1", "outcome-1"],
      budget: { maxNodes: 20, maxEdges: 30, maxDepth: 3 },
    });
    await execute("apply_location", {
      eventNodeId: "event-1",
      starCenterNodeId: "star-1",
      relationType: "about",
      evidenceRefs: ["evidence-1"],
      basis: "semantic_only",
      proximity: "near",
      strength: "weak",
      rationale: "Semantic candidate; must remain proposed",
    });
    await execute("apply_feedback", {
      feedbackType: "correct",
      targetNodeId: "claim-1",
      evidenceRefs: ["evidence-1"],
      correctedStatement: "Corrected claim",
      correctedScope: { project: "latitude" },
    });
    await execute("action_create", {
      label: "Validate loop",
      expectedOutcome: "One full cycle closes",
      reviewAt: "2026-09-01T09:00:00.000Z",
      trigger: "after browser smoke",
      observationWindow: { from: "2026-08-25", to: "2026-09-01" },
      sensitivity: "medium",
    });
    await execute("outcome_record", {
      actionId: "action-1",
      outcome: "The claim was contradicted",
      effect: "refutes",
      claimId: "claim-1",
      evidenceRefs: ["evidence-outcome-1"],
    });
    await execute("revision_queue_resolve", {
      revisionId: "revision-1",
      resolution: "revises",
      revisedStatement: "Versioned replacement",
    });
    await execute("revision_queue_list", {
      status: "pending",
      limit: 25,
      sensitivityCeiling: "low",
    });
    await execute("weekly_review_create", {
      periodStart: "2026-08-17T09:00:00.000Z",
      periodEnd: "2026-08-24T09:00:00.000Z",
      sensitivityCeiling: "low",
    });

    expect(captured.some((request) =>
      request.path === "/v1/star-map/locate-event" && request.body.eventNodeId === "event-1"
    )).toBe(true);
    expect(captured.some((request) =>
      request.path === "/v1/star-map/compile-context" &&
      (request.body.budget as Record<string, unknown>).maxDepth === 3
    )).toBe(true);
    expect(captured.find((request) => request.path === "/v1/star-map/apply-location"))
      .toMatchObject({
        idempotencyKey: expect.any(String),
        body: {
          eventNodeId: "event-1",
          starCenterNodeId: "star-1",
          relationType: "about",
          evidenceRefs: ["evidence-1"],
          basis: "semantic_only",
          rationale: "Semantic candidate; must remain proposed",
          audit: { toolCallId: "call-apply_location" },
        },
      });
    const feedback = captured.find((request) => request.path === "/v1/star-map/apply-feedback")!;
    expect(feedback).toMatchObject({
      idempotencyKey: expect.any(String),
      body: {
        feedbackType: "correct",
        targetNodeId: "claim-1",
        correctedStatement: "Corrected claim",
        audit: { toolCallId: "call-apply_feedback" },
      },
    });
    expect(captured.find((request) => request.path === "/v1/actions")?.body)
      .toMatchObject({ trigger: "after browser smoke", observationWindow: { from: "2026-08-25" } });
    expect(captured.find((request) => request.path === "/v1/outcomes")?.body)
      .toMatchObject({ effect: "refutes", evidenceRefs: ["evidence-outcome-1"] });
    const resolve = captured.find((request) =>
      request.path === "/v1/revisions/revision-1/resolve"
    )!;
    expect(resolve.body).toMatchObject({
      resolution: "revises",
      revisedStatement: "Versioned replacement",
    });
    expect(resolve.body).not.toHaveProperty("revisionId");
    expect(captured.some((request) =>
      request.method === "GET" &&
      request.path === "/v1/revisions?status=pending&limit=25&sensitivityCeiling=low"
    )).toBe(true);
    expect(captured.find((request) => request.path === "/v1/reviews")?.body)
      .toMatchObject({ sensitivityCeiling: "low" });

    await expect(execute("outcome_record", {
      actionId: "action-1",
      outcome: "partial",
      effect: "contracts",
      evidenceRefs: ["evidence-outcome-1"],
    })).rejects.toThrow(/requires revisedStatement/);

    await expect(execute("outcome_record", {
      actionId: "action-1",
      outcome: "unattributed",
      effect: "unknown",
      evidenceRefs: [],
    })).rejects.toThrow(/evidenceRefs/);
  });

  it("keeps candidate proposal and transitions evidence-grounded and hides due acknowledgement", async () => {
    const { client, captured } = await domainServer();
    const tools = client.createToolDefinitions(() => ({
      runId: "run-candidate",
      sessionId: "session-candidate",
    }));
    const propose = tools.find((tool) => tool.name === "candidate_propose")!;
    const command = tools.find((tool) => tool.name === "candidate_command")!;

    expect(JSON.stringify(command.parameters)).not.toContain("acknowledge_due");
    await propose.execute({
      label: "可持续写作启动方式",
      statement: "先把十分钟启动法作为共创候选，而不是结论",
      sourceNodeIds: ["goal-writing"],
      evidenceRefs: ["evidence-current-message"],
      payload: { hypothesis: "short-start" },
      scope: { project: "latitude" },
      sensitivity: "medium",
    }, runContext("call-candidate-propose"));
    await command.execute({
      candidateId: "candidate/one",
      command: "touch",
      note: "用户明确愿意先试一次",
      evidenceRefs: ["evidence-current-message"],
    }, runContext("call-candidate-command"));

    expect(captured.at(-2)).toMatchObject({
      method: "POST",
      path: "/v1/candidates",
      idempotencyKey: expect.any(String),
      body: {
        label: "可持续写作启动方式",
        statement: "先把十分钟启动法作为共创候选，而不是结论",
        sourceNodeIds: ["goal-writing"],
        evidenceRefs: ["evidence-current-message"],
        sensitivity: "medium",
        audit: {
          actor: "model",
          sessionId: "session-candidate",
          turnId: "run-candidate",
          toolCallId: "call-candidate-propose",
          authorizationMode: "preauthorized",
        },
      },
    });
    expect(captured.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/candidates/candidate%2Fone/commands",
      idempotencyKey: expect.any(String),
      body: {
        command: "touch",
        note: "用户明确愿意先试一次",
        evidenceRefs: ["evidence-current-message"],
        audit: {
          actor: "model",
          sessionId: "session-candidate",
          turnId: "run-candidate",
          toolCallId: "call-candidate-command",
          authorizationMode: "preauthorized",
        },
      },
    });
    expect(captured.at(-1)!.body).not.toHaveProperty("candidateId");

    await expect(propose.execute({
      label: "无证据候选",
      statement: "不应写入",
      evidenceRefs: [],
      sensitivity: "medium",
    }, runContext("call-candidate-no-evidence"))).rejects.toThrow(/evidenceRefs/);
    await expect(command.execute({
      candidateId: "candidate-1",
      command: "acknowledge_due",
      evidenceRefs: ["evidence-current-message"],
    }, runContext("call-candidate-host-only"))).rejects.toThrow(/touch, shape, conclude, or park/);
    await expect(command.execute({
      candidateId: "candidate-1",
      command: "park",
      evidenceRefs: ["duplicate", "duplicate"],
    }, runContext("call-candidate-duplicate-evidence"))).rejects.toThrow(/duplicate/);
  });

  it("ingests every web result through /v1/evidence/web and parses MutationResponse.value", async () => {
    const { client, captured } = await domainServer();
    const [source] = enrichWebSources("latest Latitude", [{
      url: "https://example.com/report",
      title: "Example report",
      snippet: "A real excerpt",
      publishedAt: "2026-08-20T00:00:00.000Z",
    }], "2026-08-24T10:00:00.000Z");
    const rankedSource = { ...source!, whyNow: "本次搜索中按来源相关性列为第 1 条。" };
    const receipts = await client.ingestWebSearch(
      "latest Latitude",
      [rankedSource],
      { actor: "agent_host:web_search", authorizationMode: "automatic" },
    );
    expect(receipts).toEqual([{
      contentHash: source!.contentHash,
      url: "https://example.com/report",
      changeId: "change-web",
      nodeId: "node-web",
      sourceRecordId: "source-1",
      evidenceRefId: "evidence-1",
    }]);
    expect(captured.at(-1)).toMatchObject({
      path: "/v1/evidence/web",
      body: {
        query: "latest Latitude",
        whyNow: "本次搜索中按来源相关性列为第 1 条。",
        url: "https://example.com/report",
        title: "Example report",
        snippet: "A real excerpt",
        retrievedAt: "2026-08-24T10:00:00.000Z",
        contentHash: source!.contentHash,
        sensitivity: "low",
      },
    });
  });

  it("drops relative published labels and supplies a non-empty evidence snippet", async () => {
    const { client, captured } = await domainServer();
    const [source] = enrichWebSources("fresh result", [{
      url: "https://example.com/no-excerpt",
      title: "Result without excerpt",
      publishedAt: "2 days ago",
    }], "2026-08-24T10:00:00.000Z");
    const rankedSource = { ...source!, whyNow: "本次搜索中按来源相关性列为第 1 条。" };
    expect(source).not.toHaveProperty("publishedAt");
    await client.ingestWebSearch(
      "fresh result",
      [rankedSource],
      { actor: "agent_host:web_search", authorizationMode: "automatic" },
    );
    expect(captured.at(-1)).toMatchObject({
      path: "/v1/evidence/web",
      body: { snippet: "Result without excerpt" },
    });
    expect(captured.at(-1)!.body).not.toHaveProperty("publishedAt");
  });

  it("persists ranked curation items using a content-specific idempotency key", async () => {
    const { client, captured } = await domainServer();
    const [source] = enrichWebSources("agent evidence", [{
      url: "https://example.com/agent",
      title: "Agent evidence",
      snippet: "A relevant result",
      publishedAt: "2026-08-24T08:00:00.000Z",
    }], "2026-08-24T10:00:00.000Z");
    const rankedSource = {
      ...source!,
      whyNow: "本次低敏策展中因证据词匹配而排第 1。",
    };
    const receipt = await client.persistWebCuration({
      dateKey: "2026-08-24",
      query: "agent evidence",
      freshnessDays: 7,
      rankingTerms: ["agent", "evidence"],
      basis: {
        goalNodeIds: ["goal-1"],
        tensionNodeIds: ["tension-1"],
        preferenceNodeIds: ["preference-1"],
      },
      coverage: {
        mode: "published_at_post_filter",
        providerSupportsFreshness: false,
        exhaustive: false,
      },
      items: [{
        rank: 1,
        score: 8.5,
        source: rankedSource,
        evidenceRefId: "evidence-1",
        evidenceNodeId: "node-web",
      }],
    }, {
      actor: "model",
      sessionId: "latitude:scheduler:daily-curation",
      turnId: "run-curation",
      toolCallId: "call-curation",
      authorizationMode: "preauthorized",
    });
    expect(receipt).toMatchObject({
      clientRequestId: expect.stringMatching(/^daily-curation:2026-08-24:[a-f0-9]{16}$/),
      changeId: "change-1",
      nodeId: "node-1",
    });
    expect(captured.at(-1)).toMatchObject({
      path: "/v1/changes",
      idempotencyKey: receipt.clientRequestId,
      body: {
        operation: "remember",
        clientRequestId: receipt.clientRequestId,
        kind: "resource",
        evidenceRefs: ["evidence-1"],
        payload: {
          resourceType: "daily_web_curation",
          dateKey: "2026-08-24",
          evidenceRefs: ["evidence-1"],
          items: [{
            rank: 1,
            contentHash: source!.contentHash,
            whyNow: "本次低敏策展中因证据词匹配而排第 1。",
          }],
        },
        audit: { toolCallId: "call-curation" },
      },
    });
    await expect(client.persistWebCuration({
      dateKey: "2026-08-25",
      query: "missing evidence receipt",
      freshnessDays: 7,
      rankingTerms: ["evidence"],
      basis: { goalNodeIds: ["goal-1"], tensionNodeIds: [], preferenceNodeIds: [] },
      coverage: {},
      items: [{ rank: 1, score: 1, source: rankedSource }],
    }, {
      actor: "model",
      authorizationMode: "preauthorized",
    })).rejects.toThrow(/evidenceRefId/);
  });

  it("rejects absent or oversized whyNow before posting web evidence", async () => {
    const { client, captured } = await domainServer();
    const [source] = enrichWebSources("bounded reason", [{
      url: "https://example.com/bounded-reason",
      title: "Bounded reason",
    }], "2026-08-24T10:00:00.000Z");
    await expect(client.ingestWebSearch(
      "bounded reason",
      [source! as unknown as RankedWebSource],
      { actor: "agent_host:web_search", authorizationMode: "automatic" },
    )).rejects.toThrow(/non-empty whyNow/);
    await expect(client.ingestWebSearch(
      "bounded reason",
      [{ ...source!, whyNow: "理".repeat(501) }],
      { actor: "agent_host:web_search", authorizationMode: "automatic" },
    )).rejects.toThrow(/500 characters/);
    expect(captured).toHaveLength(0);
  });

  it("uses decision-scoped idempotency so a later whyNow cannot overwrite history", async () => {
    const { client, captured } = await domainServer();
    const [source] = enrichWebSources("same content", [{
      url: "https://example.com/same-content",
      title: "Same content",
    }], "2026-08-24T10:00:00.000Z");
    const audit = { actor: "agent_host:web_search", authorizationMode: "automatic" } as const;
    await client.ingestWebSearch(
      "same content",
      [{ ...source!, whyNow: "第一次排序时排第 1。" }],
      audit,
    );
    await client.ingestWebSearch(
      "same content",
      [{ ...source!, whyNow: "偏好变化后再次排序时排第 2。" }],
      audit,
    );
    const writes = captured.filter((request) => request.path === "/v1/evidence/web");
    expect(writes).toHaveLength(2);
    expect(writes[0]?.body.whyNow).toBe("第一次排序时排第 1。");
    expect(writes[1]?.body.whyNow).toBe("偏好变化后再次排序时排第 2。");
    expect(writes[0]?.idempotencyKey).not.toBe(writes[1]?.idempotencyKey);
    expect(String(writes[0]?.idempotencyKey)).toContain(source!.contentHash);
  });

  it("polls exact due action/review/revision read models", async () => {
    const { client, captured } = await domainServer();
    const due = await client.listDueWork("2026-08-24T12:00:00.000Z");
    expect(due).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "outcome_collection",
        actionId: "action-1",
        dueReason: "linked_event",
        receiptKey: "outcome:action-1:event:event-completion-1:edge-evidence-1",
        trigger: "after local validation",
        observationWindow: { days: 7 },
      }),
      expect.objectContaining({ kind: "weekly_review", receiptKey: "review:2026-W34" }),
      expect.objectContaining({ kind: "revision_resolution", revisionId: "revision-1" }),
      expect.objectContaining({
        kind: "daily_curation",
        receiptKey: expect.stringMatching(/^curation:\d{4}-\d{2}-\d{2}$/),
      }),
    ]));
    expect(due.filter((item) => item.kind === "weekly_review")).toHaveLength(1);
    expect(captured.map((request) => request.path)).toEqual(expect.arrayContaining([
      "/v1/actions/due?at=2026-08-24T12%3A00%3A00.000Z&limit=100&sensitivityCeiling=highest",
      "/v1/reviews?status=due&dueBefore=2026-08-24T12%3A00%3A00.000Z&limit=20&sensitivityCeiling=highest",
      "/v1/revisions?status=pending&limit=100&sensitivityCeiling=highest",
    ]));
  });
});

function runContext(callId: string): ToolRunContext {
  return {
    callId: CallId(callId),
    signal: new AbortController().signal,
  } as ToolRunContext;
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

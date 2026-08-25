import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  assertCompletedRun,
  stableRunFailure,
} from "./accept-local-job-errors.mjs";

const WORKSPACE = process.cwd();
const SANDBOX_PREFIX = "latitude-accept-";
const OWNER_FILE = ".latitude-acceptance-owner.json";
const RUN_NONCE = randomUUID();
const ACCEPT_TIMEOUT_MS = positiveInteger(
  process.env.LATITUDE_ACCEPT_TIMEOUT_MS,
  240_000,
  "LATITUDE_ACCEPT_TIMEOUT_MS",
);
const KEEP_ON_SUCCESS = process.env.LATITUDE_ACCEPT_KEEP === "1";
const MODEL_KEY = configuredDeepSeekKey(process.env.DEEPSEEK_API_KEY);

let sandbox;
let domainProcess;
let agentProcess;
let interrupted = false;
let succeeded = false;

process.once("SIGINT", () => {
  interrupted = true;
  void stopServices().finally(() => process.exit(130));
});
process.once("SIGTERM", () => {
  interrupted = true;
  void stopServices().finally(() => process.exit(143));
});

try {
  assertRuntime();
  sandbox = await createOwnedSandbox();
  const [domainPort, agentPort] = await allocateDistinctLoopbackPorts();
  const domainUrl = `http://127.0.0.1:${domainPort}`;
  const agentUrl = `http://127.0.0.1:${agentPort}`;

  phase("start isolated Domain");
  domainProcess = startDomain(sandbox, domainPort);
  await waitForHealth(`${domainUrl}/health`, "domain", (body) =>
    body.ok === true && body.status === "ready"
  );

  // Seed curation basis before Host startup. Otherwise a fresh scheduler could
  // durably consume today's receipt while the graph is still empty.
  phase("seed bounded curation basis");
  const goal = await remember(domainUrl, {
    label: "Acceptance research goal",
    statement: "Track recent primary evidence about reliable local AI agent systems.",
    kind: "goal",
    payload: { acceptanceFixture: true },
    scope: { profile: "isolated-acceptance" },
    audit: userAudit("seed-goal"),
  });
  const goalId = nodeId(goal, "seed goal");
  const preference = await remember(domainUrl, {
    label: "Acceptance curator preference",
    statement: "Prefer dated primary technical sources over undated summaries.",
    kind: "interest",
    payload: {
      acceptanceFixture: true,
      preferenceType: "curator_preference",
    },
    scope: { profile: "isolated-acceptance" },
    audit: userAudit("seed-preference"),
  });
  const preferenceId = nodeId(preference, "seed preference");
  const tension = await remember(domainUrl, {
    label: "Acceptance reliability tension",
    statement: "Cloud capability must remain useful without weakening local auditability.",
    kind: "tension",
    payload: { acceptanceFixture: true },
    scope: { profile: "isolated-acceptance" },
    audit: userAudit("seed-tension"),
  });
  const tensionId = nodeId(tension, "seed tension");

  phase("start isolated Agent Host");
  agentProcess = startAgent(sandbox, agentPort, domainUrl);
  await waitForHealth(`${agentUrl}/health`, "agent", (body) =>
    body.status === "ready" &&
    body.model?.configured === true &&
    body.domain?.healthy === true
  );
  logCheck("health", {
    domainSchema: String((await getJson(`${domainUrl}/health`)).schemaVersion),
    modelConfigured: true,
  });

  phase("persist message evidence and close action/outcome revision loop");
  const evidence = await postJson(`${domainUrl}/v1/evidence/message`, {
    clientRequestId: acceptanceId("message"),
    messageId: acceptanceId("message-id"),
    content: "A bounded local workflow improves auditability for the isolated acceptance profile.",
    occurredAt: new Date().toISOString(),
    sensitivity: "low",
    audit: userAudit("message"),
  }, { idempotencyKey: acceptanceId("message") });
  const evidenceRefId = expectString(evidence.value?.evidenceRefId, "message evidenceRefId");
  const eventNodeId = expectString(
    evidence.value?.nodeId ?? evidence.value?.node?.id,
    "message eventNodeId",
  );

  const claim = await remember(domainUrl, {
    label: "Acceptance baseline claim",
    statement: "A bounded local workflow improves auditability.",
    kind: "claim",
    payload: { acceptanceFixture: true },
    scope: { profile: "isolated-acceptance" },
    evidenceRefs: [evidenceRefId],
    audit: userAudit("claim"),
  });
  const claimId = nodeId(claim, "claim");

  phase("locate, apply, compile, and roll back one evidence-backed orbit");
  const located = await postJson(`${domainUrl}/v1/star-map/locate-event`, {
    eventNodeId,
    evidenceRefs: [evidenceRefId],
    projectContext: { profile: "isolated-acceptance" },
    queryPolicy: { maxCandidates: 8, allowSemanticOnly: true },
    sensitivityCeiling: "low",
    audit: modelAudit("locate-event"),
  });
  assert(located.mutationPerformed === false, "locate_event unexpectedly mutated the graph");
  const locatedCandidate = located.candidates?.find((candidate) =>
    candidate.starCenterNodeId === claimId
  );
  assert(locatedCandidate, "locate_event did not project the matching acceptance claim");
  // locate_event can surface an existing evidence edge such as
  // provides_evidence_for. apply-location intentionally accepts only its four
  // semantic placement relations, so adapt without weakening Domain validation.
  const locationRelation = ["part_of", "about", "serves", "influences"].includes(
    locatedCandidate.relationType,
  ) ? locatedCandidate.relationType : "about";
  const locationRequestId = acceptanceId("apply-location");
  const appliedLocation = await postJson(`${domainUrl}/v1/star-map/apply-location`, {
    clientRequestId: locationRequestId,
    eventNodeId,
    starCenterNodeId: claimId,
    relationType: locationRelation,
    evidenceRefs: [evidenceRefId],
    basis: "explicit_statement",
    proximity: "near",
    strength: "strong",
    rationale: "The persisted user statement explicitly describes the acceptance claim.",
    audit: modelAudit("apply-location"),
  }, { idempotencyKey: locationRequestId });
  const locationChangeSetId = expectString(
    appliedLocation.changeSetId,
    "apply-location changeSetId",
  );
  const orbitEdgeId = expectString(appliedLocation.value?.orbitEdge?.id, "orbit edge id");
  const semanticEdgeId = expectString(
    appliedLocation.value?.semanticEdge?.id,
    "semantic edge id",
  );
  const compiledOrbit = await compileContext(domainUrl, eventNodeId);
  assert(
    compiledOrbit.edges?.some((edge) => edge.id === orbitEdgeId && edge.relationType === "orbits"),
    "compiled context lacks the active orbit edge",
  );
  assert(
    compiledOrbit.paths?.some((entry) =>
      entry.nodeId === claimId && Array.isArray(entry.pathEdgeIds) &&
      entry.pathEdgeIds.length > 0
    ),
    "compiled context lacks an attributed graph path to the orbited claim",
  );
  const rollbackRequestId = acceptanceId("rollback-location");
  const rolledBackLocation = await postJson(`${domainUrl}/v1/changes`, {
    operation: "rollback",
    clientRequestId: rollbackRequestId,
    changeSetId: locationChangeSetId,
    reason: "Acceptance verifies reversible orbital placement",
    audit: modelAudit("rollback-location"),
  }, { idempotencyKey: rollbackRequestId });
  assert(rolledBackLocation.ok === true, "orbital ChangeSet rollback failed");
  const compiledAfterRollback = await compileContext(domainUrl, eventNodeId);
  assert(
    !compiledAfterRollback.edges?.some((edge) =>
      edge.id === orbitEdgeId || edge.id === semanticEdgeId
    ),
    "rolled-back orbit edges remain active in compiled context",
  );

  const reviewAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const action = await postJson(`${domainUrl}/v1/actions`, {
    clientRequestId: acceptanceId("action"),
    label: "Acceptance bounded action",
    statement: "Run one isolated local closure check.",
    expectedOutcome: "The closure artifacts remain versioned and restorable.",
    trigger: "After both isolated services report ready",
    observationWindow: { startsAt: new Date().toISOString(), endsAt: reviewAt },
    reviewAt,
    payload: { acceptanceFixture: true },
    scope: { profile: "isolated-acceptance" },
    sensitivity: "low",
    claimId,
    audit: modelAudit("action"),
  }, { idempotencyKey: acceptanceId("action") });
  const actionId = expectString(action.value?.action?.id, "action id");
  assert(action.value?.action?.trigger, "action trigger was not persisted");
  assert(action.value?.action?.observationWindow, "action observationWindow was not persisted");

  const outcomeEvidenceRequestId = acceptanceId("outcome-message");
  const outcomeEvidence = await postJson(`${domainUrl}/v1/evidence/message`, {
    clientRequestId: outcomeEvidenceRequestId,
    messageId: acceptanceId("outcome-message-id"),
    content: "The isolated closure completed with explicit receipts, and the retained receipts made the result auditable.",
    occurredAt: new Date().toISOString(),
    sensitivity: "low",
    audit: userAudit("outcome-message"),
  }, { idempotencyKey: outcomeEvidenceRequestId });
  const outcomeEvidenceRefId = expectString(
    outcomeEvidence.value?.evidenceRefId,
    "outcome evidenceRefId",
  );
  const outcomeEventNodeId = expectString(
    outcomeEvidence.value?.nodeId ?? outcomeEvidence.value?.node?.id,
    "outcome eventNodeId",
  );
  const outcome = await postJson(`${domainUrl}/v1/outcomes`, {
    clientRequestId: acceptanceId("outcome"),
    actionId,
    label: "Acceptance observed outcome",
    outcome: "The isolated closure completed with explicit receipts.",
    observedAt: new Date().toISOString(),
    effect: "revises",
    claimId,
    revisedStatement: "A bounded local workflow improves auditability when receipts are retained.",
    evidenceRefs: [outcomeEvidenceRefId],
    payload: { acceptanceFixture: true },
    audit: modelAudit("outcome"),
  }, { idempotencyKey: acceptanceId("outcome") });
  assert(outcome.value?.revisionHook?.status === "applied", "outcome revision was not applied");
  assert(
    typeof outcome.value?.revisionHook?.appliedClaim?.id === "string",
    "outcome did not create a versioned claim",
  );
  const revisedClaimId = outcome.value.revisionHook.appliedClaim.id;

  const weeklyPeriodEnd = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
  const weeklyPeriodStart = new Date(Date.parse(weeklyPeriodEnd) - 7 * 86_400_000).toISOString();
  const weeklyRequestId = acceptanceId("weekly-review");
  const weekly = await postJson(`${domainUrl}/v1/reviews`, {
    clientRequestId: weeklyRequestId,
    periodStart: weeklyPeriodStart,
    periodEnd: weeklyPeriodEnd,
    sensitivityCeiling: "low",
    audit: modelAudit("weekly-review"),
  }, { idempotencyKey: weeklyRequestId });
  assert(
    Array.isArray(weekly.value?.sections?.singleLoop?.outcomes) &&
      Array.isArray(weekly.value?.sections?.singleLoop?.dueActions) &&
      Array.isArray(weekly.value?.sections?.doubleLoop?.changedClaims) &&
      Array.isArray(weekly.value?.sections?.doubleLoop?.pendingRevisions),
    "weekly review lacks the structured single-loop/double-loop sections",
  );
  logCheck("domain closure", {
    evidence: true,
    tension: true,
    orbitRollback: true,
    action: true,
    revision: true,
    weeklySections: true,
  });

  phase("run real ordinary DeepSeek turn with a successful Domain tool");
  const sessionId = `acceptance-${RUN_NONCE}`;
  const accepted = await postJson(`${agentUrl}/v1/agent/turns`, {
    sessionId,
    clientRequestId: acceptanceId("ordinary-turn"),
    text: "Inspect the isolated acceptance context and answer with one short sentence.",
    systemPrompt: "Acceptance constraint: before answering, you MUST call knowledge_context exactly once with kinds [claim, action, outcome], query acceptance, includeRetracted false, and limit 20. Do not call any mutating tool.",
    budgets: {
      maxSteps: 4,
      maxToolCalls: 2,
      wallClockMs: 90_000,
      maxOutputTokens: 1_024,
    },
  }, {
    idempotencyKey: acceptanceId("ordinary-turn"),
    expectedStatus: 202,
    timeoutMs: 15_000,
  });
  const ordinaryRunId = expectString(accepted.runId, "ordinary turn runId");
  const ordinaryJob = await waitForRun(agentUrl, ordinaryRunId);
  assertCompletedRun(ordinaryJob, "ordinary DeepSeek turn");
  assertSuccessfulTool(ordinaryJob.result, "knowledge_context");
  assert(
    typeof ordinaryJob.result?.assistantText === "string" &&
      ordinaryJob.result.assistantText.trim(),
    "ordinary turn returned no assistant text",
  );
  logCheck("real DeepSeek turn", {
    toolCalls: ordinaryJob.result.toolCallsUsed,
    status: ordinaryJob.result.status,
  });

  phase("run real DeepSeek evidence-backed automatic long-term memory and rollback");
  const automaticMemoryStatement =
    `LATITUDE_ACCEPTANCE_MEMORY_${RUN_NONCE}: explicit low-sensitivity acceptance fact.`;
  const automaticMemoryLabel = `Acceptance automatic memory ${RUN_NONCE}`;
  const memoryAccepted = await postJson(`${agentUrl}/v1/agent/turns`, {
    sessionId,
    clientRequestId: acceptanceId("memory-turn"),
    text: `${automaticMemoryStatement} I explicitly allow this fact to be stored with low sensitivity.`,
    systemPrompt: `Acceptance constraint: call knowledge_remember exactly once and no other tool. Use label ${JSON.stringify(automaticMemoryLabel)}, statement ${JSON.stringify(automaticMemoryStatement)}, kind claim, sensitivity low, scope {"profile":"isolated-acceptance"}, and evidenceRefs containing exactly the CURRENT USER MESSAGE EVIDENCE evidenceRefId injected by the Host for this turn. Do not invent or copy any other identifier.`,
    budgets: {
      maxSteps: 4,
      maxToolCalls: 1,
      wallClockMs: 90_000,
      maxOutputTokens: 1_024,
    },
  }, {
    idempotencyKey: acceptanceId("memory-turn"),
    expectedStatus: 202,
    timeoutMs: 15_000,
  });
  const memoryRunId = expectString(memoryAccepted.runId, "memory turn runId");
  const memoryJob = await waitForRun(agentUrl, memoryRunId);
  assertCompletedRun(memoryJob, "automatic long-term-memory turn");
  assertExactlyOneSuccessfulTool(memoryJob.result, "knowledge_remember");
  const remembered = successfulToolValue(memoryJob.result, "knowledge_remember");
  assert(remembered?.ok === true, "knowledge_remember returned no Domain receipt");
  const automaticMemoryNode = remembered.value?.node ?? remembered.value;
  const automaticMemoryNodeId = expectString(
    automaticMemoryNode?.id,
    "automatic memory node id",
  );
  const automaticMemoryChangeSetId = expectString(
    remembered.changeSetId,
    "automatic memory ChangeSet id",
  );
  assert(
    automaticMemoryNode.origin === "model" &&
      automaticMemoryNode.authority === "system_inferred" &&
      automaticMemoryNode.kind === "claim" &&
      automaticMemoryNode.status === "active",
    "automatic memory was promoted beyond model/system_inferred authority",
  );

  const memoryEvidenceContext = await postJson(`${domainUrl}/v1/context`, {
    kinds: ["evidence_event"],
    includeRetracted: false,
    limit: 100,
  });
  const memoryEvent = memoryEvidenceContext.nodes?.find((node) =>
    node.statement === `${automaticMemoryStatement} I explicitly allow this fact to be stored with low sensitivity.` &&
      node.scope?.turnId === memoryRunId
  );
  const currentMessageEvidenceRefId = expectString(
    memoryEvent?.payload?.evidenceRefId,
    "Host-ingested current-message EvidenceRef",
  );
  assert(
    Array.isArray(automaticMemoryNode.payload?.evidenceRefs) &&
      automaticMemoryNode.payload.evidenceRefs.length === 1 &&
      automaticMemoryNode.payload.evidenceRefs[0] === currentMessageEvidenceRefId,
    "knowledge_remember did not use exactly the Host-provided current-message EvidenceRef",
  );
  const activeAutomaticMemories = await postJson(`${domainUrl}/v1/context`, {
    query: automaticMemoryLabel,
    kinds: ["claim"],
    includeRetracted: false,
    limit: 20,
  });
  assert(
    activeAutomaticMemories.nodes?.filter((node) => node.id === automaticMemoryNodeId).length === 1,
    "automatic acceptance memory was not uniquely active",
  );

  const changeLedger = await getJson(`${domainUrl}/v1/changes?limit=100`);
  const automaticMemoryChange = changeLedger.items?.find((item) =>
    item.id === automaticMemoryChangeSetId
  );
  assert(
    automaticMemoryChange?.proposerActor === "model" &&
      automaticMemoryChange.authorizationMode === "preauthorized" &&
      automaticMemoryChange.reversible === true &&
      Array.isArray(automaticMemoryChange.operations) &&
      automaticMemoryChange.operations.some((operation) =>
        Object.hasOwn(operation, "before") &&
          Object.hasOwn(operation, "after") &&
          Object.hasOwn(operation, "inverse") &&
          operation.after &&
          operation.inverse
      ),
    "automatic memory ChangeSet lacks model/preauthorized reversible before-after-inverse audit",
  );
  const memoryRollbackRequestId = acceptanceId("rollback-automatic-memory");
  const memoryRollback = await postJson(`${domainUrl}/v1/changes`, {
    operation: "rollback",
    clientRequestId: memoryRollbackRequestId,
    changeSetId: automaticMemoryChangeSetId,
    reason: "Acceptance verifies that model-authored long-term memory is reversible",
    audit: modelAudit("rollback-automatic-memory"),
  }, { idempotencyKey: memoryRollbackRequestId });
  assert(memoryRollback.ok === true, "automatic memory rollback failed");
  const contextAfterMemoryRollback = await postJson(`${domainUrl}/v1/context`, {
    query: automaticMemoryLabel,
    kinds: ["claim"],
    includeRetracted: false,
    limit: 20,
  });
  assert(
    !contextAfterMemoryRollback.nodes?.some((node) => node.id === automaticMemoryNodeId),
    "rolled-back automatic memory remains active in context",
  );
  logCheck("automatic long-term memory", {
    hostEvidence: true,
    exactEvidenceRef: true,
    authority: "system_inferred",
    reversibleAudit: true,
    rollbackReadback: true,
  });

  phase("run real DeepSeek UiSurfaceV2 customization with one atomic ChangeSet");
  const uiAccepted = await postJson(`${agentUrl}/v1/agent/turns`, {
    sessionId,
    clientRequestId: acceptanceId("ui-turn"),
    text: "把桌面里的行动卡标题改成验收行动，并保留其他模块。",
    systemPrompt: "Acceptance constraint: call ui_customize exactly once and no other tool. Use schemaVersion 2, surfaceId latitude-browser-live, baseRevision 3, rationale Acceptance UI atomic ChangeSet, exactly two operations: set_props for componentId seed-schedule with presentation title 验收行动 and eyebrow ANCHORS; then set_visibility for componentId secretary-companion with visible true.",
    budgets: {
      maxSteps: 4,
      maxToolCalls: 2,
      wallClockMs: 90_000,
      maxOutputTokens: 1_024,
    },
  }, {
    idempotencyKey: acceptanceId("ui-turn"),
    expectedStatus: 202,
    timeoutMs: 15_000,
  });
  const uiRunId = expectString(uiAccepted.runId, "UI turn runId");
  const uiJob = await waitForRun(agentUrl, uiRunId);
  assertCompletedRun(uiJob, "UiSurfaceV2 turn");
  assertSuccessfulTool(uiJob.result, "ui_customize");
  assert(uiJob.result?.uiChangeSet?.schemaVersion === 2, "UI run lacks V2 projection");
  assert(
    uiJob.result?.uiChangeSet?.surfaceId === "latitude-browser-live" &&
      uiJob.result.uiChangeSet.baseRevision === 3,
    "UI run surface/CAS projection drifted",
  );
  assert(
    Array.isArray(uiJob.result?.uiChangeSet?.operations) &&
      uiJob.result.uiChangeSet.operations.length === 2 &&
      uiJob.result.uiChangeSet.operations[0]?.op === "set_props" &&
      uiJob.result.uiChangeSet.operations[1]?.op === "set_visibility" &&
      uiJob.result.uiChangeSet.operations[1]?.componentId === "secretary-companion",
    "UI run did not preserve the atomic raw operation",
  );
  const uiNodeId = expectString(uiJob.result.uiChangeSet.domainNodeId, "UI resource node id");
  const uiContext = await postJson(`${domainUrl}/v1/context`, {
    query: "Acceptance UI atomic ChangeSet",
    kinds: ["resource"],
    includeRetracted: false,
    limit: 20,
  });
  const uiResource = uiContext.nodes?.find((node) => node.id === uiNodeId);
  assert(
    uiResource?.payload?.schemaVersion === 2 &&
      uiResource.payload.surfaceId === "latitude-browser-live" &&
      uiResource.payload.baseLayoutId === "latitude-browser-live" &&
      Array.isArray(uiResource.payload.operations) &&
      uiResource.payload.operations.length === 2,
    "persisted UI resource does not match the V2 run projection",
  );
  logCheck("real UiSurfaceV2 ChangeSet", {
    toolCalls: uiJob.result.toolCallsUsed,
    rawOperations: uiJob.result.uiChangeSet.operations.length,
    persistedResource: true,
  });

  phase("run real DeepSeek Web Search with explicit freshness coverage");
  const search = await postJson(`${agentUrl}/v1/web/search`, {
    query: "recent primary technical research on reliable local AI agents",
    maxResults: 5,
    freshnessDays: 3_650,
  }, { timeoutMs: 90_000 });
  assert(search.coverage?.mode === "published_at_post_filter", "freshness mode was not explicit");
  assert(search.coverage?.providerSupportsFreshness === false, "provider freshness capability drifted");
  assert(search.coverage?.exhaustive === false, "search coverage must remain non-exhaustive");
  assert(
    Number.isInteger(search.coverage?.providerResultCount) &&
      search.coverage.providerResultCount > 0,
    "real provider returned no search candidates",
  );
  assert(Array.isArray(search.results), "search results must be an array");
  for (const result of search.results) {
    assert(typeof result.contentHash === "string", "search result lacks contentHash");
    assert(typeof result.evidenceRefId === "string", "search result was not persisted as evidence");
  }
  logCheck("real Web Search", {
    providerCandidates: search.coverage.providerResultCount,
    returned: search.results.length,
    excludedUndated: search.coverage.excludedUndatedCount,
    excludedStale: search.coverage.excludedStaleCount,
  });

  phase("wait for durable daily curation outbox");
  await postJson(`${agentUrl}/v1/scheduler/wake`, {}, { expectedStatus: 202 });
  const curationState = await waitForCurationState(agentUrl);
  if (curationState.item) {
    assert(curationState.item.deliveryStatus === "pending", "curation outbox was not pending");
    assert(
      typeof curationState.item.text === "string" && curationState.item.text.trim(),
      "curation text is empty",
    );
    logCheck("scheduler outbox", {
      kind: curationState.item.kind,
      pending: true,
      maxItems: 3,
    });
  } else {
    logCheck("scheduler outbox", {
      kind: "daily_curation",
      pending: false,
      honestEmptyFreshnessCoverage: true,
    });
  }

  phase("restart both services and verify durable read models");
  await stopServices();
  domainProcess = startDomain(sandbox, domainPort);
  await waitForHealth(`${domainUrl}/health`, "domain restart", (body) =>
    body.ok === true && body.status === "ready"
  );
  agentProcess = startAgent(sandbox, agentPort, domainUrl);
  await waitForHealth(`${agentUrl}/health`, "agent restart", (body) => body.status === "ready");
  await verifyDurableReadback({
    domainUrl,
    agentUrl,
    sessionId,
    goalId,
    preferenceId,
    tensionId,
    eventNodeId,
    outcomeEventNodeId,
    revisedClaimId,
    curationReceiptKey: curationState.receiptKey,
    expectedCurationDeliveryStatus: curationState.item ? "pending" : "absent",
  });

  phase("export and verify Domain + Agent integrity");
  const domainIntegrity = await getJson(`${domainUrl}/v1/admin/integrity`);
  const agentIntegrity = await getJson(`${agentUrl}/v1/agent/admin/integrity`);
  assert(domainIntegrity.ok === true, "Domain integrity failed before export");
  assert(agentIntegrity.ok === true, "Agent integrity failed before export");
  const domainSnapshot = await getJson(`${domainUrl}/v1/admin/export`, 60_000);
  const agentSnapshot = await getJson(`${agentUrl}/v1/agent/admin/export`, 60_000);
  assert(/^sha256:[a-f0-9]{64}$/.test(domainSnapshot.checksum), "Domain export checksum invalid");
  assert(/^[a-f0-9]{64}$/.test(agentSnapshot.checksum), "Agent export checksum invalid");

  // Mutate both services after their snapshots. Restore must remove/revert these
  // changes, proving the operation is not merely a no-op checksum check.
  const postSnapshotMarker = await remember(domainUrl, {
    label: "Post snapshot marker",
    statement: "This marker must disappear after acceptance restore.",
    kind: "resource",
    payload: { acceptancePostSnapshot: true },
    scope: { profile: "isolated-acceptance" },
    audit: modelAudit("post-snapshot"),
  });
  const postSnapshotMarkerId = nodeId(postSnapshotMarker, "post-snapshot marker");
  const postSnapshotSessionId = `acceptance-post-snapshot-${RUN_NONCE}`;
  const postSnapshotTurn = await postJson(`${agentUrl}/v1/agent/turns`, {
    sessionId: postSnapshotSessionId,
    clientRequestId: acceptanceId("post-snapshot-turn"),
    text: "Reply with the single word retained.",
    systemPrompt: "Do not call tools. Reply with exactly: retained",
    budgets: {
      maxSteps: 2,
      maxToolCalls: 1,
      wallClockMs: 60_000,
      maxOutputTokens: 64,
    },
  }, {
    idempotencyKey: acceptanceId("post-snapshot-turn"),
    expectedStatus: 202,
  });
  const postSnapshotJob = await waitForRun(
    agentUrl,
    expectString(postSnapshotTurn.runId, "post-snapshot runId"),
  );
  assertCompletedRun(postSnapshotJob, "post-snapshot Agent marker turn");
  if (curationState.item) {
    const acknowledged = await postJson(
      `${agentUrl}/v1/scheduler/outbox/${encodeURIComponent(curationState.receiptKey)}/ack`,
      {},
    );
    assert(acknowledged.deliveryStatus === "acknowledged", "outbox ack did not persist");
  }

  phase("two-stage restore inside verified acceptance sandbox");
  await assertOwnedSandbox(sandbox);
  const domainPrepared = await postJson(`${domainUrl}/v1/admin/dangerous/prepare`, {
    operation: "restore",
    snapshot: domainSnapshot,
  }, { expectedStatus: 202, timeoutMs: 60_000 });
  assert(domainPrepared.requiredConfirmation === "RESTORE LOCAL DATA", "Domain restore phrase drifted");
  const domainRestore = await postJson(`${domainUrl}/v1/admin/dangerous/commit`, {
    token: expectString(domainPrepared.token, "Domain restore token"),
    confirmation: "RESTORE LOCAL DATA",
  }, { timeoutMs: 60_000 });
  assert(domainRestore.ok === true, "Domain restore failed");

  await assertOwnedSandbox(sandbox);
  const agentPrepared = await postJson(`${agentUrl}/v1/agent/admin/dangerous/prepare`, {
    operation: "restore",
    snapshot: agentSnapshot,
  }, { expectedStatus: 202, timeoutMs: 60_000 });
  assert(agentPrepared.confirmationPhrase === "RESTORE LOCAL DATA", "Agent restore phrase drifted");
  const agentRestore = await postJson(`${agentUrl}/v1/agent/admin/dangerous/commit`, {
    token: expectString(agentPrepared.token, "Agent restore token"),
    confirmation: "RESTORE LOCAL DATA",
  }, { timeoutMs: 60_000 });
  assert(agentRestore.ok === true && agentRestore.restartRequired === true, "Agent restore failed");

  phase("restart after restore and verify exact snapshots");
  await stopServices();
  domainProcess = startDomain(sandbox, domainPort);
  await waitForHealth(`${domainUrl}/health`, "restored domain", (body) =>
    body.ok === true && body.status === "ready"
  );
  agentProcess = startAgent(sandbox, agentPort, domainUrl);
  await waitForHealth(`${agentUrl}/health`, "restored agent", (body) => body.status === "ready");

  const restoredDomainIntegrity = await getJson(`${domainUrl}/v1/admin/integrity`);
  const restoredAgentIntegrity = await getJson(`${agentUrl}/v1/agent/admin/integrity`);
  assert(restoredDomainIntegrity.ok === true, "restored Domain integrity failed");
  assert(restoredAgentIntegrity.ok === true, "restored Agent integrity failed");
  const restoredDomainSnapshot = await getJson(`${domainUrl}/v1/admin/export`, 60_000);
  const restoredAgentSnapshot = await getJson(`${agentUrl}/v1/agent/admin/export`, 60_000);
  assert(restoredDomainSnapshot.checksum === domainSnapshot.checksum, "Domain restore checksum mismatch");
  assert(/^[a-f0-9]{64}$/.test(restoredAgentSnapshot.checksum), "restored Agent checksum invalid");
  const markerContext = await postJson(`${domainUrl}/v1/context`, {
    query: "Post snapshot marker",
    kinds: ["resource"],
    includeRetracted: true,
    limit: 20,
  });
  assert(
    !markerContext.nodes?.some((node) => node.id === postSnapshotMarkerId),
    "post-snapshot Domain marker survived restore",
  );
  await verifyDurableReadback({
    domainUrl,
    agentUrl,
    sessionId,
    goalId,
    preferenceId,
    tensionId,
    eventNodeId,
    outcomeEventNodeId,
    revisedClaimId,
    curationReceiptKey: curationState.receiptKey,
    expectedCurationDeliveryStatus: curationState.item ? "pending" : "absent",
  });
  const postSnapshotMessages = await getJson(
    `${agentUrl}/v1/agent/sessions/${encodeURIComponent(postSnapshotSessionId)}/messages?limit=100`,
  );
  assert(
    Array.isArray(postSnapshotMessages.messages) && postSnapshotMessages.messages.length === 0,
    "post-snapshot Agent session survived restore",
  );

  phase("scan isolated artifacts for credential leakage");
  await assertOwnedSandbox(sandbox);
  await assertCredentialAbsent([
    sandbox.domainDir,
    sandbox.agentStateDir,
    path.join(WORKSPACE, "build"),
    path.join(WORKSPACE, "dist"),
  ], MODEL_KEY);
  succeeded = true;
  logCheck("acceptance", {
    status: "passed",
    domainChecksum: domainSnapshot.checksum.slice(0, 15),
    agentChecksum: agentSnapshot.checksum.slice(0, 12),
  });
} catch (error) {
  process.exitCode = 1;
  const message = sanitize(error instanceof Error ? error.message : String(error));
  process.stderr.write(`[accept-local] FAILED: ${message}\n`);
  for (const child of [domainProcess, agentProcess]) {
    if (child?.recent?.length) {
      process.stderr.write(`[accept-local] ${child.name} recent output:\n`);
      for (const line of child.recent.slice(-20)) {
        process.stderr.write(`  ${sanitize(line)}\n`);
      }
    }
  }
} finally {
  await stopServices();
  if (sandbox) {
    if (succeeded && !KEEP_ON_SUCCESS && !interrupted) {
      await assertOwnedSandbox(sandbox);
      await rm(sandbox.root, { recursive: true, force: true });
      process.stdout.write("[accept-local] isolated sandbox cleaned\n");
    } else {
      process.stderr.write(`[accept-local] isolated sandbox retained: ${sandbox.root}\n`);
    }
  }
}

function assertRuntime() {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major !== 22) throw new Error(`Node 22.x is required; current ${process.versions.node}`);
  if (!MODEL_KEY) {
    throw new Error("DEEPSEEK_API_KEY is missing or is a known placeholder");
  }
}

async function createOwnedSandbox() {
  // macOS exposes /var as a system symlink to /private/var. Canonicalize the
  // directory immediately so later ownership checks still reject any symlink
  // inside the sandbox without rejecting the OS temporary-root alias itself.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), SANDBOX_PREFIX)));
  const marker = { owner: "latitude-local-acceptance", nonce: RUN_NONCE, createdAt: new Date().toISOString() };
  await writeFile(path.join(root, OWNER_FILE), `${JSON.stringify(marker)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  const domainDir = path.join(root, "domain");
  const backupDir = path.join(domainDir, "backups");
  const agentStateDir = path.join(root, "agent");
  const cargoTargetDir = path.join(root, "cargo-target");
  await Promise.all([
    mkdir(backupDir, { recursive: true, mode: 0o700 }),
    mkdir(agentStateDir, { recursive: true, mode: 0o700 }),
    mkdir(cargoTargetDir, { recursive: true, mode: 0o700 }),
  ]);
  const value = {
    root,
    nonce: RUN_NONCE,
    domainDir,
    dbPath: path.join(domainDir, "latitude-domain.db"),
    backupDir,
    agentStateDir,
    cargoTargetDir,
  };
  await assertOwnedSandbox(value);
  return value;
}

async function assertOwnedSandbox(value) {
  const root = path.resolve(value.root);
  const tempRoot = `${await realpath(os.tmpdir())}${path.sep}`;
  assert(root.startsWith(tempRoot), "acceptance sandbox is outside the system temporary root");
  assert(path.basename(root).startsWith(SANDBOX_PREFIX), "acceptance sandbox prefix mismatch");
  const rootStat = await lstat(root);
  assert(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "acceptance sandbox is not a real directory");
  const resolvedRoot = await realpath(root);
  assert(resolvedRoot === root, "acceptance sandbox resolves through a symlink");
  const marker = JSON.parse(await readFile(path.join(root, OWNER_FILE), "utf8"));
  assert(marker.owner === "latitude-local-acceptance", "acceptance owner marker mismatch");
  assert(marker.nonce === value.nonce, "acceptance owner nonce mismatch");
  for (const target of [value.dbPath, value.backupDir, value.agentStateDir, value.cargoTargetDir]) {
    const relative = path.relative(root, path.resolve(target));
    assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "acceptance target escaped sandbox");
    const existing = await stat(path.dirname(target));
    assert(existing.isDirectory(), "acceptance target parent is not a directory");
  }
}

async function allocateDistinctLoopbackPorts() {
  const first = await freePort();
  let second = await freePort();
  while (second === first) second = await freePort();
  return [first, second];
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) reject(error);
        else if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          reject(new Error("OS did not allocate a valid loopback port"));
        } else resolve(port);
      });
    });
  });
}

function startDomain(value, port) {
  const env = withoutCredentials(process.env);
  Object.assign(env, {
    LATITUDE_DB_PATH: value.dbPath,
    LATITUDE_BACKUP_DIR: value.backupDir,
    LATITUDE_DOMAIN_ADDR: `127.0.0.1:${port}`,
    CARGO_TARGET_DIR: value.cargoTargetDir,
  });
  return trackedSpawn("domain", "cargo", [
    "run",
    "--quiet",
    "--manifest-path",
    "src-tauri/domain-service/Cargo.toml",
    "--bin",
    "latitude-domain",
  ], env);
}

function startAgent(value, port, domainUrl) {
  const env = {
    ...agentEnvironment(process.env),
    LATITUDE_STATE_DIR: value.agentStateDir,
    LATITUDE_AGENT_PORT: String(port),
    LATITUDE_DOMAIN_URL: domainUrl,
    LATITUDE_SCHEDULER_POLL_MS: "5000",
  };
  return trackedSpawn("agent", process.execPath, [
    "--import",
    "tsx",
    "services/agent/src/index.ts",
  ], env);
}

function trackedSpawn(name, command, args, env) {
  const child = spawn(command, args, {
    cwd: WORKSPACE,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.name = name;
  child.recent = [];
  for (const stream of [child.stdout, child.stderr]) {
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        child.recent.push(sanitize(line));
        if (child.recent.length > 80) child.recent.shift();
      }
    });
    stream.on("end", () => {
      if (pending.trim()) child.recent.push(sanitize(pending));
    });
  }
  return child;
}

async function stopServices() {
  const active = [agentProcess, domainProcess].filter(Boolean);
  agentProcess = undefined;
  domainProcess = undefined;
  await Promise.all(active.map(stopChild));
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const timeout = new Promise((resolve) => setTimeout(resolve, 8_000, "timeout"));
  if (await Promise.race([exited, timeout]) === "timeout") {
    child.kill("SIGKILL");
    await exited;
  }
}

async function waitForHealth(url, label, predicate) {
  const deadline = Date.now() + ACCEPT_TIMEOUT_MS;
  let last = "not reachable";
  while (Date.now() < deadline) {
    const child = label.includes("agent") ? agentProcess : domainProcess;
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`${label} exited before readiness`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      const body = await response.json();
      if (response.ok && predicate(body)) return body;
      last = `HTTP ${response.status}, status=${String(body?.status ?? "missing")}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(350);
  }
  throw new Error(`${label} health timed out: ${last}`);
}

async function waitForRun(agentUrl, runId) {
  const deadline = Date.now() + ACCEPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const job = await getJson(`${agentUrl}/v1/agent/runs/${encodeURIComponent(runId)}`);
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    await delay(500);
  }
  throw new Error("ordinary DeepSeek turn timed out");
}

async function waitForCurationState(agentUrl) {
  const deadline = Date.now() + ACCEPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const [outbox, receiptResponse] = await Promise.all([
      getJson(`${agentUrl}/v1/scheduler/outbox`),
      getJson(`${agentUrl}/v1/scheduler/receipts`),
    ]);
    const item = Array.isArray(outbox.items)
      ? outbox.items.find((candidate) => candidate.kind === "daily_curation")
      : undefined;
    if (item) return { receiptKey: item.receiptKey, item };
    const receipt = Array.isArray(receiptResponse.receipts)
      ? receiptResponse.receipts.find((candidate) => candidate.kind === "daily_curation")
      : undefined;
    if (receipt?.runId) {
      const job = await getJson(
        `${agentUrl}/v1/agent/runs/${encodeURIComponent(receipt.runId)}`,
      );
      if (["failed", "cancelled"].includes(job.status)) {
        const attempt = Number.isInteger(receipt.attempt) ? receipt.attempt : 1;
        if (
          attempt >= 3 &&
          receipt.lastStatus === job.status &&
          !receipt.nextAttemptAt
        ) {
          const failure = stableRunFailure(job);
          throw new Error(
            `daily curation exhausted ${attempt} attempts (${failure.code}): ${failure.message}`,
          );
        }
      }
      if (job.status === "completed") {
        const toolResult = successfulToolValue(job.result, "daily_web_curate");
        if (!toolResult) {
          throw new Error("daily curation completed without a successful bounded search");
        }
        assert(
          toolResult.coverage?.mode === "published_at_post_filter" &&
            toolResult.coverage?.exhaustive === false,
          "daily curation omitted honest freshness coverage",
        );
        const itemCount = Array.isArray(toolResult.items) ? toolResult.items.length : -1;
        if (itemCount === 0) {
          return { receiptKey: receipt.receiptKey, item: undefined };
        }
        throw new Error("daily curation persisted items but produced no outbox entry");
      }
    }
    await postJson(`${agentUrl}/v1/scheduler/wake`, {}, { expectedStatus: 202 });
    await delay(1_000);
  }
  throw new Error("daily curation did not reach a durable terminal state");
}

async function verifyDurableReadback({
  domainUrl,
  agentUrl,
  sessionId,
  goalId,
  preferenceId,
  tensionId,
  eventNodeId,
  outcomeEventNodeId,
  revisedClaimId,
  curationReceiptKey,
  expectedCurationDeliveryStatus,
}) {
  const messages = await getJson(
    `${agentUrl}/v1/agent/sessions/${encodeURIComponent(sessionId)}/messages?limit=100`,
  );
  assert(messages.messages?.some((message) => message.role === "user"), "user message did not survive restart");
  assert(messages.messages?.some((message) => message.role === "assistant"), "assistant message did not survive restart");
  const context = await postJson(`${domainUrl}/v1/context`, {
    kinds: ["evidence_event", "claim", "goal", "tension", "interest", "action", "outcome"],
    includeRetracted: false,
    limit: 100,
  });
  const ids = new Set((context.nodes ?? []).map((node) => node.id));
  for (const [label, id] of [
    ["revised claim", revisedClaimId],
    ["goal", goalId],
    ["preference", preferenceId],
    ["tension", tensionId],
    ["message event", eventNodeId],
    ["outcome message event", outcomeEventNodeId],
  ]) assert(ids.has(id), `${label} did not survive restart`);
  const receipts = await getJson(`${agentUrl}/v1/scheduler/receipts`);
  assert(
    receipts.receipts?.some((candidate) => candidate.receiptKey === curationReceiptKey),
    "scheduler receipt did not survive restart/restore",
  );
  const outbox = await getJson(`${agentUrl}/v1/scheduler/outbox`);
  const item = outbox.items?.find((candidate) => candidate.receiptKey === curationReceiptKey);
  if (expectedCurationDeliveryStatus === "absent") {
    assert(!item, "empty curation unexpectedly produced an outbox item after restart/restore");
  } else {
    assert(
      item?.deliveryStatus === expectedCurationDeliveryStatus,
      "scheduler delivery state did not survive restart/restore",
    );
  }
}

function assertSuccessfulTool(result, name) {
  assert(result && Number(result.toolCallsUsed) >= 1, "real turn used no tool");
  const calls = (result.events ?? []).filter((event) =>
    event.type === "tool/call" && event.data?.name === name
  );
  assert(calls.length >= 1, `real turn did not call ${name}`);
  const successful = calls.some((call) =>
    (result.events ?? []).some((event) =>
      event.type === "tool/result" &&
      event.data?.message?.source?.callId === call.data.callId &&
      !event.data?.error
    )
  );
  assert(successful, `${name} did not return a successful tool result`);
}

function assertExactlyOneSuccessfulTool(result, name) {
  const calls = (result?.events ?? []).filter((event) => event.type === "tool/call");
  assert(
    Number(result?.toolCallsUsed) === 1 &&
      calls.length === 1 &&
      calls[0]?.data?.name === name,
    `real turn must call exactly one ${name} tool`,
  );
  assertSuccessfulTool(result, name);
}

function successfulToolValue(result, name) {
  const callIds = new Set((result?.events ?? []).flatMap((event) =>
    event.type === "tool/call" && event.data?.name === name
      ? [event.data.callId]
      : []
  ));
  for (const event of result?.events ?? []) {
    if (
      event.type !== "tool/result" ||
      event.data?.error ||
      !callIds.has(event.data?.message?.source?.callId)
    ) continue;
    const resultBlock = event.data.message.content?.find((block) => block.type === "tool-result");
    if (!resultBlock || resultBlock.isError) continue;
    const text = (resultBlock.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function compileContext(domainUrl, seedNodeId) {
  return postJson(`${domainUrl}/v1/star-map/compile-context`, {
    seedNodeIds: [seedNodeId],
    needs: ["orbit", "provenance"],
    timeScope: {},
    epistemicPolicy: { canonicalOnly: false, includeObservations: true },
    sensitivityPolicy: { ceiling: "low" },
    budget: { maxNodes: 30, maxEdges: 50, maxDepth: 2 },
    audit: modelAudit("compile-context"),
  });
}

async function remember(domainUrl, input) {
  const clientRequestId = acceptanceId(`remember-${input.kind}`);
  return postJson(`${domainUrl}/v1/changes`, {
    operation: "remember",
    clientRequestId,
    sensitivity: "low",
    ...input,
  }, { idempotencyKey: clientRequestId });
}

function nodeId(response, label) {
  return expectString(response.value?.id ?? response.value?.node?.id, `${label} node id`);
}

function userAudit(turn) {
  return {
    actor: "user",
    sessionId: "isolated-acceptance",
    turnId: acceptanceId(turn),
    authorizationMode: "automatic",
  };
}

function modelAudit(turn) {
  return {
    actor: "model",
    sessionId: "isolated-acceptance",
    turnId: acceptanceId(turn),
    toolCallId: acceptanceId(`tool-${turn}`),
    authorizationMode: "preauthorized",
  };
}

function acceptanceId(label) {
  return `accept:${label}:${RUN_NONCE}`;
}

async function getJson(url, timeoutMs = 15_000) {
  return requestJson(url, { timeoutMs });
}

async function postJson(url, body, options = {}) {
  return requestJson(url, { ...options, method: "POST", body });
}

async function requestJson(url, {
  method = "GET",
  body,
  idempotencyKey,
  expectedStatus = 200,
  timeoutMs = 15_000,
} = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`${method} ${new URL(url).pathname} returned invalid JSON`);
  }
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  if (!expected.includes(response.status)) {
    const code = typeof parsed?.error?.code === "string"
      ? parsed.error.code
      : typeof parsed?.code === "string"
        ? parsed.code
        : "unknown";
    throw new Error(`${method} ${new URL(url).pathname} failed HTTP ${response.status} (${code})`);
  }
  return parsed;
}

async function assertCredentialAbsent(targets, credential) {
  const needle = Buffer.from(credential);
  for (const target of targets) {
    const files = await regularFilesIfPresent(target);
    for (const file of files) {
      const content = await readFile(file);
      assert(
        !content.includes(needle),
        `credential materialized in ${path.relative(WORKSPACE, file)}`,
      );
    }
  }
}

async function regularFilesIfPresent(target) {
  let metadata;
  try {
    metadata = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (metadata.isSymbolicLink()) throw new Error(`refusing to scan symlink: ${target}`);
  if (metadata.isFile()) return [target];
  if (!metadata.isDirectory()) return [];
  return regularFiles(target);
}

async function regularFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlink found in acceptance sandbox: ${entry.name}`);
    if (entry.isDirectory()) files.push(...await regularFiles(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function configuredDeepSeekKey(value) {
  const key = value?.trim() ?? "";
  if (!key) return "";
  if (["replace-with-local-server-key", "your-api-key", "your-deepseek-api-key", "changeme"]
    .includes(key.toLowerCase())) return "";
  return key;
}

function withoutCredentials(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) =>
    !/(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)$/iu.test(name)
  ));
}

function agentEnvironment(environment) {
  const safe = withoutCredentials(environment);
  for (const name of [
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "DEEPSEEK_SEARCH_BASE_URL",
    "DEEPSEEK_MODEL",
  ]) {
    if (environment[name] !== undefined) safe[name] = environment[name];
  }
  return safe;
}

function positiveInteger(raw, fallback, name) {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function expectString(value, label) {
  assert(typeof value === "string" && value, `${label} is missing`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function phase(name) {
  process.stdout.write(`[accept-local] ${name}\n`);
}

function logCheck(name, values) {
  process.stdout.write(`[accept-local] ${name}: ${JSON.stringify(values)}\n`);
}

function sanitize(value) {
  let text = String(value);
  if (MODEL_KEY) text = text.split(MODEL_KEY).join("[REDACTED]");
  return text.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED]");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

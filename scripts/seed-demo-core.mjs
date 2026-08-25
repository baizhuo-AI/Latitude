import { readFile } from "node:fs/promises";

const NODE_KINDS = new Set([
  "action",
  "claim",
  "goal",
  "insight",
  "method",
  "resource",
  "tension",
]);
const ACTORS = new Set(["user", "importer"]);
const GOAL_HORIZONS = new Set(["north-star", "medium-term", "short-term"]);
const FIXTURE_NODE_COUNT = 30;

const FORBIDDEN_FIXTURE_PATTERNS = [
  ["URL", /(?:https?:\/\/|www\.)/iu],
  ["email address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu],
  ["mainland phone number", /(?<!\d)1[3-9]\d{9}(?!\d)/u],
  ["credential-shaped value", /\b(?:sk|token|secret|password)[-_=:][A-Z0-9_-]{8,}\b/iu],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/u],
  ["GitHub credential", /\b(?:gh[pousr]_[A-Z0-9]{20,}|github_pat_[A-Z0-9_]{20,})\b/iu],
  ["Slack credential", /\bxox[baprs]-[A-Z0-9-]{10,}\b/iu],
  ["Bearer credential", /\bBearer\s+[A-Z0-9._~+\/-]{8,}={0,2}\b/iu],
  ["private key material", /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/iu],
  ["macOS user path", /\/Users\//u],
  ["mounted-volume path", /\/Volumes\//u],
  ["home-directory path", /(?:~\/|\/home\/)/u],
  ["Windows absolute path", /\b[A-Z]:\\\\/iu],
  ["UNC path", /\\\\\\\\[^\\\/"\s]+\\\\[^\\\/"\s]+/u],
  ["IPv4 address", /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/u],
  ["UUID", /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu],
  ["device or account identifier", /"(?:accountId|bundleId|deviceId|serialNumber|windowTitle|selectedText|typedText)"\s*:/iu],
  ["raw capture filename", /(?:\.wav\b|events\.jsonl\b|full60\b|813\d{4})/iu],
  ["named source customer", /(?:农业银行|招商银行|中国农业银行|农行)/u],
];

export async function readDemoFixture(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function validateDemoFixture(fixture) {
  if (!isRecord(fixture) || fixture.schemaVersion !== 2) {
    throw new TypeError("Demo fixture must use schemaVersion 2");
  }
  assertString(fixture.profileId, "profileId");
  if (!Array.isArray(fixture.retiredProfileIds)) {
    throw new TypeError("Demo fixture must contain retiredProfileIds");
  }
  const retiredProfileIds = new Set();
  for (const value of fixture.retiredProfileIds) {
    assertString(value, "retiredProfileIds[]");
    if (value === fixture.profileId || retiredProfileIds.has(value)) {
      throw new TypeError("retiredProfileIds must be unique and exclude the current profile");
    }
    retiredProfileIds.add(value);
  }
  if (!isRecord(fixture.userDirection)) {
    throw new TypeError("Demo fixture must contain userDirection");
  }
  assertString(fixture.userDirection.messageId, "userDirection.messageId");
  assertString(fixture.userDirection.content, "userDirection.content");
  if (!Array.isArray(fixture.nodes) || fixture.nodes.length !== FIXTURE_NODE_COUNT) {
    throw new TypeError(`Demo fixture must contain exactly ${FIXTURE_NODE_COUNT} nodes`);
  }

  const nodesBySeed = new Map();
  const indexBySeed = new Map();
  for (const [index, node] of fixture.nodes.entries()) {
    if (!isRecord(node)) throw new TypeError(`nodes[${index}] must be an object`);
    assertString(node.seedKey, `nodes[${index}].seedKey`);
    if (nodesBySeed.has(node.seedKey)) {
      throw new TypeError(`Duplicate demo seedKey: ${node.seedKey}`);
    }
    nodesBySeed.set(node.seedKey, node);
    indexBySeed.set(node.seedKey, index);
    if (!NODE_KINDS.has(node.kind)) {
      throw new TypeError(`Unsupported demo node kind: ${String(node.kind)}`);
    }
    if (node.kind === "goal" && !GOAL_HORIZONS.has(node.payload?.horizon)) {
      throw new TypeError(`Goal ${node.seedKey} has an invalid horizon`);
    }
    if (!ACTORS.has(node.actor)) {
      throw new TypeError(`Unsupported demo node actor: ${String(node.actor)}`);
    }
    assertString(node.label, `nodes[${index}].label`);
    assertString(node.statement, `nodes[${index}].statement`);
    if (!isRecord(node.payload)) {
      throw new TypeError(`nodes[${index}].payload must be an object`);
    }
    assertString(node.payload.horizon, `nodes[${index}].payload.horizon`);
    assertString(node.payload.surfaceRole, `nodes[${index}].payload.surfaceRole`);
    assertString(node.payload.desktopRole, `nodes[${index}].payload.desktopRole`);
    assertStringArray(node.payload.boardTags, `nodes[${index}].payload.boardTags`);
    if (node.sensitivity !== "low") {
      throw new TypeError(`Demo node ${node.seedKey} must be low sensitivity after redaction`);
    }
    if (node.kind === "action") {
      if (node.writeMode !== "action") {
        throw new TypeError(`Action ${node.seedKey} must use writeMode=action`);
      }
      for (const field of ["expectedOutcome", "trigger", "reviewAt"]) {
        assertString(node[field], `${node.seedKey}.${field}`);
      }
      if (!isRecord(node.observationWindow)) {
        throw new TypeError(`${node.seedKey}.observationWindow must be an object`);
      }
      if (!Number.isFinite(Date.parse(node.reviewAt))) {
        throw new TypeError(`${node.seedKey}.reviewAt must be an RFC3339 timestamp`);
      }
    } else if (node.writeMode !== undefined) {
      throw new TypeError(`Only action nodes may declare writeMode`);
    }
  }

  const requireEarlierPointer = (node, seedField, expectedKind, expectedHorizon) => {
    const seedKey = node[seedField];
    if (seedKey === undefined) return undefined;
    assertString(seedKey, `${node.seedKey}.${seedField}`);
    const target = nodesBySeed.get(seedKey);
    if (!target) throw new TypeError(`Unknown ${seedField} ${seedKey} on ${node.seedKey}`);
    if (target.kind !== expectedKind || (expectedHorizon && target.payload.horizon !== expectedHorizon)) {
      throw new TypeError(`${node.seedKey}.${seedField} targets the wrong node type or horizon`);
    }
    if (indexBySeed.get(seedKey) >= indexBySeed.get(node.seedKey)) {
      throw new TypeError(`${node.seedKey}.${seedField} must target an earlier fixture node`);
    }
    return target;
  };

  for (const node of fixture.nodes) {
    requireEarlierPointer(node, "goalSeedKey", "goal");
    requireEarlierPointer(node, "mediumGoalSeedKey", "goal", "medium-term");
    requireEarlierPointer(node, "northStarSeedKey", "goal", "north-star");
    if (node.relatedSeedKeys !== undefined) {
      assertStringArray(node.relatedSeedKeys, `${node.seedKey}.relatedSeedKeys`);
      for (const seedKey of node.relatedSeedKeys) {
        if (!nodesBySeed.has(seedKey) || indexBySeed.get(seedKey) >= indexBySeed.get(node.seedKey)) {
          throw new TypeError(`${node.seedKey}.relatedSeedKeys must target earlier fixture nodes`);
        }
      }
    }
  }

  const goals = fixture.nodes.filter((node) => node.kind === "goal");
  for (const goal of goals) {
    if (goal.actor !== "user") {
      throw new TypeError(`Goal ${goal.seedKey} must be user-authored`);
    }
    if (!GOAL_HORIZONS.has(goal.payload.horizon)) {
      throw new TypeError(`Goal ${goal.seedKey} has an invalid horizon`);
    }
    const parent = goal.parentSeedKey
      ? requireEarlierPointer(goal, "parentSeedKey", "goal")
      : undefined;
    if (goal.payload.horizon === "north-star") {
      if (parent || goal.payload.surfaceRole !== "constellation.north-star") {
        throw new TypeError("North-star goal must be root and use constellation.north-star");
      }
    } else if (goal.payload.horizon === "medium-term") {
      if (parent?.payload.horizon !== "north-star" || goal.payload.surfaceRole !== "clue.theme") {
        throw new TypeError(`Medium-term goal ${goal.seedKey} must point to north-star and route to clues`);
      }
    } else if (parent?.payload.horizon !== "medium-term" || goal.payload.surfaceRole !== "desktop.goal") {
      throw new TypeError(`Short-term goal ${goal.seedKey} must point to medium-term and route to desktop`);
    }
  }
  for (const node of fixture.nodes.filter((candidate) => candidate.kind !== "goal")) {
    if (node.actor !== "importer" || node.parentSeedKey !== undefined) {
      throw new TypeError(`Non-goal ${node.seedKey} must be an importer node without parentSeedKey`);
    }
  }

  assertLabels(goals.filter((node) => node.payload.horizon === "north-star"), ["实现 AGI"], "north-star");
  assertLabels(goals.filter((node) => node.payload.horizon === "medium-term"), [
    "完成客户交付",
    "寻找新 Agent 方向",
  ], "medium-term");
  assertLabels(goals.filter((node) => node.payload.horizon === "short-term"), [
    "把维度这个产品做好",
    "提升产品力",
    "研究 DSH",
  ], "short-term");

  const cognitions = fixture.nodes.filter((node) => node.payload.starRole === "cognition");
  const bigIdeas = fixture.nodes.filter((node) => node.payload.starRole === "big-idea");
  if (cognitions.length !== 6 || bigIdeas.length !== 4) {
    throw new TypeError("Demo constellation must contain six cognitions and four big ideas");
  }
  for (const node of [...cognitions, ...bigIdeas]) {
    if (node.kind !== "claim" || node.actor !== "importer" || !node.payload.correctionHint) {
      throw new TypeError(`Constellation inference ${node.seedKey} must stay correctable and unverified`);
    }
  }
  if (fixture.nodes.filter((node) => node.kind === "action").length !== 5) {
    throw new TypeError("Demo fixture must contain five actions");
  }
  if (fixture.nodes.some((node) => node.kind === "outcome")) {
    throw new TypeError("Demo fixture must not fabricate action outcomes");
  }
  validateRelationshipNode(fixture.nodes);

  const encoded = JSON.stringify(fixture);
  for (const [label, pattern] of FORBIDDEN_FIXTURE_PATTERNS) {
    if (pattern.test(encoded)) {
      throw new TypeError(`Sanitized demo fixture contains a forbidden ${label}`);
    }
  }

  return {
    profileId: fixture.profileId,
    nodeCount: fixture.nodes.length,
    goalCount: goals.length,
    cognitionCount: cognitions.length,
    bigIdeaCount: bigIdeas.length,
    actionCount: fixture.nodes.filter((node) => node.kind === "action").length,
    sourceGroups: Array.isArray(fixture.sourceSummary?.sourceGroups)
      ? fixture.sourceSummary.sourceGroups.length
      : 0,
  };
}

export function loopbackDomainOrigin(raw) {
  const url = new URL(raw);
  const isLoopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "http:" || !isLoopback || url.username || url.password) {
    throw new TypeError("Demo seed Domain URL must be an unauthenticated loopback HTTP origin");
  }
  return url.origin;
}

export async function seedDemoProfile({
  fixture,
  domainUrl = "http://127.0.0.1:43121",
  fetchImpl = fetch,
}) {
  const summary = validateDemoFixture(fixture);
  const origin = loopbackDomainOrigin(domainUrl);
  const health = await requestJson(fetchImpl, `${origin}/health`);
  if (health.status !== "ready" || health.ok === false) {
    throw new Error("Latitude Domain is reachable but not ready");
  }

  const evidence = await requestJson(fetchImpl, `${origin}/v1/evidence/message`, {
    method: "POST",
    idempotencyKey: `${fixture.profileId}:user-direction`,
    body: {
      clientRequestId: `${fixture.profileId}:user-direction`,
      messageId: fixture.userDirection.messageId,
      content: fixture.userDirection.content,
      sensitivity: "low",
      audit: audit("user", "goal-direction"),
    },
  });
  const evidenceRefId = requiredString(evidence?.value?.evidenceRefId, "message evidenceRefId");

  const nodeIds = new Map();
  for (const node of fixture.nodes) {
    const payload = resolvePayload(node, nodeIds, fixture.profileId);
    const scope = { profile: "browser-demo", demoProfileId: fixture.profileId };
    let response;
    if (node.writeMode === "action") {
      response = await requestJson(fetchImpl, `${origin}/v1/actions`, {
        method: "POST",
        idempotencyKey: `${fixture.profileId}:${node.seedKey}`,
        body: {
          clientRequestId: `${fixture.profileId}:${node.seedKey}`,
          label: node.label,
          statement: node.statement,
          expectedOutcome: node.expectedOutcome,
          trigger: node.trigger,
          observationWindow: node.observationWindow,
          reviewAt: node.reviewAt,
          payload,
          scope,
          sensitivity: node.sensitivity,
          audit: audit(node.actor, node.seedKey),
        },
      });
      nodeIds.set(
        node.seedKey,
        requiredString(response?.value?.action?.id, `action ${node.seedKey}`),
      );
    } else {
      response = await requestJson(fetchImpl, `${origin}/v1/changes`, {
        method: "POST",
        idempotencyKey: `${fixture.profileId}:${node.seedKey}`,
        body: {
          operation: "remember",
          clientRequestId: `${fixture.profileId}:${node.seedKey}`,
          label: node.label,
          statement: node.statement,
          kind: node.kind,
          payload,
          scope,
          sensitivity: node.sensitivity,
          ...(node.actor === "user" ? { evidenceRefs: [evidenceRefId] } : {}),
          audit: audit(node.actor, node.seedKey),
        },
      });
      nodeIds.set(node.seedKey, requiredString(response?.value?.id, `node ${node.seedKey}`));
    }
  }

  const seededContext = await readContext(fetchImpl, origin);
  const persisted = assertProfileReadback(fixture, seededContext.nodes);

  const retiredNodes = seededContext.nodes.filter((node) =>
    node?.payload?.demo === true && fixture.retiredProfileIds.includes(node.payload.demoProfileId)
  );
  for (const node of retiredNodes) {
    const oldProfileId = requiredString(node.payload.demoProfileId, "retired demo profile id");
    await requestJson(fetchImpl, `${origin}/v1/changes`, {
      method: "POST",
      idempotencyKey: `${fixture.profileId}:retire:${oldProfileId}:${node.id}`,
      body: {
        operation: "retract",
        clientRequestId: `${fixture.profileId}:retire:${oldProfileId}:${node.id}`,
        id: requiredString(node.id, "retired demo node id"),
        reason: `Superseded by sanitized demo profile ${fixture.profileId}; non-demo nodes are out of scope.`,
        audit: audit("importer", `retire-${oldProfileId}`),
      },
    });
  }

  const finalContext = await readContext(fetchImpl, origin);
  assertProfileReadback(fixture, finalContext.nodes);
  const activeRetired = finalContext.nodes.filter((node) =>
    node?.payload?.demo === true && fixture.retiredProfileIds.includes(node.payload.demoProfileId)
  );
  if (activeRetired.length !== 0) {
    throw new Error(`Domain readback retained ${activeRetired.length} active v1 demo nodes`);
  }

  return {
    ...summary,
    evidenceRefId,
    persistedNodeCount: persisted.length,
    retiredNodeCount: retiredNodes.length,
    northStarLabel: persisted.find((node) => node.payload?.surfaceRole === "constellation.north-star")?.label,
  };
}

function resolvePayload(node, nodeIds, profileId) {
  const payload = {
    ...node.payload,
    demo: true,
    demoProfileId: profileId,
    demoSeedKey: node.seedKey,
  };
  for (const [seedField, idField] of [
    ["parentSeedKey", "parentGoalId"],
    ["goalSeedKey", "goalId"],
    ["mediumGoalSeedKey", "mediumGoalId"],
    ["northStarSeedKey", "northStarGoalId"],
  ]) {
    if (!node[seedField]) continue;
    payload[seedField] = node[seedField];
    payload[idField] = requiredString(nodeIds.get(node[seedField]), `${seedField} ${node[seedField]}`);
  }
  if (node.relatedSeedKeys) {
    payload.relatedSeedKeys = [...node.relatedSeedKeys];
    payload.relatedNodeIds = node.relatedSeedKeys.map((seedKey) =>
      requiredString(nodeIds.get(seedKey), `relatedSeedKey ${seedKey}`)
    );
  }
  if (node.kind === "action") payload.tags = [...node.payload.boardTags];
  return payload;
}

function assertProfileReadback(fixture, nodes) {
  const persisted = nodes.filter((node) => node?.payload?.demoProfileId === fixture.profileId);
  if (persisted.length !== fixture.nodes.length) {
    throw new Error(`Domain readback found ${persisted.length}/${fixture.nodes.length} v2 demo nodes`);
  }
  const bySeed = new Map(persisted.map((node) => [node.payload?.demoSeedKey, node]));
  for (const expected of fixture.nodes) {
    const actual = bySeed.get(expected.seedKey);
    if (!actual || actual.kind !== expected.kind) {
      throw new Error(`Domain readback lost or changed ${expected.seedKey}`);
    }
    const expectedAuthority = expected.actor === "user" ? "user_stated" : "imported_unverified";
    const expectedOrigin = expected.actor === "user" ? "user" : "import";
    if (actual.authority !== expectedAuthority || actual.origin !== expectedOrigin) {
      throw new Error(`Domain readback changed authority for ${expected.seedKey}`);
    }
    for (const field of ["horizon", "surfaceRole", "desktopRole"]) {
      if (actual.payload?.[field] !== expected.payload[field]) {
        throw new Error(`Domain readback changed ${field} for ${expected.seedKey}`);
      }
    }
    if (expected.parentSeedKey && !actual.payload?.parentGoalId) {
      throw new Error(`Domain readback lost parentGoalId for ${expected.seedKey}`);
    }
    if (expected.goalSeedKey && !actual.payload?.goalId) {
      throw new Error(`Domain readback lost goalId for ${expected.seedKey}`);
    }
  }
  const northStars = persisted.filter(
    (node) => node.kind === "goal" && node.payload?.surfaceRole === "constellation.north-star",
  );
  if (northStars.length !== 1 || northStars[0].label !== "实现 AGI") {
    throw new Error("Domain readback did not preserve the single AGI north star");
  }
  if (persisted.some((node) => node.kind === "outcome")) {
    throw new Error("Domain readback contains a fabricated demo outcome");
  }
  const relationship = persisted.find((node) => node.payload?.surfaceRole === "secretary.relationship");
  const familiarity = relationship?.payload?.metrics?.familiarity;
  const rapport = relationship?.payload?.metrics?.rapport;
  const capability = relationship?.payload?.metrics?.capability;
  if (
    relationship?.payload?.relationshipSchemaVersion !== 1 ||
    familiarity?.epistemicAuthority !== "imported_unverified" ||
    familiarity?.correctable !== true ||
    typeof familiarity?.basis !== "string" ||
    !familiarity.basis.trim() ||
    rapport?.epistemicAuthority !== "imported_unverified" ||
    rapport?.correctable !== true ||
    typeof rapport?.basis !== "string" ||
    !rapport.basis.trim() ||
    capability?.value !== 0 ||
    capability?.stage !== "未授权" ||
    capability?.epistemicAuthority !== "system_recorded" ||
    capability?.scope !== "demo-fixture" ||
    capability?.grantState !== "ungranted" ||
    !Array.isArray(capability?.grantReceiptIds) ||
    capability.grantReceiptIds.length !== 0 ||
    capability?.correctable !== false ||
    typeof capability?.basis !== "string" ||
    !capability.basis.trim()
  ) {
    throw new Error("Demo relationship readback changed its typed authority contract");
  }
  return persisted;
}

async function readContext(fetchImpl, origin) {
  const context = await requestJson(fetchImpl, `${origin}/v1/context`, {
    method: "POST",
    body: { limit: 500, sensitivityCeiling: "low", includeRetracted: false },
  });
  return { ...context, nodes: Array.isArray(context.nodes) ? context.nodes : [] };
}

function validateRelationshipNode(nodes) {
  const matches = nodes.filter((node) => node.payload.surfaceRole === "secretary.relationship");
  if (matches.length !== 1 || matches[0].kind !== "insight" || matches[0].actor !== "importer") {
    throw new TypeError("Demo fixture must contain one imported secretary relationship insight");
  }
  const metrics = matches[0].payload.metrics;
  if (!isRecord(metrics)) throw new TypeError("Secretary relationship metrics must be an object");
  for (const key of ["familiarity", "rapport", "capability"]) {
    const metric = metrics[key];
    if (!isRecord(metric) || !Number.isInteger(metric.value) || metric.value < 0 || metric.value > 100) {
      throw new TypeError(`Secretary relationship metric ${key} must be an integer from 0 to 100`);
    }
    assertString(metric.label, `metrics.${key}.label`);
    assertString(metric.stage, `metrics.${key}.stage`);
    assertString(metric.basis, `metrics.${key}.basis`);
  }
  if (
    metrics.familiarity.epistemicAuthority !== "imported_unverified" ||
    metrics.rapport.epistemicAuthority !== "imported_unverified" ||
    metrics.familiarity.correctable !== true ||
    metrics.rapport.correctable !== true
  ) {
    throw new TypeError("Familiarity and rapport must stay imported and correctable");
  }
  if (
    metrics.capability.value !== 0 ||
    metrics.capability.stage !== "未授权" ||
    metrics.capability.grantState !== "ungranted" ||
    !Array.isArray(metrics.capability.grantReceiptIds) ||
    metrics.capability.grantReceiptIds.length !== 0
  ) {
    throw new TypeError("Capability must stay zero and ungranted without grant receipts");
  }
}

function assertLabels(nodes, expected, horizon) {
  const actual = nodes.map((node) => node.label).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new TypeError(`Demo fixture has the wrong ${horizon} goal labels`);
  }
}

function audit(actor, turnId) {
  return {
    actor,
    sessionId: "latitude-sanitized-demo-seed",
    turnId,
    authorizationMode: "preauthorized",
  };
}

async function requestJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, {
    method: options.method ?? "GET",
    headers: options.body
      ? {
          "content-type": "application/json",
          ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
        }
      : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Latitude Domain returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) {
    const message = typeof value?.error === "string"
      ? value.error
      : typeof value?.message === "string"
        ? value.message
        : `HTTP ${response.status}`;
    throw new Error(`Latitude Domain request failed: ${message}`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Missing ${label}`);
  }
  return value;
}

function assertString(value, label) {
  requiredString(value, label);
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new TypeError(`${label} must be an array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) {
    throw new TypeError(`${label} cannot contain duplicates`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

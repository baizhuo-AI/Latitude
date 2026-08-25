import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  loopbackDomainOrigin,
  readDemoFixture,
  seedDemoProfile,
  validateDemoFixture,
} from "./seed-demo-core.mjs";

const fixturePath = fileURLToPath(
  new URL("../fixtures/demo/sanitized-knowledge-profile.json", import.meta.url),
);

test("v2 fixture keeps star, clue, and desktop goals separate with unverified cognition", async () => {
  const fixture = await readDemoFixture(fixturePath);
  const summary = validateDemoFixture(fixture);

  assert.deepEqual(summary, {
    profileId: "latitude-sanitized-demo-2026-08-25-v2",
    nodeCount: 30,
    goalCount: 6,
    cognitionCount: 6,
    bigIdeaCount: 4,
    actionCount: 5,
    sourceGroups: 3,
  });
  assert.deepEqual(
    fixture.nodes.filter((node) => node.kind === "goal").map((node) => [
      node.label,
      node.payload.horizon,
      node.payload.surfaceRole,
    ]),
    [
      ["实现 AGI", "north-star", "constellation.north-star"],
      ["完成客户交付", "medium-term", "clue.theme"],
      ["寻找新 Agent 方向", "medium-term", "clue.theme"],
      ["把维度这个产品做好", "short-term", "desktop.goal"],
      ["提升产品力", "short-term", "desktop.goal"],
      ["研究 DSH", "short-term", "desktop.goal"],
    ],
  );
  assert.deepEqual(
    fixture.nodes.filter((node) => node.payload.starRole === "cognition").map((node) => node.label),
    ["系统思维", "证据优先", "高自主性", "长期主义", "反套路", "强结果感"],
  );
  assert.equal(
    fixture.nodes.filter((node) => node.payload.surfaceRole === "constellation.big-idea").length,
    4,
  );

  const relationship = fixture.nodes.find(
    (node) => node.payload.surfaceRole === "secretary.relationship",
  );
  assert.equal(relationship.payload.metrics.familiarity.epistemicAuthority, "imported_unverified");
  assert.equal(relationship.payload.metrics.rapport.correctable, true);
  assert.deepEqual(relationship.payload.metrics.capability, {
    label: "权能",
    value: 0,
    stage: "未授权",
    basis: "本演示 fixture 不包含 capability grant receipt。",
    epistemicAuthority: "system_recorded",
    scope: "demo-fixture",
    grantState: "ungranted",
    grantReceiptIds: [],
    correctable: false,
  });
});

test("fixture validator rejects authority, hierarchy, outcome, and capability inflation", async () => {
  const fixture = await readDemoFixture(fixturePath);

  const importedNorthStar = structuredClone(fixture);
  importedNorthStar.nodes[0].actor = "importer";
  assert.throws(() => validateDemoFixture(importedNorthStar), /must be user-authored/u);

  const wrongHierarchy = structuredClone(fixture);
  wrongHierarchy.nodes.find((node) => node.seedKey === "goal-short-latitude").parentSeedKey =
    "goal-north-star-agi";
  assert.throws(() => validateDemoFixture(wrongHierarchy), /must point to medium-term/u);

  const wrongHorizon = structuredClone(fixture);
  wrongHorizon.nodes[0].payload.horizon = "forever";
  assert.throws(() => validateDemoFixture(wrongHorizon), /invalid horizon/u);

  const fabricatedOutcome = structuredClone(fixture);
  fabricatedOutcome.nodes.find((node) => node.kind === "resource").kind = "outcome";
  assert.throws(() => validateDemoFixture(fabricatedOutcome), /Unsupported demo node kind/u);

  const inflatedCapability = structuredClone(fixture);
  inflatedCapability.nodes.find(
    (node) => node.payload.surfaceRole === "secretary.relationship",
  ).payload.metrics.capability.value = 1;
  assert.throws(() => validateDemoFixture(inflatedCapability), /zero and ungranted/u);
});

test("fixture validator rejects raw identifiers across supported source families", async () => {
  const fixture = await readDemoFixture(fixturePath);
  const contaminations = [
    ["https://private.example/path", /forbidden URL/u],
    ["person@example.com", /forbidden email address/u],
    ["13812345678", /forbidden mainland phone number/u],
    ["AKIAIOSFODNN7EXAMPLE", /forbidden AWS access key/u],
    ["ghp_1234567890abcdefghijklmnopqrstuvwxyz", /forbidden GitHub credential/u],
    // Build this fictional token at runtime so source hosting does not mistake it for a leaked secret.
    [["xoxb", "123456789012", "abcdefghijklmnop"].join("-"), /forbidden Slack credential/u],
    ["Bearer abcdefghijklmnopqrstuvwxyz", /forbidden Bearer credential/u],
    ["-----BEGIN PRIVATE KEY-----", /forbidden private key material/u],
    ["/Users/example/private.txt", /forbidden macOS user path/u],
    ["/Volumes/REC/private.wav", /forbidden mounted-volume path/u],
    ["~/private.txt", /forbidden home-directory path/u],
    ["/home/example/private.txt", /forbidden home-directory path/u],
    ["C:\\Users\\example\\private.txt", /forbidden Windows absolute path/u],
    ["\\\\server\\share\\private.txt", /forbidden UNC path/u],
    ["192.168.11.23", /forbidden IPv4 address/u],
    ["123e4567-e89b-42d3-a456-426614174000", /forbidden UUID/u],
  ];
  for (const [value, pattern] of contaminations) {
    const contaminated = structuredClone(fixture);
    contaminated.nodes[0].statement = value;
    assert.throws(() => validateDemoFixture(contaminated), pattern);
  }
  const deviceIdentifier = structuredClone(fixture);
  deviceIdentifier.nodes[0].payload.deviceId = "hardware-123";
  assert.throws(() => validateDemoFixture(deviceIdentifier), /forbidden device or account identifier/u);
});

test("v2 seeding is idempotent, retires only v1 demo nodes, and preserves typed pointers", async () => {
  const fixture = await readDemoFixture(fixturePath);
  const requests = [];
  const persisted = [
    {
      id: "node-old-v1",
      kind: "goal",
      label: "旧错误目标",
      status: "active",
      authority: "user_stated",
      origin: "user",
      payload: {
        demo: true,
        demoProfileId: "latitude-sanitized-demo-2026-08-25-v1",
        demoSeedKey: "old-goal",
      },
    },
    {
      id: "node-user-real",
      kind: "goal",
      label: "非 Demo 用户目标",
      status: "active",
      authority: "user_stated",
      origin: "user",
      payload: {},
    },
  ];
  const idempotency = new Map();
  let tamperRelationshipReadback = false;
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    const idempotencyKey = options.headers?.["idempotency-key"];
    requests.push({ url, options, body });
    if (url.endsWith("/health")) return jsonResponse({ ok: true, status: "ready" });
    if (idempotencyKey && idempotency.has(idempotencyKey)) {
      return jsonResponse(idempotency.get(idempotencyKey));
    }
    if (url.endsWith("/v1/evidence/message")) {
      const response = { ok: true, value: { evidenceRefId: "evidence-demo-direction-v2" } };
      idempotency.set(idempotencyKey, response);
      return jsonResponse(response);
    }
    if (url.endsWith("/v1/actions")) {
      const id = `node-${body.payload.demoSeedKey}`;
      persisted.push(domainNode(id, "action", body));
      const response = { ok: true, value: { action: { id } } };
      idempotency.set(idempotencyKey, response);
      return jsonResponse(response);
    }
    if (url.endsWith("/v1/changes")) {
      if (body.operation === "retract") {
        const target = persisted.find((node) => node.id === body.id);
        target.status = "revoked";
        const response = { ok: true, value: { id: body.id, status: "revoked" } };
        idempotency.set(idempotencyKey, response);
        return jsonResponse(response);
      }
      const id = `node-${body.payload.demoSeedKey}`;
      persisted.push(domainNode(id, body.kind, body));
      const response = { ok: true, value: { id } };
      idempotency.set(idempotencyKey, response);
      return jsonResponse(response);
    }
    if (url.endsWith("/v1/context")) {
      const nodes = structuredClone(persisted.filter((node) => node.status !== "revoked"));
      if (tamperRelationshipReadback) {
        nodes.find(
          (node) => node.payload.surfaceRole === "secretary.relationship",
        ).payload.metrics.familiarity.epistemicAuthority = "user_stated";
      }
      return jsonResponse({
        ok: true,
        nodes,
        edges: [],
      });
    }
    return jsonResponse({ error: "unexpected route" }, 404);
  };

  const first = await seedDemoProfile({ fixture, fetchImpl });
  const second = await seedDemoProfile({ fixture, fetchImpl });
  assert.equal(first.persistedNodeCount, 30);
  assert.equal(first.retiredNodeCount, 1);
  assert.equal(second.persistedNodeCount, 30);
  assert.equal(second.retiredNodeCount, 0);
  assert.equal(first.northStarLabel, "实现 AGI");
  assert.equal(
    persisted.filter((node) => node.payload.demoProfileId === fixture.profileId).length,
    30,
  );
  assert.equal(persisted.find((node) => node.id === "node-old-v1").status, "revoked");
  assert.equal(persisted.find((node) => node.id === "node-user-real").status, "active");

  const mediumGoal = persisted.find(
    (node) => node.payload.demoSeedKey === "goal-mid-client-delivery",
  );
  assert.equal(mediumGoal.payload.parentGoalId, "node-goal-north-star-agi");
  assert.equal(mediumGoal.payload.surfaceRole, "clue.theme");

  const action = persisted.find(
    (node) => node.payload.demoSeedKey === "action-latitude-product-loop",
  );
  assert.equal(action.payload.goalId, "node-goal-short-latitude");
  assert.equal(action.payload.mediumGoalId, "node-goal-mid-new-agent");
  assert.equal(action.payload.northStarGoalId, "node-goal-north-star-agi");
  assert.deepEqual(action.payload.tags, ["维度产品"]);
  assert.equal(action.authority, "imported_unverified");

  const review = persisted.find((node) => node.payload.demoSeedKey === "review-demo-weekly");
  assert.equal(review.payload.relatedNodeIds.length, 5);
  assert.equal(review.payload.outcomeCount, 0);

  const retireRequest = requests.find((request) => request.body?.operation === "retract");
  assert.equal(retireRequest.body.id, "node-old-v1");
  assert.equal(retireRequest.body.audit.actor, "importer");
  assert.match(retireRequest.body.reason, /non-demo nodes are out of scope/u);
  assert.equal(
    requests.some((request) => request.body?.operation === "retract" && request.body.id === "node-user-real"),
    false,
  );

  tamperRelationshipReadback = true;
  await assert.rejects(
    () => seedDemoProfile({ fixture, fetchImpl }),
    /relationship readback changed its typed authority contract/u,
  );
});

test("demo seeding refuses non-loopback or credential-bearing Domain URLs", () => {
  assert.equal(loopbackDomainOrigin("http://127.0.0.1:43121/path"), "http://127.0.0.1:43121");
  assert.throws(() => loopbackDomainOrigin("https://example.com"), /loopback/u);
  assert.throws(() => loopbackDomainOrigin("http://user:pass@localhost:43121"), /loopback/u);
});

function domainNode(id, kind, body) {
  return {
    id,
    kind,
    label: body.label,
    statement: body.statement,
    status: "active",
    authority: body.audit.actor === "user" ? "user_stated" : "imported_unverified",
    origin: body.audit.actor === "user" ? "user" : "import",
    payload: body.payload,
    ...(body.expectedOutcome ? { expectedOutcome: body.expectedOutcome } : {}),
    ...(body.reviewAt ? { reviewAt: body.reviewAt } : {}),
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

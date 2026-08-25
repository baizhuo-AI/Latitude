import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  allocateDistinctLoopbackPorts,
  assertOfflineTelemetry,
  assertOsNetworkTelemetry,
  buildNetworkSandboxProfile,
  installProcessLoopbackFetchGuard,
  isLoopbackHttpUrl,
} from "./accept-offline.mjs";

test("offline acceptance selects three distinct random ports without terminating conflicts", async () => {
  const candidates = [50_001, 50_001, 50_002, 50_003];
  const selected = await allocateDistinctLoopbackPorts(async () => candidates.shift());
  assert.deepEqual(selected, { web: 50_001, agent: 50_002, domain: 50_003 });
  await assert.rejects(
    allocateDistinctLoopbackPorts(async () => 50_010),
    /could not allocate three distinct/u,
  );
});

test("offline acceptance process fetch guard allows only HTTP loopback", async () => {
  const calls = [];
  const guard = installProcessLoopbackFetchGuard(async (input) => {
    calls.push(String(input));
    return new Response("ok", { status: 200 });
  });
  try {
    assert.equal(isLoopbackHttpUrl("http://127.0.0.1:43121/health"), true);
    assert.equal(isLoopbackHttpUrl("http://localhost:1420/"), true);
    assert.equal(isLoopbackHttpUrl("https://127.0.0.1:43121/health"), false);
    assert.equal(isLoopbackHttpUrl("http://example.test/"), false);
    const response = await fetch("http://127.0.0.1:43121/health");
    assert.equal(await response.text(), "ok");
    await assert.rejects(
      fetch("https://telemetry.example.test/ping"),
      /blocked external fetch/u,
    );
    assert.deepEqual(calls, ["http://127.0.0.1:43121/health"]);
    assert.deepEqual(guard.externalRequests, ["https://telemetry.example.test/ping"]);
    assert.equal(guard.loopbackRequests, 1);
  } finally {
    guard.restore();
  }
});

test("macOS network profile denies by default and names only the owned exact ports", () => {
  const profile = buildNetworkSandboxProfile({
    inboundPorts: [50_101, 50_102],
    outboundPorts: [50_103],
  });
  assert.match(profile, /\(deny network-inbound \(local tcp "\*:\*"\)\)/u);
  assert.match(profile, /\(deny network-inbound \(local udp "\*:\*"\)\)/u);
  assert.match(profile, /\(deny network-outbound\)/u);
  assert.match(profile, /local tcp "localhost:50101"/u);
  assert.match(profile, /local tcp "localhost:50102"/u);
  assert.match(profile, /remote tcp "localhost:50103"/u);
  assert.doesNotMatch(profile, /localhost:\*/u);
  assert.doesNotMatch(profile, /remote ip "\*:/u);
  assert.throws(
    () => buildNetworkSandboxProfile({ outboundPorts: [0] }),
    /invalid TCP port/u,
  );
});

test("offline telemetry contract rejects credentials, external calls, and empty real loops", () => {
  const valid = {
    mode: "hermetic-offline-acceptance",
    inheritedCredentials: false,
    syntheticHealthCredential: true,
    osNetworkProbeChild: true,
    externalNetworkCalls: 0,
    llmCalls: 6,
    webSearchCalls: 1,
  };
  assert.equal(assertOfflineTelemetry(valid, { minimumWebSearchCalls: 1 }), true);
  assert.equal(
    assertOfflineTelemetry({ ...valid, llmCalls: 0, webSearchCalls: 0 }, {
      minimumLlmCalls: 0,
      minimumWebSearchCalls: 0,
    }),
    true,
  );
  assert.throws(
    () => assertOfflineTelemetry({ ...valid, externalNetworkCalls: 1 }),
    /attempted external network/u,
  );
  assert.throws(
    () => assertOfflineTelemetry({ ...valid, inheritedCredentials: true }),
    /inherited credentials/u,
  );
  assert.throws(
    () => assertOfflineTelemetry({ ...valid, llmCalls: 0 }),
    /real DSH loop did not call adapter/u,
  );
});

test("OS network telemetry requires every protocol and child-process bypass to be EPERM", () => {
  const labels = [
    "fetch",
    "node:http",
    "node:https",
    "node:net",
    "node:tls",
    "global:WebSocket",
    "undici:request",
    "undici:Client",
    "child_process:node-net",
    "loopback:unknown-port",
    "dns:udp53",
    "unix:outbound",
  ];
  const valid = {
    mode: "macos-sandbox-exec-network-proof",
    osSandboxEnforced: true,
    externalNetwork: false,
    allowedLoopbackOrigin: "http://127.0.0.1:50111",
    allowedLoopbackFetch: true,
    probes: labels.map((label) => ({ label, blocked: true, code: "EPERM" })),
  };
  assert.equal(assertOsNetworkTelemetry(valid, valid.allowedLoopbackOrigin), true);
  assert.throws(
    () => assertOsNetworkTelemetry({ ...valid, probes: valid.probes.slice(1) }, valid.allowedLoopbackOrigin),
    /every required bypass probe/u,
  );
  assert.throws(
    () => assertOsNetworkTelemetry({
      ...valid,
      probes: valid.probes.map((probe, index) => index === 0 ? { ...probe, code: "ETIMEDOUT" } : probe),
    }, valid.allowedLoopbackOrigin),
    /not denied by the OS sandbox/u,
  );
});

test("production Agent entrypoint has no environment or HTTP fake-provider selector", async () => {
  const entrypoint = await readFile("services/agent/src/index.ts", "utf8");
  const server = await readFile("services/agent/src/http/server.ts", "utf8");
  const offlineChild = await readFile("scripts/accept-offline-agent.ts", "utf8");
  const networkProbe = await readFile("scripts/accept-offline-network-probe.mjs", "utf8");

  assert.match(entrypoint, /startAgentHost\(options: StartAgentHostOptions = \{\}\)/u);
  assert.match(entrypoint, /const host = await startAgentHost\(\);/u);
  assert.doesNotMatch(entrypoint, /process\.env\..*(?:FAKE|OFFLINE).*PROVIDER/iu);
  assert.doesNotMatch(server, /(?:fake|offline).*provider/iu);
  assert.match(offlineChild, /startAgentHost\(\{\s*runtime:/u);
  assert.match(offlineChild, /installOfficialWebSearch: false/u);
  for (const boundary of [
    "node:http",
    "node:https",
    "node:net",
    "node:tls",
    "WebSocket",
    "undici",
    "child_process",
    "dgram",
    "blocked-unix-socket",
  ]) {
    assert.match(networkProbe, new RegExp(boundary.replace(":", "[:]?"), "u"));
  }
});

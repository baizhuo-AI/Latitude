import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import net from "node:net";
import test from "node:test";
import {
  assertNode22,
  assertOwnedSandbox,
  browserBuildEnvironment,
  createOwnedSandbox,
  removeOwnedSandbox,
  reserveSmokePorts,
  startAgentStub,
} from "./accept-browser.mjs";

test("Browser smoke rejects non-Node-22 runtimes", () => {
  assert.doesNotThrow(() => assertNode22("22.23.0"));
  assert.throws(() => assertNode22("23.1.0"), /requires Node 22\.x/u);
});

test("Browser smoke reserves three distinct random loopback ports and releases only its own", async () => {
  const reservations = await reserveSmokePorts();
  const ports = Object.values(reservations.ports);
  try {
    assert.equal(new Set(ports).size, 3);
    for (const port of ports) assert.equal(await canBind(port), false);

    await reservations.release("web");
    assert.equal(await canBind(reservations.ports.web), true);
    assert.equal(await canBind(reservations.ports.agent), false);
    assert.equal(await canBind(reservations.ports.domain), false);
  } finally {
    await reservations.releaseAll();
  }
  for (const port of ports) assert.equal(await canBind(port), true);
});

test("production Browser build receives only dynamic local service URLs", () => {
  const endpoints = {
    agentOrigin: "http://127.0.0.1:50101",
    domainOrigin: "http://127.0.0.1:50102",
  };
  const environment = browserBuildEnvironment(
    {
      PATH: "/usr/bin",
      DEEPSEEK_API_KEY: "fixture-value-never-forwarded",
      VITE_LATITUDE_AGENT_URL: "http://127.0.0.1:43120",
      VITE_LATITUDE_DOMAIN_URL: "http://127.0.0.1:43121",
    },
    endpoints,
  );
  assert.equal(environment.PATH, "/usr/bin");
  assert.equal("DEEPSEEK_API_KEY" in environment, false);
  assert.equal(environment.VITE_LATITUDE_AGENT_URL, endpoints.agentOrigin);
  assert.equal(environment.VITE_LATITUDE_DOMAIN_URL, endpoints.domainOrigin);
});

test("explicit Agent test double exposes only bootstrap routes and strict CORS", async () => {
  const webOrigin = "http://127.0.0.1:51234";
  const domainOrigin = "http://127.0.0.1:51235";
  const stub = await startAgentStub({ port: 0, webOrigin, domainOrigin });
  try {
    const health = await fetch(`${stub.origin}/health`, {
      headers: { Origin: webOrigin },
    });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("access-control-allow-origin"), webOrigin);
    assert.deepEqual(await health.json(), {
      status: "ready",
      service: "latitude-agent-browser-smoke-test-double",
      apiVersion: "v1",
      testDouble: true,
      outboundNetwork: false,
      model: { provider: "none", id: "none", configured: false },
      domain: { url: domainOrigin, healthy: true },
    });

    const messages = await fetch(`${stub.origin}/v1/agent/sessions/test/messages?limit=100`);
    assert.deepEqual(await messages.json(), { sessionId: "test", messages: [] });
    const forbidden = await fetch(`${stub.origin}/health`, {
      headers: { Origin: "https://example.test" },
    });
    assert.equal(forbidden.status, 403);
    const unknown = await fetch(`${stub.origin}/v1/web/search`, { method: "POST" });
    assert.equal(unknown.status, 404);
    assert.deepEqual(stub.unknownRequests, ["POST /v1/web/search"]);
  } finally {
    await stub.close();
  }
});

function canBind(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      if (error?.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => (error ? reject(error) : resolve(true)));
    });
  });
}

test("owned Browser sandbox is validated before recursive cleanup", async () => {
  const sandbox = await createOwnedSandbox();
  await assertOwnedSandbox(sandbox);
  await removeOwnedSandbox(sandbox);
  await assert.rejects(stat(sandbox.root), (error) => error?.code === "ENOENT");
});

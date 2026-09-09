import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLoopbackPortsAvailable,
  signalManagedProcess,
  terminalLocalHealthFailure,
  waitForProcessExit,
} from "./local-processes.mjs";

test("port preflight reports every conflict without terminating it", async () => {
  const visited = [];
  await assert.rejects(
    assertLoopbackPortsAvailable(
      [
        { name: "domain", host: "127.0.0.1", port: 43121 },
        { name: "web", host: "127.0.0.1", port: 1420 },
      ],
      {
        probe: async (host, port) => {
          visited.push(`${host}:${port}`);
          if (port === 1420) {
            const error = new Error("occupied");
            error.code = "EADDRINUSE";
            throw error;
          }
        },
      },
    ),
    (error) => {
      assert.equal(error.code, "LATITUDE_PORT_IN_USE");
      assert.match(error.message, /web 127\.0\.0\.1:1420/u);
      assert.match(error.message, /will not terminate an unowned process/u);
      return true;
    },
  );
  assert.deepEqual(visited, ["127.0.0.1:43121", "127.0.0.1:1420"]);
});

test("unexpected port probe failures stay distinguishable from a conflict", async () => {
  await assert.rejects(
    assertLoopbackPortsAvailable(
      [{ name: "agent", host: "127.0.0.1", port: 43120 }],
      {
        probe: async () => {
          const error = new Error("sandbox denied bind");
          error.code = "EPERM";
          throw error;
        },
      },
    ),
    /Cannot inspect agent port 127\.0\.0\.1:43120 \(EPERM\)/u,
  );
});

test("managed POSIX children are signalled through their owned process group", () => {
  const calls = [];
  const child = { pid: 2468, exitCode: null, signalCode: null, kill: () => false };
  assert.equal(
    signalManagedProcess(child, "SIGTERM", {
      platform: "darwin",
      kill: (pid, signal) => calls.push([pid, signal]),
    }),
    true,
  );
  assert.deepEqual(calls, [[-2468, "SIGTERM"]]);
});

test("waiting on an already exited child resolves immediately", async () => {
  await waitForProcessExit({ exitCode: 0, signalCode: null });
});

test("a missing model credential is terminal instead of a 90 second boot wait", () => {
  assert.match(
    terminalLocalHealthFailure("agent", {
      status: "unavailable",
      model: { provider: "deepseek-official", configured: false },
      domain: { healthy: false },
    }),
    /DEEPSEEK_API_KEY/u,
  );
  assert.equal(
    terminalLocalHealthFailure("agent", {
      status: "unavailable",
      model: { configured: true },
      domain: { healthy: false },
    }),
    null,
  );
  assert.match(
    terminalLocalHealthFailure("agent", {
      status: "unavailable",
      model: { configured: true, authentication: "failed" },
      domain: { healthy: true },
    }),
    /authentication was rejected/u,
  );
  assert.match(
    terminalLocalHealthFailure("agent", {
      status: "unavailable",
      model: { provider: "openai", configured: false },
    }),
    /OPENAI_API_KEY/u,
  );
});

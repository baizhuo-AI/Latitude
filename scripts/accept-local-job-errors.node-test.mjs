import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCompletedRun,
  stableRunFailure,
} from "./accept-local-job-errors.mjs";

test("accept-local reports stable authentication diagnostics without provider text", () => {
  const job = {
    status: "failed",
    error: {
      code: "AUTH",
      message: "provider-private-detail",
    },
  };
  assert.deepEqual(stableRunFailure(job), {
    code: "AUTH",
    message:
      "Model provider authentication failed. Update the local credential, restart Agent Host, and retry.",
  });
  assert.throws(
    () => assertCompletedRun(job, "ordinary DeepSeek turn"),
    (error) => {
      assert.match(error.message, /ordinary DeepSeek turn failed \(AUTH\)/u);
      assert.doesNotMatch(error.message, /provider-private-detail/u);
      return true;
    },
  );
});

test("accept-local collapses unknown error bodies to one public failure", () => {
  assert.deepEqual(stableRunFailure({
    status: "failed",
    error: { code: "unexpected_private_code", message: "private transport body" },
  }), {
    code: "agent_run_failed",
    message: "Agent run failed. Check the local Agent Host diagnostics and retry.",
  });
});

test("accept-local accepts only completed jobs", () => {
  const completed = { status: "completed", result: { status: "completed" } };
  assert.equal(assertCompletedRun(completed, "turn"), completed);
});

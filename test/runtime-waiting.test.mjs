import { test } from "node:test";
import assert from "node:assert/strict";
import { RuntimeExecutor } from "../dist/runtime/executor.js";
import {
  setRetryBackoff,
  clearRetryBackoff,
  runWaiting,
} from "../dist/runtime/waiting.js";

const step = (id = "a", dependsOn = []) => ({
  id,
  tool: "read",
  input: {},
  dependsOn,
  retry: 1,
  timeoutMs: 1000,
});
const fixture = (
  invoke = async () => "ok",
  specs = [step()],
  onSave = () => {},
) => {
  const checkpoints = [];
  const executor = new RuntimeExecutor(
    {
      save(run) {
        onSave(run);
        checkpoints.push(structuredClone(run));
      },
    },
    invoke,
  );
  const run = executor.createRun("private-owner", {
    steps: specs,
    concurrency: 1,
  });
  return { run, executor, checkpoints };
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const transient = () =>
  Object.assign(Error("private-path secret-token"), { status: 503 });
const ready = (id = "a") => ({ stepId: id, reason: "scheduler" });
const noWaiting = { steps: [], cleanupPending: false };
const assertCleared = (run) => {
  // Re-expose a pending step after settlement to prove deletion, not just filtering.
  const state = run.state;
  const stepState = run.steps[0].state;
  run.state = "running";
  run.steps[0].state = "pending";
  try {
    assert.deepEqual(runWaiting(run), {
      steps: [ready()],
      cleanupPending: false,
    });
  } finally {
    run.state = state;
    run.steps[0].state = stepState;
  }
};

test("pending-only projection distinguishes dependency from ready scheduler", () => {
  const { run } = fixture(undefined, [step("a"), step("b", ["a"]), step("c")]);
  run.steps[0].state = "running";
  const before = structuredClone(run);
  assert.deepEqual(runWaiting(run, false), {
    steps: [{ stepId: "b", reason: "dependency" }, ready("c")],
    cleanupPending: false,
  });
  assert.deepEqual(run, before);
  run.steps[0].state = "succeeded";
  assert.deepEqual(runWaiting(run).steps, [ready("b"), ready("c")]);
  for (const state of [
    "running",
    "failed",
    "cancelled",
    "unknown",
    "succeeded",
  ]) {
    run.steps[1].state = state;
    assert.deepEqual(runWaiting(run).steps, [ready("c")]);
  }
});

test("real batch execution exposes scheduler and dependency without capacity claims", async () => {
  const gate = deferred();
  const started = deferred();
  let calls = 0;
  const { run, executor } = fixture(async () => {
    if (++calls === 1) {
      started.resolve();
      await gate.promise;
    }
    return "ok";
  }, [step("a"), step("b", ["a"]), step("c")]);
  const execution = executor.execute(run);
  await started.promise;
  try {
    assert.deepEqual(runWaiting(run).steps, [
      { stepId: "b", reason: "dependency" },
      ready("c"),
    ]);
  } finally {
    gate.resolve();
    await execution;
  }
  assert.equal(calls, 3);
  assert.deepEqual(runWaiting(run), noWaiting);
});

test("cleanup pending requires explicit unsettled and a non-running run", () => {
  const { run } = fixture();
  for (const state of ["interrupted", "succeeded", "failed", "cancelled"]) {
    run.state = state;
    assert.deepEqual(runWaiting(run, false), {
      steps: [],
      cleanupPending: true,
    });
    assert.deepEqual(runWaiting(run, true), noWaiting);
    assert.deepEqual(runWaiting(run), noWaiting);
  }
});

test("WeakMap identity, copied metadata, independent steps, and explicit clear", () => {
  const { run } = fixture(undefined, [step("a"), step("b")]);
  const metadata = {
    waitingSince: 10,
    nextRetryAt: 110,
    retryCategory: "transient",
    secret: "private",
  };
  const before = structuredClone(run);
  setRetryBackoff(run, "a", metadata);
  setRetryBackoff(run, "b", {
    waitingSince: 20,
    nextRetryAt: 220,
    retryCategory: "legacy_unknown",
  });
  metadata.waitingSince = 999;
  const waiting = runWaiting(run);
  assert.deepEqual(waiting.steps[0], {
    stepId: "a",
    reason: "retry_backoff",
    disposition: "waiting_retry",
    waitingSince: 10,
    nextRetryAt: 110,
    retryCategory: "transient",
  });
  assert.equal(runWaiting(run).steps[1].disposition, "waiting_retry");
  waiting.steps[0].waitingSince = 888;
  assert.equal(runWaiting(run).steps[0].waitingSince, 10);
  assert.deepEqual(run, before);
  assert.deepEqual(runWaiting(structuredClone(run)).steps, [
    ready(),
    ready("b"),
  ]);
  clearRetryBackoff(run, "a");
  assert.deepEqual(runWaiting(run).steps[0], ready());
  assert.equal(runWaiting(run).steps[1].reason, "retry_backoff");
  clearRetryBackoff(run, "b");
  clearRetryBackoff(run, "missing");
  assert.deepEqual(runWaiting(run).steps, [ready(), ready("b")]);
});

test("real transient executor retry exposes live backoff only around the await", async () => {
  const reached = deferred();
  let checkpointProjection;
  let calls = 0;
  let run;
  const f = fixture(
    async () => {
      if (++calls === 1) throw transient();
      assert.deepEqual(runWaiting(run), noWaiting);
      return "private-result";
    },
    [step()],
    (record) => {
      if (
        record.steps[0].state === "pending" &&
        record.steps[0].attempts === 1
      ) {
        checkpointProjection = runWaiting(record);
        reached.resolve();
      }
    },
  );
  run = f.run;
  const execution = f.executor.execute(run);
  await reached.promise;
  try {
    assert.deepEqual(checkpointProjection.steps, [ready()]);
    const observed = runWaiting(run);
    assert.equal(observed.steps.length, 1);
    const waiting = observed.steps[0];
    assert.equal(waiting.reason, "retry_backoff");
    assert.equal(waiting.retryCategory, "transient");
    assert.equal(waiting.nextRetryAt - waiting.waitingSince, 100);
    assert.ok(Number.isSafeInteger(waiting.waitingSince));
    assert.equal(JSON.stringify(observed).includes("private"), false);
    assert.deepEqual(runWaiting(structuredClone(run)).steps, [ready()]);
    assert.equal(JSON.stringify(f.checkpoints).includes("waitingSince"), false);
    assert.equal(JSON.stringify(run).includes("nextRetryAt"), false);
  } finally {
    await execution;
  }
  assert.equal(calls, 2);
  assert.equal(run.state, "succeeded");
  assert.deepEqual(runWaiting(run, true), noWaiting);
  assertCleared(run);
});

test("cancelling real backoff clears observation and prevents another attempt", async () => {
  const reached = deferred();
  let calls = 0;
  const { run, executor } = fixture(
    async () => {
      calls++;
      throw transient();
    },
    [step()],
    (record) => {
      if (record.steps[0].state === "pending" && record.steps[0].attempts === 1)
        reached.resolve();
    },
  );
  const execution = executor.execute(run);
  await reached.promise;
  try {
    assert.equal(runWaiting(run).steps[0].reason, "retry_backoff");
  } finally {
    executor.cancel(run);
    await execution;
  }
  assert.equal(calls, 1);
  assert.equal(run.state, "cancelled");
  assert.deepEqual(runWaiting(run, true), noWaiting);
  assertCleared(run);
});

test("failed terminal run retains no backoff after retry exhaustion", async () => {
  const { run, executor } = fixture(async () => {
    throw transient();
  });
  await executor.execute(run);
  assert.equal(run.state, "failed");
  assert.equal(run.steps[0].attempts, 2);
  assert.deepEqual(runWaiting(run), noWaiting);
  assertCleared(run);
});

test("restored attempts, timestamps and error never invent retry metadata", async () => {
  const { run, executor } = fixture();
  run.steps[0].attempts = 7;
  run.steps[0].error = "transient private-path";
  run.steps[0].startedAt = Date.now() + 1_000_000;
  run.updatedAt = Date.now() + 1_000_000;
  assert.deepEqual(runWaiting(run).steps, [ready()]);
  run.state = "interrupted";
  assert.deepEqual(runWaiting(run), noWaiting);
  await executor.resume(run);
  assert.equal(run.state, "succeeded");
  assert.deepEqual(runWaiting(run), noWaiting);
});

test("projection never discloses inputs, goals, errors, owner or result payloads", () => {
  const { run } = fixture();
  run.goal = "private-goal";
  run.error = "private-error";
  run.results = { a: { value: "private-result" } };
  run.plan.steps[0].input = { token: "private-input" };
  run.steps[0].childSessionId = "private-child";
  run.steps[0].error = "private-step-error";
  const before = structuredClone(run);
  assert.deepEqual(runWaiting(run), {
    steps: [ready()],
    cleanupPending: false,
  });
  assert.equal(JSON.stringify(runWaiting(run)).includes("private"), false);
  assert.deepEqual(run, before);
});

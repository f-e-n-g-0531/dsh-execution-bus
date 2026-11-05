import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { RuntimeExecutor } from "../dist/runtime/executor.js";
import {
  classifyRetryError,
  retryDelayMs,
  waitForRetry,
} from "../dist/runtime/retry.js";

const failure = (hints = {}) =>
  Object.assign(Error("secret host path/token"), hints);
const step = (tool = "read", retry = 3) => ({
  id: "a",
  tool,
  input: {},
  dependsOn: [],
  retry,
  timeoutMs: 1000,
});
const fixture = (invoke, spec = step(), onSave = () => {}) => {
  const checkpoints = [];
  const store = {
    save(run) {
      onSave(run);
      checkpoints.push(structuredClone(run));
    },
  };
  const executor = new RuntimeExecutor(store, invoke);
  const run = executor.createRun("owner", { steps: [spec], concurrency: 1 });
  return { executor, run, checkpoints };
};

test("pure classification: permanent structured evidence wins over transient hints", () => {
  for (const [hints, category] of [
    [{ category: "permission", status: 503 }, "permission"],
    [{ code: "EPERM" }, "permission"],
    [{ code: "FS_SANDBOX_DENIED" }, "permission"],
    [{ code: "FS_PERMISSION_DENIED" }, "permission"],
    [{ code: "INVALID_ARGS" }, "invalid"],
    [{ code: "UNKNOWN_TOOL" }, "not_found"],
    [{ code: "FS_NOT_FOUND" }, "not_found"],
    [{ code: "ABORTED", status: 503 }, "deterministic"],
    [{ code: "ABORTED_BEFORE_DISPATCH" }, "deterministic"],
    [{ errno: "EACCES" }, "permission"],
    [{ status: 403 }, "permission"],
    [{ code: "EINVAL" }, "invalid"],
    [{ category: "invalid" }, "invalid"],
    [{ statusCode: 422 }, "invalid"],
    [{ code: "ENOENT" }, "not_found"],
    [{ category: "not_found" }, "not_found"],
    [{ status: 404 }, "not_found"],
    [{ status: 409 }, "deterministic"],
    [{ code: "UNKNOWN_HOST_CODE" }, "deterministic"],
    [{ category: "transient" }, "deterministic"],
    [{ status: "503" }, "deterministic"],
  ])
    assert.deepEqual(classifyRetryError(failure(hints)), {
      category,
      retryable: false,
    });
});

test("pure classification: only known transient statuses/errno enable structured retries", () => {
  for (const hints of [
    { status: 408 },
    { statusCode: 429 },
    { status: 500 },
    { status: 599 },
    { code: "ECONNRESET" },
    { errno: "EAI_AGAIN" },
  ])
    assert.deepEqual(classifyRetryError(failure(hints)), {
      category: "transient",
      retryable: true,
    });
});

test("legacy ordinary Errors retain retries and message text never infers policy", () => {
  for (const value of [
    Error("permission denied ENOENT 403"),
    Error("transient"),
    Error("RUNTIME_STEP_FAILED"),
    null,
    "ENOENT",
  ])
    assert.deepEqual(classifyRetryError(value), {
      category: "legacy_unknown",
      retryable: true,
    });
  let calls = 0;
  const error = Object.defineProperty(Error("secret"), "code", {
    get() {
      calls++;
      throw Error("must not read");
    },
  });
  classifyRetryError(error);
  assert.equal(calls, 0);
});

test("pure bounded exponential delay: 100/200/400 only, no unsafe exponent", () => {
  assert.deepEqual([1, 2, 3].map(retryDelayMs), [100, 200, 400]);
  for (const n of [0, -1, 4, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER])
    assert.equal(retryDelayMs(n), 0);
});

test("backoff abort removes listener and already-aborted signals allocate no listener", async () => {
  const controller = new AbortController();
  const pending = waitForRetry(400, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort();
  await pending;
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await waitForRetry(400, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const live = new AbortController();
  await waitForRetry(0, live.signal);
  assert.equal(getEventListeners(live.signal, "abort").length, 0);
});

test("executor deterministic host errors fail once and redact messages/hints", async () => {
  for (const hints of [
    { category: "permission" },
    { code: "EINVAL" },
    { errno: "ENOENT" },
    { status: 404 },
    { status: 409 },
  ]) {
    let calls = 0;
    const { executor, run, checkpoints } = fixture(async () => {
      calls++;
      throw failure(hints);
    });
    await executor.execute(run);
    assert.equal(calls, 1);
    assert.equal(run.state, "failed");
    assert.equal(run.steps[0].error, "RUNTIME_STEP_FAILED");
    assert.equal(JSON.stringify(checkpoints).includes("secret"), false);
  }
});

test("executor legacy unknown ordinary Error compatibility and retry checkpoints", async () => {
  let calls = 0;
  const { executor, run, checkpoints } = fixture(
    async () => {
      if (++calls < 3) throw Error("ordinary unknown");
      return "ok";
    },
    step("read", 2),
  );
  await executor.execute(run);
  assert.equal(run.state, "succeeded");
  assert.equal(calls, 3);
  assert.deepEqual(
    checkpoints
      .filter((r) => r.steps[0].state === "pending")
      .map((r) => r.steps[0].attempts),
    [0, 0, 1, 2],
  );
});

test("executor known transient failure exhausts at most three retries", async () => {
  let calls = 0;
  const { executor, run } = fixture(
    async () => {
      calls++;
      throw failure({ status: 503 });
    },
    step("read", 100),
  );
  await executor.execute(run);
  assert.equal(calls, 4);
  assert.equal(run.state, "failed");
});

test("agent and mutation never retry even with a transient hint", async () => {
  for (const tool of ["agent", "write", "pwsh"]) {
    let calls = 0;
    const { executor, run } = fixture(async () => {
      calls++;
      throw failure({ status: 503 });
    }, step(tool));
    await executor.execute(run);
    assert.equal(calls, 1);
  }
});

test("explicit timeout retains stable code and never retries", async () => {
  let calls = 0;
  const { executor, run } = fixture(async () => {
    calls++;
    throw Object.assign(Error("RUNTIME_STEP_TIMEOUT"), { status: 503 });
  });
  await executor.execute(run);
  assert.equal(calls, 1);
  assert.equal(run.error, "RUNTIME_STEP_TIMEOUT");
});

test("cancel during checkpointed backoff prevents next invocation", async () => {
  let backoff;
  const reached = new Promise((resolve) => {
    backoff = resolve;
  });
  let calls = 0;
  const { executor, run } = fixture(
    async () => {
      calls++;
      throw failure({ status: 429 });
    },
    step(),
    (run) => {
      if (run.steps[0].state === "pending" && run.steps[0].attempts === 1)
        backoff();
    },
  );
  const execution = executor.execute(run);
  await reached;
  executor.cancel(run);
  await execution;
  assert.equal(calls, 1);
  assert.equal(run.state, "cancelled");
  assert.equal(run.steps[0].state, "cancelled");
});

test("storage failure at retry checkpoint remains fail-stop", async () => {
  let calls = 0;
  const { executor, run } = fixture(
    async () => {
      calls++;
      throw failure({ status: 503 });
    },
    step(),
    (run) => {
      if (run.steps[0].state === "pending" && run.steps[0].attempts === 1)
        throw Error("disk secret");
    },
  );
  await assert.rejects(executor.execute(run), {
    message: "RUNTIME_STORAGE_FAILED",
  });
  assert.equal(calls, 1);
  assert.equal(run.error, "RUNTIME_STORAGE_FAILED");
});

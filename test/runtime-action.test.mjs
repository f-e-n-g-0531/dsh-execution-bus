import { test } from "node:test";
import assert from "node:assert/strict";
import { runAction } from "../dist/runtime/action.js";
import { runAttention } from "../dist/runtime/attention.js";
import { reviewSnapshot } from "../dist/runtime/review.js";
import {
  setRetryBackoff,
  clearRetryBackoff,
  runWaiting,
} from "../dist/runtime/waiting.js";

const step = (id, tool = "read", state = "succeeded", extra = {}) => ({
  id,
  tool,
  state,
  attempts: state === "pending" ? 0 : 1,
  ...extra,
});
const record = (steps = [step("read")], extra = {}) => ({
  version: 1,
  runId: "run-12345678",
  ownerSessionId: "PRIVATE_OWNER",
  state: "succeeded",
  createdAt: 10,
  updatedAt: 20,
  steps,
  results: Object.fromEntries(
    steps
      .filter((s) => s.state === "succeeded")
      .map((s) => [s.id, { value: "ok" }]),
  ),
  plan: {
    concurrency: 1,
    steps: steps.map((s) => ({
      id: s.id,
      tool: s.tool,
      input: { prompt: "PRIVATE_PROMPT" },
      dependsOn: [],
      retry: 1,
      timeoutMs: 1000,
    })),
  },
  ...extra,
});
const workerResult = {
  value: {
    output: "PRIVATE_OUTPUT",
    report: {
      outcome: "blocked",
      summary: "PRIVATE_SUMMARY",
      evidence: [{ path: "PRIVATE_PATH", revision: "PRIVATE_REVISION" }],
      limitations: ["PRIVATE_LIMITATION"],
      requestedDecision: "PRIVATE_DECISION",
    },
  },
};
function acknowledge(run, kind, settled = true) {
  const attention = runAttention(run, settled);
  const item = attention.items.find((item) => item.kind === kind);
  assert.ok(item, kind);
  run.acknowledgements ??= [];
  run.acknowledgements.push({
    revision: run.acknowledgements.length + 1,
    snapshotHash: attention.snapshotHash,
    key: item.key,
    reason: "PRIVATE_ACK_REASON",
    at: 20,
  });
}
function review(run, disposition = "accepted") {
  run.ownerReviews = [
    {
      revision: 1,
      snapshotHash: reviewSnapshot(run),
      disposition,
      reason: "PRIVATE_REVIEW_REASON",
      at: 20,
    },
  ];
}
function expectAction(run, kind, actor, settled) {
  const action = runAction(run, settled);
  assert.equal(action.kind, kind);
  assert.equal(action.actor, actor);
  assert.equal(typeof action.message, "string");
  assert.ok(action.message.length);
  assert.deepEqual(Object.keys(action).sort(), ["actor", "kind", "message"]);
  return action;
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test("unknown external effects outrank cleanup and all owner tasks even acknowledged", () => {
  for (const state of ["running", "failed", "cancelled", "interrupted"]) {
    const run = record(
      [
        step("write", "write", "unknown"),
        step("worker", "agent"),
        step("missing"),
      ],
      { state },
    );
    run.results.worker = structuredClone(workerResult);
    delete run.results.missing;
    acknowledge(run, "inspect_external_state");
    assert.equal(runAttention(run, true).items[0].acknowledged, true);
    for (const settled of [undefined, false, true]) {
      const action = expectAction(
        run,
        "inspect_external_state",
        "owner",
        settled,
      );
      assert.match(action.message, /已知悉不等于解决/);
    }
  }
});

test("storage failures and interrupted in-flight writes retain external uncertainty", () => {
  for (const run of [
    record([step("read")], { error: "RUNTIME_STORAGE_FAILED" }),
    record(
      [step("read", "read", "failed", { error: "RUNTIME_STORAGE_FAILED" })],
      { state: "failed" },
    ),
    record([step("write", "write", "running")], { state: "interrupted" }),
    record(
      [step("write", "write", "failed", { error: "RUNTIME_INTERRUPTED" })],
      { state: "failed" },
    ),
  ])
    expectAction(run, "inspect_external_state", "owner", false);
});

test("pending cleanup outranks failure, decisions, unavailable results and review", () => {
  for (const run of [
    record([step("failed", "read", "failed")], { state: "failed" }),
    record([step("worker", "agent")], {
      results: { worker: structuredClone(workerResult) },
    }),
    record([step("missing")], { results: {} }),
    record(),
    record([step("read", "read", "running")], { state: "interrupted" }),
    record([step("read", "read", "cancelled")], { state: "cancelled" }),
  ]) {
    const action = expectAction(run, "wait_cleanup", "runtime", false);
    assert.match(action.message, /不确认普通宿主调用或后台 Job 已停止/);
  }
});

test("unacknowledged failure precedes decision, then unavailable result", () => {
  const run = record(
    [
      step("failed", "read", "failed"),
      step("worker", "agent"),
      step("missing"),
    ],
    { state: "failed" },
  );
  run.results.worker = structuredClone(workerResult);
  delete run.results.missing;
  expectAction(run, "inspect_failure", "owner", true);
  acknowledge(run, "inspect_failure");
  expectAction(run, "decision_required", "owner", true);
  acknowledge(run, "decision_required");
  expectAction(run, "result_unavailable", "owner", true);
  acknowledge(run, "result_unavailable");
  const action = expectAction(run, "settled", "none", true);
  assert.match(action.message, /已知悉不等于问题已解决/);
  assert.equal(run.steps[0].state, "failed");
  run.steps[0].error = "new failure";
  expectAction(run, "inspect_failure", "owner", true);
});

test("unavailable results precede read-only resume; acknowledgement is not recovery", () => {
  const run = record([step("read", "read", "running"), step("missing")], {
    state: "interrupted",
    results: {},
  });
  expectAction(run, "result_unavailable", "owner", true);
  acknowledge(run, "result_unavailable");
  expectAction(run, "resume_read_only", "owner", true);
  acknowledge(run, "resume_read_only");
  expectAction(run, "settled", "none", true);
  assert.equal(run.state, "interrupted");
  assert.equal(run.steps[0].state, "running");
});

test("successful results require review; current owner acceptance is not independent verification", () => {
  const run = record();
  expectAction(run, "review_results", "owner", true);
  review(run, "needs_work");
  expectAction(run, "review_results", "owner", true);
  review(run);
  const action = expectAction(run, "settled", "none", true);
  assert.match(action.message, /不证明独立验收或人工批准/);
  assert.match(action.message, /不表示交付完成/);
  run.results.read.value = "changed";
  expectAction(run, "review_results", "owner", true);
});

test("owner acceptance never hides a requested decision or missing/truncated result", () => {
  const run = record([step("worker", "agent")], {
    results: { worker: structuredClone(workerResult) },
  });
  review(run);
  expectAction(run, "decision_required", "owner", true);
  run.results.worker = { truncated: true, bytes: 100000 };
  expectAction(run, "result_unavailable", "owner", true);
  delete run.results.worker;
  expectAction(run, "result_unavailable", "owner", true);
});

test("retry backoff projects runtime waiting without granting retries or mutating metadata", () => {
  const run = record([step("read", "read", "pending")], { state: "running" });
  for (const category of [
    "transient",
    "legacy_unknown",
    "permission",
    "deterministic",
  ]) {
    setRetryBackoff(run, "read", {
      waitingSince: 100,
      nextRetryAt: 200,
      retryCategory: category,
    });
    const before = structuredClone(runWaiting(run));
    expectAction(run, "wait_retry", "runtime", false);
    assert.deepEqual(runWaiting(run), before);
  }
  // Owner tasks outrank retry even while another step is waiting.
  run.steps.push(step("missing"));
  expectAction(run, "result_unavailable", "owner", false);
  run.steps.pop();
  clearRetryBackoff(run, "read");
  expectAction(run, "working", "runtime", false);
  setRetryBackoff(run, "read", {
    waitingSince: 100,
    nextRetryAt: 200,
    retryCategory: "transient",
  });
  run.state = "failed";
  expectAction(run, "wait_cleanup", "runtime", false);
  expectAction(run, "inspect_failure", "owner", true);
  clearRetryBackoff(run, "read");
});

test("scheduler and dependency waiting remain working, not cleanup or retry", () => {
  const run = record(
    [step("a", "read", "pending"), step("b", "read", "pending")],
    { state: "running" },
  );
  run.plan.steps[1].dependsOn = ["a"];
  for (const settled of [undefined, false, true])
    expectAction(run, "working", "runtime", settled);
});

test("settled with unknown cleanup cannot imply cleanup, delivery or independent acceptance", () => {
  const run = record();
  review(run);
  const unknown = expectAction(run, "settled", "none");
  assert.match(unknown.message, /清理状态未知/);
  assert.doesNotMatch(unknown.message, /清理完成|已收束/);
  expectAction(run, "wait_cleanup", "runtime", false);
  assert.match(
    expectAction(run, "settled", "none", true).message,
    /不确认普通宿主调用或后台 Job 已停止/,
  );
});

test("projection is pure, deterministic and exposes no private inputs, errors, reports or reasons", () => {
  const cases = [
    record([step("PRIVATE_STEP", "write", "unknown")], {
      error: "PRIVATE_ERROR",
      goal: "PRIVATE_GOAL",
    }),
    record([step("PRIVATE_STEP", "agent")], {
      results: { PRIVATE_STEP: structuredClone(workerResult) },
    }),
    record(
      [step("PRIVATE_STEP", "read", "failed", { error: "PRIVATE_ERROR" })],
      { state: "failed" },
    ),
    record([step("PRIVATE_STEP")], {
      results: { PRIVATE_STEP: { truncated: true, bytes: 100000 } },
    }),
    record([step("PRIVATE_STEP", "read", "running")], { state: "interrupted" }),
    record(),
  ];
  const acknowledged = record([step("PRIVATE_STEP", "read", "failed")], {
    state: "failed",
  });
  acknowledge(acknowledged, "inspect_failure");
  cases.push(acknowledged);
  const accepted = record();
  review(accepted);
  cases.push(accepted);
  for (const run of cases) {
    const before = structuredClone(run);
    freeze(run);
    for (const settled of [undefined, false, true]) {
      const first = runAction(run, settled);
      assert.deepEqual(first, runAction(run, settled));
      assert.doesNotMatch(JSON.stringify(first), /PRIVATE_|run-12345678/);
      first.message = "caller mutation";
      assert.notEqual(runAction(run, settled).message, first.message);
    }
    assert.deepEqual(run, before);
  }
});

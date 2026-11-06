import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runAcceptance, runRecovery } from "../dist/runtime/insights.js";

const step = (id, tool = "agent", state = "succeeded", error) => ({
  id,
  tool,
  state,
  attempts: state === "pending" ? 0 : 1,
  ...(error === undefined ? {} : { error }),
});
const record = (steps = [], extra = {}) => ({
  version: 1,
  runId: "run-12345678",
  ownerSessionId: "owner",
  state: "succeeded",
  createdAt: 10,
  updatedAt: 20,
  steps,
  results: {},
  plan: {
    concurrency: 1,
    steps: steps.map((s) => ({
      id: s.id,
      tool: s.tool,
      input: { prompt: "PRIVATE_PROMPT" },
      dependsOn: [],
      retry: 0,
      timeoutMs: 1000,
    })),
  },
  ...extra,
});
const report = (extra = {}) => ({
  outcome: "completed",
  summary: "PRIVATE_SUMMARY",
  evidence: [{ path: "PRIVATE_PATH", revision: "PRIVATE_REVISION" }],
  limitations: [],
  ...extra,
});
const envelope = (reportValue) => ({
  sessionId: "PRIVATE_SESSION",
  output: "PRIVATE_OUTPUT",
  verification: "not_independently_verified",
  report: reportValue,
});
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test("acceptance includes only agent states and hashes only complete successful values", () => {
  const states = [
    "pending",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "unknown",
  ];
  const steps = states.map((state) => step(state, "agent", state));
  steps.push(
    step("ordinary", "read"),
    step("truncated"),
    step("missing"),
    step("null"),
  );
  const run = record(steps);
  for (const state of states)
    run.results[state] = { value: { output: "PRIVATE_OUTPUT" } };
  run.results.truncated = {
    truncated: true,
    value: envelope(report()),
    bytes: 100000,
  };
  run.results.missing = { bytes: 1 };
  run.results.null = { value: null };
  const acceptance = runAcceptance(run);
  assert.equal(acceptance.status, "not_reviewed");
  assert.equal(acceptance.workers.length, 9);
  for (const state of states) {
    assert.deepEqual(
      acceptance.workers.find((w) => w.stepId === state),
      {
        stepId: state,
        state,
        ...(state === "succeeded"
          ? { resultHash: hash(run.results[state].value) }
          : {}),
      },
    );
  }
  assert.deepEqual(
    acceptance.workers.find((w) => w.stepId === "truncated"),
    { stepId: "truncated", state: "succeeded" },
  );
  assert.deepEqual(
    acceptance.workers.find((w) => w.stepId === "missing"),
    { stepId: "missing", state: "succeeded" },
  );
  assert.deepEqual(
    acceptance.workers.find((w) => w.stepId === "null"),
    { stepId: "null", state: "succeeded", resultHash: hash(null) },
  );
});

test("validated worker claims expose counts only, never free text or acceptance", () => {
  const run = record([step("worker")]);
  const statuses = ["observed", "not_verified", "blocked"];
  run.plan.steps[0].input.acceptance_criteria = statuses.map((_, i) => ({
    id: "c" + i,
    description: "PRIVATE_CONTRACT",
  }));
  const value = envelope(
    report({
      outcome: "partial",
      limitations: ["PRIVATE_LIMITATION"],
      requestedDecision: "PRIVATE_DECISION",
      criteria: statuses.map((status, i) => ({
        id: "c" + i,
        status,
        evidence_indices: [0],
        note: "PRIVATE_NOTE",
      })),
    }),
  );
  run.results.worker = { value };
  const before = structuredClone(run);
  freeze(run);
  const acceptance = runAcceptance(run);
  assert.deepEqual(acceptance, {
    status: "not_reviewed",
    workers: [
      {
        stepId: "worker",
        state: "succeeded",
        resultHash: hash(value),
        reportOutcome: "partial",
        criteria: { observed: 1, notVerified: 1, blocked: 1 },
        evidenceCount: 1,
        limitationCount: 1,
        decisionRequired: true,
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(acceptance), /PRIVATE_/);
  assert.deepEqual(run, before);
  acceptance.workers[0].criteria.observed = 99;
  assert.equal(runAcceptance(run).workers[0].criteria.observed, 1);
});

test("valid reports without a contract omit criteria; decisions are nonempty fields only", () => {
  for (const outcome of ["completed", "partial", "blocked"]) {
    const value = envelope(
      report(
        outcome === "completed"
          ? {}
          : { outcome, limitations: ["PRIVATE_LIMITATION"] },
      ),
    );
    const run = record([step("worker")], { results: { worker: { value } } });
    assert.deepEqual(runAcceptance(run).workers[0], {
      stepId: "worker",
      state: "succeeded",
      resultHash: hash(value),
      reportOutcome: outcome,
      evidenceCount: 1,
      limitationCount: outcome === "completed" ? 0 : 1,
      decisionRequired: false,
    });
  }
});

test("malformed reports never yield report summaries even if their value has a hash", () => {
  const malformed = [
    undefined,
    null,
    "not json",
    JSON.stringify(report()),
    {},
    report({ verified: true }),
    report({ evidence: [] }),
    report({ outcome: "partial" }),
    report({
      outcome: "blocked",
      limitations: ["x"],
      requestedDecision: "   ",
    }),
    report({ summary: "x".repeat(4097) }),
    report({ evidence: [{ path: "x", lineEnd: 1 }] }),
    report({ criteria: [] }),
  ];
  for (const reportValue of malformed) {
    const value = envelope(reportValue);
    const run = record([step("worker")], { results: { worker: { value } } });
    assert.deepEqual(runAcceptance(run).workers[0], {
      stepId: "worker",
      state: "succeeded",
      resultHash: hash(value),
    });
  }
});

test("contract mismatch, invalid evidence index, and oversized report are not coverage", () => {
  for (const change of [
    { criteria: [] },
    {
      criteria: [
        { id: "other", status: "observed", evidence_indices: [], note: "x" },
      ],
    },
    {
      criteria: [
        { id: "c", status: "observed", evidence_indices: [1], note: "x" },
      ],
    },
    { limitations: Array(32).fill("x".repeat(1024)) },
  ]) {
    const run = record([step("worker")]);
    run.plan.steps[0].input.acceptance_criteria = [
      { id: "c", description: "PRIVATE_CONTRACT" },
    ];
    const value = envelope(
      report({
        criteria: [
          { id: "c", status: "observed", evidence_indices: [0], note: "x" },
        ],
        ...change,
      }),
    );
    run.results.worker = { value };
    assert.deepEqual(runAcceptance(run).workers[0], {
      stepId: "worker",
      state: "succeeded",
      resultHash: hash(value),
    });
  }
});

test("hash uses the full JSON value with Unicode and no report or contract fallback", () => {
  const value = { output: "中文🧪", report: report() };
  const run = record([step("worker")], { results: { worker: { value } } });
  run.plan.steps[0].input.acceptance_criteria = [
    { id: "invalid id", description: "x" },
  ];
  assert.deepEqual(runAcceptance(run).workers[0], {
    stepId: "worker",
    state: "succeeded",
    resultHash: hash(value),
  });
  delete run.plan.steps[0].input.acceptance_criteria;
  delete value.report;
  assert.deepEqual(runAcceptance(run).workers[0], {
    stepId: "worker",
    state: "succeeded",
    resultHash: hash(value),
  });
});

test("recovery cleanup is supplied independently and never confirms external work", () => {
  const run = record([step("read", "read")], {
    results: { read: { value: null } },
  });
  for (const [settled, cleanup] of [
    [true, "settled"],
    [false, "pending"],
    [undefined, "unknown"],
  ]) {
    const recovery = runRecovery(run, settled);
    assert.equal(recovery.cleanup, cleanup);
    assert.equal(recovery.externalWork, "unconfirmed");
    assert.equal(recovery.resultCertainty, "recorded");
    assert.equal(
      recovery.nextAction,
      settled === false ? "wait" : "review_results",
    );
    assert.match(recovery.message, /不确认.*Job/);
  }
});

test("running, missing and truncated results remain incomplete without inventing uncertainty", () => {
  const run = record([step("read", "read")]);
  for (const stored of [undefined, {}, { truncated: true, bytes: 100000 }]) {
    run.results = stored ? { read: stored } : {};
    assert.equal(runRecovery(run, true).resultCertainty, "incomplete");
    assert.equal(runRecovery(run, true).nextAction, "review_results");
  }
  run.state = "running";
  run.steps[0].state = "running";
  assert.equal(runRecovery(run).resultCertainty, "incomplete");
  assert.equal(runRecovery(run).nextAction, "wait");
});

test("interrupted read-only unknown/running steps allow explicit resume but remain uncertain", () => {
  for (const tool of ["read", "glob", "grep"]) {
    for (const state of ["running", "unknown"]) {
      const run = record(
        [step("read", tool, state), step("future", "write", "pending")],
        { state: "interrupted" },
      );
      const recovery = runRecovery(run, true);
      assert.equal(recovery.resultCertainty, "unknown");
      assert.equal(recovery.nextAction, "resume_read_only");
      assert.match(recovery.message, /可能继续尚未启动/);
      assert.equal(runRecovery(run, false).nextAction, "wait");
    }
  }
});

test("unknown side effects and interrupted workers must never recommend replay", () => {
  for (const tool of ["write", "edit", "pwsh", "agent"]) {
    for (const [state, error] of [
      ["unknown"],
      ["running"],
      ["failed", "RUNTIME_INTERRUPTED"],
    ]) {
      const run = record([step("unsafe", tool, state, error)], {
        state: "interrupted",
      });
      for (const settled of [true, false, undefined]) {
        const recovery = runRecovery(run, settled);
        assert.equal(recovery.resultCertainty, "unknown");
        assert.equal(recovery.nextAction, "inspect_external_state");
        assert.match(recovery.message, /不要自动重发/);
      }
    }
  }
});

test("storage failure overrides success and read-only recovery advice", () => {
  for (const onStep of [true, false]) {
    const run = record([step("read", "read", "unknown")], {
      state: "interrupted",
    });
    if (onStep) run.steps[0].error = "RUNTIME_STORAGE_FAILED";
    else run.error = "RUNTIME_STORAGE_FAILED";
    assert.equal(runRecovery(run, true).resultCertainty, "unknown");
    assert.equal(runRecovery(run, true).nextAction, "inspect_external_state");
  }
  const run = record([], { error: "RUNTIME_STORAGE_FAILED" });
  assert.equal(runRecovery(run, false).nextAction, "inspect_external_state");
});

test("known failures block resume; cancelled and non-interrupted unknown calls require inspection", () => {
  for (const state of ["failed", "interrupted"]) {
    const run = record([step("failure", "read", "failed")], { state });
    assert.equal(runRecovery(run, true).nextAction, "inspect_failure");
    assert.equal(runRecovery(run, true).resultCertainty, "incomplete");
  }
  for (const run of [
    record([step("read", "read", "unknown")], { state: "failed" }),
    record([step("read", "read", "cancelled")], { state: "cancelled" }),
  ])
    assert.equal(runRecovery(run, true).nextAction, "inspect_external_state");
  assert.equal(
    runRecovery(
      record([step("read", "read", "pending")], { state: "interrupted" }),
      true,
    ).nextAction,
    "resume_read_only",
  );
});

test("both projections are immutable and recovery never echoes malicious free text", () => {
  const run = record([step("worker", "agent", "unknown", "PRIVATE_ERROR")], {
    state: "interrupted",
    goal: "PRIVATE_GOAL",
    error: "PRIVATE_ERROR",
    results: {
      worker: {
        value: envelope(report({ requestedDecision: "PRIVATE_DECISION" })),
      },
    },
  });
  const before = structuredClone(run);
  freeze(run);
  for (const settled of [true, false, undefined]) {
    const output = {
      acceptance: runAcceptance(run),
      recovery: runRecovery(run, settled),
    };
    assert.doesNotMatch(JSON.stringify(output), /PRIVATE_/);
    assert.deepEqual(run, before);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runAttention } from "../dist/runtime/attention.js";

const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const step = (id, tool = "read", state = "succeeded", extra = {}) => ({
  id,
  tool,
  state,
  attempts: 1,
  ...extra,
});
const record = (steps = [], extra = {}) => ({
  version: 1,
  runId: "run-12345678",
  ownerSessionId: "PRIVATE_OWNER",
  createdAt: 1,
  updatedAt: 2,
  state: "succeeded",
  steps,
  results: Object.fromEntries(
    steps
      .filter((s) => s.state === "succeeded")
      .map((s) => [s.id, { value: null }]),
  ),
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
const workerValue = (extra = {}) => ({
  output: "PRIVATE_OUTPUT",
  sessionId: "PRIVATE_SESSION",
  report: {
    outcome: "partial",
    summary: "PRIVATE_SUMMARY",
    evidence: [{ path: "PRIVATE_PATH", revision: "PRIVATE_REVISION" }],
    limitations: ["PRIVATE_LIMITATION"],
    ...extra,
  },
});
const kinds = (attention) => attention.items.map((item) => item.kind);
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

for (const { name, state, steps, error, settled, expected } of [
  {
    name: "ordinary completed tools need one review",
    state: "succeeded",
    steps: [step("a"), step("b", "write")],
    expected: ["review_results"],
  },
  {
    name: "normal running progress stays silent",
    state: "running",
    steps: [step("a", "read", "running"), step("b", "read", "pending")],
    expected: [],
  },
  {
    name: "completed results during running are not a final review",
    state: "running",
    steps: [step("a")],
    expected: [],
  },
  {
    name: "failure needs inspection",
    state: "failed",
    steps: [step("a", "read", "failed")],
    expected: ["inspect_failure"],
  },
  {
    name: "cancellation does not prove external work stopped",
    state: "cancelled",
    steps: [step("a", "read", "cancelled")],
    expected: ["inspect_external_state"],
  },
  {
    name: "unsafe unknown outranks failure",
    state: "failed",
    steps: [step("a", "write", "unknown"), step("b", "read", "failed")],
    expected: ["inspect_external_state"],
  },
  {
    name: "storage failure outranks review",
    state: "succeeded",
    steps: [step("a")],
    error: "RUNTIME_STORAGE_FAILED",
    expected: ["inspect_external_state"],
  },
  {
    name: "interrupted read-only recovery needs explicit disposition, not review",
    state: "interrupted",
    steps: [step("a", "read", "running")],
    expected: ["resume_read_only"],
  },
  {
    name: "interrupted side effects require inspection",
    state: "interrupted",
    steps: [step("a", "write", "running")],
    expected: ["inspect_external_state"],
  },
  {
    name: "pending cleanup suppresses premature review",
    state: "succeeded",
    steps: [step("a")],
    settled: false,
    expected: [],
  },
]) {
  test(`attention states: ${name}`, () => {
    const run = record(steps, { state, ...(error ? { error } : {}) });
    const attention = runAttention(run, settled);
    assert.deepEqual(kinds(attention), expected);
    assert.equal(attention.notification.shouldNotify, expected.length > 0);
    assert.equal(
      attention.notification.key,
      hash({ runId: run.runId, items: attention.items }),
    );
  });
}

for (const [name, stored, missing] of [
  ["absent", undefined, true],
  ["no value", {}, true],
  ["undefined is not complete", { value: undefined }, true],
  ["truncated", { truncated: true, bytes: 70000 }, true],
  ["truncated even with value", { truncated: true, value: null }, true],
  ["null is complete", { value: null }, false],
  ["false is complete", { value: false }, false],
  ["zero is complete", { value: 0 }, false],
  ["empty string is complete", { value: "" }, false],
]) {
  test(`saved result: ${name}`, () => {
    const run = record([step("a")], {
      results: stored === undefined ? {} : { a: stored },
    });
    const attention = runAttention(run);
    assert.deepEqual(kinds(attention), [
      missing ? "result_unavailable" : "review_results",
    ]);
    assert.equal(attention.items[0].stepId, missing ? "a" : undefined);
  });
}

test("only succeeded steps are checked for missing results", () => {
  for (const state of [
    "pending",
    "running",
    "failed",
    "cancelled",
    "unknown",
  ]) {
    const run = record([step("a", "read", state)], {
      state: "running",
      results: {},
    });
    assert.deepEqual(runAttention(run).items, []);
  }
  const run = record([step("a")], { state: "running", results: {} });
  assert.deepEqual(kinds(runAttention(run)), ["result_unavailable"]);
});

for (const state of ["running", "succeeded", "failed", "cancelled"]) {
  test(`completed Worker decision is visible while run is ${state}`, () => {
    const value = workerValue({ requestedDecision: "PRIVATE_DECISION" });
    const run = record([step("worker", "agent")], {
      state,
      results: { worker: { value } },
    });
    const attention = runAttention(run);
    const prefix =
      state === "failed"
        ? ["inspect_failure"]
        : state === "cancelled"
          ? ["inspect_external_state"]
          : [];
    assert.deepEqual(kinds(attention), [...prefix, "decision_required"]);
    assert.equal(attention.items.at(-1).resultHash, hash(value));
    assert.equal(attention.items.at(-1).stepId, "worker");
    assert.doesNotMatch(JSON.stringify(attention), /PRIVATE/);
  });
}

test("severity order, per-step items, and duplicate suppression", () => {
  for (const external of [false, true]) {
    const value = workerValue({ requestedDecision: "PRIVATE_DECISION" });
    const run = record(
      [
        step("z"),
        step("worker", "agent"),
        step("a"),
        step("worker", "agent"),
        step("bad", "write", external ? "unknown" : "failed"),
      ],
      { state: "failed", results: { worker: { value } } },
    );
    const attention = runAttention(run);
    assert.deepEqual(kinds(attention), [
      external ? "inspect_external_state" : "inspect_failure",
      "decision_required",
      "result_unavailable",
      "result_unavailable",
    ]);
    assert.deepEqual(
      attention.items.map((item) => item.stepId),
      [undefined, "worker", "a", "z"],
    );
    assert.equal(new Set(attention.items.map((item) => item.key)).size, 4);
  }
});

test("decision requires a complete valid successful Worker report", () => {
  for (const [state, value, truncated, expected] of [
    [
      "succeeded",
      workerValue({ requestedDecision: "  " }),
      false,
      "review_results",
    ],
    [
      "succeeded",
      workerValue({
        requestedDecision: "PRIVATE_DECISION",
        outcome: "invalid",
      }),
      false,
      "review_results",
    ],
    [
      "succeeded",
      workerValue({ requestedDecision: "PRIVATE_DECISION" }),
      true,
      "result_unavailable",
    ],
    [
      "running",
      workerValue({ requestedDecision: "PRIVATE_DECISION" }),
      false,
      undefined,
    ],
  ]) {
    const run = record([step("worker", "agent", state)], {
      state: state === "running" ? "running" : "succeeded",
      results: { worker: { value, ...(truncated ? { truncated: true } : {}) } },
    });
    assert.deepEqual(kinds(runAttention(run)), expected ? [expected] : []);
  }
});

test("stable keys ignore timestamps, attempts, progress, and storage insertion order", () => {
  const value = workerValue({ requestedDecision: "PRIVATE_DECISION" });
  const run = record(
    [step("worker", "agent"), step("pending", "read", "pending")],
    {
      state: "running",
      results: { worker: { value } },
    },
  );
  const before = runAttention(run);
  run.updatedAt += 1000;
  run.steps[0].attempts += 5;
  run.steps[1].state = "running";
  run.steps.reverse();
  assert.deepEqual(runAttention(run), before);
  const review = record([step("z"), step("a")]);
  const original = runAttention(review);
  review.results = { a: { value: null }, z: { value: null } };
  review.steps.reverse();
  assert.deepEqual(runAttention(review), original);
  review.results.a.value = "changed";
  assert.notEqual(
    runAttention(review).notification.key,
    original.notification.key,
  );
  assert.notEqual(
    runAttention({ ...run, runId: "run-87654321" }).notification.key,
    before.notification.key,
  );
});

test("frozen inputs remain unchanged and repeated reads never acknowledge notification", () => {
  const run = freeze(
    record([step("worker", "agent"), step("missing")], {
      results: {
        worker: {
          value: workerValue({ requestedDecision: "PRIVATE_DECISION" }),
        },
      },
    }),
  );
  const before = structuredClone(run);
  const first = runAttention(run, true);
  assert.deepEqual(run, before);
  assert.deepEqual(runAttention(run, true), first);
  assert.equal(first.notification.shouldNotify, true);
  assert.doesNotMatch(
    JSON.stringify(first),
    /PRIVATE|accepted|delivered|readAt|acknowledged/,
  );
  first.items.length = 0;
  assert.equal(runAttention(run, true).items.length, 2);
});

test("inherited and unserializable values are unavailable, never complete", () => {
  const circular = {};
  circular.self = circular;
  for (const stored of [
    Object.create({ value: null }),
    { value: circular },
    { value: 1n },
  ]) {
    assert.deepEqual(
      kinds(runAttention(record([step("a")], { results: { a: stored } }))),
      ["result_unavailable"],
    );
  }
  assert.deepEqual(
    kinds(
      runAttention(
        record([step("a")], {
          results: Object.create({ a: { value: null } }),
        }),
      ),
    ),
    ["result_unavailable"],
  );
});

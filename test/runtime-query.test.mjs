import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery, queryRuns } from "../dist/runtime/query.js";
import { runAttention } from "../dist/runtime/attention.js";
import { runAction } from "../dist/runtime/action.js";
import { reviewSnapshot } from "../dist/runtime/review.js";

// Independent in-memory records, following runtime-action's fixture shape.
function record(runId = "run-12345678", extra = {}) {
  return {
    version: 1, runId, ownerSessionId: "owner", state: "succeeded",
    goal: "查询模块", createdAt: 1, updatedAt: 10,
    plan: { taskId: "query-task", concurrency: 1, steps: [
      { id: "read", tool: "read", input: { path: "PRIVATE_INPUT", prompt: "PRIVATE_PROMPT" },
        dependsOn: [], retry: 0, timeoutMs: 1000 },
    ] },
    steps: [{ id: "read", tool: "read", state: "succeeded", attempts: 1 }],
    results: { read: { value: "PRIVATE_RESULT" } },
    ...extra,
  };
}
const query = (runs, raw = {}, settled = () => true) => queryRuns(runs, parseQuery(raw), settled);
const ids = (result) => result.runs.map((run) => run.runId);
function acknowledge(run, kind) {
  const attention = runAttention(run, true);
  const item = attention.items.find((item) => item.kind === kind);
  assert.ok(item, kind);
  run.acknowledgements = [{ revision: 1, snapshotHash: attention.snapshotHash,
    key: item.key, reason: "PRIVATE_REASON", at: 10 }];
}
function accept(run) {
  run.ownerReviews = [{ revision: 1, snapshotHash: reviewSnapshot(run),
    disposition: "accepted", reason: "PRIVATE_REASON", at: 10 }];
}
function decision(run) {
  run.plan.steps[0].tool = "agent";
  run.steps[0].tool = "agent";
  run.results.read.value = { report: { outcome: "blocked", summary: "PRIVATE_REPORT",
    evidence: [], limitations: ["PRIVATE_LIMITATION"], requestedDecision: "PRIVATE_DECISION" } };
  return run;
}
function disposeDecision(run) {
  const attention = runAttention(run, true);
  const item = attention.items.find((item) => item.kind === "decision_required");
  assert.ok(item);
  run.decisionDispositions = [{ revision: 1, snapshotHash: attention.snapshotHash,
    key: item.key, disposition: "dismissed", reason: "PRIVATE_REASON", at: 10 }];
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test("parseQuery normalizes defaults, trim and exact legal boundary values", () => {
  assert.deepEqual(parseQuery({}), { view: "all", limit: 20, offset: 0 });
  assert.deepEqual(parseQuery(Object.create(null)), parseQuery({}));
  const raw = { q: "  中文 AbC.*  ", taskId: "Task_1-x", state: "failed",
    action: "inspect_failure", view: "needs_action", limit: 100, offset: 1000 };
  const before = structuredClone(raw);
  assert.deepEqual(parseQuery(raw), { ...raw, q: "中文 AbC.*" });
  assert.deepEqual(raw, before);
  assert.equal(parseQuery({ q: "😀".repeat(128) }).q.length, 256);
  assert.throws(() => parseQuery({ q: " " + "a".repeat(256) + " " }), /INVALID_PLAN/);
  assert.equal(parseQuery({ taskId: "a" + "_".repeat(63) }).taskId.length, 64);
  assert.equal(parseQuery({ limit: 1, offset: 0 }).limit, 1);
  for (const state of ["running", "succeeded", "failed", "cancelled", "interrupted"])
    assert.equal(parseQuery({ state }).state, state);
  for (const action of ["inspect_external_state", "wait_cleanup", "inspect_failure",
    "decision_required", "result_unavailable", "resume_read_only", "review_results",
    "wait_retry", "working", "settled"])
    assert.equal(parseQuery({ action }).action, action);
  for (const view of ["all", "needs_action", "review"])
    assert.equal(parseQuery({ view }).view, view);
});

test("parseQuery rejects nonplain values, unknown keys and unsafe descriptors without getters", () => {
  class Input {}
  let calls = 0;
  const getter = Object.defineProperty({}, "q", { enumerable: true, get() { calls++; return "x"; } });
  const hidden = Object.defineProperty({}, "q", { value: "x" });
  for (const raw of [undefined, null, [], "", 1, true, () => {}, new Date(), new Input(),
    Object.create({ q: "x" }), { unexpected: true }, { [Symbol("q")]: "x" }, getter, hidden,
    Object.defineProperty({}, "unknown", { value: 1 }), JSON.parse('{"__proto__":{}}')])
    assert.throws(() => parseQuery(raw), /INVALID_PLAN/);
  assert.equal(calls, 0);
});

test("parseQuery rejects null, undefined, wrong types and every range violation", () => {
  for (const key of ["q", "taskId", "state", "action", "view", "limit", "offset"]) {
    for (const value of [null, undefined, [], {}, true])
      assert.throws(() => parseQuery({ [key]: value }), /INVALID_PLAN/, key);
  }
  for (const q of [0, "", " \t\n", "a".repeat(257), "😀".repeat(129)])
    assert.throws(() => parseQuery({ q }), /INVALID_PLAN/);
  for (const taskId of [0, "", "1task", " task", "task ", "a/b", "中文", "a".repeat(65)])
    assert.throws(() => parseQuery({ taskId }), /INVALID_PLAN/);
  for (const [key, values] of [
    ["state", [0, "", "FAILED", "unknown", " failed"]],
    ["action", [0, "", "review", "Working", "working "]],
    ["view", [0, "", "needsAction", "ALL", " review"]],
    ["limit", ["20", 0, -1, 101, 1.5, NaN, Infinity, -Infinity]],
    ["offset", ["0", -1, 1001, 0.5, NaN, Infinity, -Infinity]],
  ]) for (const value of values) assert.throws(() => parseQuery({ [key]: value }), /INVALID_PLAN/);
});

test("q searches Chinese and case-insensitive literal substrings of each allowed metadata field", () => {
  const goal = record("run-goal0000", { goal: "修复中文 AbC.*[x]\\路径" });
  const request = record("run-request0", { goal: undefined });
  request.plan.provenance = { request_ref: "REQUEST://中文/AbC.*[x]" };
  const scope = record("run-scope000", { goal: undefined });
  scope.plan.provenance = { scope_summary: "中文 Scope AbC.*[x]" };
  const refs = record("run-refs0000", { goal: undefined });
  refs.plan.provenance = { context_refs: ["other", "中文 context AbC.*[x]"] };
  const no = record("run-other000", { goal: "unrelated" });
  const runs = [goal, request, scope, refs, no];
  for (const q of ["中文", "aBc.*[X]"]) {
    assert.deepEqual(ids(query(runs, { q })), ["run-goal0000", "run-refs0000", "run-request0", "run-scope000"]);
  }
  assert.equal(query(runs, { q: ".*" }).matchedCount, 4);
  assert.equal(query(runs, { q: "^中文|unrelated$" }).matchedCount, 0);
  assert.equal(query([record("run-empty000", { goal: undefined })], { q: "absent" }).matchedCount, 0);
});

test("q never matches plan input, results, errors, prompts, task IDs or other source fields", () => {
  const run = decision(record("run-privacy0", { error: "PRIVATE_ERROR" }));
  run.steps[0].error = "PRIVATE_STEP_ERROR";
  run.plan.goal = "PRIVATE_PLAN_GOAL";
  run.plan.handoff = { summary: "PRIVATE_HANDOFF" };
  for (const q of ["PRIVATE_INPUT", "PRIVATE_PROMPT", "PRIVATE_REPORT", "PRIVATE_DECISION",
    "PRIVATE_ERROR", "PRIVATE_STEP_ERROR", "PRIVATE_PLAN_GOAL", "PRIVATE_HANDOFF", "query-task", "run-privacy0"])
    assert.equal(query([run], { q }).matchedCount, 0, q);
  const ordinary = record();
  assert.equal(query([ordinary], { q: "PRIVATE_RESULT" }).matchedCount, 0);
});

test("view filtering scans all records before pagination so old owner work is not displaced", () => {
  const newer = Array.from({ length: 45 }, (_, index) => {
    const run = record("run-new" + String(index).padStart(5, "0"), { updatedAt: 100 + index });
    accept(run);
    return run;
  });
  const old = record("run-old00000", { state: "failed", updatedAt: 1 });
  old.steps[0].state = "failed";
  const result = query([...newer, old], { view: "needs_action", limit: 1 });
  assert.deepEqual(ids(result), [old.runId]);
  assert.equal(result.matchedCount, 1);
  assert.deepEqual(result.groups, { needsAction: 1, review: 0 });
  assert.equal(result.hasMore, false);
});

test("groups are mutually exclusive and counted before view and pagination but after filters", () => {
  const review = record("run-review00");
  const owner = decision(record("run-decision"));
  const working = record("run-working0", { state: "running" });
  working.steps[0].state = "running";
  const settled = record("run-settled0"); accept(settled);
  const runs = [review, owner, working, settled];
  for (const view of ["all", "needs_action", "review"]) {
    const result = query(runs, { view, limit: 1 });
    assert.deepEqual(result.groups, { needsAction: 1, review: 1 });
    assert.equal(result.matchedCount, view === "all" ? 4 : 1);
    assert.equal(result.hasMore, view === "all");
  }
  assert.deepEqual(ids(query(runs, { view: "review" })), [review.runId]);
  assert.deepEqual(ids(query(runs, { view: "needs_action" })), [owner.runId]);
  assert.deepEqual(query(runs, { action: "decision_required", view: "review" }).groups,
    { needsAction: 1, review: 0 });
  assert.equal(query(runs, { action: "decision_required", view: "review" }).matchedCount, 0);
  assert.deepEqual(query(runs, { state: "running" }).groups, { needsAction: 0, review: 0 });
});

test("q/taskId/state/action/view combine with exact AND semantics", () => {
  const target = decision(record("run-target00", { goal: "Matching 中文" }));
  const wrongTask = structuredClone(target); wrongTask.runId = "run-task0000"; wrongTask.plan.taskId = "Query-task";
  const wrongState = structuredClone(target); wrongState.runId = "run-state000"; wrongState.state = "failed";
  const wrongAction = record("run-action00", { goal: target.goal });
  const wrongQ = decision(record("run-query000", { goal: "other" }));
  const runs = [target, wrongTask, wrongState, wrongAction, wrongQ];
  const raw = { q: "中文", taskId: "query-task", state: "succeeded", action: "decision_required", view: "needs_action" };
  const result = query(runs, raw);
  assert.deepEqual(ids(result), [target.runId]);
  assert.deepEqual(result.groups, { needsAction: 1, review: 0 });
  assert.equal(query(runs, { ...raw, taskId: "query" }).matchedCount, 0);
  assert.equal(query(runs, { ...raw, view: "review" }).matchedCount, 0);
});

test("action grouping reuses acknowledgements, decision dispositions and unknown priority", () => {
  const failed = record("run-failed00", { state: "failed" }); failed.steps[0].state = "failed";
  acknowledge(failed, "inspect_failure");
  const disposed = decision(record("run-disposed")); disposeDecision(disposed);
  const unknown = decision(record("run-unknown0", { state: "failed" }));
  unknown.steps.push({ id: "write", tool: "write", state: "unknown", attempts: 1 });
  unknown.plan.steps.push({ id: "write", tool: "write", input: { path: "x", content: "x" },
    dependsOn: [], retry: 0, timeoutMs: 1000 });
  acknowledge(unknown, "inspect_external_state"); disposeDecision(unknown);
  assert.equal(runAction(failed, true).kind, "settled");
  assert.equal(runAction(disposed, true).kind, "settled");
  assert.equal(runAction(unknown, false).kind, "inspect_external_state");
  assert.deepEqual(ids(query([failed, disposed, unknown], { view: "needs_action" })), [unknown.runId]);
  assert.deepEqual(ids(query([failed, disposed, unknown], { action: "inspect_external_state" }, () => false)), [unknown.runId]);
});

test("settlement callback selects runtime cleanup instead of owner review without inferring unknown", () => {
  const run = record();
  const seen = [];
  const result = query([run], { view: "review" }, (id) => { seen.push(id); return false; });
  assert.deepEqual(seen, [run.runId]);
  assert.equal(result.matchedCount, 0);
  assert.deepEqual(result.groups, { needsAction: 0, review: 0 });
  assert.equal(query([run], { action: "wait_cleanup" }, () => false).matchedCount, 1);
  assert.equal(query([run], { view: "review" }, () => undefined).matchedCount, 1);
});

test("updatedAt descending/runId ascending is stable across input permutations and page boundaries", () => {
  const runs = [record("run-z0000000", { updatedAt: 20 }), record("run-b0000000", { updatedAt: 30 }),
    record("run-a0000000", { updatedAt: 30 }), record("run-c0000000", { updatedAt: 10 })];
  const expected = ["run-a0000000", "run-b0000000", "run-z0000000", "run-c0000000"];
  assert.deepEqual(ids(query(runs)), expected);
  assert.deepEqual(ids(query([...runs].reverse())), expected);
  const first = query(runs, { limit: 2 });
  const second = query(runs, { limit: 2, offset: 2 });
  assert.deepEqual([...ids(first), ...ids(second)], expected);
  assert.equal(first.matchedCount, 4); assert.equal(second.matchedCount, 4);
  assert.equal(first.hasMore, true); assert.equal(second.hasMore, false);
  const beyond = query(runs, { offset: 1000 });
  assert.deepEqual(beyond.runs, []); assert.equal(beyond.matchedCount, 4); assert.equal(beyond.hasMore, false);
  assert.deepEqual(query([], {}), { runs: [], matchedCount: 0, groups: { needsAction: 0, review: 0 }, hasMore: false });
});

test("queries do not mutate records, input arrays or parsed input; returned page arrays are independent", () => {
  const runs = [record("run-z0000000"), decision(record("run-a0000000"))];
  const input = parseQuery({ q: "查询", limit: 1 });
  const before = structuredClone({ runs, input });
  freeze(runs); freeze(input);
  const first = queryRuns(runs, input, () => true);
  const second = queryRuns(runs, input, () => true);
  assert.deepEqual(first, second);
  assert.equal(first.runs[0], runs[1]);
  first.runs.pop(); first.groups.needsAction = 999;
  assert.equal(second.runs.length, 1);
  assert.equal(second.groups.needsAction, 1);
  assert.deepEqual({ runs, input }, before);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunStore } from "../dist/runtime/store.js";
import { RuntimeService } from "../dist/runtime/service.js";
import { parsePlan } from "../dist/runtime/plan.js";
import { runAttention } from "../dist/runtime/attention.js";
import { attentionSnapshot } from "../dist/runtime/acknowledgement.js";
import { reviewSnapshot } from "../dist/runtime/review.js";
import { runAction } from "../dist/runtime/action.js";
import { decisionLedger, validDecisionDispositions } from "../dist/runtime/decision.js";
import { createServiceContext } from "./fixtures/service-context.mjs";

const exec = (id = "owner") => ({ agent: { id }, callId: "decision", signal: new AbortController().signal });
function record(runId = "run-12345678", state = "succeeded") {
  return {
    version: 1, runId, ownerSessionId: "owner", state,
    plan: parsePlan({ task_id: "decision-task", steps: [{ id: "worker", tool: "agent", input: { prompt: "PRIVATE_PROMPT", output_format: "report" } }] }),
    steps: [{ id: "worker", tool: "agent", state: "succeeded", attempts: 1, startedAt: 2, finishedAt: 3 }],
    results: { worker: { value: { report: { outcome: "blocked", summary: "PRIVATE_REPORT", evidence: [], limitations: ["Decision not supplied"], requestedDecision: "PRIVATE_REQUEST" } } } },
    createdAt: 1, updatedAt: 10, ...(state === "running" ? {} : { finishedAt: 10 }),
  };
}
function input(run, extra = {}) {
  const attention = runAttention(run);
  return { snapshotHash: attention.snapshotHash, key: attention.items.find((i) => i.kind === "decision_required").key,
    expectedRevision: run.decisionDispositions?.length ?? 0, disposition: "answered", reason: "PRIVATE_REASON", answerRef: "opaque:PRIVATE_REF", ...extra };
}
const publicInput = (run, extra = {}) => {
  const { answerRef, successorRunId, ...rest } = input(run);
  return { runId: run.runId, ...rest, answer_ref: answerRef, ...(successorRunId ? { successor_run_id: successorRunId } : {}), ...extra };
};
async function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaohe-decision-"));
  const store = new RunStore(root);
  let calls = 0;
  const service = new RuntimeService(createServiceContext(async () => { calls++; throw Error("no scheduling permitted"); }), store);
  try { await fn({ root, store, service, calls: () => calls }); }
  finally { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
}

test("decision persists reload, keeps execution snapshots/evidence/timestamps immutable, and projects privacy-safe disposition", () => fixture(({ root, store, service, calls }) => {
  const run = record(); store.save(run);
  const before = structuredClone(run), snapshot = attentionSnapshot(run), review = reviewSnapshot(run);
  const saved = service.decision(publicInput(run, { reason: "  PRIVATE_REASON  ", answer_ref: "  opaque:PRIVATE_REF  " }), exec());
  assert.equal(saved.decisionLedger.revision, 1);
  assert.equal(saved.decisionLedger.verification, "owner_declared_not_user_approval");
  assert.equal(saved.decisionLedger.items[0].status, "answered");
  assert.equal(saved.attention.items.find((i) => i.kind === "decision_required").disposition, "answered");
  assert.equal(saved.attention.items.find((i) => i.kind === "decision_required").acknowledged, undefined);
  assert.equal(saved.attention.notification.shouldNotify, false);
  assert.notEqual(saved.action.kind, "decision_required");
  assert.equal(saved.decisionHistory[0].answerRef, "opaque:PRIVATE_REF");
  const loaded = new RunStore(root).load(run.runId);
  assert.deepEqual(loaded.decisionDispositions, saved.decisionHistory);
  const { decisionDispositions, ...execution } = loaded;
  assert.deepEqual(execution, before);
  assert.equal(attentionSnapshot(loaded), snapshot); assert.equal(reviewSnapshot(loaded), review);
  assert.equal(calls(), 0);
  const status = service.status({ runId: run.runId }, exec());
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE_REASON|PRIVATE_REF|PRIVATE_REPORT|PRIVATE_REQUEST|PRIVATE_PROMPT/);
  assert.equal(service.task({ taskId: "decision-task" }, exec()).page.attentionCount, 0);
  assert.equal(service.status({}, exec()).runs[0].decisionLedger.items[0].status, "answered");
  assert.deepEqual(service.result({ runId: run.runId }, exec()).decisionHistory, decisionDispositions);
  assert.deepEqual(service.result({ runId: run.runId, stepId: "worker", limit: 1 }, exec()).decisionHistory, decisionDispositions);
  saved.decisionHistory[0].reason = "mutated caller result";
  assert.equal(store.load(run.runId).decisionDispositions[0].reason, "PRIVATE_REASON");
}));

test("CAS rejects stale revision/snapshot; changed execution reopens while retaining history", () => fixture(({ store, service }) => {
  const run = record(); store.save(run);
  const old = publicInput(run);
  service.decision(old, exec());
  assert.throws(() => service.decision(old, exec()), /RUNTIME_RESULT_CHANGED/);
  let current = store.load(run.runId);
  assert.throws(() => service.decision(publicInput(current, { snapshotHash: "a".repeat(64) }), exec()), /RUNTIME_RESULT_CHANGED/);
  current.results.worker.value.report.summary = "changed evidence snapshot";
  store.save(current);
  const status = service.status({ runId: run.runId }, exec());
  assert.equal(status.decisionLedger.revision, 1); assert.equal(status.decisionLedger.items[0].status, "open");
  assert.equal(status.attention.items[0].disposition, undefined);
  assert.equal(status.attention.notification.shouldNotify, true); assert.equal(status.action.kind, "decision_required");
  assert.equal(service.result({ runId: run.runId }, exec()).decisionHistory.length, 1);
  service.decision(publicInput(current, { disposition: "dismissed", answer_ref: undefined }), exec());
  assert.equal(store.load(run.runId).decisionDispositions.length, 2);
}));

test("ownership, malformed input, unknown/nondecision keys and source states fail closed", () => fixture(({ store, service }) => {
  const run = record(); store.save(run);
  assert.throws(() => service.decision(publicInput(run), exec("peer")), /RUNTIME_NOT_FOUND/);
  assert.throws(() => store.recordDecision(run.runId, "peer", input(run)), /RUNTIME_NOT_FOUND/);
  for (const patch of [ { key: "x" }, { key: "f".repeat(64) }, { expectedRevision: -1 }, { disposition: "accepted" },
    { reason: "" }, { reason: "a".repeat(2049) }, { reason: "中".repeat(683) }, { reason: "bad" + String.fromCharCode(0) },
    { answer_ref: undefined }, { answer_ref: " " }, { answer_ref: "x".repeat(1001) }, { answer_ref: "😀".repeat(501) },
    { answer_ref: "bad" + String.fromCharCode(127) }, { successor_run_id: "../escape" }, { unexpected: true } ])
    assert.throws(() => service.decision(publicInput(run, patch), exec()), /INVALID_PLAN|RUNTIME_INVALID_STATE/);
  const failed = record("run-87654321", "failed"); failed.results.worker = { truncated: true, bytes: 100000 };
  store.save(failed);
  const failureAttention = runAttention(failed);
  assert.throws(() => service.decision({ ...publicInput(run), runId: failed.runId, snapshotHash: failureAttention.snapshotHash, key: failureAttention.items[0].key }, exec()), /RUNTIME_INVALID_STATE/);
  for (const state of ["running", "interrupted"]) {
    const other = record("run-state000", state); store.save(other);
    assert.throws(() => service.decision(publicInput(other), exec()), /RUNTIME_INVALID_STATE/);
    assert.throws(() => store.recordDecision(other.runId, "owner", input(other)), /RUNTIME_INVALID_STATE/);
  }
  for (const state of ["failed", "cancelled"]) {
    const other = record("run-terminal", state); store.save(other);
    assert.equal(service.decision(publicInput(other, { disposition: "superseded", answer_ref: undefined }), exec()).decisionLedger.items[0].status, "superseded");
  }
}));

test("source active/cleanup/failure manager entries reject declarations independently of persisted terminal state", () => fixture(({ store, service }) => {
  const run = record(); store.save(run);
  for (const map of [service.manager.active, service.manager.failures]) {
    map.set(run.runId, map === service.manager.active ? { run } : run);
    try { assert.throws(() => service.decision(publicInput(run), exec()), /RUNTIME_INVALID_STATE/); }
    finally { map.delete(run.runId); }
  }
}));

test("successor must be existing same-owner same-task direct child; running successor is valid and never executed", () => fixture(({ store, service, calls }) => {
  const run = record(); store.save(run);
  const child = record("run-child000", "running"); child.plan.previousRunId = run.runId;
  store.save(child);
  for (const patch of [{ ownerSessionId: "peer" }, { plan: { ...child.plan, taskId: "other" } }, { plan: { ...child.plan, previousRunId: "run-unknown0" } }]) {
    store.save({ ...child, ...patch });
    assert.throws(() => service.decision(publicInput(run, { successor_run_id: child.runId }), exec()), /RUNTIME_NOT_FOUND|RUNTIME_INVALID_STATE/);
  }
  store.save(child);
  assert.throws(() => service.decision(publicInput(run, { successor_run_id: run.runId }), exec()), /RUNTIME_INVALID_STATE/);
  assert.throws(() => service.decision(publicInput(run, { successor_run_id: "run-missing0" }), exec()), /RUNTIME_NOT_FOUND/);
  const noTask = structuredClone(run); delete noTask.plan.taskId; store.save(noTask);
  assert.throws(() => service.decision(publicInput(noTask, { successor_run_id: child.runId }), exec()), /RUNTIME_INVALID_STATE/);
  store.save(run);
  const saved = service.decision(publicInput(run, { successor_run_id: child.runId }), exec());
  assert.equal(saved.decisionHistory[0].successorRunId, child.runId); assert.equal(store.load(child.runId).state, "running"); assert.equal(calls(), 0);
}));

test("UTF8 and UTF16 limits, optional references, 32 cap, and immutable append-only CAS history", () => fixture(({ store, service }) => {
  let run = record(); store.save(run);
  service.decision(publicInput(run, { reason: "é".repeat(1024), answer_ref: "😀".repeat(500) }), exec());
  for (let i = 1; i < 32; i++) {
    run = store.load(run.runId);
    const history = structuredClone(run.decisionDispositions);
    service.decision(publicInput(run, { disposition: i % 2 ? "dismissed" : "superseded", answer_ref: i % 2 ? undefined : "opaque:optional" }), exec());
    assert.deepEqual(store.load(run.runId).decisionDispositions.slice(0, i), history);
  }
  run = store.load(run.runId);
  assert.throws(() => service.decision(publicInput(run), exec()), /RUNTIME_INVALID_STATE/);
  assert.equal(run.decisionDispositions.length, 32);
}));

test("strict persisted validation rejects malformed records and retains historical snapshots", () => fixture(({ store, root }) => {
  const run = record(); store.save(run);
  const saved = store.recordDecision(run.runId, "owner", input(run));
  const entry = saved.decisionDispositions[0];
  assert.equal(validDecisionDispositions([{ ...entry, snapshotHash: "b".repeat(64) }], 1), true);
  for (const patch of [{ revision: 2 }, { at: 0 }, { reason: " " }, { answerRef: "" }, { answerRef: " padded " }, { disposition: "accepted" }, { extra: true }]) {
    const bad = { ...saved, decisionDispositions: [{ ...entry, ...patch }] };
    fs.writeFileSync(path.join(root, run.runId + ".json"), JSON.stringify(bad));
    assert.equal(new RunStore(root).load(run.runId), undefined);
  }
  for (const field of ["revision", "snapshotHash", "key", "disposition", "reason", "at"]) {
    const bad = { ...entry }; delete bad[field]; assert.equal(validDecisionDispositions([bad], 1), false);
  }
  assert.equal(validDecisionDispositions([], 1), false);
  assert.equal(validDecisionDispositions(Array.from({ length: 33 }, (_, i) => ({ ...entry, revision: i + 1 })), 1), false);
}));

test("disposed decisions never hide external uncertainty or alter acknowledgement/review revisions", () => fixture(({ store, service }) => {
  const run = record(); run.state = "failed";
  run.plan.steps.push({ id: "external", tool: "pwsh", input: { command: "opaque" }, dependsOn: [], retry: 0, timeoutMs: 120000 });
  run.steps.push({ id: "external", tool: "pwsh", state: "unknown", attempts: 1, startedAt: 4, finishedAt: 5 });
  store.save(run);
  const attention = runAttention(run);
  const saved = service.decision(publicInput(run, { disposition: "dismissed", answer_ref: undefined }), exec());
  assert.equal(saved.attention.revision, attention.revision);
  assert.equal(saved.ownerReview.revision, 0);
  assert.equal(saved.attention.notification.shouldNotify, true);
  assert.equal(saved.action.kind, "inspect_external_state");
  assert.equal(saved.attention.items.find((i) => i.kind === "inspect_external_state").acknowledged, undefined);
}));

test("store rechecks source and successor after lock acquisition rather than trusting service reads", () => fixture(({ root, store, service }) => {
  const run = record(); store.save(run);
  const originalLoad = store.load.bind(store); let reads = 0;
  store.load = (id) => {
    if (id === run.runId && ++reads === 2) {
      assert.equal(fs.existsSync(path.join(root, id + ".json.review-lock")), true);
      const changed = originalLoad(id); changed.results.worker.value.report.summary = "concurrent snapshot";
      store.save(changed);
    }
    return originalLoad(id);
  };
  try { assert.throws(() => service.decision(publicInput(run), exec()), /RUNTIME_RESULT_CHANGED/); }
  finally { store.load = originalLoad; }
  assert.equal(originalLoad(run.runId).decisionDispositions, undefined);
}));

test("shared review lock and save failures leave no declaration or evidence mutation", () => fixture(({ root, store, service }) => {
  const run = record(); store.save(run);
  const target = path.join(root, run.runId + ".json"); const before = fs.readFileSync(target, "utf8");
  fs.writeFileSync(target + ".review-lock", "busy");
  assert.throws(() => service.decision(publicInput(run), exec()), /RUNTIME_BUSY/);
  fs.rmSync(target + ".review-lock");
  const save = store.save; store.save = () => { throw Error("RUNTIME_STORAGE_FAILED"); };
  try { assert.throws(() => service.decision(publicInput(run), exec()), /RUNTIME_STORAGE_FAILED/); }
  finally { store.save = save; }
  assert.equal(fs.readFileSync(target, "utf8"), before);
  assert.equal(fs.existsSync(target + ".review-lock"), false);
  assert.equal(runAction(run).kind, "decision_required");
  assert.equal(decisionLedger(run, runAttention(run)).items[0].status, "open");
}));

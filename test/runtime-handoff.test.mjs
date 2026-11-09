import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePlan } from "../dist/runtime/plan.js";
import { RuntimeService } from "../dist/runtime/service.js";
import { RuntimeExecutor } from "../dist/runtime/executor.js";
import { RunStore } from "../dist/runtime/store.js";
import { parseHandoffInput, parseHandoffSnapshot, verifyHandoffSelections } from "../dist/runtime/handoff.js";
import { createServiceContext } from "./fixtures/service-context.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const exec = (id = "owner") => ({ agent: { id }, callId: "handoff-test", signal: new AbortController().signal });
const steps = [{ id: "read", tool: "read", input: { tag: "explicit-task" } }];
const plan = (extra = {}) => ({ task_id: "Task", steps, ...extra });
const request = (runId, resultHash, summary = "Private owner summary: not permission") => ({
  runId, selections: [{ stepId: "read", resultHash }], summary,
});
const linked = (handoff, extra = {}) => plan({ previous_run_id: handoff.sourceRunId, handoff, ...extra });
async function fixture(t, invoke = async () => ({ secret: "RAW_RESULT_DO_NOT_COPY" })) {
  const root = mkdtempSync(path.join(os.tmpdir(), "handoff-"));
  const store = new RunStore(root);
  const calls = [];
  const service = new RuntimeService(createServiceContext(async (call) => {
    calls.push({ name: call.name, arguments: structuredClone(call.arguments) });
    return invoke(call);
  }), store);
  t.after(async () => { await service.dispose(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, service, calls };
}
async function source(f, extra = {}) {
  const run = await f.service.run({ plan: plan(extra) }, exec());
  const page = f.service.result({ runId: run.runId, stepId: "read" }, exec()).page;
  return { run, input: request(run.runId, page.hash) };
}
function snapshotDigest(snapshot) {
  return hash({ kind: snapshot.kind, sourceRunId: snapshot.sourceRunId, taskId: snapshot.taskId,
    summary: snapshot.summary, selections: snapshot.selections });
}

test("handoff returns a bounded detached snapshot without storing or exposing results", async (t) => {
  const f = await fixture(t);
  const { run, input } = await source(f);
  const before = readdirSync(f.root);
  const snapshot = f.service.handoff(input, exec());
  assert.deepEqual(readdirSync(f.root), before);
  assert.deepEqual(Object.keys(snapshot), ["kind", "sourceRunId", "taskId", "summary", "selections", "snapshotHash", "authorized", "executable"]);
  assert.equal(snapshot.kind, "untrusted_run_handoff");
  assert.equal(snapshot.authorized, false);
  assert.equal(snapshot.executable, false);
  assert.equal(snapshot.sourceRunId, run.runId);
  assert.equal(snapshot.taskId, "Task");
  assert.equal(snapshot.snapshotHash, snapshotDigest(snapshot));
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 12 * 1024);
  assert.equal(JSON.stringify(snapshot).includes("RAW_RESULT_DO_NOT_COPY"), false);
  input.selections[0].resultHash = "a".repeat(64);
  assert.notEqual(snapshot.selections[0].resultHash, input.selections[0].resultHash);
  assert.deepEqual(parseHandoffSnapshot(snapshot), snapshot);
});

test("strict handoff input rejects missing/unknown fields, types, duplicates and malformed hashes", () => {
  const valid = request("run-12345678", "a".repeat(64));
  for (const raw of [null, [], new Date(), {}, { ...valid, extra: 1 }, { ...valid, runId: "wrong" },
    { ...valid, selections: [] }, { ...valid, selections: Array(9).fill(valid.selections[0]) },
    { ...valid, selections: [...valid.selections, ...valid.selections] },
    { ...valid, selections: [{ stepId: "read", resultHash: "A".repeat(64) }] },
    { ...valid, selections: [{ stepId: "read", resultHash: "a".repeat(64), raw: {} }] },
    { ...valid, selections: Array(1) }, { ...valid, summary: undefined },
    Object.assign(Object.create({ inherited: true }), valid)]) {
    assert.throws(() => parseHandoffInput(raw), /INVALID_PLAN/);
  }
  assert.equal(parseHandoffInput(valid).summary, valid.summary);
});

test("getters and toJSON are never invoked at any handoff boundary", () => {
  const valid = request("run-12345678", "a".repeat(64));
  let reads = 0;
  const getter = () => { reads++; throw Error("must not execute"); };
  const top = { ...valid };
  Object.defineProperty(top, "summary", { get: getter, enumerable: true });
  const item = { ...valid.selections[0] };
  Object.defineProperty(item, "resultHash", { get: getter, enumerable: true });
  const array = [...valid.selections];
  Object.defineProperty(array, "0", { get: getter, enumerable: true });
  const json = { ...valid, toJSON: getter };
  for (const raw of [top, json, { ...valid, selections: [item] }, { ...valid, selections: array }])
    assert.throws(() => parseHandoffInput(raw), /INVALID_PLAN/);
  const snapshot = { kind: "untrusted_run_handoff", sourceRunId: valid.runId, taskId: "Task",
    summary: valid.summary, selections: valid.selections, snapshotHash: "a".repeat(64), authorized: false, executable: false };
  Object.defineProperty(snapshot, "summary", { get: getter, enumerable: true });
  assert.throws(() => parsePlan(linked(snapshot)), /INVALID_PLAN/);
  assert.equal(reads, 0);
});

test("summary uses raw UTF8 byte bounds, allows newline/tab, rejects controls and lone surrogates", () => {
  const raw = request("run-12345678", "a".repeat(64));
  for (const text of ["", " \n\t", "x".repeat(4097), "😀".repeat(1025), "a\rb", "a\0b", "a\x7fb", "a\x85b", "a\ud800", "\udfff"])
    assert.throws(() => parseHandoffInput({ ...raw, summary: text }), /INVALID_PLAN/);
  for (const text of ["x".repeat(4096), "😀".repeat(1024), " text\n\t "])
    assert.equal(parseHandoffInput({ ...raw, summary: text }).summary, text);
  const eight = Array.from({ length: 8 }, (_, i) => ({ stepId: "step" + i, resultHash: "a".repeat(64) }));
  assert.equal(parseHandoffInput({ ...raw, selections: eight }).selections.length, 8);
});

test("selection requires successful complete retained JSON and exact value hash", () => {
  const selection = [{ stepId: "read", resultHash: hash({ ok: true }) }];
  const good = { steps: [{ id: "read", state: "succeeded" }], results: { read: { value: { ok: true } } } };
  verifyHandoffSelections(selection, good);
  for (const value of [{}, { truncated: true, bytes: 70000 }, { value: undefined }])
    assert.throws(() => verifyHandoffSelections(selection, { ...good, results: { read: value } }), /RESULT_UNAVAILABLE/);
  assert.throws(() => verifyHandoffSelections(selection, { ...good, steps: [{ id: "read", state: "failed" }] }), /RESULT_UNAVAILABLE/);
  assert.throws(() => verifyHandoffSelections(selection, { ...good, steps: [] }), /NOT_FOUND/);
  assert.throws(() => verifyHandoffSelections(selection, { ...good, results: { read: { value: { ok: false } } } }), /RESULT_CHANGED/);
});

test("source must be owned, terminal settled, and have a task", async (t) => {
  const f = await fixture(t);
  const { input } = await source(f);
  assert.throws(() => f.service.handoff(input, exec("stranger")), /NOT_FOUND/);
  assert.throws(() => f.service.handoff({ ...input, runId: "run-12345678" }, exec()), /NOT_FOUND/);
  assert.throws(() => f.service.handoff({ ...input, selections: [{ stepId: "read", resultHash: "0".repeat(64) }] }, exec()), /RESULT_CHANGED/);
  const unlinked = await source(f, { task_id: undefined });
  assert.throws(() => f.service.handoff(unlinked.input, exec()), /INVALID_STATE/);
  const executor = new RuntimeExecutor(f.store, async () => ({ ok: true }));
  const historical = executor.createRun("owner", parsePlan(plan()));
  await executor.execute(historical);
  assert.throws(() => f.service.handoff(request(historical.runId, hash({ ok: true })), exec()), /INVALID_STATE/);
  historical.state = "interrupted";
  historical.error = "RUNTIME_INTERRUPTED";
  f.store.save(historical);
  assert.throws(() => f.service.handoff(request(historical.runId, hash({ ok: true })), exec()), /INVALID_STATE/);
});

test("active work and terminal cancellation still cleaning up cannot hand off", async (t) => {
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const f = await fixture(t, async () => { started(); await gate; return { ok: true }; });
  try {
    const running = await f.service.run({ plan: plan(), async: true }, exec());
    await entered;
    const raw = request(running.runId, hash({ ok: true }));
    assert.throws(() => f.service.handoff(raw, exec()), /INVALID_STATE/);
    f.service.cancel({ runId: running.runId }, exec());
    assert.throws(() => f.service.handoff(raw, exec()), /INVALID_STATE/);
  } finally {
    finish();
  }
});

test("plan handoff integrity and exact same task/source linkage are mandatory", async (t) => {
  const f = await fixture(t);
  const { input } = await source(f);
  const snapshot = f.service.handoff(input, exec());
  assert.deepEqual(parsePlan(linked(snapshot)).handoff, snapshot);
  for (const extra of [{ task_id: "Other" }, { task_id: undefined }, { previous_run_id: undefined }, { previous_run_id: "run-12345678" }])
    assert.throws(() => parsePlan(linked(snapshot, extra)), /INVALID_PLAN/);
  assert.throws(() => parsePlan(linked({ ...snapshot, summary: "tampered" })), /RESULT_CHANGED/);
  for (const patch of [{ authorized: true }, { executable: true }, { rawResults: {} }, { snapshotHash: "bad" }])
    assert.throws(() => parsePlan(linked({ ...snapshot, ...patch })), /INVALID_PLAN/);
  const largeSteps = [{ ...steps[0], input: { value: "x".repeat(64 * 1024) } }];
  assert.throws(() => parsePlan(linked(snapshot, { steps: largeSteps })), /PLAN_TOO_LARGE/);
});

test("persistence roundtrip, old records compatibility, privacy and no automatic tool injection/reuse", async (t) => {
  const f = await fixture(t);
  const { run, input } = await source(f);
  assert.equal(Object.hasOwn(f.store.load(run.runId).plan, "handoff"), false);
  const snapshot = f.service.handoff(input, exec());
  const successor = await f.service.run({ plan: linked(snapshot) }, exec());
  assert.deepEqual(f.store.load(successor.runId).plan.handoff, snapshot);
  assert.deepEqual(f.service.result({ runId: successor.runId }, exec()).handoff, snapshot);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].arguments, steps[0].input);
  assert.equal(JSON.stringify(f.calls).includes(snapshot.summary), false);
  for (const surface of [successor, f.service.status({ runId: successor.runId }, exec()), f.service.status({}, exec()),
    f.service.result({ runId: successor.runId, stepId: "read" }, exec())])
    assert.equal(JSON.stringify(surface).includes(snapshot.summary), false);
  const filename = path.join(f.root, successor.runId + ".json");
  const record = JSON.parse(readFileSync(filename, "utf8"));
  record.plan.handoff.summary = "tampered persisted summary";
  writeFileSync(filename, JSON.stringify(record));
  assert.equal(f.store.load(successor.runId), undefined);
});

test("run preflight rechecks retained source hashes before create or dispatch", async (t) => {
  const f = await fixture(t);
  const { run, input } = await source(f);
  const snapshot = f.service.handoff(input, exec());
  const original = f.store.load(run.runId);
  const changed = structuredClone(original);
  changed.results.read = { value: { changed: true } };
  f.store.save(changed);
  const count = readdirSync(f.root).filter((name) => name.endsWith(".json")).length;
  await assert.rejects(f.service.run({ plan: linked(snapshot) }, exec()), /RESULT_CHANGED/);
  assert.equal(f.calls.length, 1);
  assert.equal(readdirSync(f.root).filter((name) => name.endsWith(".json")).length, count);
  rmSync(path.join(f.root, run.runId + ".json"));
  await assert.rejects(f.service.run({ plan: linked(snapshot) }, exec()), /NOT_FOUND/);
  assert.equal(f.calls.length, 1);
});

test("resume revalidates source presence and hashes before dispatch, never reuses source output", async (t) => {
  const f = await fixture(t);
  const { run, input } = await source(f);
  const snapshot = f.service.handoff(input, exec());
  const executor = new RuntimeExecutor(f.store, async () => ({}));
  const successor = executor.createRun("owner", parsePlan(linked(snapshot)));
  successor.state = "interrupted";
  successor.error = "RUNTIME_INTERRUPTED";
  successor.finishedAt = successor.updatedAt;
  f.store.save(successor);
  const original = f.store.load(run.runId);
  const changed = structuredClone(original);
  changed.results.read = { value: { changed: true } };
  f.store.save(changed);
  await assert.rejects(f.service.resume({ runId: successor.runId }, exec()), /RESULT_CHANGED/);
  assert.equal(f.calls.length, 1);
  rmSync(path.join(f.root, run.runId + ".json"));
  await assert.rejects(f.service.resume({ runId: successor.runId }, exec()), /NOT_FOUND/);
  assert.equal(f.calls.length, 1);
  f.store.save(original);
  const resumed = await f.service.resume({ runId: successor.runId }, exec());
  assert.equal(resumed.state, "succeeded");
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].arguments, steps[0].input);
});

test("failed and cancelled settled sources may select only successful retained steps", async (t) => {
  const f = await fixture(t);
  const { run, input } = await source(f);
  const record = f.store.load(run.runId);
  for (const state of ["failed", "cancelled"]) {
    record.state = state;
    record.error = state === "failed" ? "RUNTIME_STEP_FAILED" : "RUNTIME_CANCELLED";
    f.store.save(record);
    assert.equal(f.service.handoff(input, exec()).sourceRunId, run.runId);
  }
  record.state = "failed";
  record.steps[0].state = "failed";
  record.steps[0].error = "RUNTIME_STEP_FAILED";
  f.store.save(record);
  assert.throws(() => f.service.handoff(input, exec()), /RESULT_UNAVAILABLE/);
  record.steps[0].state = "succeeded";
  delete record.steps[0].error;
  record.results.read = { truncated: true, bytes: 70000 };
  f.store.save(record);
  assert.throws(() => f.service.handoff(input, exec()), /RESULT_UNAVAILABLE/);
});

test("cached storage failure overrides an older durable source checkpoint", async (t) => {
  const f = await fixture(t);
  const { run, input } = await source(f);
  const snapshot = f.service.handoff(input, exec());
  f.service.manager.failures.set(run.runId, { ...f.store.load(run.runId), state: "failed", error: "RUNTIME_STORAGE_FAILED" });
  assert.throws(() => f.service.handoff(input, exec()), /INVALID_STATE/);
  await assert.rejects(f.service.run({plan: linked(snapshot)}, exec()), /INVALID_STATE/);
  assert.equal(f.calls.length, 1);
  f.service.manager.failures.delete(run.runId);
});

test("handoff source is rechecked across the scheduling microtask boundary", async (t) => {
  const f = await fixture(t);
  const { run, input } = await source(f);
  const snapshot = f.service.handoff(input, exec());
  const pending = f.service.run({plan: linked(snapshot)}, exec());
  const changed = f.store.load(run.runId);
  changed.results.read = { value: "changed before dispatch" }; f.store.save(changed);
  await assert.rejects(pending, /RUNTIME_RESULT_CHANGED/);
  assert.equal(f.calls.length, 1);
});

test("handoff does not bypass the existing worker adapter preflight", async (t) => {
  const f = await fixture(t);
  const { input } = await source(f);
  const snapshot = f.service.handoff(input, exec());
  const workerSteps = [{ id: "worker", tool: "agent", input: { prompt: "Explicit Lead task only" } }];
  await assert.rejects(f.service.run({ plan: linked(snapshot, { steps: workerSteps }) }, exec()), /RUNTIME_AGENT_POLICY_UNSUPPORTED/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(parsePlan(linked(snapshot, { steps: workerSteps })).steps[0].input.prompt, "Explicit Lead task only");
});

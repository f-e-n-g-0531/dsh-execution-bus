import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeService } from "../dist/runtime/service.js";
import { RuntimeExecutor } from "../dist/runtime/executor.js";
import { RunStore } from "../dist/runtime/store.js";
import { parsePlan } from "../dist/runtime/plan.js";
import { ownerReview, reviewSnapshot } from "../dist/runtime/review.js";
import { runAttention } from "../dist/runtime/attention.js";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import {
  RUNTIME_OUTPUT_SCHEMAS,
  runtimePresentationMeta,
} from "../dist/presentation.js";

async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-review-"));
  const store = new RunStore(root);
  const executor = new RuntimeExecutor(store, async () => ({
    text: "中文🧪",
    report: "private",
  }));
  const run = executor.createRun(
    "owner",
    parsePlan({ steps: [{ id: "read", tool: "read", input: {} }] }),
  );
  await executor.execute(run);
  const service = new RuntimeService({}, store);
  const exec = { agent: { id: "owner" } };
  const request = () => ({
    runId: run.runId,
    snapshotHash: service.result({ runId: run.runId }, exec).ownerReview
      .snapshotHash,
    expectedRevision: service.result({ runId: run.runId }, exec).ownerReview
      .revision,
    disposition: "accepted",
    reason: "PRIVATE_REVIEW_REASON",
  });
  return {
    root,
    store,
    executor,
    run,
    service,
    exec,
    request,
    async close() {
      await service.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("active terminal cleanup blocks review and save failure preserves the ledger", async () => {
  const f = await fixture();
  try {
    const req = f.request();
    const save = mock.method(f.store, "save", () => {
      throw Error("RUNTIME_STORAGE_FAILED");
    });
    assert.throws(
      () => f.service.review(req, f.exec),
      /RUNTIME_STORAGE_FAILED/,
    );
    save.mock.restore();
    assert.equal(f.store.load(f.run.runId).ownerReviews, undefined);
    assert.equal(f.service.review(req, f.exec).ownerReview.revision, 1);
    const old = ownerReview(f.store.load(f.run.runId)).snapshotHash;
    const modified = f.store.load(f.run.runId);
    modified.plan.steps[0].input = { file_path: "different-policy-subject" };
    assert.notEqual(reviewSnapshot(modified), old);
    assert.equal(ownerReview(modified).status, "stale");
    const lock = f.store.pathFor(f.run.runId) + ".review-lock";
    writeFileSync(lock, "");
    f.store.remove(f.run.runId);
    assert.ok(f.store.load(f.run.runId));
    rmSync(lock);
    f.store.remove(f.run.runId);
    assert.equal(f.store.load(f.run.runId), undefined);
  } finally {
    mock.restoreAll();
    await f.close();
  }
});

test("review rejects a real active service while preserving normal completion", async () => {
  const f = await fixture();
  let release;
  const started = new Promise((resolve) => {
    release = resolve;
  });
  let began;
  const entered = new Promise((resolve) => {
    began = resolve;
  });
  const service = new RuntimeService(
    {
      tools: {
        resolve() {
          return undefined;
        },
      },
    },
    f.store,
  );
  // Use a real service invocation with its owned executor and admission-free host fixture.
  service.executor = () =>
    new RuntimeExecutor(f.store, async () => {
      began();
      await started;
      return { ok: true };
    });
  try {
    const pending = service.run(
      { plan: { steps: [{ id: "a", tool: "read", input: {} }] }, async: true },
      f.exec,
    );
    const receipt = await pending;
    await entered;
    assert.throws(
      () =>
        service.review(
          {
            runId: receipt.runId,
            snapshotHash: "a".repeat(64),
            expectedRevision: 0,
            disposition: "accepted",
            reason: "x",
          },
          f.exec,
        ),
      /RUNTIME_INVALID_STATE/,
    );
    release();
    await service.dispose();
  } finally {
    release();
    await service.dispose();
    await f.close();
  }
});

test("owner review persists result-bound history without claiming independent acceptance", async () => {
  const f = await fixture();
  try {
    const before = f.service.result({ runId: f.run.runId }, f.exec);
    assert.equal(before.ownerReview.status, "not_recorded");
    const saved = f.service.review(f.request(), f.exec);
    assert.deepEqual(
      validateJsonSchemaValue(RUNTIME_OUTPUT_SCHEMAS.runtime_review, saved),
      [],
    );
    assert.equal(saved.ownerReview.status, "accepted");
    assert.equal(saved.ownerReview.revision, 1);
    assert.equal(
      saved.attention.items.some((i) => i.kind === "review_results"),
      false,
    );
    assert.equal(saved.ownerReviewHistory[0].reason, "PRIVATE_REVIEW_REASON");
    assert.ok(
      !runtimePresentationMeta({}, saved).text.includes(
        "PRIVATE_REVIEW_REASON",
      ),
    );
    const reopened = new RuntimeService({}, new RunStore(f.root));
    const value = reopened.result({ runId: f.run.runId }, f.exec);
    assert.equal(value.acceptance.status, "not_reviewed");
    assert.equal(value.ownerReview.status, "accepted");
    assert.deepEqual(
      validateJsonSchemaValue(RUNTIME_OUTPUT_SCHEMAS.runtime_result, value),
      [],
    );
    assert.equal(value.updatedAt, before.updatedAt);
    assert.equal(value.finishedAt, before.finishedAt);
    const needs = reopened.review(
      { ...f.request(), disposition: "needs_work" },
      f.exec,
    );
    assert.equal(needs.ownerReview.revision, 2);
    assert.ok(needs.attention.items.some((i) => i.kind === "review_results"));
    assert.equal(needs.ownerReviewHistory.length, 2);
    await reopened.dispose();
  } finally {
    await f.close();
  }
});

test("review rejects peer, stale snapshot/revision, invalid inputs and cancellation", async () => {
  const f = await fixture();
  try {
    const req = f.request();
    assert.throws(
      () => f.service.review(req, { agent: { id: "peer" } }),
      /RUNTIME_NOT_FOUND/,
    );
    assert.throws(() => f.service.review(req, {}), /OWNING_SESSION_REQUIRED/);
    assert.throws(
      () => f.service.review({ ...req, snapshotHash: "0".repeat(64) }, f.exec),
      /RUNTIME_RESULT_CHANGED/,
    );
    for (const change of [
      { expectedRevision: -1 },
      { disposition: "verified" },
      { reason: " " },
      { reason: "中".repeat(700) },
      { extra: true },
      { expectedRevision: 1.1 },
    ])
      assert.throws(
        () => f.service.review({ ...req, ...change }, f.exec),
        /INVALID_PLAN/,
      );
    const c = new AbortController();
    c.abort();
    assert.throws(
      () => f.service.review(req, { ...f.exec, signal: c.signal }),
      /RUNTIME_CANCELLED/,
    );
    f.service.review(req, f.exec);
    assert.throws(
      () => f.service.review(req, f.exec),
      /RUNTIME_RESULT_CHANGED/,
    );
    assert.equal(f.store.load(f.run.runId).ownerReviews.length, 1);
  } finally {
    await f.close();
  }
});

test("locked reviews fail closed; changed output invalidates previous disposition", async () => {
  const f = await fixture();
  try {
    const lock = f.store.pathFor(f.run.runId) + ".review-lock";
    writeFileSync(lock, "");
    assert.throws(() => f.service.review(f.request(), f.exec), /RUNTIME_BUSY/);
    rmSync(lock);
    f.service.review(f.request(), f.exec);
    const run = f.store.load(f.run.runId);
    const old = ownerReview(run).snapshotHash;
    run.results.read.value.text = "changed";
    run.results.read.bytes = Buffer.byteLength(
      JSON.stringify(run.results.read.value),
    );
    assert.notEqual(reviewSnapshot(run), old);
    assert.equal(ownerReview(run).status, "stale");
    assert.ok(
      runAttention(run, true).items.some((i) => i.kind === "review_results"),
    );
    f.store.save(run);
    assert.throws(
      () => f.service.review({ ...f.request(), snapshotHash: old }, f.exec),
      /RUNTIME_RESULT_CHANGED/,
    );
    assert.equal(f.service.review(f.request(), f.exec).ownerReview.revision, 2);
  } finally {
    await f.close();
  }
});

test("truncated, failed and active runs cannot be reviewed; invalid ledger fails strict loading", async () => {
  const f = await fixture();
  try {
    const truncated = f.store.load(f.run.runId);
    truncated.results.read = { truncated: true, bytes: 70000 };
    f.store.save(truncated);
    assert.equal(
      f.service.result({ runId: f.run.runId }, f.exec).ownerReview.snapshotHash,
      undefined,
    );
    assert.throws(
      () =>
        f.service.review(
          { ...f.request(), snapshotHash: "a".repeat(64) },
          f.exec,
        ),
      /RUNTIME_INVALID_STATE/,
    );
    assert.equal(
      ownerReview({ ...f.run, state: "failed" }).snapshotHash,
      undefined,
    );
    f.store.save(f.run);
    f.service.review(f.request(), f.exec);
    const file = f.store.pathFor(f.run.runId);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.ownerReviews[0].revision = 8;
    writeFileSync(file, JSON.stringify(raw));
    assert.equal(f.store.load(f.run.runId), undefined);
  } finally {
    await f.close();
  }
});

test("review history is bounded and cannot be injected by a Worker result", async () => {
  const f = await fixture();
  try {
    f.run.results.read.value = { ownerReviews: [{ disposition: "accepted" }] };
    f.run.results.read.bytes = Buffer.byteLength(
      JSON.stringify(f.run.results.read.value),
    );
    f.store.save(f.run);
    assert.equal(
      f.service.result({ runId: f.run.runId }, f.exec).ownerReview.status,
      "not_recorded",
    );
    for (let i = 0; i < 32; i++) f.service.review(f.request(), f.exec);
    assert.throws(
      () => f.service.review(f.request(), f.exec),
      /RUNTIME_INVALID_STATE/,
    );
    assert.equal(f.store.load(f.run.runId).ownerReviews.length, 32);
  } finally {
    await f.close();
  }
});

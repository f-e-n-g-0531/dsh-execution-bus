import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunStore } from "../dist/runtime/store.js";
import { RuntimeService } from "../dist/runtime/service.js";
import { createServiceContext } from "./fixtures/service-context.mjs";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import {
  RUNTIME_OUTPUT_SCHEMAS,
  runtimePresentationMeta,
} from "../dist/presentation.js";
const exec = (id = "owner") => ({
  agent: { id },
  callId: "task-view",
  signal: new AbortController().signal,
});
const steps = [{ id: "read", tool: "read", input: { secret: "plan-secret" } }];
test("task view filters before paging, isolates owners, exposes retained-page counts without payloads", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-task-view-"));
  const store = new RunStore(root);
  const service = new RuntimeService(
    createServiceContext(async () => ({ secret: "result-secret" })),
    store,
  );
  try {
    const first = await service.run(
      { plan: { task_id: "audit", steps } },
      exec(),
    );
    const second = await service.run(
      { plan: { task_id: "audit", previous_run_id: first.runId, steps } },
      exec(),
    );
    await service.run({ plan: { task_id: "other", steps } }, exec());
    await service.run({ plan: { task_id: "audit", steps } }, exec("peer"));
    const before = readdirSync(root);
    const page = service.task({ taskId: "audit", limit: 1 }, exec());
    assert.equal(page.runs.length, 1);
    assert.equal(page.hasMore, true);
    assert.equal(page.page.reviewCount, 1);
    assert.equal(page.page.runCount, 1);
    assert.equal(page.scope, "retained_owner_runs");
    const rest = service.task({ taskId: "audit", limit: 1, offset: 1 }, exec());
    assert.equal(rest.hasMore, false);
    assert.deepEqual(
      new Set([...page.runs, ...rest.runs].map((r) => r.runId)),
      new Set([first.runId, second.runId]),
    );
    assert.deepEqual(
      validateJsonSchemaValue(RUNTIME_OUTPUT_SCHEMAS.runtime_task, page),
      [],
    );
    assert.doesNotMatch(
      JSON.stringify(page),
      /plan-secret|result-secret|ownerSessionId/,
    );
    assert.deepEqual(readdirSync(root), before);
    assert.equal(service.task({ taskId: "absent" }, exec()).runs.length, 0);
    assert.match(
      runtimePresentationMeta({}, page).text,
      /仅当前owner保留记录的本页/,
    );
    assert.match(runtimePresentationMeta({}, page).text, /当前行动/);
    for (const input of [
      { taskId: "../bad" },
      { taskId: "audit", limit: 0 },
      { taskId: "audit", offset: -1 },
      { taskId: "audit", owner: "peer" },
    ])
      assert.throws(() => service.task(input, exec()), /INVALID_PLAN/);
    store.remove(first.runId);
    assert.equal(service.task({ taskId: "audit" }, exec()).runs.length, 1);
  } finally {
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
test("same run interrupted again gets a fresh notification after a running interval", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-notify-epoch-"));
  const store = new RunStore(root);
  const service = new RuntimeService(
    createServiceContext(async () => "ok"),
    store,
  );
  try {
    const completed = await service.run({ plan: { steps } }, exec());
    const run = store.load(completed.runId);
    run.state = "interrupted";
    run.steps[0].state = "unknown";
    run.results = {};
    store.save(run);
    const first = service.notification(
      { runId: run.runId, operation: "sync" },
      exec(),
    ).receipt;
    assert.equal(first.status, "pending");
    run.state = "running";
    delete run.finishedAt;
    run.steps[0].state = "running";
    delete run.steps[0].finishedAt;
    store.save(run);
    assert.equal(
      service.notification({ runId: run.runId, operation: "sync" }, exec())
        .receipt.status,
      "withdrawn",
    );
    run.state = "interrupted";
    run.finishedAt = run.updatedAt;
    run.steps[0].state = "unknown";
    run.steps[0].attempts++;
    run.steps[0].finishedAt = run.updatedAt;
    store.save(run);
    const second = service.notification(
      { runId: run.runId, operation: "sync" },
      exec(),
    ).receipt;
    assert.equal(second.status, "pending");
    assert.notEqual(second.key, first.key);
    assert.ok(second.revision > first.revision);
    assert.equal(
      service.notification(
        {
          runId: run.runId,
          operation: "claim",
          key: second.key,
          expectedRevision: second.revision,
        },
        exec(),
      ).receipt.status,
      "delivering",
    );
    assert.throws(
      () =>
        service.notification(
          {
            runId: run.runId,
            operation: "claim",
            key: first.key,
            expectedRevision: first.revision,
          },
          exec(),
        ),
      /RUNTIME_RESULT_CHANGED/,
    );
  } finally {
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("notification service requires explicit protocol, rejects stale callbacks and does not change run", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-notify-api-"));
  const store = new RunStore(root);
  const service = new RuntimeService(
    createServiceContext(async () => {
      throw Error("failure-secret");
    }),
    store,
  );
  try {
    const run = await service.run({ plan: { steps } }, exec());
    const saved = store.load(run.runId);
    const get = service.notification({ runId: run.runId }, exec());
    assert.equal(get.receipt, undefined);
    assert.equal(get.current.shouldNotify, true);
    const pending = service.notification(
      { runId: run.runId, operation: "sync" },
      exec(),
    );
    assert.equal(pending.receipt.status, "pending");
    const claim = service.notification(
      {
        runId: run.runId,
        operation: "claim",
        key: pending.receipt.key,
        expectedRevision: pending.receipt.revision,
      },
      exec(),
    );
    assert.equal(claim.receipt.status, "delivering");
    const request = {
      runId: run.runId,
      operation: "settle",
      key: claim.receipt.key,
      expectedRevision: claim.receipt.revision,
      attemptToken: claim.receipt.attemptToken,
      outcome: "failed",
    };
    const failed = service.notification(request, exec());
    assert.equal(failed.receipt.status, "failed");
    assert.throws(
      () => service.notification(request, exec()),
      /RUNTIME_RESULT_CHANGED|RUNTIME_INVALID_STATE/,
    );
    const retry = service.notification(
      {
        runId: run.runId,
        operation: "claim",
        key: failed.receipt.key,
        expectedRevision: failed.receipt.revision,
      },
      exec(),
    );
    const sent = service.notification(
      {
        ...request,
        expectedRevision: retry.receipt.revision,
        attemptToken: retry.receipt.attemptToken,
        outcome: "sent",
      },
      exec(),
    );
    assert.equal(sent.receipt.status, "sent");
    assert.equal(
      service.notification({ runId: run.runId, operation: "sync" }, exec())
        .receipt.status,
      "sent",
    );
    assert.deepEqual(
      validateJsonSchemaValue(
        RUNTIME_OUTPUT_SCHEMAS.runtime_notification,
        sent,
      ),
      [],
    );
    const text = runtimePresentationMeta({}, retry).text;
    assert.doesNotMatch(text, new RegExp(retry.receipt.attemptToken));
    assert.doesNotMatch(text, /failure-secret|plan-secret/);
    assert.throws(
      () => service.notification({ runId: run.runId }, exec("peer")),
      /RUNTIME_NOT_FOUND/,
    );
    assert.throws(
      () =>
        service.notification({ runId: run.runId, key: "a".repeat(64) }, exec()),
      /INVALID_PLAN/,
    );
    assert.deepEqual(store.load(run.runId), saved);
    // A new problem snapshot creates a fresh delivery version even for the same action.
    const changed = structuredClone(saved);
    changed.steps[0].error = "updated-failure";
    changed.updatedAt++;
    store.save(changed);
    const nextPending = service.notification(
      { runId: run.runId, operation: "sync" },
      exec(),
    );
    assert.notEqual(nextPending.receipt.key, sent.receipt.key);
    assert.equal(nextPending.receipt.status, "pending");
    // Explicit acknowledgement clears the action and must fence a claimed callback.
    const another = await service.run({ plan: { steps } }, exec());
    const queued = service.notification(
      { runId: another.runId, operation: "sync" },
      exec(),
    );
    const active = service.notification(
      {
        runId: another.runId,
        operation: "claim",
        key: queued.receipt.key,
        expectedRevision: queued.receipt.revision,
      },
      exec(),
    );
    const status = service.status({ runId: another.runId }, exec());
    service.acknowledge(
      {
        runId: another.runId,
        snapshotHash: status.attention.snapshotHash,
        key: status.attention.items[0].key,
        expectedRevision: status.attention.revision,
        reason: "known",
      },
      exec(),
    );
    assert.throws(
      () =>
        service.notification(
          {
            runId: another.runId,
            operation: "settle",
            key: active.receipt.key,
            expectedRevision: active.receipt.revision,
            attemptToken: active.receipt.attemptToken,
            outcome: "sent",
          },
          exec(),
        ),
      /RUNTIME_RESULT_CHANGED/,
    );
    assert.equal(
      service.notification({ runId: another.runId }, exec()).receipt.status,
      "withdrawn",
    );
    const aborted = exec();
    aborted.signal = AbortSignal.abort();
    assert.throws(
      () =>
        service.notification({ runId: run.runId, operation: "sync" }, aborted),
      /RUNTIME_CANCELLED/,
    );
  } finally {
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeService } from "../dist/runtime/service.js";
import { RuntimeExecutor } from "../dist/runtime/executor.js";
import { RunStore } from "../dist/runtime/store.js";
import { parsePlan } from "../dist/runtime/plan.js";
import { runAttention } from "../dist/runtime/attention.js";
import { validAcknowledgements } from "../dist/runtime/acknowledgement.js";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import {
  RUNTIME_OUTPUT_SCHEMAS,
  runtimePresentationMeta,
} from "../dist/presentation.js";
async function fixture(tool = "read") {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-ack-"));
  const store = new RunStore(root);
  const executor = new RuntimeExecutor(store, async () => {
    throw Error("private-failure");
  });
  const run = executor.createRun(
    "owner",
    parsePlan({ steps: [{ id: "a", tool, input: {} }] }),
  );
  await executor.execute(run);
  const service = new RuntimeService({}, store),
    exec = { agent: { id: "owner" } };
  const request = () => {
    const attention = service.status({ runId: run.runId }, exec).attention;
    return {
      runId: run.runId,
      snapshotHash: attention.snapshotHash,
      key: attention.items[0].key,
      expectedRevision: attention.revision,
      reason: "PRIVATE_ACK_REASON",
    };
  };
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
test("acknowledgement persists without changing execution, review, or hiding the problem", async () => {
  const f = await fixture();
  try {
    const before = f.store.load(f.run.runId),
      req = f.request();
    const result = f.service.acknowledge(req, f.exec);
    assert.deepEqual(
      validateJsonSchemaValue(
        RUNTIME_OUTPUT_SCHEMAS.runtime_acknowledge,
        result,
      ),
      [],
    );
    assert.equal(result.attention.items[0].acknowledged, true);
    assert.equal(result.attention.notification.shouldNotify, false);
    assert.equal(result.state, "failed");
    assert.equal(result.ownerReview.status, "not_recorded");
    assert.match(
      runtimePresentationMeta({}, result).text,
      /已知悉（不等于解决或验收）/,
    );
    assert.doesNotMatch(
      runtimePresentationMeta({}, result).text,
      /PRIVATE_ACK_REASON/,
    );
    const after = f.store.load(f.run.runId);
    const { acknowledgements, ...execution } = after;
    assert.deepEqual(execution, before);
    const reopened = new RuntimeService({}, new RunStore(f.root));
    assert.equal(
      reopened.status({ runId: f.run.runId }, f.exec).attention.items[0]
        .acknowledged,
      true,
    );
    assert.equal(
      reopened.status({}, f.exec).runs[0].attention.items[0].acknowledged,
      true,
    );
    const savedResult = reopened.result({ runId: f.run.runId }, f.exec);
    assert.deepEqual(savedResult.acknowledgementHistory, acknowledgements);
    assert.deepEqual(
      validateJsonSchemaValue(
        RUNTIME_OUTPUT_SCHEMAS.runtime_result,
        savedResult,
      ),
      [],
    );
    assert.doesNotMatch(
      JSON.stringify(reopened.status({}, f.exec)),
      /PRIVATE_ACK_REASON/,
    );
    await reopened.dispose();
    assert.throws(
      () => f.service.acknowledge(req, f.exec),
      /RUNTIME_RESULT_CHANGED/,
    );
    assert.throws(
      () => f.service.acknowledge(f.request(), f.exec),
      /RUNTIME_INVALID_STATE/,
    );
    after.steps[0].error = "new-problem";
    f.store.save(after);
    assert.equal(
      f.service.status({ runId: f.run.runId }, f.exec).attention.items[0]
        .acknowledged,
      undefined,
    );
    assert.equal(
      f.service.status({ runId: f.run.runId }, f.exec).attention.notification
        .shouldNotify,
      true,
    );
  } finally {
    await f.close();
  }
});
test("unknown external effects remain urgent after acknowledgement", async () => {
  const f = await fixture("write");
  try {
    const run = f.store.load(f.run.runId);
    run.steps[0].state = "unknown";
    f.store.save(run);
    const result = f.service.acknowledge(f.request(), f.exec);
    assert.equal(result.attention.items[0].kind, "inspect_external_state");
    assert.equal(result.attention.items[0].acknowledged, true);
    assert.equal(result.attention.notification.shouldNotify, true);
    assert.match(runtimePresentationMeta({}, result).text, /不要自动重发/);
  } finally {
    await f.close();
  }
});
test("owner, current snapshot, revision, inputs, cancellation and lock are enforced", async () => {
  const f = await fixture();
  try {
    const req = f.request();
    assert.throws(
      () => f.service.acknowledge(req, { agent: { id: "peer" } }),
      /RUNTIME_NOT_FOUND/,
    );
    assert.throws(
      () => f.service.acknowledge(req, {}),
      /OWNING_SESSION_REQUIRED/,
    );
    for (const change of [
      { snapshotHash: "0".repeat(64) },
      { expectedRevision: 1 },
    ])
      assert.throws(
        () => f.service.acknowledge({ ...req, ...change }, f.exec),
        /RUNTIME_RESULT_CHANGED/,
      );
    for (const change of [
      { key: "x" },
      { reason: " " },
      { reason: "中".repeat(700) },
      { extra: true },
      { expectedRevision: -1 },
      { expectedRevision: 0.5 },
    ])
      assert.throws(
        () => f.service.acknowledge({ ...req, ...change }, f.exec),
        /INVALID_PLAN/,
      );
    assert.throws(
      () => f.service.acknowledge({ ...req, key: "0".repeat(64) }, f.exec),
      /RUNTIME_INVALID_STATE/,
    );
    const c = new AbortController();
    c.abort();
    assert.throws(
      () => f.service.acknowledge(req, { ...f.exec, signal: c.signal }),
      /RUNTIME_CANCELLED/,
    );
    const lock = f.store.pathFor(f.run.runId) + ".review-lock";
    writeFileSync(lock, "");
    assert.throws(() => f.service.acknowledge(req, f.exec), /RUNTIME_BUSY/);
    rmSync(lock);
    const save = mock.method(f.store, "save", () => {
      throw Error("RUNTIME_STORAGE_FAILED");
    });
    assert.throws(
      () => f.service.acknowledge(req, f.exec),
      /RUNTIME_STORAGE_FAILED/,
    );
    save.mock.restore();
    assert.equal(f.store.load(f.run.runId).acknowledgements, undefined);
  } finally {
    mock.restoreAll();
    await f.close();
  }
});
test("active and recoverable runs cannot acquire acknowledgements; successful review is separate", async () => {
  const f = await fixture();
  try {
    const req = f.request(),
      run = f.store.load(f.run.runId);
    run.state = "interrupted";
    f.store.save(run);
    assert.throws(
      () => f.service.acknowledge(req, f.exec),
      /RUNTIME_INVALID_STATE/,
    );
    run.state = "running";
    delete run.finishedAt;
    f.store.save(run);
    assert.throws(
      () => f.service.acknowledge(req, f.exec),
      /RUNTIME_INVALID_STATE/,
    );
    const success = new RuntimeExecutor(f.store, async () => "ok");
    const r = success.createRun(
      "owner",
      parsePlan({ steps: [{ id: "a", tool: "read", input: {} }] }),
    );
    await success.execute(r);
    const attention = runAttention(r);
    assert.throws(
      () =>
        f.service.acknowledge(
          {
            ...req,
            runId: r.runId,
            snapshotHash: attention.snapshotHash,
            key: attention.items[0].key,
          },
          f.exec,
        ),
      /RUNTIME_INVALID_STATE/,
    );
  } finally {
    await f.close();
  }
});
test("ledger cap rejects new acknowledgements without evicting history", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 32; i++) {
      const run = f.store.load(f.run.runId);
      run.steps[0].error = "problem-" + i;
      f.store.save(run);
      assert.equal(
        f.service.acknowledge(f.request(), f.exec).attention.revision,
        i + 1,
      );
    }
    const run = f.store.load(f.run.runId);
    run.steps[0].error = "new-problem-after-cap";
    f.store.save(run);
    assert.throws(
      () => f.service.acknowledge(f.request(), f.exec),
      /RUNTIME_INVALID_STATE/,
    );
    assert.equal(f.store.load(f.run.runId).acknowledgements.length, 32);
    assert.equal(
      f.service.status({ runId: f.run.runId }, f.exec).attention.notification
        .shouldNotify,
      true,
    );
  } finally {
    await f.close();
  }
});

test("strict bounded ledger rejects malformed persisted declarations", async () => {
  const f = await fixture();
  try {
    const result = f.service.acknowledge(f.request(), f.exec),
      valid = result.acknowledgementHistory;
    assert.equal(validAcknowledgements(valid, 0), true);
    for (const bad of [
      [],
      [...valid, { ...valid[0] }],
      [{ ...valid[0], extra: true }],
      [{ ...valid[0], at: NaN }],
      [{ ...valid[0], reason: " " }],
      Array.from({ length: 33 }, (_, i) => ({ ...valid[0], revision: i + 1 })),
    ])
      assert.equal(validAcknowledgements(bad, 0), false);
    const run = f.store.load(f.run.runId);
    run.acknowledgements[0].revision = 99;
    writeFileSync(f.store.pathFor(run.runId), JSON.stringify(run));
    assert.equal(f.store.load(run.runId), undefined);
  } finally {
    await f.close();
  }
});

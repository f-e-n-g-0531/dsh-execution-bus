import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunStore } from "../dist/runtime/store.js";
import { RuntimeService } from "../dist/runtime/service.js";
import { createServiceContext } from "./fixtures/service-context.mjs";
import { RUNTIME_OUTPUT_SCHEMAS, runtimePresentationMeta } from "../dist/presentation.js";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";

const exec = (id = "owner") => ({ agent: { id }, callId: "comparison", signal: new AbortController().signal });
const steps = (secret) => [{ id: "read", tool: "read", input: { secret } }];

test("full result derives private plan differences without changing execution, pages or lists", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-comparison-"));
  const store = new RunStore(root);
  let calls = 0;
  const service = new RuntimeService(createServiceContext(async () => ++calls), store);
  try {
    const first = await service.run({ plan: { task_id: "audit", steps: steps("first-secret"), concurrency: 1 } }, exec());
    const next = await service.run({ plan: { task_id: "audit", previous_run_id: first.runId, steps: steps("next-secret"), concurrency: 2 } }, exec());
    const files = readdirSync(root);
    const bytes = readFileSync(store.pathFor(next.runId), "utf8");
    const detail = service.result({ runId: next.runId }, exec());
    assert.deepEqual(detail.planComparison, { comparable: true, changes: {
      addedSteps: [], removedSteps: [], changedSteps: [{ id: "read", fields: ["input"] }],
      concurrencyChanged: true, goalChanged: false, provenanceChanged: false, handoffChanged: false,
    } });
    assert.deepEqual(validateJsonSchemaValue(RUNTIME_OUTPUT_SCHEMAS.runtime_result, detail), []);
    assert.doesNotMatch(JSON.stringify(detail.planComparison), /first-secret|next-secret|hash/);
    const text = runtimePresentationMeta({}, detail).text;
    assert.match(text, /计划差异/);
    assert.match(text, /修改步骤：read/);
    assert.doesNotMatch(text, /first-secret|next-secret/);
    assert.equal(calls, 2);
    assert.equal(detail.results.read.value, 2);
    assert.equal(readFileSync(store.pathFor(next.runId), "utf8"), bytes);
    assert.deepEqual(readdirSync(root), files);
    for (const value of [next, service.status({runId: next.runId}, exec()), service.status({}, exec()), service.task({taskId: "audit"}, exec()), service.result({runId: next.runId, stepId: "read"}, exec())])
      assert.equal(JSON.stringify(value).includes("planComparison"), false);
    assert.deepEqual(service.result({runId: first.runId}, exec()).planComparison, { comparable: false, reason: "no_previous_run" });
    assert.throws(() => service.result({runId: next.runId}, exec("peer")), /RUNTIME_NOT_FOUND/);
    const same = await service.run({ plan: { task_id: "audit", previous_run_id: next.runId, steps: steps("next-secret"), concurrency: 2 } }, exec());
    const unchanged = service.result({runId: same.runId}, exec());
    assert.deepEqual(unchanged.planComparison.changes.changedSteps, []);
    assert.match(runtimePresentationMeta({}, unchanged).text, /已比较：所列计划字段无变化/);
    const before = readFileSync(store.pathFor(first.runId), "utf8");
    const record = JSON.parse(before);
    record.ownerSessionId = "peer";
    writeFileSync(store.pathFor(first.runId), JSON.stringify(record));
    assert.deepEqual(service.result({runId: next.runId}, exec()).planComparison, { comparable: false, reason: "predecessor_unavailable" });
    writeFileSync(store.pathFor(first.runId), before);
    record.ownerSessionId = "owner";
    record.state = "interrupted";
    writeFileSync(store.pathFor(first.runId), JSON.stringify(record));
    assert.deepEqual(service.result({runId: next.runId}, exec()).planComparison, { comparable: false, reason: "incompatible_predecessor" });
    Object.assign(record, JSON.parse(before));
    record.plan.taskId = "different";
    writeFileSync(store.pathFor(first.runId), JSON.stringify(record));
    assert.deepEqual(service.result({runId: next.runId}, exec()).planComparison, { comparable: false, reason: "incompatible_predecessor" });
    writeFileSync(store.pathFor(first.runId), '{"version":999}');
    assert.deepEqual(service.result({runId: next.runId}, exec()).planComparison, { comparable: false, reason: "predecessor_unavailable" });
    rmSync(store.pathFor(first.runId));
    const missing = service.result({runId: next.runId}, exec());
    assert.deepEqual(missing.planComparison, { comparable: false, reason: "predecessor_unavailable" });
    assert.match(runtimePresentationMeta({}, missing).text, /不可比较/);
    assert.deepEqual(validateJsonSchemaValue(RUNTIME_OUTPUT_SCHEMAS.runtime_result, missing), []);
  } finally { await service.dispose(); rmSync(root, {recursive: true, force: true}); }
});

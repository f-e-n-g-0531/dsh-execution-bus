import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeService } from "../dist/runtime/service.js";
import { RunStore } from "../dist/runtime/store.js";
import { parsePlan } from "../dist/runtime/plan.js";
import { RUNTIME_OUTPUT_SCHEMAS, runtimePresentationMeta } from "../dist/presentation.js";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { createServiceContext } from "./fixtures/service-context.mjs";
const exec = (id = "owner") => ({ agent: { id }, signal: new AbortController().signal });
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-query-"));
  const store = new RunStore(root);
  let calls = 0;
  const service = new RuntimeService(createServiceContext(async () => { calls++; return "ok"; }), store);
  const seed = (n, owner = "owner", failed = false) => {
    const run = { version: 1, runId: "run-" + String(n).padStart(8, "0"), ownerSessionId: owner,
      state: failed ? "failed" : "succeeded", createdAt: 1, updatedAt: n + 2, finishedAt: n + 2,
      goal: "核查 Atlas " + n,
      plan: parsePlan({ goal: "核查 Atlas " + n, task_id: n % 2 ? "audit" : "other", provenance: { request_ref: "issue:Atlas", scope_summary: "渲染", context_refs: ["session:context"] },
        steps: [{ id: "read", tool: "read", input: { file_path: "PRIVATE_INPUT" } }] }),
      steps: [{ id: "read", tool: "read", state: failed ? "failed" : "succeeded", attempts: 1, startedAt: 1, finishedAt: n + 2 }],
      results: failed ? {} : { read: { value: "PRIVATE_RESULT" } },
      ...(failed ? { error: "PRIVATE_ERROR" } : {}),
    };
    store.save(run);
    return run;
  };
  return { root, store, service, seed, calls: () => calls, async close() { await service.dispose(); rmSync(root, { recursive: true, force: true }); } };
}

test("query finds old cross-task actions before paging, isolates owners and never writes or dispatches", async () => {
  const f = fixture();
  try {
    const old = f.seed(1, "owner", true);
    for (let n = 2; n <= 25; n++) f.seed(n);
    f.seed(30, "peer", true);
    const names = readdirSync(f.root);
    const bytes = names.filter(n => n.endsWith(".json")).map(n => [n, readFileSync(path.join(f.root, n), "utf8")]);
    const result = f.service.query({ view: "needs_action", limit: 1 }, exec());
    assert.deepEqual(result.runs.map(r => r.runId), [old.runId]);
    assert.equal(result.matchedCount, 1);
    assert.deepEqual(result.groups, { needsAction: 1, review: 24 });
    assert.equal(result.scannedCount, 25);
    assert.equal(result.hasMore, false);
    assert.deepEqual(validateJsonSchemaValue(RUNTIME_OUTPUT_SCHEMAS.runtime_query, result), []);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_INPUT|PRIVATE_RESULT|PRIVATE_ERROR|ownerSessionId|attemptToken/);
    const text = runtimePresentationMeta({}, result).text;
    assert.match(text, /跨任务元数据查询/);
    assert.match(text, /必须处理 1 · 待复核 24/);
    assert.match(text, new RegExp(old.runId));
    assert.doesNotMatch(text, /undefined|NaN/);
    assert.deepEqual(readdirSync(f.root), names);
    for (const [name, content] of bytes) assert.equal(readFileSync(path.join(f.root, name), "utf8"), content);
    assert.equal(f.calls(), 0);
    assert.deepEqual(f.service.query({ q: "Atlas", state: "failed" }, exec("absent")).runs, []);
    assert.equal(f.service.query({ q: "issue:atlas", taskId: "audit", state: "failed" }, exec()).matchedCount, 1);
    for (const q of ["PRIVATE_INPUT", "PRIVATE_RESULT", "PRIVATE_ERROR"]) assert.equal(f.service.query({ q }, exec()).matchedCount, 0);
    for (const bad of [{ owner: "peer" }, { cursor: "x" }, { snapshot: true }]) assert.throws(() => f.service.query(bad, exec()), /INVALID_PLAN/);
    assert.throws(() => f.service.query({}, {}), /OWNING_SESSION_REQUIRED/);
    const review = f.service.query({ view: "review", limit: 2 }, exec());
    assert.equal(review.matchedCount, 24);
    assert.equal(review.hasMore, true);
    assert.equal(review.runs.length, 2);
    f.store.remove(old.runId);
    assert.equal(f.service.query({ view: "needs_action" }, exec()).matchedCount, 0);
    await f.service.dispose();
    assert.throws(() => f.service.query({}, exec()), /CLOSED/);
  } finally { await f.close(); }
});

test("query rejects candidate overflow even if the matching action is old", async () => {
  const f = fixture();
  try {
    // Query does not maintain/clean history. Seed after service initialization.
    for (let n = 0; n < 1001; n++) f.seed(n, "owner", n === 0);
    assert.throws(() => f.service.query({ view: "needs_action", limit: 1 }, exec()), /RUNTIME_INVALID_STATE/);
    f.store.remove("run-00001000");
    const result = f.service.query({ view: "needs_action", limit: 1 }, exec());
    assert.equal(result.scannedCount, 1000);
    assert.equal(result.matchedCount, 1);
    assert.equal(result.runs[0].runId, "run-00000000");
  } finally { await f.close(); }
});

test("query surfaces corrupt records as diagnostics instead of claiming full history", async () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.root, "run-bad00000.json"), "{broken");
    const result = f.service.query({}, exec());
    assert.equal(result.matchedCount, 0);
    assert.ok(result.diagnostics.invalidRecords > 0);
    assert.match(result.message, /空结果不证明没有待办/);
    assert.match(runtimePresentationMeta({}, result).text, /不证明没有待办/);
    assert.deepEqual(validateJsonSchemaValue(RUNTIME_OUTPUT_SCHEMAS.runtime_query, result), []);
  } finally { await f.close(); }
});

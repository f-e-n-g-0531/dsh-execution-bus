import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeService } from "../dist/runtime/service.js";
import { RuntimeExecutor } from "../dist/runtime/executor.js";
import { RunStore } from "../dist/runtime/store.js";
import { parsePlan } from "../dist/runtime/plan.js";
import {
  RUNTIME_OUTPUT_SCHEMAS,
  runtimePresentationMeta,
} from "../dist/presentation.js";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";

const exec = (id = "owner", toolSet) => ({
  agent: { id },
  ...(toolSet === undefined ? {} : { toolSet }),
});
const validate = (name, value) =>
  assert.deepEqual(
    validateJsonSchemaValue(RUNTIME_OUTPUT_SCHEMAS[name], value),
    [],
  );
function fixture(adapter) {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-capabilities-"));
  const store = new RunStore(root);
  const service = new RuntimeService({}, store, adapter);
  return {
    store,
    service,
    async close() {
      await service.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("capabilities describes unsupported standard Worker without dispatch or run creation", async () => {
  const f = fixture();
  try {
    for (const toolSet of [undefined, {}]) {
      const value = f.service.capabilities({}, exec("owner", toolSet));
      validate("runtime_capabilities", value);
      assert.equal(value.worker, "unavailable");
      assert.equal(value.workerReason, "trusted_adapter_missing");
      assert.equal(value.ordinaryAsync, toolSet === undefined);
      assert.equal(value.workerAsync, false);
      assert.equal(value.authorization, "checked_at_execution");
      assert.match(runtimePresentationMeta({}, value).text, /unavailable/);
      value.workerTools.push("write");
      assert.deepEqual(f.service.capabilities({}, exec()).workerTools, [
        "read",
        "glob",
        "grep",
      ]);
    }
    await assert.rejects(
      f.service.run(
        {
          plan: {
            steps: [{ id: "w", tool: "agent", input: { prompt: "test" } }],
          },
        },
        exec(),
      ),
      /RUNTIME_AGENT_POLICY_UNSUPPORTED/,
    );
    assert.deepEqual(f.store.list(), []);
    assert.throws(
      () => f.service.capabilities({}, {}),
      /OWNING_SESSION_REQUIRED/,
    );
    for (const input of [
      null,
      [],
      { plan: {} },
      Object.create({}),
      {
        get secret() {
          throw Error("should not read");
        },
      },
    ])
      assert.throws(
        () => f.service.capabilities(input, exec()),
        /INVALID_PLAN/,
      );
    await f.service.dispose();
    assert.throws(() => f.service.capabilities({}, exec()), /CLOSED/);
  } finally {
    await f.close();
  }
});

test("trusted adapter presence is conditional, not a policy authorization", async () => {
  let checks = 0;
  const f = fixture({
    checkParentPolicy() {
      checks++;
      throw Error("not called");
    },
  });
  try {
    assert.equal(
      f.service.capabilities({}, exec()).workerReason,
      "parent_admission_missing",
    );
    const value = f.service.capabilities({}, exec("owner", {}));
    validate("runtime_capabilities", value);
    assert.equal(value.worker, "conditional");
    assert.equal(value.workerReason, "execution_checks_required");
    assert.equal(value.ordinaryAsync, false);
    assert.equal(checks, 0);
    assert.deepEqual(f.store.list(), []);
  } finally {
    await f.close();
  }
});

test("owner-only result projects unreviewed report counts bound to exact saved value", async () => {
  const f = fixture();
  try {
    const maker = new RuntimeExecutor(f.store, async () => ({}));
    const run = maker.createRun(
      "owner",
      parsePlan({
        steps: [
          {
            id: "w",
            tool: "agent",
            input: { prompt: "PRIVATE-PROMPT", output_format: "report" },
          },
        ],
      }),
    );
    const report = {
      outcome: "blocked",
      summary: "PRIVATE-SUMMARY",
      evidence: [{ path: "PRIVATE-PATH" }],
      limitations: ["PRIVATE-LIMIT"],
      requestedDecision: "PRIVATE-DECISION",
    };
    run.state = "succeeded";
    run.finishedAt = run.updatedAt;
    run.steps[0] = {
      ...run.steps[0],
      state: "succeeded",
      attempts: 1,
      startedAt: run.createdAt,
      finishedAt: run.updatedAt,
    };
    run.results.w = {
      value: {
        sessionId: "child",
        output: JSON.stringify(report),
        report,
        verification: "not_independently_verified",
      },
    };
    f.store.save(run);
    const result = f.service.result({ runId: run.runId }, exec());
    const paged = f.service.result(
      { runId: run.runId, stepId: "w", limit: 1 },
      exec(),
    );
    validate("runtime_result", result);
    validate("runtime_result", paged);
    assert.deepEqual(result.acceptance, paged.acceptance);
    assert.equal(result.acceptance.status, "not_reviewed");
    const worker = result.acceptance.workers[0];
    assert.equal(worker.resultHash, paged.page.hash);
    assert.equal(worker.reportOutcome, "blocked");
    assert.equal(worker.evidenceCount, 1);
    assert.equal(worker.limitationCount, 1);
    assert.equal(worker.decisionRequired, true);
    assert.doesNotMatch(JSON.stringify(result.acceptance), /PRIVATE/);
    assert.doesNotMatch(
      JSON.stringify(runtimePresentationMeta({}, result)),
      /PRIVATE/,
    );
    const status = f.service.status({ runId: run.runId }, exec());
    validate("runtime_status", status);
    assert.equal(Object.hasOwn(status, "acceptance"), false);
    assert.equal(status.recovery.cleanup, "unknown");
    assert.equal(status.recovery.externalWork, "unconfirmed");
    for (const args of [
      { runId: run.runId },
      { runId: run.runId, stepId: "w" },
    ])
      assert.throws(
        () => f.service.result(args, exec("peer")),
        /RUNTIME_NOT_FOUND/,
      );
    const stored = JSON.parse(readFileSync(f.store.pathFor(run.runId), "utf8"));
    assert.equal(Object.hasOwn(stored, "acceptance"), false);
    assert.equal(Object.hasOwn(stored, "recovery"), false);
    const oldHash = worker.resultHash;
    run.results.w.value.report.summary = "changed";
    f.store.save(run);
    assert.notEqual(
      f.service.result({ runId: run.runId }, exec()).acceptance.workers[0]
        .resultHash,
      oldHash,
    );
  } finally {
    await f.close();
  }
});

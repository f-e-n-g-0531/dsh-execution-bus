import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePlan } from "../dist/runtime/plan.js";
import { RunStore } from "../dist/runtime/store.js";
import { RuntimeService } from "../dist/runtime/service.js";
import { RuntimeExecutor } from "../dist/runtime/executor.js";
import { createServiceContext } from "./fixtures/service-context.mjs";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { RUNTIME_OUTPUT_SCHEMAS } from "../dist/presentation.js";

const steps = [{ id: "read", tool: "read", input: {} }];
const exec = (id = "owner") => ({
  agent: { id },
  callId: "links",
  signal: new AbortController().signal,
});

test("task links are optional, bounded and round-trip without changing legacy defaults", () => {
  const legacy = parsePlan({ steps });
  assert.equal(Object.hasOwn(legacy, "taskId"), false);
  const parsed = parsePlan({
    task_id: "Audit_1",
    previous_run_id: "run-12345678",
    steps,
  });
  assert.equal(parsed.taskId, "Audit_1");
  assert.equal(parsed.previousRunId, "run-12345678");
  for (const over of [
    { task_id: "" },
    { task_id: "x".repeat(65) },
    { task_id: "a b" },
    { previous_run_id: "run-12345678" },
    { task_id: "x", previous_run_id: "bad" },
    { task_id: null },
  ]) {
    assert.throws(() => parsePlan({ steps, ...over }), /INVALID_PLAN/);
  }
});

test("task history checks owner/task/finished predecessor before creating a new run and never reuses results", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-links-"));
  const store = new RunStore(root);
  let calls = 0;
  const service = new RuntimeService(
    createServiceContext(async () => ++calls),
    store,
  );
  try {
    const first = await service.run(
      { plan: { task_id: "audit", steps } },
      exec(),
    );
    assert.equal(first.taskId, "audit");
    const next = await service.run(
      { plan: { task_id: "audit", previous_run_id: first.runId, steps } },
      exec(),
    );
    assert.equal(next.previousRunId, first.runId);
    assert.deepEqual(
      validateJsonSchemaValue(RUNTIME_OUTPUT_SCHEMAS.runtime_run, next),
      [],
    );
    assert.deepEqual(
      validateJsonSchemaValue(
        RUNTIME_OUTPUT_SCHEMAS.runtime_status,
        service.status({}, exec()),
      ),
      [],
    );
    assert.equal(calls, 2);
    const saved = store.load(next.runId);
    assert.equal(saved.plan.taskId, "audit");
    assert.equal(saved.plan.previousRunId, first.runId);
    assert.equal(
      service.result({ runId: next.runId }, exec()).results.read.value,
      2,
    );
    assert.equal(service.status({}, exec()).runs[0].taskId, "audit");
    const before = store.list(100).length;
    await assert.rejects(
      service.run(
        { plan: { task_id: "other", previous_run_id: first.runId, steps } },
        exec(),
      ),
      /RUNTIME_TASK_LINK_INVALID/,
    );
    await assert.rejects(
      service.run(
        { plan: { task_id: "audit", previous_run_id: first.runId, steps } },
        exec("other"),
      ),
      /RUNTIME_NOT_FOUND/,
    );
    await assert.rejects(
      service.run(
        { plan: { task_id: "audit", previous_run_id: "run-12345678", steps } },
        exec(),
      ),
      /RUNTIME_NOT_FOUND/,
    );
    assert.equal(store.list(100).length, before);
    const legacy = await service.run({ plan: { steps } }, exec());
    assert.equal(Object.hasOwn(legacy, "taskId"), false);
    assert.equal(Object.hasOwn(store.load(legacy.runId).plan, "taskId"), false);
  } finally {
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("task links and criteria preserve an exact 64KiB wire plan across save/reload", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-linked-boundary-"));
  try {
    const wire = {
      task_id: "boundary",
      previous_run_id: "run-12345678",
      steps: [
        {
          id: "worker",
          tool: "agent",
          input: {
            prompt: "",
            output_format: "report",
            acceptance_criteria: [
              { id: "inspect", description: "Inspect source" },
            ],
          },
        },
      ],
    };
    wire.steps[0].input.prompt = "x".repeat(
      65536 - Buffer.byteLength(JSON.stringify(wire)),
    );
    assert.equal(Buffer.byteLength(JSON.stringify(wire)), 65536);
    const store = new RunStore(root);
    const executor = new RuntimeExecutor(store, async () => null);
    const run = executor.createRun("owner", parsePlan(wire));
    assert.deepEqual(store.load(run.runId).plan, run.plan);
    run.plan.previousRunId = run.runId;
    assert.throws(() => store.save(run), /RUNTIME_INVALID_STATE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an active predecessor cannot be relabeled as a fresh linked execution", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-links-active-"));
  let entered, release;
  const started = new Promise((r) => {
    entered = r;
  });
  const gate = new Promise((r) => {
    release = r;
  });
  const service = new RuntimeService(
    createServiceContext(async () => {
      entered();
      await gate;
      return true;
    }),
    new RunStore(root),
  );
  let running;
  try {
    running = service.run({ plan: { task_id: "audit", steps } }, exec());
    await started;
    const id = service.status({}, exec()).runs[0].runId;
    await assert.rejects(
      service.run(
        { plan: { task_id: "audit", previous_run_id: id, steps } },
        exec(),
      ),
      /RUNTIME_TASK_LINK_INVALID/,
    );
  } finally {
    release();
    await running;
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

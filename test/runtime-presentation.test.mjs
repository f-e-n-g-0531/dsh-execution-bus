import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import {
  ToolRuntime,
  assertSupportedJsonSchema,
  validateJsonSchemaValue,
} from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import { createScope } from "@deepseek-ai/dsh-scope";
import * as plugin from "../dist/plugin.js";
import { RuntimeService } from "../dist/runtime/service.js";
import { RuntimeExecutor } from "../dist/runtime/executor.js";
import { RunStore } from "../dist/runtime/store.js";
import { parsePlan } from "../dist/runtime/plan.js";
import {
  RUNTIME_OUTPUT_SCHEMAS,
  runProgress,
  runGuidance,
  runtimePresentationMeta,
  presentRuntimeResult,
} from "../dist/presentation.js";

const states = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
];
const step = (id, tool, state = "pending", error) => ({
  id,
  tool,
  state,
  attempts: state === "pending" ? 0 : 1,
  ...(error ? { error } : {}),
});
const record = (steps, extra = {}) => ({
  version: 1,
  runId: "run-12345678",
  ownerSessionId: "owner",
  state: "interrupted",
  createdAt: 10,
  updatedAt: 20,
  results: {},
  steps,
  ...extra,
});
const exec = (id = "owner") => ({
  agent: { id },
  callId: randomUUID(),
  signal: new AbortController().signal,
});

function serviceFixture(invoke = async () => ({ ok: true })) {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "xiaohe-presentation-service-"),
  );
  const store = new RunStore(root);
  const calls = [];
  const ctx = {
    tools: {
      async execute(call) {
        calls.push(call.name);
        return { isError: false, value: await invoke(call) };
      },
    },
  };
  const service = new RuntimeService(ctx, store);
  return {
    store,
    service,
    calls,
    async close() {
      await service.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function validate(name, value) {
  assert.deepEqual(
    validateJsonSchemaValue(RUNTIME_OUTPUT_SCHEMAS[name], value),
    [],
  );
}

test("progress counts every state independently; unknown is never counted as success", () => {
  const run = record(states.map((state, i) => step("s" + i, "read", state)));
  const before = structuredClone(run);
  assert.deepEqual(runProgress(run), {
    total: 6,
    pending: 1,
    running: 1,
    succeeded: 1,
    failed: 1,
    cancelled: 1,
    unknown: 1,
  });
  assert.deepEqual(run, before);
});

test("guidance distinguishes read recovery, unknown side effects and cancelled scheduling", () => {
  const read = record([step("a", "read", "running")]);
  assert.deepEqual(runGuidance(read).at(-1).suggestions, [
    { tool: "runtime_resume", input: { runId: read.runId } },
  ]);
  for (const tool of ["edit", "write", "pwsh"]) {
    for (const state of ["unknown", "running", "failed"]) {
      const run = record([
        step(
          "a",
          tool,
          state,
          state === "failed" ? "RUNTIME_INTERRUPTED" : undefined,
        ),
      ]);
      const before = structuredClone(run);
      const advice = runGuidance(run);
      assert.ok(advice.some((item) => item.code === "unknown_side_effect"));
      assert.equal(
        advice.some((item) =>
          item.suggestions?.some((s) => s.tool === "runtime_resume"),
        ),
        false,
      );
      assert.match(advice[0].message, /不要自动重发/);
      assert.deepEqual(run, before);
    }
  }
  const cancelled = runGuidance(
    record([step("a", "pwsh", "unknown")], { state: "cancelled" }),
  );
  assert.match(cancelled.find((g) => g.code === "cancelled").message, /不确认/);
  const failed = record([], {
    state: "failed",
    error: "RUNTIME_STORAGE_FAILED",
  });
  assert.ok(runGuidance(failed).some((g) => g.code === "storage_failure"));
});

test("Job advice uses only exact pwsh background receipts and never arbitrary result job IDs", () => {
  for (const kind of ["background", "promoted"]) {
    const run = record(
      [step("cmd", "pwsh", "unknown", "RUNTIME_BACKGROUND_UNSUPPORTED")],
      {
        state: "failed",
        results: {
          cmd: { value: { kind, jobId: "job-owned", command: "SECRET" } },
        },
      },
    );
    const before = structuredClone(run);
    const job = runGuidance(run).find((g) => g.code === "background_job");
    assert.equal(job.jobId, "job-owned");
    assert.deepEqual(job.suggestions, [
      { tool: "job_output", input: { job_id: "job-owned" } },
      { tool: "job_kill", input: { job_id: "job-owned" } },
    ]);
    assert.doesNotMatch(JSON.stringify(runGuidance(run)), /SECRET/);
    assert.deepEqual(run, before);
  }
  for (const tool of ["read", "grep", "write"]) {
    const run = record(
      [step("x", tool, "unknown", "RUNTIME_BACKGROUND_UNSUPPORTED")],
      {
        results: { x: { value: { kind: "promoted", jobId: "not-a-receipt" } } },
      },
    );
    assert.equal(
      runGuidance(run).some((g) => g.jobId),
      false,
    );
  }
  for (const value of [
    { kind: "promoted" },
    { kind: "promoted", jobId: "" },
    { kind: "foreground", jobId: "x" },
    null,
  ]) {
    const run = record(
      [step("x", "pwsh", "unknown", "RUNTIME_BACKGROUND_UNSUPPORTED")],
      { results: { x: { value } } },
    );
    assert.ok(
      runGuidance(run).some((g) => g.code === "background_job_unlocated"),
    );
  }
});

test("all output schemas use the host subset and accept old canonical output shapes", () => {
  for (const schema of Object.values(RUNTIME_OUTPUT_SCHEMAS))
    assertSupportedJsonSchema(schema);
  const old = {
    runId: "run-12345678",
    state: "succeeded",
    createdAt: 10,
    updatedAt: 20,
    durationMs: 10,
    steps: [step("a", "read", "succeeded")],
  };
  validate("runtime_run", { runId: old.runId, state: "running" });
  for (const name of [
    "runtime_run",
    "runtime_status",
    "runtime_resume",
    "runtime_cancel",
  ])
    validate(name, old);
  validate("runtime_result", {
    ...old,
    results: {
      a: { value: [null, "x", 1] },
      b: { truncated: true, bytes: 100000 },
    },
    finished: true,
  });
  validate("runtime_status", {
    runs: [{ runId: old.runId, state: old.state, updatedAt: 20, stepCount: 1 }],
    diagnostics: {
      invalidRecords: 0,
      oversizedRecords: 0,
      readFailures: 0,
      writeFailures: 0,
    },
  });
  assert.notDeepEqual(
    validateJsonSchemaValue(RUNTIME_OUTPUT_SCHEMAS.runtime_run, {
      runId: old.runId,
      state: "invented",
    }),
    [],
  );
});

test("owner-filtered summaries expose progress/advice without plan inputs or raw values; record v1 stays unchanged", async () => {
  const f = serviceFixture(async () => ({
    kind: "promoted",
    jobId: "job-private",
  }));
  try {
    const run = await f.service.run(
      {
        plan: {
          steps: [
            { id: "cmd", tool: "pwsh", input: { command: "SECRET-COMMAND" } },
            {
              id: "later",
              tool: "write",
              input: { content: "SECRET-CONTENT" },
              depends_on: ["cmd"],
            },
          ],
        },
      },
      exec(),
    );
    validate("runtime_run", run);
    assert.equal(run.state, "failed");
    assert.equal(run.progress.unknown, 1);
    assert.equal(run.progress.succeeded, 0);
    assert.equal(run.steps.find((s) => s.id === "later").attempts, 0);
    assert.ok(run.guidance.some((g) => g.jobId === "job-private"));
    const listed = f.service.status({}, exec());
    validate("runtime_status", listed);
    assert.deepEqual(listed.runs[0].progress, run.progress);
    const status = f.service.status({ runId: run.runId }, exec());
    assert.doesNotMatch(
      JSON.stringify(status),
      /SECRET|ownerSessionId|"results"/,
    );
    const result = f.service.result({ runId: run.runId }, exec());
    validate("runtime_result", result);
    assert.equal(result.results.cmd.value.jobId, "job-private");
    assert.deepEqual(f.calls, ["pwsh"]); // No implicit job_output/job_kill or dependent write.
    assert.deepEqual(f.service.status({}, exec("peer")).runs, []);
    for (const method of ["status", "result", "cancel"]) {
      assert.throws(
        () => f.service[method]({ runId: run.runId }, exec("peer")),
        /RUNTIME_NOT_FOUND/,
      );
    }
    await assert.rejects(
      f.service.resume({ runId: run.runId }, exec("peer")),
      /RUNTIME_NOT_FOUND/,
    );
    const stored = JSON.parse(readFileSync(f.store.pathFor(run.runId), "utf8"));
    assert.equal(stored.version, 1);
    assert.equal(Object.hasOwn(stored, "progress"), false);
    assert.equal(Object.hasOwn(stored, "guidance"), false);
    const meta = runtimePresentationMeta(
      { plan: { secret: "SECRET" } },
      result,
    );
    assert.match(meta.text, /unknown 1|job-private/);
    assert.doesNotMatch(meta.text, /SECRET/);
  } finally {
    await f.close();
  }
});

test("interrupted unknown writes remain non-replayable after presenting advice", async () => {
  const f = serviceFixture();
  try {
    const maker = new RuntimeExecutor(f.store, async () => ({}));
    const run = maker.createRun(
      "owner",
      parsePlan({
        steps: [
          { id: "write", tool: "write", input: { content: "x" } },
          { id: "pending", tool: "write", input: { content: "y" } },
        ],
      }),
    );
    run.state = "interrupted";
    run.finishedAt = run.updatedAt;
    run.steps[0].state = "unknown";
    run.steps[0].attempts = 1;
    run.steps[0].startedAt = run.createdAt;
    run.steps[0].finishedAt = run.updatedAt;
    f.store.save(run);
    const status = f.service.status({ runId: run.runId }, exec());
    assert.ok(status.guidance.some((g) => g.code === "unknown_side_effect"));
    const resumed = await f.service.resume({ runId: run.runId }, exec());
    validate("runtime_resume", resumed);
    assert.equal(resumed.state, "failed");
    assert.equal(resumed.steps[0].error, "RUNTIME_INTERRUPTED");
    assert.deepEqual(f.calls, []);
  } finally {
    await f.close();
  }
});

test("volatile storage failures still satisfy status/result schemas without exposing inputs", async () => {
  const f = serviceFixture(async () => {
    f.store.save = () => {
      throw Error("RUNTIME_STORAGE_FAILED");
    };
    return { payload: "PRIVATE-RAW" };
  });
  try {
    await assert.rejects(
      f.service.run(
        {
          plan: {
            steps: [
              { id: "a", tool: "read", input: { secret: "PRIVATE-INPUT" } },
            ],
          },
        },
        exec(),
      ),
      /RUNTIME_STORAGE_FAILED/,
    );
    const listed = f.service.status({}, exec());
    validate("runtime_status", listed);
    const runId = listed.runs[0].runId;
    const status = f.service.status({ runId }, exec());
    const result = f.service.result({ runId }, exec());
    validate("runtime_status", status);
    validate("runtime_result", result);
    assert.equal(status.error, "RUNTIME_STORAGE_FAILED");
    assert.ok(status.guidance.some((g) => g.code === "storage_failure"));
    assert.doesNotMatch(
      JSON.stringify(runtimePresentationMeta({}, result)),
      /PRIVATE/,
    );
    assert.deepEqual(f.service.status({}, exec("peer")).runs, []);
  } finally {
    await f.close();
  }
});

test("dedicated presentation replays pure metadata, preserves failure fallback and handles async/list values", () => {
  for (const value of [
    null,
    [],
    {},
    { runs: [] },
    { runId: "run-12345678", state: "running" },
  ]) {
    const meta = runtimePresentationMeta({}, value);
    const outcome = { isError: false, content: [], meta };
    assert.deepEqual(
      presentRuntimeResult({}, outcome),
      presentRuntimeResult({}, structuredClone(outcome)),
    );
  }
  assert.match(runtimePresentationMeta({}, { runs: [] }).text, /暂无运行/);
  assert.match(
    runtimePresentationMeta({}, { runId: "run-12345678", state: "running" })
      .text,
    /异步运行/,
  );
  assert.equal(
    presentRuntimeResult(
      {},
      { isError: true, content: [], meta: { text: "not authorized" } },
    ),
    undefined,
  );
  assert.equal(
    presentRuntimeResult({}, { isError: false, content: [] }),
    undefined,
  );
});

test("real host registration validates schemas and retains JSON renderer plus readable presentation metadata", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-presentation-host-"));
  const previous = process.env.XIAOHE_RUNTIME_DIR;
  process.env.XIAOHE_RUNTIME_DIR = root;
  const ctx = new Context();
  new SystemPrompt(ctx, {});
  new ToolRuntime(ctx, {});
  ctx.tools.register({
    name: "read",
    description: "stub",
    parameters: { type: "object" },
    output: { schema: {}, render: () => [] },
    async execute() {
      return { content: "RAW-PRIVATE-RESULT" };
    },
  });
  const agent = { id: "owner", session: { header: { cwd: process.cwd() } } };
  const scope = createScope(ctx, agent);
  agent.ctx = scope.ctx;
  try {
    plugin.apply(scope.ctx);
    const result = await ctx.tools.execute({
      name: "runtime_run",
      callId: randomUUID(),
      agent,
      arguments: {
        plan: { goal: "test", steps: [{ id: "a", tool: "read", input: {} }] },
      },
      signal: new AbortController().signal,
    });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.value.progress.succeeded, 1);
    assert.deepEqual(JSON.parse(result.content[0].text), result.value);
    assert.match(JSON.stringify(result.meta), /成功 1|succeeded/);
    assert.doesNotMatch(JSON.stringify(result.meta), /RAW-PRIVATE-RESULT/);
    validate("runtime_run", result.value);
    for (const [name, args] of [
      ["runtime_status", {}],
      ["runtime_status", { runId: result.value.runId }],
      ["runtime_result", { runId: result.value.runId }],
      ["runtime_cancel", { runId: result.value.runId }],
    ]) {
      const response = await ctx.tools.execute({
        name,
        arguments: args,
        callId: randomUUID(),
        agent,
        signal: new AbortController().signal,
      });
      assert.equal(response.isError, false, JSON.stringify(response));
      validate(name, response.value);
      assert.deepEqual(JSON.parse(response.content[0].text), response.value);
      assert.ok(presentRuntimeResult(args, response));
      assert.doesNotMatch(JSON.stringify(response.meta), /RAW-PRIVATE-RESULT/);
    }
  } finally {
    await scope.dispose();
    rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.XIAOHE_RUNTIME_DIR;
    else process.env.XIAOHE_RUNTIME_DIR = previous;
  }
});

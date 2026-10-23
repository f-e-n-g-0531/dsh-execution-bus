import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  loadRuntime,
  makeDag,
  nativeDag,
  runDagSample,
  measureBlocking,
  historyRecord,
  parseArgs,
  validateOptions,
  runBenchmark,
} from "../scripts/benchmark-runtime.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("test barrier timed out")), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("benchmark options are bounded, explicit capacity defaults include 1k/10k and interrupted-heavy histories", () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.suite, "dag");
  assert.deepEqual(defaults.sizes, [1000, 10000]);
  assert.deepEqual(defaults.interrupted, [0, 0.5, 0.9]);
  assert.deepEqual(
    parseArgs([
      "--suite",
      "capacity",
      "--sizes",
      "10",
      "--interrupted",
      "0,0.8",
      "--iterations",
      "1",
    ]).sizes,
    [10],
  );
  for (const options of [
    { iterations: 0 },
    { steps: 33 },
    { concurrency: [5] },
    { concurrency: [2, 2] },
    { seed: -1 },
    { unitMs: 101 },
    { sizes: [10001] },
    { interrupted: [1.1] },
    { sizes: [] },
    { suite: "install" },
    { command: "secret" },
  ])
    assert.throws(() => validateOptions(options), /INVALID_BENCHMARK_OPTIONS/);
  for (const argv of [
    ["--sizes", ""],
    ["--steps", "3.5"],
    ["--seed", "-1"],
    ["--sizes", "10,"],
    ["--suite", "dag", "--suite", "capacity"],
    ["--input", "secret"],
  ])
    assert.throws(() => parseArgs(argv), /INVALID_BENCHMARK_OPTIONS/);
});

test("seeded synthetic DAG is reproducible, valid and does not mutate options", async () => {
  const runtime = await loadRuntime();
  const options = { seed: 42, steps: 16, unitMs: 1, shape: "long-tail" };
  const raw = makeDag(options);
  assert.deepEqual(raw, makeDag(options));
  assert.notDeepEqual(raw, makeDag({ ...options, seed: 43 }));
  assert.equal(raw[0].input.durationMs, 20);
  assert.ok(
    raw
      .slice(8)
      .every((s) => s.depends_on.length > 0 && !s.depends_on.includes("s0")),
  );
  assert.equal(
    runtime.parsePlan({ steps: raw, concurrency: 4 }).steps.length,
    16,
  );
  assert.ok(
    makeDag({ ...options, shape: "capacity" }).every(
      (s) => s.depends_on.length === 0,
    ),
  );
  assert.equal(options.seed, 42);
});

test("native scheduler bounds concurrency, respects dependencies, and drains failures without launching pending work", async () => {
  const a = deferred(),
    b = deferred(),
    cStarted = deferred();
  const calls = [];
  let active = 0,
    peak = 0;
  const plan = {
    concurrency: 2,
    steps: [
      { id: "a", input: { id: "a" }, dependsOn: [] },
      { id: "b", input: { id: "b" }, dependsOn: [] },
      { id: "c", input: { id: "c" }, dependsOn: ["b"] },
    ],
  };
  const execution = nativeDag(plan, async (_, { id }) => {
    calls.push(id);
    active++;
    peak = Math.max(peak, active);
    try {
      if (id === "a") await a.promise;
      if (id === "b") await b.promise;
      if (id === "c") cStarted.resolve();
    } finally {
      active--;
    }
  });
  b.resolve();
  await bounded(cStarted.promise);
  assert.deepEqual(calls, ["a", "b", "c"]);
  assert.equal(peak, 2);
  a.resolve();
  assert.equal((await bounded(execution)).state, "succeeded");
  const failedCalls = [];
  const failure = await nativeDag(
    { ...plan, concurrency: 1 },
    async (_, { id }) => {
      failedCalls.push(id);
      throw Error("private-command-path");
    },
  );
  assert.equal(failure.state, "failed");
  assert.deepEqual(failedCalls, ["a"]);
});

test("actual runtime batch barrier differs from work-conserving native, without wall-time thresholds", async () => {
  const runtime = await loadRuntime();
  const gates = { slow: deferred(), fast: deferred() };
  const fastFinished = deferred(),
    childStarted = deferred();
  const calls = [];
  const steps = [
    { id: "slow", tool: "read", input: { id: "slow" } },
    { id: "fast", tool: "read", input: { id: "fast" } },
    { id: "child", tool: "read", input: { id: "child" }, depends_on: ["fast"] },
  ];
  const execution = runDagSample(
    runtime,
    steps,
    2,
    "runtime",
    async (_, { id }) => {
      calls.push(id);
      if (id === "child") childStarted.resolve();
      else await gates[id].promise;
      if (id === "fast") fastFinished.resolve();
      return { ok: true };
    },
  );
  gates.fast.resolve();
  await bounded(fastFinished.promise);
  // A turn boundary lets runStep publish fast success; slow remains deliberately blocked.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["slow", "fast"]);
  gates.slow.resolve();
  await bounded(childStarted.promise);
  const result = await bounded(execution);
  assert.equal(result.state, "succeeded");
  assert.equal(result.toolRequests, 3);
  assert.equal(result.toolSuccesses, 3);
  assert.equal(result.peakConcurrency, 2);
});

test("component samples retain tool failures and request counts separately, redact exception data", async () => {
  const runtime = await loadRuntime();
  const raw = makeDag({ steps: 4, unitMs: 1 });
  for (const arm of ["native", "runtime"]) {
    const result = await runDagSample(runtime, raw, 1, arm, async () => {
      throw Error("G:/private-business secret-command");
    });
    assert.equal(result.state, "failed");
    assert.equal(result.toolRequests, 1);
    assert.equal(result.toolSuccesses, 0);
    assert.equal(result.requestedSteps, 4);
    assert.ok(result.wallTimeMs >= 0);
    assert.doesNotMatch(
      JSON.stringify(result),
      /private-business|secret-command/,
    );
  }
});

test("short DAG benchmark exercises both real executor and native at equal concurrency without model metrics", async () => {
  const report = await runBenchmark({
    suite: "dag",
    iterations: 2,
    steps: 4,
    concurrency: [2],
    unitMs: 1,
    seed: 7,
  });
  assert.equal(report.dag.samples.length, 8);
  assert.match(report.environment.runtimeArtifactDigest, /^[a-f0-9]{64}$/);
  assert.equal(report.dag.summary.length, 4);
  assert.match(report.interpretation, /NOT model\/agent benefit/);
  assert.match(report.contracts.runtime, /batch barriers/);
  assert.match(report.contracts.native, /work-conserving/);
  assert.equal(report.capacity, undefined);
  for (const sample of report.dag.samples) {
    assert.equal(sample.state, "succeeded");
    assert.equal(sample.toolRequests, 4);
    assert.equal(sample.toolSuccesses, 4);
    assert.ok(sample.peakConcurrency <= 2);
    assert.ok(sample.toolLatencyMs.observed === 4);
    assert.ok(sample.wallTimeMs >= 0);
    assert.equal(sample.promptTokens, undefined);
  }
  for (const shape of ["capacity", "long-tail"]) {
    const samples = report.dag.samples.filter((s) => s.shape === shape);
    assert.deepEqual(
      samples.map((s) => s.arm),
      ["native", "runtime", "runtime", "native"],
    );
  }
});

test("ten-record prune retains unknown writes and deletes only terminal history", async (t) => {
  const runtime = await loadRuntime();
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-bench-retain-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new runtime.RunStore(root);
  for (let i = 0; i < 10; i++)
    store.save(historyRecord(runtime, i, i < 4 ? "interrupted" : "succeeded"));
  store.prune(2);
  const remaining = store.list(100);
  assert.equal(remaining.length, 6);
  assert.equal(remaining.filter((r) => r.state === "succeeded").length, 2);
  assert.equal(
    remaining.filter(
      (r) => r.state === "interrupted" && r.steps[0].state === "unknown",
    ).length,
    4,
  );
});

test("benchmark CLI writes machine-readable component report with no paths", () => {
  const cli = spawnSync(
    process.execPath,
    [
      "scripts/benchmark-runtime.mjs",
      "--suite",
      "capacity",
      "--sizes",
      "10",
      "--interrupted",
      "0.8",
      "--iterations",
      "1",
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(cli.status, 0, cli.stderr);
  const report = JSON.parse(cli.stdout);
  assert.equal(report.capacity.samples.length, 3);
  assert.match(report.interpretation, /NOT model/);
  assert.ok(!cli.stdout.includes(process.cwd()));
  assert.ok(!cli.stdout.includes(os.tmpdir()));
  const failed = spawnSync(
    process.execPath,
    ["scripts/benchmark-runtime.mjs", "--secret-command", "G:/secret-business"],
    { encoding: "utf8" },
  );
  assert.equal(failed.status, 1);
  assert.doesNotMatch(failed.stderr, /secret-command|secret-business|stack/);
});

test("blocking probe captures synchronous operations and preserves failures", async () => {
  const result = await measureBlocking(() => 42);
  assert.equal(result.value, 42);
  assert.equal(result.failed, false);
  assert.ok(result.operationMs >= 0);
  assert.ok(result.eventLoopProbeDelayMs >= result.operationMs);
  const failed = await measureBlocking(() => {
    throw Error("secret");
  });
  assert.equal(failed.failed, true);
  assert.doesNotMatch(JSON.stringify(failed), /secret/);
});

test("ten-record disk capacity benchmark measures list/prune/startup and never resumes unknown writes", async () => {
  const runtime = await loadRuntime();
  const report = await runBenchmark(
    { suite: "capacity", iterations: 1, sizes: [10], interrupted: [0, 0.8] },
    runtime,
  );
  assert.equal(report.capacity.samples.length, 6);
  assert.equal(report.capacity.summary.length, 6);
  assert.equal(report.dag, undefined);
  for (const sample of report.capacity.samples) {
    assert.equal(sample.failed, false);
    assert.ok(sample.operationMs >= 0);
    assert.ok(sample.eventLoopProbeDelayMs >= sample.operationMs);
    assert.equal(sample.remaining, 10); // retention budget=100; interrupted never consumes it
    assert.equal(
      sample.states.succeeded,
      sample.recoverableRatio === 0 ? 10 : 2,
    );
    if (sample.recoverableRatio === 0.8) {
      if (sample.operation === "startup") {
        assert.equal(sample.states.running, 0);
        assert.equal(sample.states.interrupted, 8);
        assert.equal(sample.unknownSteps, 8);
      } else {
        assert.equal(sample.states.running, 4);
        assert.equal(sample.states.interrupted, 4);
        assert.equal(sample.unknownSteps, 4);
      }
    }
  }
  assert.match(report.contracts.capacity, /setup excluded/);
  assert.match(report.contracts.eventLoop, /not CPU time/);
  const interrupted = historyRecord(runtime, 1, "interrupted");
  assert.equal(interrupted.steps[0].tool, "write");
  assert.equal(interrupted.steps[0].state, "unknown");
});

#!/usr/bin/env node
/** Offline component benchmark, NOT model/agent benefit evidence.
 * Requires existing dist from the build owner; never builds, installs or invokes host tools.
 * node scripts/benchmark-runtime.mjs --suite dag --iterations 3 --steps 16 --concurrency 2,4 --seed 1
 * node scripts/benchmark-runtime.mjs --suite capacity --sizes 1000,10000 --interrupted 0,0.5,0.9
 * Capacity setup is excluded from timings; each mutating operation gets fresh history.
 * Default suite=dag (short); capacity/all is explicit because 10k disk records are costly.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  setTimeout as delay,
  setImmediate as nextTurn,
} from "node:timers/promises";
import { statistics } from "./pilot-report.mjs";

const fail = () => {
  throw Error("INVALID_BENCHMARK_OPTIONS");
};
const integer = (n, min, max) =>
  Number.isSafeInteger(n) && n >= min && n <= max;
const unique = (values) => new Set(values).size === values.length;
export function validateOptions(options = {}) {
  if (
    Object.keys(options).some(
      (k) =>
        ![
          "suite",
          "iterations",
          "steps",
          "concurrency",
          "seed",
          "unitMs",
          "sizes",
          "interrupted",
        ].includes(k),
    )
  )
    fail();
  const out = {
    suite: "dag",
    iterations: 3,
    steps: 16,
    concurrency: [2, 4],
    seed: 1,
    unitMs: 2,
    sizes: [1000, 10000],
    interrupted: [0, 0.5, 0.9],
    ...options,
  };
  if (
    !["dag", "capacity", "all"].includes(out.suite) ||
    !integer(out.iterations, 1, 20) ||
    !integer(out.steps, 4, 32) ||
    !integer(out.seed, 0, 0xffffffff) ||
    !integer(out.unitMs, 1, 100) ||
    !Array.isArray(out.concurrency) ||
    !out.concurrency.length ||
    !unique(out.concurrency) ||
    !out.concurrency.every((n) => integer(n, 1, 4)) ||
    !Array.isArray(out.sizes) ||
    !out.sizes.length ||
    out.sizes.length > 4 ||
    !unique(out.sizes) ||
    !out.sizes.every((n) => integer(n, 1, 10000)) ||
    !Array.isArray(out.interrupted) ||
    !out.interrupted.length ||
    out.interrupted.length > 4 ||
    !unique(out.interrupted) ||
    !out.interrupted.every((n) => Number.isFinite(n) && n >= 0 && n <= 1)
  )
    fail();
  return out;
}
export function parseArgs(argv) {
  const out = {};
  const lists = {
    "--concurrency": "concurrency",
    "--sizes": "sizes",
    "--interrupted": "interrupted",
  };
  const numbers = {
    "--iterations": "iterations",
    "--steps": "steps",
    "--seed": "seed",
    "--unit-ms": "unitMs",
  };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[++i];
    if (seen.has(flag) || !value || value.startsWith("--")) fail();
    seen.add(flag);
    if (flag === "--suite") out.suite = value;
    else if (Object.hasOwn(lists, flag)) {
      if (
        !value.split(",").every((n) => /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(n))
      )
        fail();
      out[lists[flag]] = value.split(",").map(Number);
    } else if (Object.hasOwn(numbers, flag) && /^(0|[1-9][0-9]*)$/.test(value))
      out[numbers[flag]] = Number(value);
    else fail();
  }
  return validateOptions(out);
}

// Known local execution closure; optional modules preserve pre-Agent build comparisons.
export const RUNTIME_ARTIFACT_FILES = Object.freeze([
  "runtime/executor.js", "runtime/store.js", "runtime/plan.js", "runtime/service.js",
  "error-codes.js", "presentation.js", "runtime/retry.js", "runtime/agent.js",
  "runtime/agent-report.js", "runtime/agent-trace.js", "runtime/worker-quota.js",
]);
export function runtimeArtifactDigest(dist, read = readFileSync) {
  const root = dist instanceof URL ? dist : pathToFileURL(path.resolve(dist) + path.sep);
  const hash = createHash("sha256");
  for (const [index, name] of RUNTIME_ARTIFACT_FILES.entries()) {
    hash.update(name + "\0");
    let bytes;
    try { bytes = read(new URL(name, root)); } catch (error) {
      if (index < 6 || error?.code !== "ENOENT") throw error;
      hash.update("missing\0");
      continue;
    }
    hash.update("present\0" + bytes.length + "\0").update(bytes);
  }
  return hash.digest("hex");
}

export async function loadRuntime() {
  try {
    const [executor, store, plan, service] = await Promise.all([
      import("../dist/runtime/executor.js"),
      import("../dist/runtime/store.js"),
      import("../dist/runtime/plan.js"),
      import("../dist/runtime/service.js"),
    ]);
    const artifactDigest = runtimeArtifactDigest(new URL("../dist/", import.meta.url));
    return {
      ...executor,
      ...store,
      ...plan,
      ...service,
      artifactDigest,
    };
  } catch {
    throw Error(
      "BENCHMARK_RUNTIME_UNAVAILABLE: ask the build owner to prepare dist",
    );
  }
}

/** Seeded, read-only synthetic calls only. The first slow root exposes batch barriers. */
export function makeDag({
  steps = 16,
  seed = 1,
  unitMs = 2,
  shape = "long-tail",
} = {}) {
  if (
    !integer(steps, 4, 32) ||
    !integer(seed, 0, 0xffffffff) ||
    !integer(unitMs, 1, 100) ||
    !["capacity", "long-tail"].includes(shape)
  )
    fail();
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const roots = Math.floor(steps / 2);
  return Array.from({ length: steps }, (_, i) => ({
    id: "s" + i,
    tool: "read",
    input: {
      index: i,
      durationMs:
        unitMs * (shape === "long-tail" && i === 0 ? 20 : 1 + (random() % 3)),
    },
    // Independent capacity plan vs a long root alongside short dependency chains.
    depends_on:
      shape === "capacity" || i < roots
        ? []
        : ["s" + (1 + ((i - roots) % (roots - 1)))],
    retry: 0,
    timeout_ms: 600000,
  }));
}

/** Work-conserving native bounded Promise DAG: no persistence/retry/recovery. */
export async function nativeDag(plan, invoke) {
  const pending = [...plan.steps];
  const done = new Set();
  const active = new Map();
  let failed = false;
  while (pending.length || active.size) {
    while (!failed && active.size < plan.concurrency) {
      const index = pending.findIndex((step) =>
        step.dependsOn.every((id) => done.has(id)),
      );
      if (index < 0) break;
      const step = pending.splice(index, 1)[0];
      const promise = Promise.resolve()
        .then(() => invoke(step.tool, step.input))
        .then(
          () => ({ id: step.id, ok: true }),
          () => ({ id: step.id, ok: false }),
        );
      active.set(step.id, promise);
    }
    if (!active.size) break;
    const result = await Promise.race(active.values());
    active.delete(result.id);
    if (result.ok) done.add(result.id);
    else failed = true;
  }
  return {
    state: failed || pending.length ? "failed" : "succeeded",
    completed: done.size,
  };
}

async function withTemp(prefix, run) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  // Deletion target is only the exact root allocated above, never caller-supplied.
  try {
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
export async function runDagSample(
  runtime,
  rawSteps,
  concurrency,
  arm,
  invokeOverride,
) {
  if (!["native", "runtime"].includes(arm)) fail();
  const plan = runtime.parsePlan({ steps: rawSteps, concurrency });
  return withTemp("xiaohe-bench-dag-", async (root) => {
    let active = 0,
      peak = 0,
      requests = 0,
      successes = 0;
    const latencies = [];
    const invoke = async (tool, input, signal) => {
      active++;
      requests++;
      peak = Math.max(peak, active);
      const start = performance.now();
      try {
        const result = invokeOverride
          ? await invokeOverride(tool, input, signal)
          : await delay(
              input.durationMs,
              { ok: true },
              signal ? { signal } : undefined,
            );
        successes++;
        return result;
      } finally {
        active--;
        latencies.push(performance.now() - start);
      }
    };
    const start = performance.now();
    let state = "failed";
    try {
      if (arm === "native") state = (await nativeDag(plan, invoke)).state;
      else {
        const executor = new runtime.RuntimeExecutor(
          new runtime.RunStore(root),
          invoke,
        );
        const record = executor.createRun("benchmark-owner", plan);
        state = (await executor.execute(record)).state;
      }
    } catch {
      /* failed sample is retained without exception/command/path */
    }
    const wallTimeMs = performance.now() - start;
    return {
      arm,
      state,
      wallTimeMs,
      toolRequests: requests,
      toolSuccesses: successes,
      peakConcurrency: peak,
      requestedSteps: plan.steps.length,
      toolLatencyMs: statistics(latencies),
      successfulThroughputPerSecond:
        wallTimeMs > 0 ? (successes * 1000) / wallTimeMs : null,
    };
  });
}

export async function benchmarkDags(runtime, options) {
  const samples = [];
  const plans = [];
  for (const shape of ["capacity", "long-tail"]) {
    const raw = makeDag({ ...options, shape });
    const planDigest = createHash("sha256")
      .update(JSON.stringify(raw))
      .digest("hex");
    plans.push({ shape, planDigest });
    for (const concurrency of options.concurrency) {
      for (let iteration = 0; iteration < options.iterations; iteration++) {
        // Alternate order to reduce first-run/cache bias; not statistical randomization.
        const order =
          iteration % 2 ? ["runtime", "native"] : ["native", "runtime"];
        for (const arm of order)
          samples.push({
            shape,
            concurrency,
            iteration,
            ...(await runDagSample(runtime, raw, concurrency, arm)),
          });
      }
    }
  }
  const summary = [];
  for (const shape of ["capacity", "long-tail"])
    for (const concurrency of options.concurrency) {
      for (const arm of ["native", "runtime"]) {
        const rows = samples.filter(
          (s) =>
            s.shape === shape && s.concurrency === concurrency && s.arm === arm,
        );
        summary.push({
          shape,
          concurrency,
          arm,
          attempted: rows.length,
          succeeded: rows.filter((s) => s.state === "succeeded").length,
          failed: rows.filter((s) => s.state !== "succeeded").length,
          wallTimeMs: statistics(rows.map((s) => s.wallTimeMs)),
        });
      }
    }
  return { plans, samples, summary };
}

/** A queued immediate cannot run during synchronous disk scans. Not CPU time or a histogram. */
export async function measureBlocking(operation) {
  await nextTurn();
  const scheduled = performance.now();
  const probe = new Promise((resolve) =>
    setImmediate(() => resolve(performance.now() - scheduled)),
  );
  const start = performance.now();
  let value,
    failed = false;
  try {
    value = operation();
  } catch {
    failed = true;
  }
  const operationMs = performance.now() - start;
  return { operationMs, eventLoopProbeDelayMs: await probe, failed, value };
}

// Small synthetic record with explicit unknown write side effect for recoverable history.
export function historyRecord(runtime, i, state) {
  if (!["succeeded", "interrupted", "running"].includes(state)) fail();
  const terminal = state === "succeeded";
  const t = 1700000000000 + i;
  const plan = runtime.parsePlan({
    steps: [{ id: "synthetic", tool: "write", input: {} }],
    concurrency: 1,
  });
  return {
    version: 1,
    runId: "run-bench-" + String(i).padStart(8, "0"),
    ownerSessionId: "benchmark-owner",
    plan,
    state,
    steps: [
      {
        id: "synthetic",
        tool: "write",
        state: terminal
          ? "succeeded"
          : state === "running"
            ? "running"
            : "unknown",
        attempts: 1,
        startedAt: t,
        ...(state === "running" ? {} : { finishedAt: t + 1 }),
      },
    ],
    results: terminal ? { synthetic: { value: { ok: true } } } : {},
    createdAt: t,
    updatedAt: t + 1,
    ...(state === "running" ? {} : { finishedAt: t + 1 }),
  };
}

export async function benchmarkCapacity(runtime, options) {
  const samples = [];
  for (const size of options.sizes)
    for (const ratio of options.interrupted) {
      for (let iteration = 0; iteration < options.iterations; iteration++) {
        for (const operation of ["list", "prune", "startup"]) {
          samples.push(
            ...(await withTemp("xiaohe-bench-history-", async (root) => {
              const setupStore = new runtime.RunStore(root);
              const recoverable = Math.floor(size * ratio);
              // Half already interrupted, half abandoned running: startup must preserve unknown.
              const existingInterrupted = Math.ceil(recoverable / 2);
              for (let i = 0; i < size; i++)
                setupStore.save(
                  historyRecord(
                    runtime,
                    i,
                    i < existingInterrupted
                      ? "interrupted"
                      : i < recoverable
                        ? "running"
                        : "succeeded",
                  ),
                );
              // Unique fresh history/root; setup uses saves, not list. A new instance alone
              // does NOT isolate module-level metadata caches; OS file cache is NOT flushed.
              const store = new runtime.RunStore(root);
              let service;
              const measured = await measureBlocking(() => {
                if (operation === "list")
                  return store.list(20, "benchmark-owner").length;
                if (operation === "prune") {
                  store.prune(100);
                  return null;
                }
                service = new runtime.RuntimeService({}, store);
                return null;
              });
              // One immediate second list on the same instance, before verification scans.
              const warm =
                operation === "list"
                  ? await measureBlocking(
                      () => store.list(20, "benchmark-owner").length,
                    )
                  : null;
              try {
                const remaining = store.list(Number.MAX_SAFE_INTEGER);
                const states = Object.fromEntries(
                  ["succeeded", "running", "interrupted"].map((s) => [
                    s,
                    remaining.filter((r) => r.state === s).length,
                  ]),
                );
                const context = {
                  size,
                  recoverableRatio: ratio,
                  initialInterrupted: existingInterrupted,
                  initialAbandonedRunning: recoverable - existingInterrupted,
                  iteration,
                  operation,
                  remaining: remaining.length,
                  states,
                  unknownSteps: remaining.reduce(
                    (n, r) =>
                      n + r.steps.filter((s) => s.state === "unknown").length,
                    0,
                  ),
                };
                const sample = (op, m, cacheState) => ({
                  ...context,
                  operation: op,
                  cacheState,
                  operationMs: m.operationMs,
                  eventLoopProbeDelayMs: m.eventLoopProbeDelayMs,
                  failed: m.failed,
                  returnedRecords: m.value ?? null,
                });
                return [
                  sample(
                    operation,
                    measured,
                    "fresh-history-root-first-operation",
                  ),
                  ...(warm
                    ? [sample("warm-list", warm, "same-instance-second-read")]
                    : []),
                ];
              } finally {
                if (service) await service.dispose();
              }
            })),
          );
        }
      }
    }
  return {
    samples,
    summary: options.sizes.flatMap((size) =>
      options.interrupted.flatMap((ratio) =>
        ["list", "warm-list", "prune", "startup"].map((operation) => {
          const rows = samples.filter(
            (s) =>
              s.size === size &&
              s.recoverableRatio === ratio &&
              s.operation === operation,
          );
          return {
            size,
            recoverableRatio: ratio,
            operation,
            attempted: rows.length,
            failed: rows.filter((s) => s.failed).length,
            independentHistories: new Set(rows.map((s) => s.iteration)).size,
            operationMs: statistics(
              rows.filter((s) => !s.failed).map((s) => s.operationMs),
              rows.length,
            ),
            eventLoopProbeDelayMs: statistics(
              rows.filter((s) => !s.failed).map((s) => s.eventLoopProbeDelayMs),
              rows.length,
            ),
          };
        }),
      ),
    ),
  };
}

/** Include every local statistics dependency, not only the entry script. */
export function benchmarkAlgorithmDigest(read = readFileSync) {
  const hash = createHash("sha256");
  for (const name of ["benchmark-runtime.mjs", "pilot-report.mjs"]) {
    hash.update(name + "\0").update(read(new URL(name, import.meta.url)));
  }
  return hash.digest("hex");
}

export async function runBenchmark(options = {}, runtime) {
  const config = validateOptions(options);
  const modules = runtime ?? (await loadRuntime());
  const report = {
    version: 1,
    kind: "runtime-component-benchmark",
    config,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      runtimeArtifactDigest: modules.artifactDigest ?? null,
      benchmarkAlgorithmDigest: benchmarkAlgorithmDigest(),
    },
    interpretation:
      "synthetic local component benchmark; NOT model/agent benefit evidence; timings are machine/load dependent",
    contracts: {
      native:
        "work-conserving bounded Promise DAG; no durability/recovery; same concurrency and synthetic tool work",
      runtime:
        "real RuntimeExecutor with disk RunStore; batch barriers wait for all siblings before next ready batch; includes checkpoints",
      capacity:
        "fresh synthetic history/root per operation/iteration; setup excluded; list=first list after setup saves, warm-list=same-instance second read before verification; new instances do not isolate module metadata, other roots may be cached; neither is OS-cold; iterations are independent histories, list/warm-list are paired not independent; startup=RuntimeService constructor including markInterrupted and prune(100); no host execution; failed samples remain but missing from timing summaries",
      eventLoop:
        "queued setImmediate wall delay, including scheduler baseline and synchronous blocking; not CPU time, isolated attribution, or lag histogram",
      reproducibility:
        "seed fixes workload/digests, not elapsed time; existing dist is used without rebuilding; no model/token metrics synthesized",
    },
  };
  if (config.suite !== "capacity")
    report.dag = await benchmarkDags(modules, config);
  if (config.suite !== "dag")
    report.capacity = await benchmarkCapacity(modules, config);
  return report;
}
export async function main(argv = process.argv.slice(2), emit = console.log) {
  const result = await runBenchmark(parseArgs(argv));
  emit(JSON.stringify(result, null, 2));
  return result;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch(() => {
    console.error(
      "BENCHMARK_FAILED: check options and existing dist; no automatic build/install",
    );
    process.exitCode = 1;
  });
}

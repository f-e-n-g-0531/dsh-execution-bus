#!/usr/bin/env node
/** Development-only trusted-build comparison. No build/install and no OS sandbox. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  runBenchmark,
  benchmarkAlgorithmDigest,
  runtimeArtifactDigest,
} from "../scripts/benchmark-runtime.mjs";

const SELF = fileURLToPath(import.meta.url);
const MODULES = ["executor", "store", "plan", "service"];
// Shared digest includes the known local execution closure, including optional legacy modules.
const OPERATIONS = ["list", "warm-list", "prune", "startup"];
const MAX_OUTPUT = 1024 * 1024;
const integer = (n, lo, hi) => Number.isSafeInteger(n) && n >= lo && n <= hi;
const finite = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
const object = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
const fail = (code = "INVALID_COMPARISON_OPTIONS") => {
  throw Error(code);
};
const closed = (o, keys) =>
  object(o) &&
  Object.keys(o).length === keys.length &&
  keys.every((k) => Object.hasOwn(o, k));

export function validateComparisonOptions(raw = {}) {
  const keys = [
    "before",
    "after",
    "sizes",
    "interrupted",
    "iterations",
    "timeoutMs",
  ];
  if (!object(raw) || Object.keys(raw).some((k) => !keys.includes(k))) fail();
  const out = {
    sizes: [10],
    interrupted: [0.5],
    iterations: 2,
    timeoutMs: 60000,
    ...raw,
  };
  for (const arm of ["before", "after"]) {
    if (
      typeof out[arm] !== "string" ||
      !out[arm].trim() ||
      out[arm].includes("\0")
    )
      fail();
    out[arm] = path.resolve(out[arm]);
  }
  if (!integer(out.iterations, 1, 10) || !integer(out.timeoutMs, 1000, 600000))
    fail();
  for (const key of ["sizes", "interrupted"]) {
    const list = out[key];
    if (
      !Array.isArray(list) ||
      !list.length ||
      list.length > 4 ||
      new Set(list).size !== list.length
    )
      fail();
    if (
      !list.every((n) =>
        key === "sizes" ? integer(n, 1, 10000) : finite(n) && n <= 1,
      )
    )
      fail();
    out[key] = [...list];
  }
  if (out.sizes.length * out.interrupted.length * out.iterations * 2 > 256)
    fail();
  return out;
}

export function parseComparisonArgs(argv) {
  if (!Array.isArray(argv)) fail();
  const flags = {
    "--before": "before",
    "--after": "after",
    "--sizes": "sizes",
    "--interrupted": "interrupted",
    "--iterations": "iterations",
    "--timeout-ms": "timeoutMs",
  };
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = flags[argv[i]],
      value = argv[i + 1];
    if (
      !key ||
      Object.hasOwn(out, key) ||
      typeof value !== "string" ||
      !value ||
      value.startsWith("--")
    )
      fail();
    if (key === "before" || key === "after") out[key] = value;
    else {
      const parts = value.split(",");
      if (parts.some((p) => !p.trim())) fail();
      if (key === "sizes" || key === "interrupted")
        out[key] = parts.map(Number);
      else {
        if (parts.length !== 1) fail();
        out[key] = Number(value);
      }
    }
  }
  return validateComparisonOptions(out);
}

const artifactDigest = runtimeArtifactDigest;
function dependencyDigests() {
  const out = {};
  for (const [name, url] of [
    ["runner", import.meta.url],
    ["benchmark", new URL("../scripts/benchmark-runtime.mjs", import.meta.url)],
    ["pilot", new URL("../scripts/pilot-report.mjs", import.meta.url)],
  ])
    out[name] = createHash("sha256")
      .update(readFileSync(new URL(url)))
      .digest("hex");
  return out;
}

// Strict projection: neither worker metadata nor injected receipt strings are echoed.
function validateReceipt(receipt, input, algorithmDigest) {
  const keys = [
    "version",
    "kind",
    "arm",
    "size",
    "ratio",
    "iteration",
    "processId",
    "artifactDigest",
    "algorithmDigest",
    "samples",
  ];
  if (
    !closed(receipt, keys) ||
    receipt.version !== 1 ||
    receipt.kind !== "capacity-worker" ||
    receipt.arm !== input.arm ||
    receipt.size !== input.size ||
    receipt.ratio !== input.ratio ||
    receipt.iteration !== input.iteration ||
    !integer(receipt.processId, 1, Number.MAX_SAFE_INTEGER) ||
    receipt.artifactDigest !== input.artifactDigest ||
    receipt.algorithmDigest !== algorithmDigest ||
    !Array.isArray(receipt.samples) ||
    receipt.samples.length !== 4
  )
    fail("INVALID_RECEIPT");
  const recoverable = Math.floor(input.size * input.ratio);
  const interrupted = Math.ceil(recoverable / 2);
  const seen = new Set();
  const samples = receipt.samples.map((s) => {
    if (
      !object(s) ||
      !OPERATIONS.includes(s.operation) ||
      seen.has(s.operation)
    )
      fail("INVALID_RECEIPT");
    seen.add(s.operation);
    if (s.failed === true) fail("SAMPLE_FAILED");
    const startup = s.operation === "startup";
    const pruned = startup || s.operation === "prune";
    const succeeded = pruned
      ? Math.min(100, input.size - recoverable)
      : input.size - recoverable;
    const states = {
      succeeded,
      running: startup ? 0 : recoverable - interrupted,
      interrupted: startup ? recoverable : interrupted,
    };
    const expectedCache =
      s.operation === "warm-list"
        ? "same-instance-second-read"
        : "fresh-history-root-first-operation";
    if (
      s.size !== input.size ||
      s.recoverableRatio !== input.ratio ||
      s.iteration !== 0 ||
      s.initialInterrupted !== interrupted ||
      s.initialAbandonedRunning !== recoverable - interrupted ||
      s.failed !== false ||
      !finite(s.operationMs) ||
      !finite(s.eventLoopProbeDelayMs) ||
      s.cacheState !== expectedCache ||
      s.remaining !== succeeded + recoverable ||
      !closed(s.states, ["succeeded", "running", "interrupted"]) ||
      Object.keys(states).some((k) => s.states[k] !== states[k]) ||
      s.unknownSteps !== (startup ? recoverable : interrupted) ||
      s.returnedRecords !==
        (["list", "warm-list"].includes(s.operation)
          ? Math.min(20, input.size)
          : null)
    )
      fail("INVALID_RECEIPT");
    return {
      size: input.size,
      recoverableRatio: input.ratio,
      initialInterrupted: interrupted,
      initialAbandonedRunning: recoverable - interrupted,
      iteration: 0,
      operation: s.operation,
      remaining: s.remaining,
      states,
      unknownSteps: s.unknownSteps,
      cacheState: expectedCache,
      operationMs: s.operationMs,
      eventLoopProbeDelayMs: s.eventLoopProbeDelayMs,
      failed: false,
      returnedRecords: s.returnedRecords,
    };
  });
  return {
    processId: receipt.processId,
    samples: OPERATIONS.map((op) => samples.find((s) => s.operation === op)),
  };
}

async function defaultRunChild(input) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !["NODE_OPTIONS", "NODE_PATH"].includes(k.toUpperCase()),
    ),
  );
  const result = spawnSync(process.execPath, [SELF, "--worker"], {
    shell: false,
    env,
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: input.timeoutMs,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    // spawnSync does not inherit process.execArgv; only the two fixed arguments above run.
  });
  if (result.error?.code === "ETIMEDOUT") fail("TIMEOUT");
  if (result.error?.code === "ENOBUFS") fail("OUTPUT_LIMIT");
  if (result.signal) fail("CHILD_SIGNAL");
  if (result.error || result.status !== 0) fail("CHILD_EXIT");
  if (
    Buffer.byteLength(result.stdout ?? "") > MAX_OUTPUT ||
    Buffer.byteLength(result.stderr ?? "") > MAX_OUTPUT
  )
    fail("OUTPUT_LIMIT");
  if (result.stderr) fail("CHILD_STDERR");
  let receipt;
  try {
    receipt = JSON.parse(result.stdout);
  } catch {
    fail("INVALID_JSON");
  }
  // PID equality is a consistency check, not proof of OS isolation/authenticity.
  if (receipt?.processId !== result.pid) fail("INVALID_RECEIPT");
  return receipt;
}

const mean = (values) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b),
    i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
};
export function summarizeComparison(attempts) {
  const groups = new Map();
  for (const attempt of attempts) {
    const key = JSON.stringify([attempt.size, attempt.ratio]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(attempt);
  }
  return [...groups.values()].flatMap((rows) =>
    OPERATIONS.map((operation) => {
      const { size, ratio } = rows[0];
      const iterations = [...new Set(rows.map((r) => r.iteration))];
      const pairs = iterations.map((iteration) => {
        const pair = rows.filter((r) => r.iteration === iteration);
        const before = pair.find((r) => r.arm === "before"),
          after = pair.find((r) => r.arm === "after");
        const ok =
          pair.length === 2 &&
          before?.state === "succeeded" &&
          after?.state === "succeeded";
        const b = ok
          ? before.samples.find((s) => s.operation === operation)?.operationMs
          : null;
        const a = ok
          ? after.samples.find((s) => s.operation === operation)?.operationMs
          : null;
        const valid = ok && finite(b) && finite(a);
        return {
          iteration,
          state: valid ? "succeeded" : "failed",
          beforeMs: valid ? b : null,
          afterMs: valid ? a : null,
          deltaMs: valid ? a - b : null,
          changePercent: valid && b > 0 ? ((a - b) / b) * 100 : null,
        };
      });
      const successful = pairs.filter((p) => p.state === "succeeded");
      const percentages = successful
        .map((p) => p.changePercent)
        .filter((n) => n !== null);
      return {
        size,
        ratio,
        operation,
        attemptedPairs: pairs.length,
        succeededPairs: successful.length,
        failedPairs: pairs.length - successful.length,
        percentagePairs: percentages.length,
        missingPercentPairs: pairs.length - percentages.length,
        beforeMs: mean(successful.map((p) => p.beforeMs)),
        afterMs: mean(successful.map((p) => p.afterMs)),
        deltaMs: mean(successful.map((p) => p.deltaMs)),
        changePercent: mean(percentages),
        beforeMedianMs: median(successful.map((p) => p.beforeMs)),
        afterMedianMs: median(successful.map((p) => p.afterMs)),
        pairedMedianChangePercent: median(percentages),
        pairs,
      };
    }),
  );
}

export async function runComparison(
  options,
  { runChild = defaultRunChild } = {},
) {
  const config = validateComparisonOptions(options);
  if (typeof runChild !== "function") fail();
  let digests, dependencies, algorithmDigest;
  try {
    digests = {
      before: artifactDigest(config.before),
      after: artifactDigest(config.after),
    };
    dependencies = dependencyDigests();
    algorithmDigest = benchmarkAlgorithmDigest();
  } catch {
    fail("COMPARISON_ARTIFACT_UNAVAILABLE");
  }
  const attempts = [];
  let pairIndex = 0;
  for (const size of config.sizes)
    for (const ratio of config.interrupted)
      for (let iteration = 0; iteration < config.iterations; iteration++) {
        const order =
          pairIndex++ % 2 ? ["after", "before"] : ["before", "after"];
        for (const arm of order) {
          const input = {
            arm,
            size,
            ratio,
            iteration,
            dist: config[arm],
            timeoutMs: config.timeoutMs,
            artifactDigest: digests[arm],
          };
          const start = performance.now();
          const attempt = {
            arm,
            size,
            ratio,
            iteration,
            sequence: attempts.length,
            state: "failed",
            failureCode: null,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            wallTimeMs: null,
            processId: null,
            artifactDigest: digests[arm],
            algorithmDigest: null,
            cleanup: "unknown",
            samples: null,
          };
          try {
            const assertStableDependencies = () => {
              const current = dependencyDigests();
              if (
                Object.keys(dependencies).some(
                  (key) => current[key] !== dependencies[key],
                )
              )
                fail("DEPENDENCY_CHANGED");
            };
            assertStableDependencies();
            const receipt = await runChild(input);
            assertStableDependencies();
            const clean = validateReceipt(receipt, input, algorithmDigest);
            Object.assign(attempt, clean, {
              state: "succeeded",
              algorithmDigest,
              cleanup: "completed",
            });
          } catch (error) {
            const codes = [
              "TIMEOUT",
              "OUTPUT_LIMIT",
              "CHILD_SIGNAL",
              "CHILD_EXIT",
              "CHILD_STDERR",
              "INVALID_JSON",
              "INVALID_RECEIPT",
              "SAMPLE_FAILED",
              "DEPENDENCY_CHANGED",
            ];
            attempt.failureCode = codes.includes(error?.message)
              ? error.message
              : "CHILD_FAILED";
          }
          attempt.finishedAt = new Date().toISOString();
          attempt.wallTimeMs = performance.now() - start;
          attempts.push(attempt);
        }
      }
  return {
    version: 1,
    kind: "capacity-comparison",
    config: {
      sizes: config.sizes,
      interrupted: config.interrupted,
      iterations: config.iterations,
      timeoutMs: config.timeoutMs,
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      artifactDigests: digests,
      algorithmDigest,
      dependencies,
    },
    interpretation:
      "Trusted local build code executes with normal user privileges, NOT an OS sandbox. Separate Node processes reset module caches, NOT OS cold caches. Synthetic component timings are NOT model/agent benefit evidence. PID receipts are consistency hints, not isolation authentication. Failed workers may leave temporary roots: cleanup unknown; no automatic bulk cleanup. Successful pairs only enter timing summaries; negative change means faster after. Setup is excluded from operation timings; wallTimeMs includes process/setup/cleanup overhead.",
    attempted: attempts.length,
    succeeded: attempts.filter((a) => a.state === "succeeded").length,
    failed: attempts.filter((a) => a.state === "failed").length,
    attempts,
    summary: summarizeComparison(attempts),
  };
}

async function worker() {
  const raw = readFileSync(0);
  if (raw.length > 16384) fail();
  const input = JSON.parse(raw.toString("utf8"));
  if (
    !closed(input, [
      "arm",
      "size",
      "ratio",
      "iteration",
      "dist",
      "timeoutMs",
      "artifactDigest",
    ]) ||
    !["before", "after"].includes(input.arm) ||
    !integer(input.iteration, 0, 9)
  )
    fail();
  validateComparisonOptions({
    before: input.dist,
    after: input.dist,
    sizes: [input.size],
    interrupted: [input.ratio],
    iterations: 1,
    timeoutMs: input.timeoutMs,
  });
  const digest = artifactDigest(input.dist);
  if (digest !== input.artifactDigest) fail();
  const runtime = { artifactDigest: digest };
  for (const name of MODULES)
    Object.assign(
      runtime,
      await import(
        pathToFileURL(path.join(input.dist, "runtime", name + ".js")).href
      ),
    );
  const report = await runBenchmark(
    {
      suite: "capacity",
      iterations: 1,
      sizes: [input.size],
      interrupted: [input.ratio],
    },
    runtime,
  );
  // Detect direct module changes during this worker as well as before import.
  if (
    artifactDigest(input.dist) !== digest ||
    report.environment.runtimeArtifactDigest !== digest ||
    report.environment.benchmarkAlgorithmDigest !== benchmarkAlgorithmDigest()
  )
    fail();
  const receipt = {
    version: 1,
    kind: "capacity-worker",
    arm: input.arm,
    size: input.size,
    ratio: input.ratio,
    iteration: input.iteration,
    processId: process.pid,
    artifactDigest: digest,
    algorithmDigest: report.environment.benchmarkAlgorithmDigest,
    samples: report.capacity.samples,
  };
  process.stdout.write(JSON.stringify(receipt));
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  (async () => {
    if (process.argv.length === 3 && process.argv[2] === "--worker")
      await worker();
    else {
      const report = await runComparison(
        parseComparisonArgs(process.argv.slice(2)),
      );
      console.log(JSON.stringify(report, null, 2));
      if (report.failed) process.exitCode = 2;
    }
  })().catch(() => {
    console.error("CAPACITY_COMPARISON_FAILED");
    process.exitCode = 1;
  });
}

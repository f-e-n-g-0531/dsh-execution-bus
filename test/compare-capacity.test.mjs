import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { benchmarkAlgorithmDigest } from "../scripts/benchmark-runtime.mjs";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  validateComparisonOptions,
  parseComparisonArgs,
  runComparison,
} from "../dev/compare-capacity.mjs";

const options = {
  before: "dist",
  after: "dist",
  sizes: [4],
  interrupted: [0.5],
  iterations: 1,
  timeoutMs: 10000,
};

function receipt(request, ms = request.arm === "before" ? 10 : 5) {
  const recoverable = Math.floor(request.size * request.ratio);
  const interrupted = Math.ceil(recoverable / 2);
  const terminal = request.size - recoverable;
  return {
    version: 1,
    kind: "capacity-worker",
    arm: request.arm,
    size: request.size,
    ratio: request.ratio,
    iteration: request.iteration,
    processId:
      90000 + request.iteration * 2 + (request.arm === "after" ? 1 : 0),
    artifactDigest: request.artifactDigest,
    algorithmDigest: benchmarkAlgorithmDigest(),
    samples: ["list", "warm-list", "prune", "startup"].map((operation) => ({
      size: request.size,
      recoverableRatio: request.ratio,
      initialInterrupted: interrupted,
      initialAbandonedRunning: recoverable - interrupted,
      iteration: 0,
      operation,
      remaining:
        operation === "prune" || operation === "startup"
          ? recoverable + Math.min(100, terminal)
          : request.size,
      states: {
        succeeded:
          operation === "prune" || operation === "startup"
            ? Math.min(100, terminal)
            : terminal,
        running: operation === "startup" ? 0 : recoverable - interrupted,
        interrupted: operation === "startup" ? recoverable : interrupted,
      },
      unknownSteps: operation === "startup" ? recoverable : interrupted,
      cacheState:
        operation === "warm-list"
          ? "same-instance-second-read"
          : "fresh-history-root-first-operation",
      operationMs: ms,
      eventLoopProbeDelayMs: ms + 1,
      failed: false,
      returnedRecords:
        operation === "list" || operation === "warm-list"
          ? Math.min(20, request.size)
          : null,
    })),
  };
}

test("comparison options require explicit trusted builds and bounded matrix", () => {
  assert.doesNotThrow(() => validateComparisonOptions(options));
  for (const value of [
    { ...options, before: "" },
    { ...options, after: null },
    { ...options, iterations: 0 },
    { ...options, iterations: 11 },
    { ...options, sizes: [0] },
    { ...options, sizes: [10001] },
    { ...options, sizes: [4, 4] },
    { ...options, sizes: [1, 2, 3, 4, 5] },
    { ...options, interrupted: [-0.1] },
    { ...options, interrupted: [1.1] },
    { ...options, interrupted: [NaN] },
    { ...options, interrupted: [0, 0] },
    { ...options, timeoutMs: 999 },
    { ...options, timeoutMs: 600001 },
    { ...options, command: "not allowed" },
    {
      ...options,
      sizes: [1, 2, 3, 4],
      interrupted: [0, 0.1, 0.5, 1],
      iterations: 10,
    },
  ])
    assert.throws(() => validateComparisonOptions(value));
});

test("comparison CLI rejects unknown, duplicate, missing and invalid flags", () => {
  const parsed = parseComparisonArgs([
    "--before",
    "dist",
    "--after",
    "dist",
    "--sizes",
    "4",
    "--interrupted",
    "0.5",
    "--iterations",
    "1",
    "--timeout-ms",
    "10000",
  ]);
  assert.equal(parsed.iterations, 1);
  assert.deepEqual(parsed.sizes, [4]);
  for (const argv of [
    [],
    ["--before"],
    ["--before", "dist", "--after", "dist", "--before", "dist"],
    ["--before", "dist", "--after", "dist", "--secret", "value"],
    ["--before", "dist", "--after", "dist", "--sizes", "1,,2"],
  ]) {
    assert.throws(() => parseComparisonArgs(argv));
  }
});

test("invalid comparison CLI fails locally without leaking input paths", () => {
  const cli = spawnSync(
    process.execPath,
    [
      "dev/compare-capacity.mjs",
      "--secret-command",
      "G:/private-business-path",
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.ifError(cli.error);
  assert.equal(cli.status, 1);
  assert.doesNotMatch(
    cli.stderr,
    /private-business-path|secret-command| at |stack/,
  );
  assert.equal(cli.stdout, "");
});

test("AB/BA sequence is sequential and successful pairs have correct deltas", async () => {
  const calls = [];
  let active = 0;
  const report = await runComparison(
    { ...options, iterations: 2 },
    {
      runChild: async (request) => {
        assert.equal(active++, 0);
        calls.push(request);
        await Promise.resolve();
        active--;
        return receipt(request);
      },
    },
  );
  assert.deepEqual(
    calls.map((c) => c.arm),
    ["before", "after", "after", "before"],
  );
  assert.deepEqual(
    report.attempts.map((a) => a.sequence),
    [0, 1, 2, 3],
  );
  for (const row of report.summary) {
    assert.equal(row.succeededPairs, 2);
    assert.equal(row.failedPairs, 0);
    assert.equal(row.deltaMs, -5);
    assert.equal(row.changePercent, -50);
    assert.equal(row.beforeMedianMs, 10);
    assert.equal(row.afterMedianMs, 5);
    assert.equal(row.pairedMedianChangePercent, -50);
  }
});

for (const code of [
  "TIMEOUT",
  "CHILD_EXIT",
  "OUTPUT_LIMIT",
  "INVALID_JSON",
  "private-path-message",
]) {
  test(
    "failed child remains missing and does not suppress other arm: " + code,
    async () => {
      const report = await runComparison(options, {
        runChild: async (request) => {
          if (request.arm === "before")
            throw Object.assign(Error("G:/private-business-path"), { code });
          return receipt(request);
        },
      });
      assert.equal(report.attempts.length, 2);
      assert.equal(report.attempts[0].state, "failed");
      assert.equal(report.attempts[0].samples, null);
      assert.equal(report.attempts[0].cleanup, "unknown");
      assert.equal(report.attempts[0].failureCode, "CHILD_FAILED");
      assert.equal(report.attempts[1].state, "succeeded");
      for (const row of report.summary) {
        assert.equal(row.succeededPairs, 0);
        assert.equal(row.failedPairs, 1);
        assert.equal(row.deltaMs, null);
        assert.equal(row.changePercent, null);
      }
      assert.doesNotMatch(
        JSON.stringify(report),
        /private-business-path|private-path-message/,
      );
    },
  );
}

for (const mutate of [
  (r) => {
    r.artifactDigest = "0".repeat(64);
  },
  (r) => {
    r.algorithmDigest = "0".repeat(64);
  },
  (r) => {
    r.arm = "unexpected";
  },
  (r) => {
    r.size++;
  },
  (r) => {
    r.processId = 0;
  },
  (r) => {
    r.samples.pop();
  },
  (r) => {
    r.samples[0].operationMs = -1;
  },
  (r) => {
    r.samples[0].operationMs = Infinity;
  },
  (r) => {
    r.samples[0].states.running++;
  },
  (r) => {
    r.samples[0].failed = true;
  },
  (r) => {
    r.samples[0].unknownSteps++;
  },
]) {
  test(
    "worker identity, timing and state corruption cannot enter paired statistics " +
      mutate.toString(),
    async () => {
      const report = await runComparison(options, {
        runChild: async (request) => {
          const r = receipt(request);
          if (request.arm === "before") mutate(r);
          return r;
        },
      });
      assert.equal(report.attempts[0].state, "failed");
      assert.equal(report.attempts[0].samples, null);
      assert.ok(
        report.summary.every(
          (s) => s.succeededPairs === 0 && s.failedPairs === 1,
        ),
      );
    },
  );
}

test("receipt extras rejected and sample extra strings not copied", async () => {
  const report = await runComparison(options, {
    runChild: async (request) => {
      const r = receipt(request);
      if (request.arm === "before") r.secret = "private-business-path";
      else r.samples[0].secret = "private-business-path";
      return r;
    },
  });
  assert.equal(report.attempts[0].state, "failed");
  assert.equal(report.attempts[1].state, "succeeded");
  assert.doesNotMatch(JSON.stringify(report), /private-business-path/);
});
test("whitelisted child errors preserve category", async () => {
  const report = await runComparison(options, {
    runChild: async () => {
      throw Error("TIMEOUT");
    },
  });
  assert.ok(
    report.attempts.every(
      (a) => a.failureCode === "TIMEOUT" && a.samples === null,
    ),
  );
});
for (const [name, source, code] of [
  ["timeout", "while (true) {}", "TIMEOUT"],
  ["stderr", 'process.stderr.write("private-business-path");', "CHILD_STDERR"],
  [
    "dirty-json",
    'process.stdout.write("private-business-path");',
    "INVALID_JSON",
  ],
  ["exit", 'throw Error("private-business-path");', "CHILD_EXIT"],
]) {
  test(
    "real worker " + name + " remains failure without private output",
    async () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "xiaohe-compare-fixture-"),
      );
      try {
        fs.cpSync("dist", path.join(root, "dist"), { recursive: true });
        // The service now imports the public host pipeline at runtime. Preserve
        // normal package resolution for this isolated trusted-build fixture.
        fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
        fs.writeFileSync(
          path.join(root, "package.json"),
          JSON.stringify({ type: "module" }),
        );
        fs.appendFileSync(
          path.join(root, "dist/runtime/store.js"),
          "\n" + source + "\n",
        );
        const report = await runComparison({
          ...options,
          before: path.join(root, "dist"),
          after: path.join(root, "dist"),
          timeoutMs: name === "timeout" ? 1000 : 10000,
        });
        assert.equal(report.failed, 2);
        assert.ok(
          report.attempts.every(
            (a) =>
              a.state === "failed" &&
              a.failureCode === code &&
              a.samples === null &&
              a.cleanup === "unknown",
          ),
        );
        assert.ok(
          report.summary.every(
            (s) => s.succeededPairs === 0 && s.failedPairs === 1,
          ),
        );
        assert.doesNotMatch(JSON.stringify(report), /private-business-path/);
        assert.ok(!JSON.stringify(report).includes(root));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
test("runner source drift rejects receipt and prevents subsequent children", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaohe-runner-drift-"));
  try {
    fs.mkdirSync(path.join(root, "dev"));
    fs.mkdirSync(path.join(root, "scripts"));
    const runner = path.join(root, "dev/compare-capacity.mjs");
    fs.copyFileSync("dev/compare-capacity.mjs", runner);
    for (const name of ["benchmark-runtime.mjs", "pilot-report.mjs"])
      fs.copyFileSync(
        path.join("scripts", name),
        path.join(root, "scripts", name),
      );
    const isolated = await import(pathToFileURL(runner).href);
    let calls = 0;
    const report = await isolated.runComparison(
      { ...options, before: path.resolve("dist"), after: path.resolve("dist") },
      {
        runChild: async (r) => {
          calls++;
          fs.appendFileSync(runner, "\n// deliberate source drift\n");
          return receipt(r);
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(report.failed, 2);
    assert.ok(
      report.attempts.every(
        (a) => a.failureCode === "DEPENDENCY_CHANGED" && a.samples === null,
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("artifact digest binds transitive runtime presentation code", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaohe-compare-digest-"));
  try {
    fs.cpSync("dist", path.join(root, "dist"), { recursive: true });
    fs.appendFileSync(
      path.join(root, "dist/presentation.js"),
      "\n// digest mutation fixture\n",
    );
    const report = await runComparison(
      { ...options, after: path.join(root, "dist") },
      { runChild: async (r) => receipt(r) },
    );
    assert.notEqual(
      report.environment.artifactDigests.before,
      report.environment.artifactDigests.after,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("zero baseline does not manufacture percent improvement", async () => {
  const report = await runComparison(options, {
    runChild: async (request) => receipt(request, 0),
  });
  for (const row of report.summary) {
    assert.equal(row.deltaMs, 0);
    assert.equal(row.changePercent, null);
    assert.equal(row.pairedMedianChangePercent, null);
  }
});

test("fresh worker comparison on the same build produces valid small histories", async () => {
  const report = await runComparison(options);
  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /private-business-path/);
  assert.ok(!text.includes(process.cwd()));
  assert.ok(!text.includes(os.tmpdir()));
  assert.equal(report.attempts.length, 2);
  assert.ok(
    report.attempts.every(
      (a) => a.state === "succeeded" && a.cleanup === "completed",
    ),
  );
  assert.ok(report.attempts.every((a) => a.processId !== process.pid));
  assert.equal(new Set(report.attempts.map((a) => a.processId)).size, 2);
  assert.ok(report.attempts.every((a) => a.samples.length === 4));
  assert.ok(
    report.summary.every(
      (s) =>
        s.attemptedPairs === 1 && s.succeededPairs === 1 && s.failedPairs === 0,
    ),
  );
});

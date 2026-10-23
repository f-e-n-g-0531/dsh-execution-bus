import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  METRICS,
  OUTCOMES,
  normalizeObservation,
  collectObservations,
  statistics,
  buildReport,
  renderReport,
  boundedRead,
  parseArgs,
  main,
} from "../scripts/pilot-report.mjs";

const row = (
  arm = "native",
  outcome = "succeeded",
  metrics = {},
  extra = {},
) => ({ version: 1, arm, outcome, metrics, ...extra });
const encode = (rows) => rows.map((r) => JSON.stringify(r)).join("\n");
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pilot-report-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("projection is deterministic, redacts business data and preserves missing vs zero", () => {
  const input = row(
    "runtime",
    "interrupted",
    {
      toolRequests: 8,
      toolSuccesses: 3,
      wallTimeMs: 0,
      promptTokens: null,
      completionTokens: "42",
      retryRequests: -1,
      command: "secret-command",
      cwd: "G:/secret-business",
    },
    {
      pairId: "G:/secret-business secret-command",
      command: "secret-command",
      goal: "secret-command",
      taskClass: "G:/secret-business",
      runId: "G:/secret-business",
      error: "secret-command",
    },
  );
  const a = normalizeObservation(input);
  assert.deepEqual(a, normalizeObservation(input));
  assert.match(a.pairKey, /^[a-f0-9]{64}$/);
  assert.equal(a.taskClass, "other");
  assert.equal(a.metrics.wallTimeMs, 0);
  assert.equal(a.metrics.promptTokens, null);
  assert.equal(a.metrics.completionTokens, null);
  assert.equal(a.metrics.retryRequests, null);
  assert.equal(a.metrics.toolRequests, 8);
  assert.equal(a.metrics.toolSuccesses, 3);
  const report = buildReport([input]);
  for (const output of [
    JSON.stringify(a),
    JSON.stringify(report),
    renderReport(report),
  ]) {
    assert.doesNotMatch(output, /secret-command|secret-business/);
  }
});

test("failures, aborts, interrupted, unknown and running are not discarded or called successes", () => {
  const rows = OUTCOMES.map((outcome) =>
    row("runtime", outcome, { toolRequests: 5 }),
  );
  rows.push(row("runtime", "private-error-string"));
  const s = buildReport(rows).arms.runtime;
  assert.equal(s.attemptedTasks, OUTCOMES.length + 1);
  assert.equal(s.outcomes.succeeded, 1);
  assert.equal(s.outcomes.unknown, 2);
  assert.equal(s.successRate, 1 / (OUTCOMES.length + 1));
  assert.equal(s.metrics.toolRequests.observed, OUTCOMES.length);
  assert.equal(s.metrics.toolSuccesses.observed, 0);
  assert.equal(s.metrics.toolSuccesses.mean, null);
  assert.equal(s.metrics.toolSuccesses.missing, OUTCOMES.length + 1);
});

test("JSONL malformed/rejected diagnostics survive collect roundtrip without raw exception leakage", () => {
  const text =
    encode([row(), { version: 900, arm: "native" }, row("runtime", "failed")]) +
    '\n{"command":"secret"\n';
  const collected = collectObservations(text);
  assert.equal(collected.observations.length, 2);
  assert.deepEqual(collected.diagnostics, {
    malformed: 1,
    rejected: 1,
    inconsistentToolCounts: 0,
  });
  assert.deepEqual(collectObservations(JSON.stringify(collected)), collected);
  assert.deepEqual(buildReport(collected).diagnostics, collected.diagnostics);
  assert.doesNotMatch(JSON.stringify(collected), /secret/);
  assert.throws(() => collectObservations("[broken"), /INVALID_PILOT_INPUT/);
  assert.equal(collectObservations("").observations.length, 0);
});

test("successful paired deltas require unique pair keys and preserve missing measurements", () => {
  const pair = (id, a, b) => [
    row("native", "succeeded", a, { pairId: id }),
    row("runtime", "succeeded", b, { pairId: id }),
  ];
  const rows = [
    ...pair(
      "a",
      { wallTimeMs: 10, toolRequests: 7 },
      { wallTimeMs: 6, toolRequests: 2 },
    ),
    ...pair("b", { wallTimeMs: 4 }, {}),
    row("native", "succeeded", { wallTimeMs: 1 }, { pairId: "failed" }),
    row("runtime", "failed", { wallTimeMs: 99 }, { pairId: "failed" }),
    ...pair("duplicate", { wallTimeMs: 10 }, { wallTimeMs: 1 }),
    row("runtime", "succeeded", { wallTimeMs: 2 }, { pairId: "duplicate" }),
    row("runtime", "aborted", {}, { pairId: "unmatched" }),
    row("native"),
    row("runtime"),
  ];
  const report = buildReport(rows);
  assert.equal(report.pairs.complete, 3);
  assert.equal(report.pairs.bothSucceeded, 2);
  assert.equal(report.pairs.notBothSucceeded, 1);
  assert.equal(report.pairs.ambiguous, 1);
  assert.equal(report.pairs.incomplete, 1);
  assert.deepEqual(report.pairs.successfulDeltaRuntimeMinusNative.wallTimeMs, {
    observed: 1,
    missing: 1,
    mean: -4,
    p50: -4,
    p95: -4,
  });
  assert.deepEqual(buildReport([...rows].reverse()), report);
});

test("invalid numeric metrics are missing, contradictions are diagnosed, not clamped to fake successes", () => {
  const normalized = normalizeObservation(
    row("native", "succeeded", {
      toolRequests: 1,
      toolSuccesses: 2,
      promptTokens: 1.5,
      completionTokens: Infinity,
      modelTurns: Number.MAX_SAFE_INTEGER + 1,
      humanInterventions: NaN,
      recoveryMs: 0.25,
      pollingRequests: 0,
    }),
  );
  assert.equal(normalized.metrics.toolSuccesses, null);
  assert.equal(normalized.metrics.toolRequests, 1);
  assert.equal(normalized.inconsistentToolCounts, true);
  for (const key of [
    "promptTokens",
    "completionTokens",
    "modelTurns",
    "humanInterventions",
  ])
    assert.equal(normalized.metrics[key], null);
  assert.equal(normalized.metrics.recoveryMs, 0.25);
  assert.equal(normalized.metrics.pollingRequests, 0);
  const collected = collectObservations(JSON.stringify([normalized]));
  assert.equal(collected.diagnostics.inconsistentToolCounts, 1);
  assert.equal(buildReport(collected).diagnostics.inconsistentToolCounts, 1);
});

test("empty report and nearest-rank summaries do not invent zero measurements", () => {
  const report = buildReport([]);
  for (const arm of ["native", "runtime"]) {
    assert.equal(report.arms[arm].successRate, null);
    for (const key of METRICS)
      assert.equal(report.arms[arm].metrics[key].mean, null);
  }
  assert.deepEqual(statistics([3, 1, 2], 5), {
    observed: 3,
    missing: 2,
    mean: 2,
    p50: 2,
    p95: 3,
  });
  assert.match(renderReport(report), /missing/);
  assert.match(report.interpretation, /not randomized or causal/);
});

test("descriptor bounded reads reject nonregular, oversized and growing inputs, close even on errors", (t) => {
  const root = fixture(t);
  assert.throws(() => boundedRead(root), /INVALID_PILOT_INPUT/);
  const file = path.join(root, "input.json");
  writeFileSync(file, "12345");
  assert.throws(() => boundedRead(file, 4), /INVALID_PILOT_INPUT/);
  assert.equal(boundedRead(file, 5).toString(), "12345");
  function fake(size, content, regular = true) {
    let closed = 0,
      offset = 0;
    return {
      io: {
        openSync: () => 42,
        closeSync: (fd) => {
          assert.equal(fd, 42);
          closed++;
        },
        fstatSync: () => ({ size, isFile: () => regular }),
        readSync: (_fd, buffer, at, length) => {
          const n = Math.min(1, length, content.length - offset); // exercise short reads
          if (n > 0) buffer[at] = content.charCodeAt(offset++);
          return n;
        },
      },
      closed: () => closed,
    };
  }
  for (const input of [fake(2, "abc"), fake(1, "a", false), fake(6, "abc")]) {
    assert.throws(
      () => boundedRead("not-used", 5, input.io),
      /INVALID_PILOT_INPUT/,
    );
    assert.equal(input.closed(), 1);
  }
  const short = fake(5, "abc");
  assert.equal(boundedRead("not-used", 5, short.io).toString(), "abc");
  assert.equal(short.closed(), 1);
});

test("combined input files obey byte/row/count limits and collect reentry keeps pair identity", (t) => {
  const root = fixture(t);
  const a = path.join(root, "a.json");
  const b = path.join(root, "b.json");
  // Whitespace does not count as a row but still consumes the combined byte budget.
  writeFileSync(a, " ".repeat(9 * 1024 * 1024));
  writeFileSync(b, " ".repeat(9 * 1024 * 1024));
  assert.throws(
    () => main(["collect", "--input", a, "--input", b], () => {}),
    /INVALID_PILOT_INPUT/,
  );
  writeFileSync(a, "null\n".repeat(50001));
  writeFileSync(b, "null\n".repeat(50000));
  assert.throws(
    () => main(["collect", "--input", a, "--input", b], () => {}),
    /INVALID_PILOT_INPUT/,
  );
  assert.throws(
    () =>
      parseArgs([
        "collect",
        ...Array.from({ length: 17 }, () => ["--input", a]).flat(),
      ]),
    /INVALID_PILOT_INPUT/,
  );
  const original = row("native", "succeeded", {}, { pairId: "private pair" });
  const first = collectObservations(JSON.stringify(original));
  assert.notEqual(first.observations[0].pairKey, original.pairId);
  const second = collectObservations(JSON.stringify(first));
  const third = collectObservations(JSON.stringify(second));
  assert.deepEqual(first, second);
  assert.deepEqual(first, third);
});

test("CLI collect/report read only local inputs, combine diagnostics, and never echo file errors", (t) => {
  const root = fixture(t);
  const input = path.join(root, "secret-business.jsonl");
  const normalized = path.join(root, "normalized.json");
  writeFileSync(
    input,
    encode([
      row("native", "succeeded", { wallTimeMs: 20 }, { pairId: "task" }),
      row("runtime", "aborted", {}, { pairId: "task" }),
    ]),
  );
  let output;
  const collected = main(["collect", "--input", input], (text) => {
    output = text;
  });
  assert.equal(JSON.parse(output).observations.length, 2);
  writeFileSync(normalized, output);
  const report = main(["report", "--input", normalized, "--json"], (text) => {
    output = text;
  });
  assert.equal(report.pairs.notBothSucceeded, 1);
  assert.equal(JSON.parse(output).arms.runtime.outcomes.aborted, 1);
  assert.doesNotMatch(output, /secret-business/);
  assert.deepEqual(report, buildReport(collected));
  const cli = spawnSync(
    process.execPath,
    ["scripts/pilot-report.mjs", "report", "--input", input, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), report);
  const failedCli = spawnSync(
    process.execPath,
    [
      "scripts/pilot-report.mjs",
      "report",
      "--input",
      path.join(root, "secret-business-missing"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(failedCli.status, 1);
  assert.doesNotMatch(failedCli.stderr, /secret-business|ENOENT|stack/);
  assert.equal(failedCli.stdout, "");
  assert.throws(
    () => main(["report", "--input", path.join(root, "private-missing")]),
    (error) => error.message === "INVALID_PILOT_INPUT",
  );
  for (const args of [
    [],
    ["report"],
    ["collect", "--input"],
    ["report", "--url", "https://secret"],
  ])
    assert.throws(() => parseArgs(args), /INVALID_PILOT_INPUT/);
});

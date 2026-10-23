#!/usr/bin/env node
/** Offline pilot observations, NOT a causal model-benefit evaluator.
 * One JSON/JSONL object per attempted task:
 * {version:1, arm:"native"|"runtime", outcome:"succeeded"|"failed"|"aborted"|
 * "cancelled"|"interrupted"|"unknown"|"running", pairId?:string,
 * taskClass?:"read-only"|"mixed"|"maintenance"|"recovery", metrics:{...METRICS}}
 * collect projects onto an allowlist; report never copies labels, commands,
 * paths, results or exception text. Missing/invalid measurements remain null.
 * node scripts/pilot-report.mjs collect --input observations.jsonl
 * node scripts/pilot-report.mjs report --input observations.jsonl [--json]
 * Match pairs on equivalent task/model/settings externally, before collecting.
 * pairKey is deterministic SHA-256 (pseudonymous, not anonymous); collect reentry preserves it.
 * Local input limits: 16 files, 16 MiB combined bytes, 100000 combined attempted/rejected/malformed rows.
 */
import { openSync, closeSync, fstatSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";

export const METRICS = Object.freeze([
  "wallTimeMs",
  "modelTurns",
  "toolRequests",
  "toolSuccesses",
  "promptTokens",
  "completionTokens",
  "pollingRequests",
  "retryRequests",
  "recoveryMs",
  "humanInterventions",
]);
export const OUTCOMES = Object.freeze([
  "succeeded",
  "failed",
  "aborted",
  "cancelled",
  "interrupted",
  "unknown",
  "running",
]);
const ARMS = ["native", "runtime"];
const CLASSES = ["read-only", "mixed", "maintenance", "recovery", "other"];
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 100000;
const MAX_INPUTS = 16;
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hash = (v) => createHash("sha256").update(v).digest("hex");
const validMetric = (key, v) =>
  typeof v === "number" &&
  Number.isFinite(v) &&
  v >= 0 &&
  v <= Number.MAX_SAFE_INTEGER &&
  (key.endsWith("Ms") || Number.isSafeInteger(v));
const fail = () => {
  throw Error("INVALID_PILOT_INPUT");
};

export function normalizeObservation(raw) {
  if (!object(raw) || raw.version !== 1 || !ARMS.includes(raw.arm)) return null;
  const metrics = Object.fromEntries(
    METRICS.map((key) => [
      key,
      object(raw.metrics) && validMetric(key, raw.metrics[key])
        ? raw.metrics[key]
        : null,
    ]),
  );
  // Keep the observed request count; contradictory successes are not trusted.
  const inconsistent =
    metrics.toolRequests !== null &&
    metrics.toolSuccesses !== null &&
    metrics.toolSuccesses > metrics.toolRequests;
  if (inconsistent) metrics.toolSuccesses = null;
  const pairKey =
    typeof raw.pairId === "string" &&
    raw.pairId.length > 0 &&
    raw.pairId.length <= 4096
      ? hash(raw.pairId)
      : typeof raw.pairKey === "string" && /^[a-f0-9]{64}$/.test(raw.pairKey)
        ? raw.pairKey
        : null;
  return {
    version: 1,
    arm: raw.arm,
    outcome: OUTCOMES.includes(raw.outcome) ? raw.outcome : "unknown",
    pairKey,
    taskClass: CLASSES.includes(raw.taskClass) ? raw.taskClass : "other",
    metrics,
    inconsistentToolCounts: inconsistent || raw.inconsistentToolCounts === true,
  };
}

/** Parse recoverably: malformed JSONL lines and rejected rows remain diagnostic counts. */
export function collectObservations(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BYTES) fail();
  const diagnostics = { malformed: 0, rejected: 0, inconsistentToolCounts: 0 };
  let rows;
  const trimmed = text.trim();
  if (!trimmed) rows = [];
  else if (trimmed.startsWith("[")) {
    try {
      rows = JSON.parse(trimmed);
    } catch {
      fail();
    }
    if (!Array.isArray(rows)) fail();
  } else {
    // Accept a collect envelope or a single observation as well as JSONL.
    let value;
    try {
      value = JSON.parse(trimmed);
    } catch {
      /* parse each line below */
    }
    if (
      object(value) &&
      value.kind === "pilot-observations" &&
      value.version === 1 &&
      Array.isArray(value.observations)
    ) {
      rows = value.observations;
      for (const key of Object.keys(diagnostics)) {
        const n = value.diagnostics?.[key];
        if (Number.isSafeInteger(n) && n >= 0) diagnostics[key] = n;
      }
    } else if (value !== undefined) rows = [value];
    else {
      rows = [];
      for (const line of trimmed.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          rows.push(JSON.parse(line));
        } catch {
          diagnostics.malformed++;
        }
      }
    }
  }
  if (rows.length + diagnostics.malformed + diagnostics.rejected > MAX_ROWS)
    fail();
  const observations = [];
  let inconsistencies = 0;
  for (const raw of rows) {
    const row = normalizeObservation(raw);
    if (!row) diagnostics.rejected++;
    else {
      observations.push(row);
      if (row.inconsistentToolCounts) inconsistencies++;
    }
  }
  diagnostics.inconsistentToolCounts = Math.max(
    diagnostics.inconsistentToolCounts,
    inconsistencies,
  );
  return { version: 1, kind: "pilot-observations", observations, diagnostics };
}

export function statistics(values, total = values.length) {
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (p) =>
    sorted.length
      ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]
      : null;
  return {
    observed: sorted.length,
    missing: total - sorted.length,
    mean: sorted.length
      ? sorted.reduce((n, v) => n + v / sorted.length, 0)
      : null,
    p50: quantile(0.5),
    p95: quantile(0.95),
  };
}
const summarize = (rows) => ({
  attemptedTasks: rows.length,
  outcomes: Object.fromEntries(
    OUTCOMES.map((s) => [s, rows.filter((r) => r.outcome === s).length]),
  ),
  successRate: rows.length
    ? rows.filter((r) => r.outcome === "succeeded").length / rows.length
    : null,
  metrics: Object.fromEntries(
    METRICS.map((key) => [
      key,
      statistics(
        rows.map((r) => r.metrics[key]).filter((v) => v !== null),
        rows.length,
      ),
    ]),
  ),
});

export function buildReport(input) {
  // Re-project even programmatic input; arbitrary properties never enter reports.
  const clean = collectObservations(JSON.stringify(input));
  const rows = clean.observations;
  const paired = new Map();
  for (const row of rows) {
    if (!row.pairKey) continue;
    const group = paired.get(row.pairKey) ?? { native: [], runtime: [] };
    group[row.arm].push(row);
    paired.set(row.pairKey, group);
  }
  const complete = [...paired.values()].filter(
    (p) => p.native.length === 1 && p.runtime.length === 1,
  );
  const successful = complete.filter(
    (p) =>
      p.native[0].outcome === "succeeded" &&
      p.runtime[0].outcome === "succeeded",
  );
  return {
    version: 1,
    kind: "pilot-report",
    interpretation:
      "observational comparison; not randomized or causal; no automatic model-benefit claim",
    metricSemantics:
      "all attempts included; toolRequests are not toolSuccesses; null means unobserved; quantiles use nearest rank",
    diagnostics: clean.diagnostics,
    arms: Object.fromEntries(
      ARMS.map((arm) => [arm, summarize(rows.filter((r) => r.arm === arm))]),
    ),
    pairs: {
      observedKeys: paired.size,
      complete: complete.length,
      ambiguous: [...paired.values()].filter(
        (p) => p.native.length > 1 || p.runtime.length > 1,
      ).length,
      incomplete: [...paired.values()].filter(
        (p) => !p.native.length || !p.runtime.length,
      ).length,
      bothSucceeded: successful.length,
      notBothSucceeded: complete.length - successful.length,
      // No pairing by arbitrary task-class label or by array position.
      successfulDeltaRuntimeMinusNative: Object.fromEntries(
        METRICS.map((key) => [
          key,
          statistics(
            successful
              .filter(
                (p) =>
                  p.native[0].metrics[key] !== null &&
                  p.runtime[0].metrics[key] !== null,
              )
              .map((p) => p.runtime[0].metrics[key] - p.native[0].metrics[key]),
            successful.length,
          ),
        ]),
      ),
    },
  };
}

export function renderReport(report) {
  const lines = [
    "# Offline pilot comparison",
    "",
    report.interpretation,
    report.metricSemantics,
    "",
    "| Arm | Attempted | Succeeded | Failed | Aborted | Cancelled | Interrupted | Unknown | Running |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const arm of ARMS) {
    const s = report.arms[arm];
    lines.push(
      `| ${arm} | ${s.attemptedTasks} | ${OUTCOMES.map((k) => s.outcomes[k]).join(" | ")} |`,
    );
  }
  lines.push(
    "",
    "| Metric | Native mean (observed/missing) | Runtime mean (observed/missing) | Successful paired delta (observed/missing) |",
    "| --- | ---: | ---: | ---: |",
  );
  const format = (s) =>
    `${s.mean === null ? "missing" : s.mean.toFixed(3)} (${s.observed}/${s.missing})`;
  for (const key of METRICS)
    lines.push(
      `| ${key} | ${format(report.arms.native.metrics[key])} | ${format(report.arms.runtime.metrics[key])} | ${format(report.pairs.successfulDeltaRuntimeMinusNative[key])} |`,
    );
  lines.push(
    "",
    `Pairs: complete=${report.pairs.complete}, bothSucceeded=${report.pairs.bothSucceeded}, notBothSucceeded=${report.pairs.notBothSucceeded}, ambiguous=${report.pairs.ambiguous}, incomplete=${report.pairs.incomplete}.`,
    `Diagnostics: malformed=${report.diagnostics.malformed}, rejected=${report.diagnostics.rejected}, inconsistentToolCounts=${report.diagnostics.inconsistentToolCounts}.`,
  );
  return lines.join("\n");
}

export function parseArgs(argv) {
  const mode = argv[0];
  if (!["collect", "report"].includes(mode)) fail();
  const inputs = [];
  let json = false;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--json") json = true;
    else if (
      argv[i] === "--input" &&
      argv[i + 1] &&
      !argv[i + 1].startsWith("--")
    )
      inputs.push(argv[++i]);
    else fail();
  }
  if (!inputs.length || inputs.length > MAX_INPUTS) fail();
  return { mode, inputs, json };
}

/** Descriptor-based bounded read: rejects directories and files growing past observed size.
 * io is injectable solely for deterministic short-read/growth tests.
 */
export function boundedRead(
  file,
  maxBytes = MAX_BYTES,
  io = { openSync, closeSync, fstatSync, readSync },
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_BYTES)
    fail();
  const fd = io.openSync(file, "r");
  try {
    const stat = io.fstatSync(fd);
    if (
      !stat.isFile() ||
      !Number.isSafeInteger(stat.size) ||
      stat.size < 0 ||
      stat.size > maxBytes
    )
      fail();
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = io.readSync(fd, buffer, length, buffer.length - length, null);
      if (!n) break;
      length += n;
    }
    if (length > stat.size) fail();
    return buffer.subarray(0, length);
  } finally {
    io.closeSync(fd);
  }
}

export function main(argv = process.argv.slice(2), emit = console.log) {
  const options = parseArgs(argv);
  const combined = {
    version: 1,
    kind: "pilot-observations",
    observations: [],
    diagnostics: { malformed: 0, rejected: 0, inconsistentToolCounts: 0 },
  };
  let inputBytes = 0;
  try {
    for (const file of options.inputs) {
      const bytes = boundedRead(file, MAX_BYTES - inputBytes);
      inputBytes += bytes.length;
      const collected = collectObservations(bytes.toString("utf8"));
      const total =
        combined.observations.length +
        collected.observations.length +
        combined.diagnostics.malformed +
        combined.diagnostics.rejected +
        collected.diagnostics.malformed +
        collected.diagnostics.rejected;
      if (total > MAX_ROWS) fail();
      for (const row of collected.observations) combined.observations.push(row);
      for (const key of Object.keys(combined.diagnostics))
        combined.diagnostics[key] += collected.diagnostics[key];
    }
  } catch {
    fail();
  } // Never expose file names or filesystem exception messages.
  const result = options.mode === "collect" ? combined : buildReport(combined);
  emit(
    options.mode === "collect" || options.json
      ? JSON.stringify(result, null, 2)
      : renderReport(result),
  );
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    main();
  } catch {
    console.error(
      "PILOT_INPUT_ERROR: use collect|report --input <local JSON/JSONL> [--json]",
    );
    process.exitCode = 1;
  }
}

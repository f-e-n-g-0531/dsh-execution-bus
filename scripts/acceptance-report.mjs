#!/usr/bin/env node
/** Offline evidence ledger, not a desktop driver or proof that assertions are true. */
import { createHash } from "node:crypto";
import {
  openSync,
  fstatSync,
  readSync,
  closeSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ACCEPTANCE_CASES = Object.freeze({
  "preset-isolation": [
    "targetToolsVisible",
    "ordinaryAgentUnchanged",
    "defaultPresetUnchanged",
  ],
  "ptc-chain": [
    "generatedSdkUsed",
    "nestedCallsObserved",
    "parentAuthorityPreserved",
    "cwdPreserved",
    "diskResultVerified",
  ],
  "readonly-deny": [
    "realSandboxUsed",
    "denialObserved",
    "forbiddenEffectsZero",
  ],
  "workspace-write": [
    "realSandboxUsed",
    "allowedWriteVerified",
    "outsideWorkspaceEffectsZero",
  ],
  "approval-deny": [
    "realApprovalPolicyUsed",
    "denialObserved",
    "forbiddenEffectsZero",
  ],
  "sync-cancel": [
    "schedulingStopped",
    "laterStepsZero",
    "lateResultNotPublished",
  ],
  "async-detach": [
    "acceptedBeforeOuterAbort",
    "workSurvivedOuterAbort",
    "resultCollected",
  ],
  "scope-unload": [
    "ownSchedulingStopped",
    "otherScopeUnaffected",
    "reloadSucceeded",
  ],
  "host-restart": [
    "wholeHostKilled",
    "sameSessionReopened",
    "checkpointVerified",
    "completedWritesNotReplayed",
    "readonlyRecoveryVerified",
  ],
  "unknown-side-effect": [
    "uncertaintyDisplayed",
    "noAutomaticReplay",
    "laterStepsZero",
    "externalEffectsReconciled",
  ],
  "background-job-cleanup": [
    "jobHandleCollected",
    "downstreamEffectsZero",
    "nativeJobCollectedOrStopped",
    "noResidualJobsOrProcesses",
  ],
  "real-model": [
    "realModelUsed",
    "planSubmittedByModel",
    "taskOutcomeIndependentlyVerified",
  ],
});
const fail = () => {
  throw Error("INVALID_ACCEPTANCE_REPORT");
};
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function exact(v, keys) {
  if (!object(v) || Object.keys(v).some((key) => !keys.includes(key))) fail();
}
const label = (v) =>
  typeof v === "string" && /^[A-Za-z0-9@][A-Za-z0-9 ._+:/@()-]{0,127}$/.test(v);
const stamp = (v) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v) &&
  Number.isFinite(Date.parse(v));
const digest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);

export function createTemplate({ packageName, version, candidateSha256 }) {
  if (!label(packageName) || !label(version) || !digest(candidateSha256))
    fail();
  return {
    version: 1,
    candidate: { packageName, version, sha256: candidateSha256 },
    environment: {
      dsh: null,
      cordis: null,
      node: process.versions.node,
      platform: process.platform,
      model: null,
      permissionProfile: null,
    },
    cases: Object.entries(ACCEPTANCE_CASES).map(([id, assertions]) => ({
      id,
      status: "pending",
      startedAt: null,
      finishedAt: null,
      evidenceId: null,
      assertions: Object.fromEntries(assertions.map((key) => [key, null])),
    })),
  };
}

export function evaluateReport(report, expected) {
  exact(report, ["version", "candidate", "environment", "cases"]);
  if (report.version !== 1) fail();
  exact(report.candidate, ["packageName", "version", "sha256"]);
  const candidate = report.candidate;
  if (
    !label(candidate.packageName) ||
    !label(candidate.version) ||
    !digest(candidate.sha256)
  )
    fail();
  if (
    expected &&
    (candidate.sha256 !== expected.sha256 ||
      candidate.packageName !== expected.packageName ||
      candidate.version !== expected.version)
  )
    throw Error("ACCEPTANCE_CANDIDATE_MISMATCH");
  const environmentKeys = [
    "dsh",
    "cordis",
    "node",
    "platform",
    "model",
    "permissionProfile",
  ];
  exact(report.environment, environmentKeys);
  if (
    environmentKeys.some(
      (key) =>
        report.environment[key] !== null && !label(report.environment[key]),
    )
  )
    fail();
  const missingEnvironment = environmentKeys.filter(
    (key) => !label(report.environment[key]),
  );
  if (
    !Array.isArray(report.cases) ||
    report.cases.length !== Object.keys(ACCEPTANCE_CASES).length
  )
    fail();
  const seen = new Set();
  const counts = { pass: 0, fail: 0, skipped: 0, pending: 0 };
  const checks = [];
  for (const entry of report.cases) {
    exact(entry, [
      "id",
      "status",
      "startedAt",
      "finishedAt",
      "evidenceId",
      "assertions",
    ]);
    if (typeof entry.id !== "string" || typeof entry.status !== "string")
      fail();
    const required = ACCEPTANCE_CASES[entry.id];
    if (
      !Object.hasOwn(ACCEPTANCE_CASES, entry.id) ||
      seen.has(entry.id) ||
      !Object.hasOwn(counts, entry.status)
    )
      fail();
    seen.add(entry.id);
    exact(entry.assertions, required);
    if (
      required.some(
        (key) =>
          !Object.hasOwn(entry.assertions, key) ||
          ![true, false, null].includes(entry.assertions[key]),
      )
    )
      fail();
    if (
      entry.evidenceId !== null &&
      (typeof entry.evidenceId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(entry.evidenceId))
    )
      fail();
    for (const time of [entry.startedAt, entry.finishedAt])
      if (time !== null && !stamp(time)) fail();
    if (
      entry.startedAt !== null &&
      entry.finishedAt !== null &&
      Date.parse(entry.finishedAt) < Date.parse(entry.startedAt)
    )
      fail();
    if (
      entry.status === "pass" &&
      (!entry.evidenceId ||
        !stamp(entry.startedAt) ||
        !stamp(entry.finishedAt) ||
        required.some((key) => entry.assertions[key] !== true))
    )
      fail();
    counts[entry.status]++;
    checks.push({ id: entry.id, status: entry.status });
  }
  return {
    version: 1,
    candidate: { ...candidate },
    environment: { ...report.environment },
    counts,
    missingEnvironment,
    ready:
      counts.pass === Object.keys(ACCEPTANCE_CASES).length &&
      missingEnvironment.length === 0,
    checks,
    scope:
      "Operator-supplied offline evidence only; not independent verification, a sandbox certificate, model benefit evidence, or release authorization. Skipped/pending never count as pass. No network, installation or host restart is performed.",
  };
}

function boundedRead(file, maxBytes) {
  const fd = openSync(file, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) fail();
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const bytes = readSync(fd, buffer, length, buffer.length - length, null);
      if (!bytes) break;
      length += bytes;
    }
    if (length > stat.size) fail();
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}
export function candidateHash(file) {
  // Candidates are small npm archives; refuse unbounded or non-regular input.
  return createHash("sha256")
    .update(boundedRead(file, 32 * 1024 * 1024))
    .digest("hex");
}
export function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!["init", "check"].includes(command)) throw Error("USAGE");
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (
      !["--candidate", "--report"].includes(key) ||
      options[key] ||
      !value ||
      value.startsWith("--")
    )
      throw Error("USAGE");
    options[key] = value;
  }
  if (
    !options["--candidate"] ||
    (command === "check") !== Boolean(options["--report"])
  )
    throw Error("USAGE");
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const expected = {
    packageName: pkg.name,
    version: pkg.version,
    sha256: candidateHash(options["--candidate"]),
  };
  if (command === "init") {
    console.log(
      JSON.stringify(
        createTemplate({ ...expected, candidateSha256: expected.sha256 }),
        null,
        2,
      ),
    );
    return 0;
  }
  const result = evaluateReport(
    JSON.parse(boundedRead(options["--report"], 1024 * 1024).toString("utf8")),
    expected,
  );
  console.log(JSON.stringify(result, null, 2));
  return result.ready ? 0 : 2;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = main();
  } catch {
    console.error(
      "Acceptance report failed: invalid arguments, report, candidate, or inaccessible file. No input paths or contents are printed.",
    );
    process.exitCode = 1;
  }
}

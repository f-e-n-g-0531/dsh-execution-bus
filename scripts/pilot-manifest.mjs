#!/usr/bin/env node
/** Local preregistration and byte binding, not an experiment runner or certification.
 * init --candidate <archive> prints a pending template, NOT observed evidence.
 * check --candidate <archive> --manifest <json> [--observations <json|jsonl>]
 * Fill exact host/model IDs locally. Output contains hashes, never those IDs/text/paths.
 * Hash external controlled task plan, success criteria and decision thresholds BEFORE
 * execution; this tool neither reads those texts nor certifies their timing/truth.
 * Suggested 36 attempts = 18 pairs, not a global requirement; pairs stays null at init.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { candidateHash } from "./acceptance-report.mjs";
import {
  boundedRead,
  collectObservations,
  buildReport,
} from "./pilot-report.mjs";

const fail = () => {
  throw Error("INVALID_PILOT_MANIFEST");
};
const hash = (v) => createHash("sha256").update(v).digest("hex");
const digest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const integer = (v, max) => Number.isSafeInteger(v) && v >= 1 && v <= max;
const id = (v) =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 512 &&
  v.trim() === v &&
  !/[\u0000-\u001f\u007f]/.test(v) &&
  !["unknown", "pending", "default"].includes(v.toLowerCase());
const KEYS = [
  "version",
  "kind",
  "evidenceReady",
  "candidateSha256",
  "hostId",
  "modelId",
  "mode",
  "sandbox",
  "executionMode",
  "presentation",
  "snapshotSha256",
  "planSha256",
  "successCriteriaSha256",
  "decisionThresholdsSha256",
  "modelSettingsSha256",
  "registeredAt",
  "concurrency",
  "order",
];
function exact(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail();
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((k) => typeof k !== "string" || !keys.includes(k))
  )
    fail();
  for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(value, k);
    if (!d || !("value" in d) || !d.enumerable) fail();
  }
}
export function createTemplate(candidateSha256) {
  if (!digest(candidateSha256)) fail();
  return {
    version: 1,
    kind: "pilot-manifest",
    evidenceReady: false,
    candidateSha256,
    hostId: null,
    modelId: null,
    mode: "paired-native-runtime",
    sandbox: null,
    executionMode: null,
    presentation: { native: null, runtime: null },
    snapshotSha256: null,
    planSha256: null,
    successCriteriaSha256: null,
    decisionThresholdsSha256: null,
    modelSettingsSha256: null,
    registeredAt: null,
    concurrency: { native: null, runtime: null },
    order: { strategy: "alternating", firstArm: null, pairs: null },
  };
}

/** Strict complete-or-null fields; a missing/unknown enum is not silently accepted. */
export function validateManifest(raw, expectedCandidateSha256) {
  exact(raw, KEYS);
  exact(raw.presentation, ["native", "runtime"]);
  exact(raw.concurrency, ["native", "runtime"]);
  exact(raw.order, ["strategy", "firstArm", "pairs"]);
  if (
    raw.version !== 1 ||
    raw.kind !== "pilot-manifest" ||
    raw.evidenceReady !== false ||
    !digest(raw.candidateSha256) ||
    !digest(expectedCandidateSha256) ||
    raw.candidateSha256 !== expectedCandidateSha256 ||
    raw.mode !== "paired-native-runtime" ||
    raw.order.strategy !== "alternating"
  )
    fail();
  const missing = [];
  function field(name, value, predicate) {
    if (value === null) missing.push(name);
    else if (!predicate(value)) fail();
  }
  field(
    "registeredAt",
    raw.registeredAt,
    (v) =>
      typeof v === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v) &&
      Number.isFinite(Date.parse(v)) &&
      new Date(v).toISOString().replace(".000Z", "Z") ===
        v.replace(".000Z", "Z"),
  );
  field("hostId", raw.hostId, id);
  field("modelId", raw.modelId, id);
  field("sandbox", raw.sandbox, (v) =>
    ["read-only", "workspace-write", "danger-full-access"].includes(v),
  );
  field("executionMode", raw.executionMode, (v) =>
    ["per-call", "persistent-in-memory"].includes(v),
  );
  for (const arm of ["native", "runtime"]) {
    field("presentation." + arm, raw.presentation[arm], (v) =>
      ["native", "ptc"].includes(v),
    );
    field("concurrency." + arm, raw.concurrency[arm], (v) => integer(v, 4));
  }
  if (
    raw.concurrency.native !== null &&
    raw.concurrency.runtime !== null &&
    raw.concurrency.native !== raw.concurrency.runtime
  )
    fail();
  for (const key of [
    "snapshotSha256",
    "planSha256",
    "successCriteriaSha256",
    "decisionThresholdsSha256",
    "modelSettingsSha256",
  ])
    field(key, raw[key], digest);
  field("order.firstArm", raw.order.firstArm, (v) =>
    ["native", "runtime"].includes(v),
  );
  field("order.pairs", raw.order.pairs, (v) => integer(v, 50000));
  // Fixed order canonical projection: never serialize getters/extra fields or arbitrary object order.
  const canonical = Object.fromEntries(KEYS.map((k) => [k, raw[k]]));
  canonical.presentation = {
    native: raw.presentation.native,
    runtime: raw.presentation.runtime,
  };
  canonical.concurrency = {
    native: raw.concurrency.native,
    runtime: raw.concurrency.runtime,
  };
  canonical.order = {
    strategy: raw.order.strategy,
    firstArm: raw.order.firstArm,
    pairs: raw.order.pairs,
  };
  return { canonical, missing };
}

export function checkManifest(
  raw,
  expectedCandidateSha256,
  observationBytes = null,
) {
  const { canonical: m, missing } = validateManifest(
    raw,
    expectedCandidateSha256,
  );
  const planComplete = missing.length === 0;
  let report = null;
  let observationsSha256 = null;
  let observationsPresent = false;
  if (observationBytes !== null) {
    if (
      !planComplete ||
      !Buffer.isBuffer(observationBytes) ||
      observationBytes.length > 16 * 1024 * 1024
    )
      fail();
    observationsSha256 = hash(observationBytes);
    const collected = collectObservations(observationBytes.toString("utf8"));
    report = buildReport(collected); // Existing metrics/missingness/failure semantics, no new statistics.
    observationsPresent = collected.observations.length > 0;
  }
  const manifestSha256 = hash(JSON.stringify(m));
  return {
    version: 1,
    kind: "pilot-manifest-check",
    candidateSha256: expectedCandidateSha256,
    manifestSha256,
    planComplete,
    missing,
    observationsPresent,
    observationsSha256,
    bindingSha256: observationsSha256
      ? hash(JSON.stringify({ manifestSha256, observationsSha256 }))
      : null,
    evidenceReady: false,
    declared: {
      hostIdSha256: m.hostId === null ? null : hash(m.hostId),
      modelIdSha256: m.modelId === null ? null : hash(m.modelId),
      mode: m.mode,
      sandbox: m.sandbox,
      executionMode: m.executionMode,
      presentation: m.presentation,
      snapshotSha256: m.snapshotSha256,
      planSha256: m.planSha256,
      successCriteriaSha256: m.successCriteriaSha256,
      decisionThresholdsSha256: m.decisionThresholdsSha256,
      modelSettingsSha256: m.modelSettingsSha256,
      registeredAt: m.registeredAt,
      concurrency: m.concurrency,
      order: m.order,
    },
    report,
    scope:
      "Operator declarations and local byte bindings only; init/pending is not evidence. Shared host/model/settings/snapshot/input/budget and alternating order are preregistered, not execution-verified. External snapshot and task/success/threshold texts and preregistration time are not independently certified. PTC executionMode is a declaration, not host acceptance. runtime commonly uses ptc but native presentation is supported; baseline may use native or ptc. No automatic model-benefit or release claim.",
  };
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!["init", "check"].includes(command)) fail();
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i],
      value = rest[i + 1];
    if (
      !["--candidate", "--manifest", "--observations"].includes(key) ||
      Object.hasOwn(options, key) ||
      !value ||
      value.startsWith("--")
    )
      fail();
    options[key] = value;
  }
  if (
    !options["--candidate"] ||
    (command === "check") !== Boolean(options["--manifest"]) ||
    (command === "init" && options["--observations"])
  )
    fail();
  return { command, options };
}
export function main(argv = process.argv.slice(2), emit = console.log) {
  try {
    const { command, options } = parseArgs(argv);
    const sha = candidateHash(options["--candidate"]);
    const result =
      command === "init"
        ? createTemplate(sha)
        : checkManifest(
            JSON.parse(
              boundedRead(options["--manifest"], 64 * 1024).toString("utf8"),
            ),
            sha,
            options["--observations"]
              ? boundedRead(options["--observations"])
              : null,
          );
    emit(JSON.stringify(result, null, 2));
    return {
      result,
      exitCode: command === "init" || result.planComplete ? 0 : 2,
    };
  } catch {
    fail();
  } // No raw input, path, candidate body or system exception is printed.
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    process.exitCode = main().exitCode;
  } catch {
    console.error(
      "PILOT_MANIFEST_ERROR: invalid local manifest, candidate, observations or arguments",
    );
    process.exitCode = 1;
  }
}

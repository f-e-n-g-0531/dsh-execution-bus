import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  createTemplate,
  validateManifest,
  checkManifest,
  parseArgs,
  main,
} from "../scripts/pilot-manifest.mjs";

const hash = (v) => createHash("sha256").update(v).digest("hex");
const candidate = hash("synthetic candidate archive bytes, not a release");
function complete() {
  return {
    ...createTemplate(candidate),
    hostId: "exact-host-build-1",
    modelId: "provider/exact-model-1",
    sandbox: "read-only",
    executionMode: "per-call",
    presentation: { native: "native", runtime: "ptc" },
    snapshotSha256: hash("snapshot fixture"),
    planSha256: hash("external controlled task plan fixture"),
    successCriteriaSha256: hash("external success criteria fixture"),
    decisionThresholdsSha256: hash("external decision thresholds fixture"),
    modelSettingsSha256: hash("external equal model settings fixture"),
    registeredAt: "2026-11-02T06:00:00Z",
    concurrency: { native: 2, runtime: 2 },
    order: { strategy: "alternating", firstArm: "native", pairs: 2 },
  };
}
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pilot-manifest-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("init is bound to candidate but null fields and absent observations remain pending, never evidence", () => {
  const template = createTemplate(candidate);
  assert.equal(template.evidenceReady, false);
  const result = checkManifest(template, candidate);
  assert.equal(result.planComplete, false);
  assert.equal(result.observationsPresent, false);
  assert.equal(result.evidenceReady, false);
  assert.equal(result.report, null);
  assert.equal(result.bindingSha256, null);
  assert.equal(result.declared.order.pairs, null); // 36 attempts is not a global default sample claim
  for (const name of [
    "hostId",
    "modelId",
    "executionMode",
    "snapshotSha256",
    "registeredAt",
    "planSha256",
    "successCriteriaSha256",
    "decisionThresholdsSha256",
    "modelSettingsSha256",
    "concurrency.native",
    "presentation.runtime",
  ])
    assert.ok(result.missing.includes(name));
  assert.throws(
    () => checkManifest(template, candidate, Buffer.from("[]")),
    /INVALID_PILOT_MANIFEST/,
  );
  assert.throws(() => createTemplate("not a digest"), /INVALID_PILOT_MANIFEST/);
});

test("strict validation rejects unknown, missing, inherited, accessor, malformed or unequal settings", () => {
  const changes = [
    (m) => {
      m.command = "secret";
    },
    (m) => {
      delete m.hostId;
    },
    (m) => {
      m.evidenceReady = true;
    },
    (m) => {
      m.presentation.command = "secret";
    },
    (m) => {
      m.concurrency.native = 1;
    },
    (m) => {
      m.concurrency.runtime = 5;
    },
    (m) => {
      m.order.strategy = "uncontrolled";
    },
    (m) => {
      m.order.firstArm = "unknown";
    },
    (m) => {
      m.order.pairs = 0;
    },
    (m) => {
      m.mode = "default-preset";
    },
    (m) => {
      m.executionMode = "unknown";
    },
    (m) => {
      m.sandbox = "disabled-maybe";
    },
    (m) => {
      m.modelId = "unknown";
    },
    (m) => {
      m.hostId = "line\nbreak";
    },
    (m) => {
      m.modelId = "";
    },
    (m) => {
      m.snapshotSha256 = "path/to/snapshot";
    },
    (m) => {
      m.successCriteriaSha256 = "plain success text";
    },
    (m) => {
      m.planSha256 = "a".repeat(63);
    },
    (m) => {
      m.decisionThresholdsSha256 = undefined;
    },
    (m) => {
      m.registeredAt = "2026-11-02T06:00:00";
    },
    (m) => {
      m.registeredAt = "2026-02-30T06:00:00Z";
    },
    (m) => {
      Object.defineProperty(m, "hostId", {
        get() {
          throw Error("must not invoke");
        },
        enumerable: true,
      });
    },
    (m) => {
      m[Symbol("secret")] = "secret";
    },
  ];
  for (const change of changes) {
    const m = complete();
    change(m);
    assert.throws(
      () => validateManifest(m, candidate),
      /INVALID_PILOT_MANIFEST/,
    );
  }
  assert.throws(
    () => validateManifest(Object.create(complete()), candidate),
    /INVALID_PILOT_MANIFEST/,
  );
  assert.throws(
    () => checkManifest(complete(), hash("different candidate")),
    /INVALID_PILOT_MANIFEST/,
  );
});

test("canonical binding is stable across key order and changes with exact IDs, settings and candidate", () => {
  const m = complete();
  const a = checkManifest(m, candidate);
  assert.equal(a.planComplete, true);
  assert.equal(a.evidenceReady, false);
  assert.equal(a.observationsPresent, false);
  const reordered = Object.fromEntries(Object.entries(m).reverse());
  reordered.order = Object.fromEntries(Object.entries(m.order).reverse());
  assert.equal(
    checkManifest(reordered, candidate).manifestSha256,
    a.manifestSha256,
  );
  for (const change of [
    (v) => {
      v.hostId += ".different-build";
    },
    (v) => {
      v.modelId += ".different-version";
    },
    (v) => {
      v.executionMode = "persistent-in-memory";
    },
    (v) => {
      v.presentation.native = "ptc";
    },
    (v) => {
      v.presentation.runtime = "native";
    },
    (v) => {
      v.order.pairs = 1;
    },
    (v) => {
      v.order.firstArm = "runtime";
    },
    (v) => {
      v.decisionThresholdsSha256 = hash(
        "different preregistered threshold fixture",
      );
    },
    (v) => {
      v.snapshotSha256 = hash("different external snapshot fixture");
    },
  ]) {
    const changed = structuredClone(m);
    change(changed);
    const result = checkManifest(changed, candidate);
    assert.notEqual(result.manifestSha256, a.manifestSha256);
    assert.equal(result.evidenceReady, false);
  }
  const next = { ...m, candidateSha256: hash("different candidate bytes") };
  assert.notEqual(
    checkManifest(next, next.candidateSha256).manifestSha256,
    a.manifestSha256,
  );
});

test("optional observation byte binding reuses pilot semantics without turning supplied data into evidence", () => {
  const rows = [
    {
      version: 1,
      arm: "native",
      outcome: "failed",
      pairId: "private task body",
      metrics: { toolRequests: 3, toolSuccesses: 1 },
    },
    {
      version: 1,
      arm: "runtime",
      outcome: "unknown",
      pairId: "private task body",
      metrics: {},
    },
    {
      version: 1,
      arm: "runtime",
      outcome: "aborted",
      metrics: { wallTimeMs: 0 },
    },
  ];
  const bytes = Buffer.from(
    rows.map((r) => JSON.stringify(r)).join("\n") +
      '\n{"command":"private-command"\n',
  );
  const a = checkManifest(complete(), candidate, bytes);
  assert.equal(a.observationsPresent, true);
  assert.equal(a.observationsSha256, hash(bytes));
  assert.equal(a.evidenceReady, false);
  assert.equal(a.report.arms.native.outcomes.failed, 1);
  assert.equal(a.report.arms.native.metrics.toolRequests.mean, 3);
  assert.equal(a.report.arms.native.metrics.toolSuccesses.mean, 1);
  assert.equal(a.report.arms.runtime.metrics.toolSuccesses.mean, null);
  assert.equal(a.report.arms.runtime.metrics.toolSuccesses.missing, 2);
  assert.equal(a.report.pairs.bothSucceeded, 0);
  assert.equal(a.report.diagnostics.malformed, 1);
  assert.doesNotMatch(JSON.stringify(a), /private task body|private-command/);
  const b = checkManifest(
    complete(),
    candidate,
    Buffer.concat([bytes, Buffer.from("\n")]),
  );
  assert.deepEqual(a.report, b.report);
  assert.notEqual(a.bindingSha256, b.bindingSha256); // actual bytes, not just parsed data
  const empty = checkManifest(complete(), candidate, Buffer.from("[]"));
  assert.equal(empty.observationsPresent, false);
  assert.equal(empty.report.arms.native.successRate, null);
  assert.equal(empty.evidenceReady, false);
});

test("report output hashes even path-like exact IDs instead of echoing business labels", () => {
  const m = complete();
  m.hostId = "G:/private-business/exact-host";
  m.modelId = "/private-business/private-command-exact-model";
  const report = checkManifest(m, candidate);
  assert.equal(report.declared.hostIdSha256, hash(m.hostId));
  assert.equal(report.declared.modelIdSha256, hash(m.modelId));
  assert.doesNotMatch(
    JSON.stringify(report),
    /private-business|private-command|exact-host/,
  );
});

test("CLI hashes actual candidate bytes and keeps errors/local paths private", (t) => {
  const root = fixture(t);
  const archive = path.join(root, "private-candidate.tgz");
  const manifestPath = path.join(root, "private-manifest.json");
  writeFileSync(archive, "synthetic candidate archive bytes, not a release");
  let output;
  const init = main(["init", "--candidate", archive], (s) => {
    output = s;
  });
  assert.equal(init.exitCode, 0);
  assert.equal(JSON.parse(output).candidateSha256, candidate);
  writeFileSync(manifestPath, output);
  const pending = main(
    ["check", "--candidate", archive, "--manifest", manifestPath],
    (s) => {
      output = s;
    },
  );
  assert.equal(pending.exitCode, 2);
  assert.equal(JSON.parse(output).evidenceReady, false);
  writeFileSync(manifestPath, JSON.stringify(complete()));
  const checked = main(
    ["check", "--candidate", archive, "--manifest", manifestPath],
    (s) => {
      output = s;
    },
  );
  assert.equal(checked.exitCode, 0); // complete declaration only, NOT evidence acceptance
  assert.equal(JSON.parse(output).evidenceReady, false);
  assert.doesNotMatch(output, /private-candidate|private-manifest/);
  writeFileSync(archive, "changed candidate bytes");
  assert.throws(
    () => main(["check", "--candidate", archive, "--manifest", manifestPath]),
    /INVALID_PILOT_MANIFEST/,
  );
  const cli = spawnSync(
    process.execPath,
    [
      "scripts/pilot-manifest.mjs",
      "check",
      "--candidate",
      archive,
      "--manifest",
      manifestPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, "");
  assert.doesNotMatch(
    cli.stderr,
    /private-candidate|private-manifest|changed candidate|stack/,
  );
  assert.throws(
    () => main(["init", "--candidate", root]),
    /INVALID_PILOT_MANIFEST/,
  );
  for (const args of [
    [],
    ["init"],
    ["check", "--candidate", archive],
    ["init", "--candidate", archive, "--manifest", manifestPath],
    ["init", "--candidate", archive, "--observations", manifestPath],
    ["init", "--candidate", archive, "--candidate", archive],
    ["init", "--command", "private-command"],
  ])
    assert.throws(() => parseArgs(args), /INVALID_PILOT_MANIFEST/);
});

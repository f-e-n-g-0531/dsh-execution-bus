import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  ACCEPTANCE_CASES,
  createTemplate,
  evaluateReport,
  candidateHash,
} from "../scripts/acceptance-report.mjs";

const identity = {
  packageName: "@feng0531/dsh-execution-bus",
  version: "1.2.0",
  candidateSha256: "a".repeat(64),
};
const fresh = () => createTemplate(identity);
function complete() {
  const report = fresh();
  report.environment = {
    dsh: "0.2.1-rc.2",
    cordis: "4.0.5",
    node: "24.21.0",
    platform: "win32",
    model: "test-model",
    permissionProfile: "isolated-matrix",
  };
  for (const entry of report.cases) {
    entry.status = "pass";
    entry.startedAt = "2026-10-23T10:00:00+08:00";
    entry.finishedAt = "2026-10-23T10:01:00+08:00";
    entry.evidenceId = "evidence-" + entry.id;
    for (const key of Object.keys(entry.assertions))
      entry.assertions[key] = true;
  }
  return report;
}
test("acceptance template is pending, bound to candidate and never claims execution", () => {
  const template = fresh();
  assert.equal(template.cases.length, Object.keys(ACCEPTANCE_CASES).length);
  const result = evaluateReport(template);
  assert.equal(result.ready, false);
  assert.equal(result.counts.pending, template.cases.length);
  assert.ok(result.missingEnvironment.includes("dsh"));
  assert.match(result.scope, /not independent verification/);
  assert.doesNotMatch(JSON.stringify(result), /command|file_path/);
});
test("acceptance requires all assertions, evidence, ordered timestamps and complete environment", () => {
  assert.equal(evaluateReport(complete()).ready, true);
  for (const mutate of [
    (r) => {
      r.cases[0].assertions.targetToolsVisible = false;
    },
    (r) => {
      r.cases[0].assertions.targetToolsVisible = null;
    },
    (r) => {
      r.cases[0].evidenceId = null;
    },
    (r) => {
      r.cases[0].finishedAt = "2026-10-23T09:00:00+08:00";
    },
    (r) => {
      r.cases[0].startedAt = null;
    },
    (r) => {
      r.cases[0].finishedAt = "2026-10-23T10:01:00";
    },
  ]) {
    const report = complete();
    mutate(report);
    assert.throws(() => evaluateReport(report), /INVALID_ACCEPTANCE_REPORT/);
  }
  for (const status of ["skipped", "pending", "fail"]) {
    const report = complete();
    report.cases[0].status = status;
    assert.equal(evaluateReport(report).ready, false);
  }
  const report = complete();
  report.environment.model = null;
  assert.equal(evaluateReport(report).ready, false);
});
test("acceptance rejects malformed, duplicate, missing, injected and stale-candidate evidence", () => {
  for (const mutate of [
    (r) => {
      r.command = "secret";
    },
    (r) => {
      r.environment.token = "secret";
    },
    (r) => {
      r.cases[0].logPath = "secret";
    },
    (r) => {
      r.cases[0].assertions.extra = true;
    },
    (r) => {
      delete r.cases[0].assertions.targetToolsVisible;
    },
    (r) => {
      r.cases[1] = r.cases[0];
    },
    (r) => {
      r.cases[0].id = "__proto__";
    },
    (r) => {
      r.cases[0].status = "__proto__";
    },
    (r) => {
      r.cases[0].status = ["pass"];
    },
    (r) => {
      r.cases[0].id = ["preset-isolation"];
    },
    (r) => {
      r.cases[0].evidenceId = "C:/private/log";
    },
    (r) => {
      r.cases.pop();
    },
    (r) => {
      r.candidate.sha256 = "invalid";
    },
  ]) {
    const report = complete();
    mutate(report);
    assert.throws(() => evaluateReport(report), /INVALID_ACCEPTANCE_REPORT/);
  }
  const coercion = fresh();
  coercion.environment = complete().environment;
  for (const entry of coercion.cases) entry.status = ["pass"];
  assert.throws(() => evaluateReport(coercion), /INVALID_ACCEPTANCE_REPORT/);
  assert.throws(
    () =>
      evaluateReport(complete(), {
        packageName: identity.packageName,
        version: identity.version,
        sha256: "b".repeat(64),
      }),
    /CANDIDATE_MISMATCH/,
  );
});
test("acceptance CLI fails closed, redacts errors, and hashes exact archive bytes", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xiaohe-acceptance-"));
  try {
    const candidate = path.join(dir, "candidate.tgz");
    const report = path.join(dir, "report.json");
    writeFileSync(candidate, "fixture bytes, not a real npm archive");
    assert.equal(candidateHash(candidate).length, 64);
    const call = (...args) =>
      spawnSync(process.execPath, ["scripts/acceptance-report.mjs", ...args], {
        encoding: "utf8",
      });
    const init = call("init", "--candidate", candidate);
    assert.equal(init.status, 0, init.stderr);
    const pending = JSON.parse(init.stdout);
    assert.equal(pending.candidate.sha256, candidateHash(candidate));
    writeFileSync(report, JSON.stringify(pending));
    const check = call("check", "--candidate", candidate, "--report", report);
    assert.equal(check.status, 2);
    assert.equal(JSON.parse(check.stdout).ready, false);
    for (const args of [
      [],
      ["init"],
      ["init", "--candidate", candidate, "--report", report],
      ["init", "--candidate", candidate, "--candidate", candidate],
      [
        "check",
        "--candidate",
        candidate,
        "--report",
        path.join(dir, "secret-missing"),
      ],
    ]) {
      const bad = call(...args);
      assert.equal(bad.status, 1);
      assert.equal(bad.stdout, "");
      assert.ok(!bad.stderr.includes(dir));
    }
    writeFileSync(report, "x".repeat(1024 * 1024 + 1));
    assert.equal(
      call("check", "--candidate", candidate, "--report", report).status,
      1,
    );
    assert.throws(() => candidateHash(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { verifyTag } from "../scripts/verify-tag.mjs";
import { verifyReport } from "../scripts/verify-package.mjs";
const pkg = JSON.parse(readFileSync("package.json"));
const lock = JSON.parse(readFileSync("package-lock.json"));
test("tag gate rejects mismatched versions, leading zeroes and prerelease", () => {
  verifyTag("v" + pkg.version, pkg, lock);
  for (const tag of ["v00.1.0", "v1.2.3", "v0.1.0-beta", "v0x1x0"])
    assert.throws(() => verifyTag(tag, pkg, lock));
  assert.throws(() => verifyTag("v" + pkg.version, pkg, { ...lock, version: "other" }));
});
test("package whitelist rejects missing exports and sensitive additions", () => {
  const required = [
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "package.json",
    "README.md",
    "cordis.patch.yml",
    "dist/error-codes.js",
    "dist/error-codes.d.ts",
    "dist/mode.js",
    "dist/mode.d.ts",
    "dist/plugin.js",
    "dist/plugin.d.ts",
    "dist/preset.js",
    "dist/preset.d.ts",
    "dist/product.js",
    "dist/product.d.ts",
    "dist/presentation.js",
    "dist/presentation.d.ts",
    "dist/test-mode.js",
    "dist/test-mode.d.ts",
    "dist/runtime/plan.js",
    "dist/runtime/plan.d.ts",
    "dist/runtime/store.js",
    "dist/runtime/store.d.ts",
    "dist/runtime/executor.js",
    "dist/runtime/executor.d.ts",
    "dist/runtime/service.js",
    "dist/runtime/service.d.ts",
    "docs/host-compatibility.md",
    "docs/protocol.md",
    "docs/validation.md",
    "docs/RELEASING.md",
    "docs/DECLARATIVE-RUNTIME.md",
    "docs/OPERATIONS.md",
    "scripts/acceptance-report.mjs",
    "scripts/pilot-report.mjs",
    "scripts/benchmark-runtime.mjs",
    "scripts/session-metrics.mjs",
    "docs/releases/" + pkg.version + ".md",
  ];
  const report = {
    name: pkg.name,
    version: pkg.version,
    files: required.map((path) => ({ path, size: 1 })),
  };
  assert.equal(verifyReport(report, pkg), required.length);
  assert.throws(() => verifyReport({ ...report, files: report.files.slice(1) }, pkg));
  assert.throws(() =>
    verifyReport({ ...report, files: [...report.files, { path: ".npmrc", size: 1 }] }, pkg),
  );
  assert.throws(() => verifyReport({ ...report, bundled: ["secret"] }, pkg));
});
test("CI is tag/manual only with four platform combinations and exact candidate install", () => {
  const ci = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  assert.deepEqual(Object.keys(ci.on).sort(), ["push", "workflow_dispatch"]);
  assert.deepEqual(Object.keys(ci.on.push), ["tags"]);
  assert.deepEqual(ci.jobs.test.strategy.matrix, {
    os: ["ubuntu-latest", "windows-latest"],
    node: [22, 24],
  });
  assert.equal(ci.permissions.contents, "read");
  const runs = ci.jobs.test.steps.map((step) => step.run).filter(Boolean);
  assert.ok(runs.includes("npm run check"));
  assert.ok(runs.some((run) => run.includes("test:install -- artifacts/candidate/")));
  assert.ok(!JSON.stringify(ci).includes("NODE_AUTH_TOKEN"));
});
test("release requires main, manual confirmation, exact-tag artifacts, npm then public verify then GitHub", () => {
  const workflow = parse(readFileSync(".github/workflows/release.yml", "utf8"));
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, {});
  assert.equal(workflow.jobs.publish.environment, "npm-release");
  assert.equal(workflow.jobs.publish.if, "github.ref == 'refs/heads/main'");
  const steps = workflow.jobs.publish.steps;
  const index = (text) => steps.findIndex((step) => step.run?.includes(text));
  assert.ok(index("release-preflight") < index("npm ci"));
  assert.ok(index("require-tag-ci") < index("npm-release.mjs publish"));
  assert.ok(index("npm-release.mjs publish") < index("npm-release.mjs verify"));
  assert.ok(index("npm-release.mjs verify") < index("gh release create"));
  assert.equal(steps.filter((step) => step.env?.NODE_AUTH_TOKEN).length, 1);
  assert.ok(steps[index("npm-release.mjs publish")].env.NODE_AUTH_TOKEN);
});
test("release preflight requires explicit confirmation without touching registry", () => {
  const result = spawnSync(process.execPath, ["scripts/release-preflight.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_TAG: "v" + pkg.version,
      CONFIRM_PUBLISH: "not-authorized",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Explicit publication confirmation required/);
});

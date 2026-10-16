import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { verifyTag } from "../scripts/verify-tag.mjs";
import { verifyReport } from "../scripts/verify-package.mjs";
const pkg = JSON.parse(readFileSync("package.json")),
  lock = JSON.parse(readFileSync("package-lock.json"));
test("tag gate rejects mismatched versions, leading zeroes and prerelease", () => {
  verifyTag("v" + pkg.version, pkg, lock);
  for (const tag of ["v00.1.0", "v1.2.3", "v0.1.0-beta", "v0x1x0"])
    assert.throws(() => verifyTag(tag, pkg, lock));
  assert.throws(() =>
    verifyTag("v" + pkg.version, pkg, { ...lock, version: "other" }),
  );
});
test("package whitelist rejects missing exports and sensitive additions", () => {
  const required = [
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "package.json",
    "README.md",
    "cordis.patch.yml",
    "dist/preset.js",
    "dist/preset.d.ts",
    "dist/test-mode.js",
    "dist/test-mode.d.ts",
    "dist/json.js",
    "dist/json.d.ts",
    "dist/bus.js",
    "dist/bus.d.ts",
    "dist/plugin.js",
    "dist/plugin.d.ts",
    "dist/handlers.js",
    "dist/handlers.d.ts",
    "docs/host-compatibility.md",
    "docs/protocol.md",
    "docs/validation.md",
    "docs/RELEASING.md",
    "docs/releases/" + pkg.version + ".md",
  ];
  const r = {
    name: pkg.name,
    version: pkg.version,
    files: required.map((path) => ({ path, size: 1 })),
  };
  assert.equal(verifyReport(r, pkg), required.length);
  assert.throws(() => verifyReport({ ...r, files: r.files.slice(1) }, pkg));
  assert.throws(() =>
    verifyReport(
      { ...r, files: [...r.files, { path: ".npmrc", size: 1 }] },
      pkg,
    ),
  );
  assert.throws(() => verifyReport({ ...r, bundled: ["secret"] }, pkg));
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
  const runs = ci.jobs.test.steps.map((s) => s.run).filter(Boolean);
  assert.ok(runs.includes("npm run check"));
  assert.ok(
    runs.some((r) => r.includes("test:install -- artifacts/candidate/")),
  );
  assert.ok(!JSON.stringify(ci).includes("NODE_AUTH_TOKEN"));
});
test("release requires main, manual confirmation, exact-tag artifacts, npm then public verify then GitHub", () => {
  const w = parse(readFileSync(".github/workflows/release.yml", "utf8"));
  assert.deepEqual(Object.keys(w.on), ["workflow_dispatch"]);
  assert.deepEqual(w.permissions, {});
  assert.equal(w.jobs.publish.environment, "npm-release");
  assert.equal(w.jobs.publish.if, "github.ref == 'refs/heads/main'");
  const steps = w.jobs.publish.steps;
  const index = (text) => steps.findIndex((s) => s.run?.includes(text));
  assert.ok(index("release-preflight") < index("npm ci"));
  assert.ok(index("require-tag-ci") < index("npm-release.mjs publish"));
  assert.ok(index("npm-release.mjs publish") < index("npm-release.mjs verify"));
  assert.ok(index("npm-release.mjs verify") < index("gh release create"));
  assert.equal(steps.filter((s) => s.env?.NODE_AUTH_TOKEN).length, 1);
  assert.ok(steps[index("npm-release.mjs publish")].env.NODE_AUTH_TOKEN);
});
test("release preflight requires explicit confirmation without touching registry", () => {
  const r = spawnSync(process.execPath, ["scripts/release-preflight.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_TAG: "v" + pkg.version,
      CONFIRM_PUBLISH: "not-authorized",
    },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Explicit publication confirmation required/);
});

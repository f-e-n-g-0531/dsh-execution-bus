import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
    "locale/en.json",
    "locale/zh.json",
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
    "dist/runtime/agent.js",
    "dist/runtime/agent.d.ts",
    "dist/runtime/agent-report.js",
    "dist/runtime/agent-report.d.ts",
    "dist/runtime/agent-trace.js",
    "dist/runtime/agent-trace.d.ts",
    "dist/runtime/host-compat.js",
    "dist/runtime/host-compat.d.ts",
    "dist/runtime/dependency-context.js",
    "dist/runtime/dependency-context.d.ts",
    "dist/runtime/model-wait.js",
    "dist/runtime/model-wait.d.ts",
    "dist/runtime/handoff.js",
    "dist/runtime/handoff.d.ts",
    "dist/runtime/prompt-history.js",
    "dist/runtime/prompt-history.d.ts",
    "dist/runtime/decision.js",
    "dist/runtime/decision.d.ts",
    "dist/runtime/prompt-preview.js",
    "dist/runtime/prompt-preview.d.ts",
    "dist/runtime/worker-quota.js",
    "dist/runtime/worker-quota.d.ts",
    "dist/runtime/insights.js",
    "dist/runtime/insights.d.ts",
    "dist/runtime/acknowledgement.js",
    "dist/runtime/acknowledgement.d.ts",
    "dist/runtime/action.js",
    "dist/runtime/action.d.ts",
    "dist/runtime/notifications.js",
    "dist/runtime/notifications.d.ts",
    "dist/runtime/notification-delivery.js",
    "dist/runtime/notification-delivery.d.ts",
    "dist/runtime/attention.js",
    "dist/runtime/attention.d.ts",
    "dist/runtime/query.js",
    "dist/runtime/query.d.ts",
    "dist/runtime/history.js",
    "dist/runtime/history.d.ts",
    "dist/runtime/waiting.js",
    "dist/runtime/waiting.d.ts",
    "dist/runtime/review.js",
    "dist/runtime/review.d.ts",
    "dist/runtime/retry.js",
    "dist/runtime/retry.d.ts",
    "dist/runtime/plan.js",
    "dist/runtime/plan.d.ts",
    "dist/runtime/plan-diff.js",
    "dist/runtime/plan-diff.d.ts",
    "dist/runtime/root-lock.js",
    "dist/runtime/root-lock.d.ts",
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
    "scripts/pilot-manifest.mjs",
    "docs/DEVELOPMENT-PLAN.md",
    "docs/RESEARCH-READINESS.md",
    "docs/SUPERAGENT-COMPARISON.md",
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
  assert.throws(
    () =>
      verifyReport(
        {
          ...report,
          files: report.files.filter(
            (f) => f.path !== "docs/RESEARCH-READINESS.md",
          ),
        },
        pkg,
      ),
    /Missing packed file/,
  );
  assert.doesNotThrow(() => verifyReport(report, pkg));
  assert.throws(() =>
    verifyReport({ ...report, files: report.files.slice(1) }, pkg),
  );
  assert.throws(() =>
    verifyReport(
      { ...report, files: [...report.files, { path: ".npmrc", size: 1 }] },
      pkg,
    ),
  );
  assert.throws(() => verifyReport({ ...report, bundled: ["secret"] }, pkg));
});
test("all host peers and locked DSH components target 0.2.3-alpha.2 without mixed release candidates", () => {
  const target = "0.2.3-alpha.2";
  assert.deepEqual(lock.packages[""].peerDependencies, pkg.peerDependencies);
  assert.deepEqual(lock.packages[""].devDependencies, pkg.devDependencies);
  for (const [name, version] of Object.entries({
    ...pkg.peerDependencies,
    ...pkg.devDependencies,
  })) {
    if (name.startsWith("@deepseek-ai/dsh-"))
      assert.equal(version, target, name);
  }
  const components = Object.entries(lock.packages).filter(([name]) =>
    name.includes("node_modules/@deepseek-ai/dsh-"),
  );
  assert.ok(components.length > 20);
  for (const [name, entry] of components)
    assert.equal(entry.version, target, name);
});

test("CI is tag/manual only with four platform combinations and exact candidate install", () => {
  const ci = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  assert.deepEqual(Object.keys(ci.on).sort(), ["push", "workflow_dispatch"]);
  assert.deepEqual(Object.keys(ci.on.push), ["tags"]);
  assert.deepEqual(ci.jobs.test.strategy.matrix, {
    os: ["ubuntu-latest", "windows-latest"],
    node: ["24.22.3", "26.13.1"],
  });
  assert.equal(ci.permissions.contents, "read");
  const runs = ci.jobs.test.steps.map((step) => step.run).filter(Boolean);
  for (const step of ["npm run check", "node scripts/verify-dist.mjs", "npm run pack:candidate"]) assert.ok(runs.includes(step));
  assert.ok(runs.indexOf("npm run check") < runs.indexOf("node scripts/verify-dist.mjs"));
  assert.ok(runs.indexOf("node scripts/verify-dist.mjs") < runs.indexOf("npm run pack:candidate"));
  assert.ok(
    runs.some((run) => run.includes("test:install -- artifacts/candidate/")),
  );
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
  for (const step of ["release-preflight", "npm ci", "require-tag-ci", "npm-release.mjs publish", "npm-release.mjs verify", "gh release create"]) {
    assert.ok(index(step) >= 0, `Missing required release step: ${step}`);
  }
  assert.ok(index("release-preflight") < index("npm ci"));
  assert.ok(index("require-tag-ci") < index("npm-release.mjs publish"));
  assert.ok(index("npm-release.mjs publish") < index("npm-release.mjs verify"));
  assert.ok(index("npm-release.mjs verify") < index("gh release create"));
  assert.equal(steps.filter((step) => step.env?.NODE_AUTH_TOKEN).length, 1);
  assert.ok(steps[index("npm-release.mjs publish")].env.NODE_AUTH_TOKEN);
});
test("dist gate compares raw bytes and detects missing and extra files", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "xiaohe-dist-gate-"));
  const fixture = path.join(cwd, "dist", "entry.js");
  const script = fileURLToPath(new URL("../scripts/verify-dist.mjs", import.meta.url));
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr ?? String(r.error));
  };
  const check = () => spawnSync(process.execPath, [script], { cwd, encoding: "utf8" });
  try {
    git("init", "-q");
    mkdirSync(path.dirname(fixture));
    writeFileSync(path.join(cwd, ".gitattributes"), "* text=auto eol=lf\n");
    writeFileSync(path.join(cwd, ".gitignore"), "dist/extra.js\n");
    writeFileSync(fixture, "export {};\n");
    // Include multiple blobs, a duplicate OID, a zero-length blob and binary LF/NUL.
    const binary = Buffer.from([0x00, 0x0a, 0xff, 0x0d, 0x0a]);
    writeFileSync(path.join(cwd, "dist", "a.bin"), binary);
    writeFileSync(path.join(cwd, "dist", "b.bin"), binary);
    writeFileSync(path.join(cwd, "dist", "empty.bin"), Buffer.alloc(0));
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
    const good = check();
    assert.equal(good.status, 0, good.stderr);
    const duplicate = path.join(cwd, "dist", "b.bin");
    writeFileSync(duplicate, Buffer.from([0x00, 0x0a, 0xfe, 0x0d, 0x0a]));
    assert.match(check().stderr, /Generated bytes differ: dist[/]b.bin/);
    writeFileSync(duplicate, binary);
    writeFileSync(fixture, "export {};\r\n");
    assert.match(check().stderr, /Generated bytes differ/);
    rmSync(fixture);
    assert.match(check().stderr, /Missing dist files/);
    writeFileSync(fixture, "export {};\n");
    writeFileSync(path.join(cwd, "dist", "extra.js"), "export {};\n");
    assert.match(check().stderr, /Unexpected dist entry/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("release preflight requires explicit confirmation without touching registry", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/release-preflight.mjs"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        RELEASE_TAG: "v" + pkg.version,
        CONFIRM_PUBLISH: "not-authorized",
      },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Explicit publication confirmation required/);
});

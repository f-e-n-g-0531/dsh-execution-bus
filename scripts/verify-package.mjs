import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { npm, report } from "./npm.mjs";
export function verifyReport(r, p) {
  assert.equal(p.name, "@feng0531/dsh-execution-bus");
  assert.match(
    p.version,
    /^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$/,
  );
  assert.equal(p.type, "module");
  assert.equal(r.name, p.name);
  assert.equal(r.version, p.version);
  assert.deepEqual(r.bundled ?? [], []);
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
    "dist/runtime/prompt-preview.js",
    "dist/runtime/prompt-preview.d.ts",
    "dist/runtime/worker-quota.js",
    "dist/runtime/worker-quota.d.ts",
    "dist/runtime/insights.js",
    "dist/runtime/insights.d.ts",
    "dist/runtime/decision.js",
    "dist/runtime/decision.d.ts",
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
    "docs/releases/" + p.version + ".md",
  ];
  const allowed = new Set([
    ...required,
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "docs/FLOW-TEST.md",
    "docs/OPTIMIZATION.md",
    "docs/GITHUB-COMPARISON.md",
    "docs/INTEGRATION.md",
    "docs/PRODUCT.md",
    "docs/RETROSPECTIVE.md",
  ]);
  const paths = new Set();
  for (const f of r.files) {
    assert.ok(
      allowed.has(f.path) ||
        /^docs[/]releases[/][0-9]+[.][0-9]+[.][0-9]+[.]md$/.test(f.path),
      "Unexpected packed path: " + f.path,
    );
    assert.ok(!paths.has(f.path), "Duplicate packed path");
    assert.ok(Number.isSafeInteger(f.size) && f.size > 0);
    paths.add(f.path);
  }
  for (const f of required)
    assert.ok(paths.has(f), "Missing packed file: " + f);
  assert.deepEqual(p.exports, {
    ".": "./dist/plugin.js",
    "./mode": "./dist/mode.js",
    "./test-mode": "./dist/mode.js",
    "./preset": "./dist/preset.js",
    "./package.json": "./package.json",
    "./locale/*.json": "./locale/*.json",
  });
  for (const target of Object.values(p.exports)) {
    if (target.includes("*")) continue;
    assert.ok(paths.has(target.slice(2)));
  }
  assert.deepEqual(
    Object.keys(p.peerDependencies).sort(),
    [
      "@deepseek-ai/cordis",
      "@deepseek-ai/cordis-plugin-include",
      "@deepseek-ai/dsh-agent-preset-registry",
      "@deepseek-ai/dsh-agent",
      "@deepseek-ai/dsh-llm",
      "@deepseek-ai/dsh-session",
      "@deepseek-ai/dsh-sandbox-policy",
      "@deepseek-ai/dsh-user-approval",
      "@deepseek-ai/dsh-working-directory",
      "@deepseek-ai/dsh-tool-executor-native",
      "@deepseek-ai/dsh-scope",
      "@deepseek-ai/dsh-system-prompt",
      "@deepseek-ai/dsh-tools",
    ].sort(),
  );
  for (const [name, range] of Object.entries(p.peerDependencies))
    assert.equal(typeof range, "string", "invalid peer range: " + name);
  return paths.size;
}
if (process.argv[1]?.endsWith("verify-package.mjs")) {
  const p = JSON.parse(readFileSync("package.json", "utf8"));
  console.log(
    "Verified packed files:",
    verifyReport(
      report(npm(["pack", "--dry-run", "--ignore-scripts", "--json"])),
      p,
    ),
  );
}

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
    "dist/runtime/worker-quota.js",
    "dist/runtime/worker-quota.d.ts",
    "dist/runtime/insights.js",
    "dist/runtime/insights.d.ts",
    "dist/runtime/attention.js",
    "dist/runtime/attention.d.ts",
    "dist/runtime/waiting.js",
    "dist/runtime/waiting.d.ts",
    "dist/runtime/review.js",
    "dist/runtime/review.d.ts",
    "dist/runtime/retry.js",
    "dist/runtime/retry.d.ts",
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
    "scripts/pilot-manifest.mjs",
    "docs/DEVELOPMENT-PLAN.md",
    "docs/RESEARCH-READINESS.md",
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
  assert.deepEqual(p.peerDependencies, {
    "@deepseek-ai/cordis": "~4.1.0",
    "@deepseek-ai/cordis-plugin-include": "~1.1.0",
    "@deepseek-ai/dsh-agent-preset-registry": "0.2.2-rc.1",
    "@deepseek-ai/dsh-agent": "0.2.2-rc.1",
    "@deepseek-ai/dsh-llm": "0.2.2-rc.1",
    "@deepseek-ai/dsh-session": "0.2.2-rc.1",
    "@deepseek-ai/dsh-sandbox-policy": "0.2.2-rc.1",
    "@deepseek-ai/dsh-user-approval": "0.2.2-rc.1",
    "@deepseek-ai/dsh-working-directory": "0.2.2-rc.1",
    "@deepseek-ai/dsh-tool-executor-native": "0.2.2-rc.1",
    "@deepseek-ai/dsh-scope": "0.2.2-rc.1",
    "@deepseek-ai/dsh-system-prompt": "0.2.2-rc.1",
    "@deepseek-ai/dsh-tools": "0.2.2-rc.1",
  });
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

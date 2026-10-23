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
  });
  for (const target of Object.values(p.exports))
    assert.ok(paths.has(target.slice(2)));
  assert.equal(p.peerDependencies["@deepseek-ai/dsh-tools"], "0.2.1-rc.2");
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

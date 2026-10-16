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
    "dist/preset.js",
    "dist/preset.d.ts",
    "dist/mode.js",
    "dist/mode.d.ts",
    "dist/product.js",
    "dist/product.d.ts",
    "dist/test-mode.js",
    "dist/test-mode.d.ts",
    "dist/json.js",
    "dist/json.d.ts",
    "dist/execution.js",
    "dist/execution.d.ts",
    "dist/diagnostics.js",
    "dist/diagnostics.d.ts",
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
    "docs/releases/" + p.version + ".md",
  ];
  const allowed = new Set([...required, "LICENSE", "THIRD_PARTY_NOTICES.md", "docs/FLOW-TEST.md", "docs/OPTIMIZATION.md", "docs/GITHUB-COMPARISON.md", "docs/INTEGRATION.md", "docs/PRODUCT.md"]);
  const paths = new Set();
  for (const f of r.files) {
    assert.ok(allowed.has(f.path) || /^docs[/]releases[/][0-9]+[.][0-9]+[.][0-9]+[.]md$/.test(f.path), "Unexpected packed path: " + f.path);
    assert.ok(!paths.has(f.path), "Duplicate packed path");
    assert.ok(Number.isSafeInteger(f.size) && f.size > 0);
    paths.add(f.path);
  }
  for (const f of required)
    assert.ok(paths.has(f), "Missing packed file: " + f);
  assert.deepEqual(p.exports, {
    ".": "./dist/plugin.js",
    "./core": "./dist/bus.js",
    "./mode": "./dist/mode.js",
    "./test-mode": "./dist/mode.js",
    "./preset": "./dist/preset.js",
  });
  for (const target of Object.values(p.exports))
    assert.ok(paths.has(target.slice(2)));
  assert.equal(p.peerDependencies["@deepseek-ai/dsh-tools"], "0.2.0-rc.2");
  assert.equal(p.peerDependencies["@deepseek-ai/dsh-jobs"], "0.2.0-rc.2");
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

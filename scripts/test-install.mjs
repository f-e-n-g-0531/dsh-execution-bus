import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { npm, report } from "./npm.mjs";
assert.ok(
  process.argv.length <= 3,
  "Usage: npm run test:install -- [local.tgz]",
);
const root = process.cwd(),
  temp = await mkdtemp(path.join(tmpdir(), "execution-bus-install-"));
try {
  const archive = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(
        temp,
        report(
          npm([
            "pack",
            "--ignore-scripts",
            "--json",
            "--pack-destination",
            temp,
          ]),
        ).filename,
      );
  assert.ok(archive.endsWith(".tgz") && (await stat(archive)).isFile());
  const expected = JSON.parse(await readFile("package.json", "utf8"));
  // Install the exact byte snapshot we hashed, even if another pack replaces the source path.
  const bytes = await readFile(archive);
  const snapshot = path.join(temp, "candidate-snapshot.tgz");
  await writeFile(snapshot, bytes, { flag: "wx" });
  console.log("Candidate SHA256:", createHash("sha256").update(bytes).digest("hex"));
  await writeFile(
    path.join(temp, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  npm(
    [
      "install",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      snapshot,
    ],
    temp,
  );
  const installed = path.join(temp, "node_modules/@feng0531/dsh-execution-bus");
  const actual = JSON.parse(
    await readFile(path.join(installed, "package.json"), "utf8"),
  );
  assert.equal(actual.name, expected.name);
  assert.equal(actual.version, expected.version);
  // A fresh child process rooted outside this checkout prevents resolving source devDependencies.
  const source = `import assert from 'node:assert/strict';import * as plugin from './node_modules/@feng0531/dsh-execution-bus/dist/plugin.js';
const preset=await import('./node_modules/@feng0531/dsh-execution-bus/dist/preset.js');assert.equal(preset.PRESET_ID,'xiao-he-runtime');assert.equal(preset.derivePreset('[]').plugins.at(-1).name,'@feng0531/dsh-execution-bus/mode');const mode=await import('@feng0531/dsh-execution-bus/mode');const legacy=await import('@feng0531/dsh-execution-bus/test-mode');assert.equal(mode,legacy);assert.equal(mode.apply,legacy.apply);
assert.equal(plugin.name,'xiao-he-runtime');assert.deepEqual(plugin.inject,['tools']);const tools=[];const disposers=[];
plugin.apply({effect(fn){disposers.push(fn())},tools:{register(t){tools.push(t)}}});assert.deepEqual(tools.map(t=>t.name).sort(),['runtime_cancel','runtime_result','runtime_resume','runtime_run','runtime_status']);const run=tools.find(t=>t.name==='runtime_run');assert.equal(typeof run.execute,'function');
await assert.rejects(run.execute({},{}),/OWNING_SESSION_REQUIRED/);for(const dispose of disposers)await dispose();
const acceptance=await import('./node_modules/@feng0531/dsh-execution-bus/scripts/acceptance-report.mjs');const template=acceptance.createTemplate({packageName:'@feng0531/dsh-execution-bus',version:'fixture',candidateSha256:'a'.repeat(64)});assert.equal(acceptance.evaluateReport(template).ready,false);await import('./node_modules/@feng0531/dsh-execution-bus/scripts/pilot-report.mjs');await import('./node_modules/@feng0531/dsh-execution-bus/scripts/benchmark-runtime.mjs');await import('./node_modules/@feng0531/dsh-execution-bus/scripts/session-metrics.mjs');
console.log('Production-only entries, registration and offline tool imports passed (stub host, not live DSH)');
`;
  await writeFile(path.join(temp, "verify.mjs"), source);
  const child = spawnSync(process.execPath, ["verify.mjs"], {
    cwd: temp,
    stdio: "inherit",
    timeout: 30000,
  });
  if (child.error) throw child.error;
  assert.equal(child.status, 0);
} finally {
  assert.ok(temp.startsWith(path.join(tmpdir(), "execution-bus-install-")));
  await rm(temp, { recursive: true, force: true });
}

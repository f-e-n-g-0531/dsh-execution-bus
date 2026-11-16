import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHostSmoke } from "./fixtures/host-compat-smoke.mjs";
import { executionStatus, fingerprint, candidateIdentity, main } from "../scripts/test-hosts.mjs";

test("real installed-host smoke registers plugin, guards, identities and both owners", async () => {
  const previous = process.env.XIAOHE_RUNTIME_DIR;
  const result = await runHostSmoke(process.cwd(), "local-installed-peers");
  assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
  assert.equal(process.env.XIAOHE_RUNTIME_DIR, previous);
  assert.equal(result.checks.length, 23);
  assert.deepEqual(result.evidence.workerGate, { error: "RUNTIME_AGENT_POLICY_UNSUPPORTED", creations: 0, agentToolCallsAfterControl: 0, newRuns: 0 });
  assert.deepEqual(result.evidence.identityPropagation, { parentMatchesToken: true, rootMatches: true, ownerMatches: true });
  assert.match(result.host["@deepseek-ai/dsh-tools"].manifestSha256, /^[a-f0-9]{64}$/);
});

test("matrix distinguishes not executed, install failure, execution failure and pass", () => {
  assert.equal(executionStatus(), "not_executed");
  assert.equal(executionStatus({ status: 1 }), "installation_failed");
  assert.equal(executionStatus({ status: 0, error: Error("spawn failed") }), "installation_failed");
  assert.equal(executionStatus({ status: 0 }), "not_executed");
  assert.equal(executionStatus({ status: 0 }, { status: 1 }), "execution_failed");
  assert.equal(executionStatus({ status: 0 }, { status: 0 }, { status: "failed" }), "execution_failed");
  assert.equal(executionStatus({ status: 0 }, { status: 0 }), "execution_failed");
  assert.equal(executionStatus({ status: 0 }, { status: 0 }, { status: "passed" }), "passed");
});

test("matrix fingerprints bind file bytes, paths, source, dist and harness independently", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "host-evidence-"));
  try {
    for (const directory of ["src", "dist", "locale", "test/fixtures", "scripts"]) await mkdir(path.join(root, directory), { recursive: true });
    for (const [file, content] of Object.entries({ "package.json": '{"name":"fixture","version":"1.0.0"}', "tsconfig.json": "{}", "src/a.ts": "source", "dist/a.js": "dist", "locale/en.json": "{}", "cordis.patch.yml": "patch", "test/fixtures/host-compat-smoke.mjs": "smoke", "scripts/test-hosts.mjs": "matrix" })) await writeFile(path.join(root, file), content);
    await assert.rejects(main(["--no-exectue"], root), /Unknown host matrix argument/);
    const link = path.join(root, "linked-source");
    await symlink(path.join(root, "src"), link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(fingerprint(root, ["linked-source"]), /Fingerprint refuses symlink/);
    const before = await candidateIdentity(root);
    assert.deepEqual(await candidateIdentity(root), before);
    await writeFile(path.join(root, "src/a.ts"), "changed source");
    const source = await candidateIdentity(root);
    assert.notEqual(source.source.digest, before.source.digest);
    assert.equal(source.dist.digest, before.dist.digest);
    assert.equal(source.package.digest, before.package.digest);
    await writeFile(path.join(root, "dist/a.js"), "changed dist");
    const dist = await candidateIdentity(root);
    assert.notEqual(dist.dist.digest, source.dist.digest);
    assert.notEqual(dist.package.digest, source.package.digest);
    await rename(path.join(root, "dist/a.js"), path.join(root, "dist/b.js"));
    assert.notEqual((await fingerprint(root, ["dist"])).digest, dist.dist.digest);
    assert.equal(dist.sourceDistCorrespondence, "not_verified_no_build_performed");
    const previousExit = process.exitCode;
    try {
      // Uses the existing matrix writer in a disposable fixture, with no npm or child execution.
      const report = await main(["--no-execute"], root);
      assert.equal(report.candidateUnchanged, true);
      assert.equal(report.results.length, 5);
      assert.deepEqual(JSON.parse(await readFile(path.join(root, "artifacts/host-compatibility-results.json"), "utf8")), report);
      for (const row of report.results) {
        assert.equal(row.status, "not_executed"); assert.equal(row.installation.status, "not_executed"); assert.equal(row.execution.status, "not_executed");
        assert.equal(row.host, undefined);
      }
    } finally { process.exitCode = previousExit; }
  } finally { await rm(root, { recursive: true, force: true }); }
});

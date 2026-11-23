import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runHostSmoke } from "./fixtures/host-compat-smoke.mjs";
import { executionStatus, fingerprint, candidateIdentity, hostMatrixPassed, main } from "../scripts/test-hosts.mjs";

test("real installed-host smoke registers plugin, guards, identities and both owners", async () => {
  const previous = process.env.XIAOHE_RUNTIME_DIR;
  const result = await runHostSmoke(process.cwd(), "local-installed-peers");
  assert.equal(result.status, "passed", JSON.stringify(result, null, 2));
  assert.equal(process.env.XIAOHE_RUNTIME_DIR, previous);
  assert.equal(result.checks.length, 25);
  assert.ok(result.checks.includes("standard runtime_resume agent gate preserves interrupted checkpoint"));
  assert.deepEqual(result.evidence.workerResumeGate, { error: "RUNTIME_AGENT_POLICY_UNSUPPORTED", creations: 0, checkpointUnchanged: true, nestedCalls: 0 });
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

test("host matrix rejects invalid --all lists before preparing or installing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "host-matrix-invalid-"));
  try {
    const dir = path.join(root, "artifacts");
    await mkdir(dir);
    const script = fileURLToPath(new URL("../scripts/test-hosts.mjs", import.meta.url));
    for (const invalid of [[], ["0.2.2-rc.3", "0.2.2-rc.3"], "0.2.2-rc.3", {}, [null], ["latest"], ["0.2.2-rc.03"], ["0.2.2\n"]]) {
      await writeFile(path.join(dir, "dsh-versions.json"), JSON.stringify(invalid));
      const child = spawnSync(process.execPath, [script, "--all", "--no-execute"], { cwd: root, encoding: "utf8", timeout: 5000 });
      assert.ifError(child.error);
      assert.equal(child.status, 1);
      assert.match(child.stderr, /Invalid host version list/);
      assert.deepEqual(await readdir(dir), ["dsh-versions.json"]);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("host matrix only passes when every distinct requested version passed both phases", () => {
  const requested = ["0.2.0-rc.1", "0.2.2-rc.3"];
  const row = (version, status = "passed") => ({ version, status, installation: { status }, execution: { status } });
  const results = requested.map(version => row(version));
  const valid = { requested, results, candidateUnchanged: true };
  assert.equal(hostMatrixPassed(valid), true);
  for (const patch of [
    { results: [] }, { requested: [], results: [] }, { results: [results[0]] },
    { results: [results[0], results[0]] }, { results: [results[0], row("0.2.2-rc.2")] },
    { results: [results[0], row(requested[1], "not_executed")] },
    { results: [results[0], { ...results[1], execution: { status: "failed" } }] },
    { candidateUnchanged: false },
  ]) assert.equal(hostMatrixPassed({ ...valid, ...patch }), false);
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
      assert.equal(report.results.length, 6);
      assert.equal(process.exitCode, 1);
      assert.deepEqual(JSON.parse(await readFile(path.join(root, "artifacts/host-compatibility-results.json"), "utf8")), report);
      for (const row of report.results) {
        assert.equal(row.status, "not_executed"); assert.equal(row.installation.status, "not_executed"); assert.equal(row.execution.status, "not_executed");
        assert.equal(row.host, undefined);
      }
      await writeFile(path.join(root, "artifacts/dsh-versions.json"), JSON.stringify(["0.2.0-rc.1", "0.2.2-rc.3"]));
      const custom = await main(["--all", "--no-execute"], root);
      assert.deepEqual(custom.results.map(row => row.version), ["0.2.0-rc.1", "0.2.2-rc.3"]);
      assert.equal(process.exitCode, 1);
    } finally { process.exitCode = previousExit; }
  } finally { await rm(root, { recursive: true, force: true }); }
});

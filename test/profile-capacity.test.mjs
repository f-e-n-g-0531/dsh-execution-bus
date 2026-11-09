import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { openSync as esmOpen } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { measureFsCalls } from "../dev/fs-probe.mjs";
import { parseProfileArgs, profileCapacity } from "../dev/profile-capacity.mjs";

test("fs probe counts ESM failures, redacts workload errors and restores builtins", () => {
  const original = fs.openSync;
  const sentinel = Error("private-path-error");
  const m = measureFsCalls(() => {
    assert.notEqual(fs.openSync, original);
    try {
      esmOpen("missing-private-fixture-" + process.pid, "r");
    } catch {}
    throw sentinel;
  });
  assert.equal(m.failed, true);
  assert.equal(m.value, undefined);
  assert.equal(m.calls.openSync.calls, 1);
  assert.equal(m.calls.openSync.failures, 1);
  assert.ok(m.calls.openSync.totalMs >= 0);
  assert.equal(fs.openSync, original);
  assert.equal(esmOpen, original);
  assert.doesNotMatch(JSON.stringify(m), /private-path-error|missing-private/);
});
test("fs probe windows exclude previous and later fs calls and preserve results", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaohe-probe-test-"));
  try {
    const file = path.join(root, "a");
    fs.writeFileSync(file, "x");
    const m = measureFsCalls(() => {
      fs.renameSync(file, path.join(root, "b"));
      return 17;
    });
    assert.equal(m.failed, false);
    assert.equal(m.value, 17);
    assert.equal(m.calls.renameSync.calls, 1);
    assert.equal(m.calls.writeFileSync.calls, 0);
    assert.ok(fs.existsSync(path.join(root, "b")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("fs probe rejects nested and asynchronous operations without retaining patches", () => {
  const original = fs.openSync;
  let code;
  const m = measureFsCalls(() => {
    try {
      measureFsCalls(() => 1);
    } catch (e) {
      code = e.message;
    }
    return 1;
  });
  assert.equal(code, "FS_PROBE_BUSY");
  assert.equal(m.failed, false);
  assert.equal(fs.openSync, original);
  assert.throws(
    () => measureFsCalls(() => Promise.resolve(1)),
    /FS_PROBE_ASYNC_UNSUPPORTED/,
  );
  assert.equal(fs.openSync, original);
  assert.equal(esmOpen, original);
});
test("profile input bounds reject unknown duplicates missing and unbounded values", () => {
  assert.deepEqual(parseProfileArgs([]), { size: 100, ratio: 0.5 });
  for (const args of [
    ["--size"],
    ["--size", "0"],
    ["--size", "1001"],
    ["--size", "1.2"],
    ["--ratio", "NaN"],
    ["--ratio", "1.1"],
    ["--size", "1", "--size", "2"],
    ["--path", "private-path"],
  ])
    assert.throws(() => parseProfileArgs(args));
});
test("profile CLI invalid args emit only controlled failure", () => {
  const r = spawnSync(
    process.execPath,
    ["dev/profile-capacity.mjs", "--path", "private-path"],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.ifError(r.error);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr.trim(), "CAPACITY_PROFILE_FAILED");
});
for (const ratio of [0, 0.5, 1])
  test(
    "profile measures only operations with verified synthetic states ratio " +
      ratio,
    async () => {
      const report = await profileCapacity({ size: 8, ratio });
      assert.equal(report.failed, 0);
      assert.equal(report.samples.length, 4);
      const list = report.samples.find((s) => s.operation === "list"),
        warm = report.samples.find((s) => s.operation === "warm-list"),
        prune = report.samples.find((s) => s.operation === "prune"),
        startup = report.samples.find((s) => s.operation === "startup");
      assert.equal(list.calls.readdirSync.calls, 1);
      assert.equal(warm.calls.readdirSync.calls, 1);
      for (const s of [list, warm, prune]) {
        assert.equal(s.calls.writeFileSync.calls, 0);
        assert.equal(s.calls.renameSync.calls, 0);
      }
      assert.equal(
        startup.calls.renameSync.calls,
        Math.floor(8 * ratio) - Math.ceil(Math.floor(8 * ratio) / 2),
      );
      assert.equal(startup.calls.rmSync.calls, 0); // no excess terminal; no successful-save cleanup probes
      for (const s of report.samples) {
        assert.equal(s.verified, true);
        assert.ok(s.wallTimeMs >= 0);
        assert.ok(
          [
            "invalidRecords",
            "oversizedRecords",
            "readFailures",
            "writeFailures",
          ].every((key) => s.diagnostics[key] === 0),
        );
        assert.ok(
          Object.values(s.diagnostics.lastObservedAt).every(
            (at) => at === null,
          ),
        );
      }
      assert.ok(!JSON.stringify(report).includes(os.tmpdir()));
      assert.ok(!JSON.stringify(report).includes(process.cwd()));
    },
  );
test("prune and startup removal counts exclude setup and final cleanup", async () => {
  const r = await profileCapacity({ size: 105, ratio: 0 });
  for (const s of r.samples.filter((s) =>
    ["prune", "startup"].includes(s.operation),
  )) {
    // Five history records plus each per-run review/remove lock cleanup.
    assert.equal(s.calls.rmSync.calls, 10);
    assert.equal(s.remaining, 100);
  }
});

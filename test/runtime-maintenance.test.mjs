import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { RunStore } from "../dist/runtime/store.js";
import { parsePlan } from "../dist/runtime/plan.js";

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaohe-maintenance-"));
  try {
    const store = new RunStore(root);
    const record = {
      version: 1,
      runId: "run-maintenance-0001",
      ownerSessionId: "owner",
      plan: parsePlan({ steps: [{ id: "a", tool: "read", input: {} }] }),
      state: "running",
      steps: [{ id: "a", tool: "read", state: "pending", attempts: 0 }],
      results: {},
      createdAt: 1,
      updatedAt: 1,
    };
    fn(store, record, root);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("successful atomic save consumes its temp file without a cleanup probe", () =>
  fixture((store, record, root) => {
    const rm = mock.method(fs, "rmSync", () =>
      assert.fail("no cleanup after successful rename"),
    );
    syncBuiltinESMExports();
    store.save(record);
    record.updatedAt = 2;
    store.save(record);
    assert.equal(rm.mock.callCount(), 0);
    assert.equal(store.load(record.runId).updatedAt, 2);
    assert.deepEqual(fs.readdirSync(root), [record.runId + ".json"]);
  }));

for (const stage of ["writeFileSync", "fsyncSync", "renameSync"]) {
  test(`failed ${stage} cleans the unique temp and preserves the last checkpoint`, () =>
    fixture((store, record, root) => {
      store.save(record);
      const original = fs.readFileSync(store.pathFor(record.runId), "utf8");
      const cleanup = mock.method(fs, "rmSync");
      mock.method(fs, stage, () => {
        throw Error("private injected failure");
      });
      syncBuiltinESMExports();
      record.updatedAt = 2;
      assert.throws(
        () => store.save(record),
        /^Error: RUNTIME_STORAGE_FAILED$/,
      );
      assert.equal(cleanup.mock.callCount(), 1);
      const [target, options] = cleanup.mock.calls[0].arguments;
      assert.equal(path.dirname(target), root);
      assert.match(
        path.basename(target),
        /^run-maintenance-0001[.]json[.][0-9a-f-]+[.]tmp$/,
      );
      assert.deepEqual(options, { force: true });
      assert.equal(
        fs.readFileSync(store.pathFor(record.runId), "utf8"),
        original,
      );
      assert.deepEqual(fs.readdirSync(root), [record.runId + ".json"]);
    }));
}

test("successful save fsyncs checkpoint data before the atomic rename", () =>
  fixture((store, record) => {
    const order = [];
    const actualFsync = fs.fsyncSync;
    const actualRename = fs.renameSync;
    mock.method(fs, "fsyncSync", (...args) => {
      order.push("fsync");
      return actualFsync(...args);
    });
    mock.method(fs, "renameSync", (...args) => {
      order.push("rename");
      return actualRename(...args);
    });
    syncBuiltinESMExports();
    store.save(record);
    assert.deepEqual(order, ["fsync", "rename"]);
  }));

test("failed exclusive temp open never removes an unowned path", () =>
  fixture((store, record) => {
    mock.method(fs, "openSync", () => {
      throw Object.assign(Error("private collision"), { code: "EEXIST" });
    });
    const cleanup = mock.method(fs, "rmSync", () =>
      assert.fail("no owned temp to clean"),
    );
    syncBuiltinESMExports();
    assert.throws(() => store.save(record), /^Error: RUNTIME_STORAGE_FAILED$/);
    assert.equal(cleanup.mock.callCount(), 0);
  }));

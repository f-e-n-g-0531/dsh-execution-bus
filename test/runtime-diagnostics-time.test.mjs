import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { RunStore } from "../dist/runtime/store.js";
import { RuntimeService } from "../dist/runtime/service.js";
import { RUNTIME_OUTPUT_SCHEMAS } from "../dist/presentation.js";
import { createServiceContext } from "./fixtures/service-context.mjs";

const keys = [
  "invalidRecords",
  "oversizedRecords",
  "readFailures",
  "writeFailures",
];
const emptyTimes = () => Object.fromEntries(keys.map((key) => [key, null]));
const exec = () => ({
  agent: { id: "private-owner" },
  callId: "diagnostics-time",
  signal: new AbortController().signal,
});
function intercept(name, replacement, fn) {
  const entry = mock.method(fs, name, replacement);
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    entry.mock.restore();
    syncBuiltinESMExports();
  }
}
function fixture(fn) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "xiaohe-diagnostics-time-"),
  );
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("diagnostics starts at store instance creation, reads fresh snapshots without I/O or persistence", () => {
  fixture((root) => {
    let now = 100;
    const clock = mock.method(Date, "now", () => now);
    try {
      const store = new RunStore(root);
      now = 200;
      const snapshot = intercept(
        "readdirSync",
        () => {
          throw Error("unexpected I/O");
        },
        () => store.diagnostics(),
      );
      assert.deepEqual(snapshot, {
        invalidRecords: 0,
        oversizedRecords: 0,
        readFailures: 0,
        writeFailures: 0,
        startedAt: 100,
        observedAt: 200,
        lastObservedAt: emptyTimes(),
      });
      assert.deepEqual(
        Object.keys(snapshot).sort(),
        [...keys, "startedAt", "observedAt", "lastObservedAt"].sort(),
      );
      snapshot.invalidRecords = 99;
      snapshot.lastObservedAt.invalidRecords = 99;
      now = 300;
      assert.equal(store.diagnostics().observedAt, 300);
      assert.equal(store.diagnostics().invalidRecords, 0);
      assert.deepEqual(store.diagnostics().lastObservedAt, emptyTimes());
      const second = new RunStore(root);
      assert.equal(second.diagnostics().startedAt, 300);
      assert.equal(store.diagnostics().startedAt, 100);
      assert.deepEqual(fs.readdirSync(root), []);
    } finally {
      clock.mock.restore();
    }
  });
});

test("counted observations accumulate with category-specific latest times, including saturation", () => {
  fixture((root) => {
    let now = 100;
    const clock = mock.method(Date, "now", () => now);
    try {
      const store = new RunStore(root);
      const badId = "run-private1";
      fs.writeFileSync(path.join(root, badId + ".json"), "private-payload");
      now = 200;
      assert.equal(store.load(badId), undefined);
      const first = store.diagnostics();
      now = 300;
      store.load(badId);
      assert.equal(store.diagnostics().invalidRecords, 2);
      assert.equal(store.diagnostics().lastObservedAt.invalidRecords, 300);
      assert.equal(first.lastObservedAt.invalidRecords, 200);
      now = 400;
      intercept(
        "fstatSync",
        () => ({ isFile: () => true, size: 4n * 1024n * 1024n + 1n }),
        () => store.load(badId),
      );
      now = 500;
      intercept(
        "openSync",
        () => {
          throw Object.assign(Error("private-path private-error"), {
            code: "EACCES",
          });
        },
        () => store.load(badId),
      );
      now = 600;
      intercept(
        "rmSync",
        () => {
          throw Error("private-path private-error");
        },
        () =>
          assert.throws(() => store.remove(badId), /RUNTIME_STORAGE_FAILED/),
      );
      now = 700;
      const snapshot = store.diagnostics();
      assert.deepEqual(snapshot.lastObservedAt, {
        invalidRecords: 300,
        oversizedRecords: 400,
        readFailures: 500,
        writeFailures: 600,
      });
      assert.deepEqual(
        keys.map((key) => snapshot[key]),
        [2, 1, 1, 1],
      );
      assert.equal(snapshot.observedAt, 700);
      assert.doesNotMatch(
        JSON.stringify(snapshot),
        /private|run-|payload|path|error|health|processStartedAt/,
      );
      // Seed only the pre-existing private counter to exercise its saturation boundary.
      store.counters.invalidRecords = 1_000_000;
      now = 800;
      store.load(badId);
      assert.equal(store.diagnostics().invalidRecords, 1_000_000);
      assert.equal(store.diagnostics().lastObservedAt.invalidRecords, 800);
      now = 900;
      store.load("../private-invalid-id");
      store.load("run-missing1");
      assert.equal(store.diagnostics().lastObservedAt.invalidRecords, 800);
      assert.equal(store.diagnostics().lastObservedAt.readFailures, 500);
      assert.equal(new RunStore(root).diagnostics().invalidRecords, 0);
      assert.deepEqual(
        new RunStore(root).diagnostics().lastObservedAt,
        emptyTimes(),
      );
    } finally {
      clock.mock.restore();
    }
  });
});

test("real RuntimeService status and task share strict diagnostics schema with null or counted times", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "xiaohe-diagnostics-service-"),
  );
  const store = new RunStore(root);
  const service = new RuntimeService(
    createServiceContext(async () => "unused"),
    store,
  );
  try {
    for (const [name, read] of [
      ["runtime_status", () => service.status({}, exec())],
      ["runtime_task", () => service.task({ taskId: "audit" }, exec())],
    ]) {
      const initial = read();
      assert.deepEqual(initial.diagnostics.lastObservedAt, emptyTimes());
      assert.deepEqual(
        validateJsonSchemaValue(RUNTIME_OUTPUT_SCHEMAS[name], initial),
        [],
      );
    }
    fs.writeFileSync(path.join(root, "run-private1.json"), "private-payload");
    const before = fs.readdirSync(root);
    const status = service.status({}, exec());
    const task = service.task({ taskId: "audit" }, exec());
    assert.equal(status.diagnostics.invalidRecords, 1);
    assert.equal(task.diagnostics.invalidRecords, 2);
    for (const [name, output] of [
      ["runtime_status", status],
      ["runtime_task", task],
    ]) {
      assert.equal(
        typeof output.diagnostics.lastObservedAt.invalidRecords,
        "number",
      );
      assert.deepEqual(
        validateJsonSchemaValue(RUNTIME_OUTPUT_SCHEMAS[name], output),
        [],
      );
      assert.doesNotMatch(
        JSON.stringify(output),
        /private|payload|processStartedAt/,
      );
      for (const change of [
        (d) => {
          d.startedAt = "invalid-time";
        },
        (d) => {
          delete d.lastObservedAt.readFailures;
        },
        (d) => {
          d.lastObservedAt.readFailures = "private-error";
        },
        (d) => {
          d.lastObservedAt.path = root;
        },
        (d) => {
          d.health = "healthy";
        },
      ]) {
        const invalid = structuredClone(output);
        change(invalid.diagnostics);
        assert.notDeepEqual(
          validateJsonSchemaValue(RUNTIME_OUTPUT_SCHEMAS[name], invalid),
          [],
        );
      }
    }
    assert.deepEqual(fs.readdirSync(root), before);
    status.diagnostics.lastObservedAt.invalidRecords = -1;
    assert.notEqual(store.diagnostics().lastObservedAt.invalidRecords, -1);
  } finally {
    await service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

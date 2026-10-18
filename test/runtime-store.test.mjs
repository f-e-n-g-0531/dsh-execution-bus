import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunStore } from "../dist/runtime/store.js";
import { parsePlan } from "../dist/runtime/plan.js";

const run = (runId, state = "running", steps = []) => ({
  version: 1,
  runId,
  ownerSessionId: "s1",
  plan: parsePlan({ steps: [{ id: "a", tool: "read", input: { file_path: "x" } }] }),
  state,
  steps: steps.length ? steps : [{ id: "a", tool: "read", state: "pending", attempts: 0 }],
  results: {},
  createdAt: 1,
  updatedAt: 1,
});

test("运行记录：原子保存、读取、列表与清理", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xiaohe-store-"));
  try {
    const store = new RunStore(dir);
    store.save(run("run-aaaaaaaa", "running"));
    store.save(run("run-bbbbbbbb", "succeeded"));
    assert.equal(store.load("run-aaaaaaaa")?.state, "running");
    assert.deepEqual(store.list(10).map((r) => r.runId).sort(), ["run-aaaaaaaa", "run-bbbbbbbb"]);
    store.remove("run-aaaaaaaa");
    assert.equal(store.load("run-aaaaaaaa"), undefined);
    assert.throws(() => store.pathFor("../escape"), /RUNTIME_NOT_FOUND/);
    assert.equal(store.load("../escape"), undefined);
    const raw = readFileSync(path.join(dir, "run-bbbbbbbb.json"), "utf8");
    assert.equal(JSON.parse(raw).runId, "run-bbbbbbbb");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("启动清理：running 变 interrupted，运行中步骤变 unknown", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xiaohe-store-"));
  try {
    const store = new RunStore(dir);
    store.save(run("run-cccccccc", "running", [
      { id: "a", tool: "read", state: "running", attempts: 1 },
      { id: "b", tool: "write", state: "pending", attempts: 0 },
    ]));
    store.save(run("run-dddddddd", "succeeded"));
    assert.equal(store.markInterrupted(), 1);
    const interrupted = store.load("run-cccccccc");
    assert.equal(interrupted?.state, "interrupted");
    assert.equal(interrupted?.steps[0].state, "unknown");
    assert.equal(interrupted?.steps[1].state, "pending");
    assert.equal(store.load("run-dddddddd")?.state, "succeeded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("损坏记录被忽略而不是中断整个列表", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xiaohe-store-"));
  try {
    const store = new RunStore(dir);
    store.save(run("run-eeeeeeee", "succeeded"));
    writeFileSync(path.join(dir, "run-ffffffff.json"), "{not json", "utf8");
    assert.equal(store.load("run-ffffffff"), undefined);
    assert.equal(store.list(10).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

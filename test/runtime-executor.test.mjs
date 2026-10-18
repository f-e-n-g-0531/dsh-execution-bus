import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunStore } from "../dist/runtime/store.js";
import { RuntimeExecutor } from "../dist/runtime/executor.js";
import { parsePlan } from "../dist/runtime/plan.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "xiaohe-exec-"));
const step = (id, tool = "read", over = {}) => ({
  id,
  tool,
  input: { tag: id },
  ...over,
});

test("DAG：独立步骤并行、依赖步骤等前置完成", async () => {
  const dir = tmp();
  try {
    const store = new RunStore(dir);
    const calls = [];
    let active = 0;
    let peak = 0;
    const executor = new RuntimeExecutor(store, async (_tool, input) => {
      active++;
      peak = Math.max(peak, active);
      calls.push(input.tag);
      await sleep(20);
      active--;
      return { tag: input.tag };
    });
    const run = executor.createRun("s1", parsePlan({
      concurrency: 2,
      steps: [step("a"), step("b"), step("c", "write", { depends_on: ["a", "b"] })],
    }));
    await executor.execute(run);
    assert.equal(run.state, "succeeded");
    assert.equal(peak, 2);
    assert.deepEqual(calls.slice(0, 2).sort(), ["a", "b"]);
    assert.equal(calls[2], "c");
    assert.equal(run.steps.every((s) => s.state === "succeeded"), true);
    assert.deepEqual(run.results.c.value, { tag: "c" });
    assert.equal(store.load(run.runId)?.state, "succeeded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("幂等步骤重试：失败两次后成功，attempts=3", async () => {
  const dir = tmp();
  try {
    const store = new RunStore(dir);
    let runs = 0;
    const executor = new RuntimeExecutor(store, async () => {
      runs++;
      if (runs < 3) throw Error("transient");
      return { ok: true };
    });
    const run = executor.createRun("s1", parsePlan({
      steps: [step("a", "read", { retry: 2 })],
    }));
    await executor.execute(run);
    assert.equal(run.state, "succeeded");
    assert.equal(runs, 3);
    assert.equal(run.steps[0].attempts, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("失败步骤阻止依赖步骤，run 标记 failed", async () => {
  const dir = tmp();
  try {
    const store = new RunStore(dir);
    const executor = new RuntimeExecutor(store, async (_tool, input) => {
      if (input.tag === "a") throw Error("boom");
      return { ok: true };
    });
    const run = executor.createRun("s1", parsePlan({
      steps: [step("a"), step("b", "write", { depends_on: ["a"] })],
    }));
    await executor.execute(run);
    assert.equal(run.state, "failed");
    assert.equal(run.steps[0].state, "failed");
    assert.equal(run.steps[0].error, "RUNTIME_STEP_FAILED");
    assert.equal(run.steps[1].state, "pending");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("超时标记 RUNTIME_STEP_TIMEOUT，不重试非幂等", async () => {
  const dir = tmp();
  try {
    const store = new RunStore(dir);
    const executor = new RuntimeExecutor(store, async () => {
      await sleep(1500);
      return { ok: true };
    });
    const run = executor.createRun("s1", parsePlan({
      steps: [step("a", "read", { timeout_ms: 1000 })],
    }));
    const started = Date.now();
    await executor.execute(run);
    assert.equal(run.state, "failed");
    assert.equal(run.steps[0].error, "RUNTIME_STEP_TIMEOUT");
    assert.ok(Date.now() - started < 1400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("取消：pending→cancelled，running→unknown", async () => {
  const dir = tmp();
  try {
    const store = new RunStore(dir);
    const executor = new RuntimeExecutor(store, async (_tool, _input, signal) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 500);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Error("aborted"));
        }, { once: true });
      });
      return { ok: true };
    });
    const controller = new AbortController();
    const run = executor.createRun("s1", parsePlan({ steps: [step("a", "write")] }));
    const execution = executor.execute(run, controller.signal);
    await sleep(50);
    controller.abort();
    await execution;
    assert.equal(run.state, "cancelled");
    assert.equal(run.steps[0].state, "unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("结果超过 64KiB 只保留截断标记", async () => {
  const dir = tmp();
  try {
    const store = new RunStore(dir);
    const executor = new RuntimeExecutor(store, async () => ({ big: "x".repeat(70 * 1024) }));
    const run = executor.createRun("s1", parsePlan({ steps: [step("a")] }));
    await executor.execute(run);
    assert.equal(run.state, "succeeded");
    assert.equal(run.results.a.truncated, true);
    assert.ok(run.results.a.bytes > 64 * 1024);
    assert.equal(run.results.a.value, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("恢复：interrupted 的幂等步骤重排，副作用步骤失败", async () => {
  const dir = tmp();
  try {
    const store = new RunStore(dir);
    const executor = new RuntimeExecutor(store, async () => ({ ok: true }));
    const run = executor.createRun("s1", parsePlan({
      steps: [step("a", "read"), step("b", "write")],
    }));
    run.state = "interrupted";
    run.steps[0].state = "running";
    run.steps[1].state = "unknown";
    store.save(run);
    await executor.resume(run);
    assert.equal(run.state, "failed");
    assert.equal(run.steps[0].state, "succeeded");
    assert.equal(run.steps[1].state, "failed");
    assert.equal(run.steps[1].error, "RUNTIME_INTERRUPTED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const promptly = async (promise) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("execution did not stop promptly")),
          500,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
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
    const run = executor.createRun(
      "s1",
      parsePlan({
        concurrency: 2,
        steps: [
          step("a"),
          step("b"),
          step("c", "write", { depends_on: ["a", "b"] }),
        ],
      }),
    );
    await executor.execute(run);
    assert.equal(run.state, "succeeded");
    assert.equal(peak, 2);
    assert.deepEqual(calls.slice(0, 2).sort(), ["a", "b"]);
    assert.equal(calls[2], "c");
    assert.equal(
      run.steps.every((s) => s.state === "succeeded"),
      true,
    );
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
    const run = executor.createRun(
      "s1",
      parsePlan({
        steps: [step("a", "read", { retry: 2 })],
      }),
    );
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
    const run = executor.createRun(
      "s1",
      parsePlan({
        steps: [step("a"), step("b", "write", { depends_on: ["a"] })],
      }),
    );
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
    const run = executor.createRun(
      "s1",
      parsePlan({
        steps: [step("a", "read", { timeout_ms: 1000 })],
      }),
    );
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
    const executor = new RuntimeExecutor(
      store,
      async (_tool, _input, signal) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 500);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(Error("aborted"));
            },
            { once: true },
          );
        });
        return { ok: true };
      },
    );
    const controller = new AbortController();
    const run = executor.createRun(
      "s1",
      parsePlan({ steps: [step("a", "write")] }),
    );
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
    const executor = new RuntimeExecutor(store, async () => ({
      big: "x".repeat(70 * 1024),
    }));
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
    const run = executor.createRun(
      "s1",
      parsePlan({
        steps: [step("a", "read"), step("b", "write")],
      }),
    );
    run.state = "interrupted";
    const now = Date.now();
    run.updatedAt = now;
    run.finishedAt = now;
    for (const record of run.steps) {
      record.state = "unknown";
      record.attempts = 1;
      record.startedAt = now;
      record.finishedAt = now;
    }
    store.save(run);
    await executor.resume(run);
    assert.equal(run.state, "failed");
    assert.equal(run.steps[0].state, "pending");
    assert.equal(run.steps[1].state, "failed");
    assert.equal(run.steps[1].error, "RUNTIME_INTERRUPTED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("快 write 完成时立即 checkpoint，不等待同批次慢 read", async () => {
  const dir = tmp();
  const slow = deferred();
  const started = deferred();
  const saved = deferred();
  try {
    const store = new RunStore(dir);
    const save = store.save.bind(store);
    store.save = (run) => {
      save(run);
      if (
        run.steps[0].state === "succeeded" &&
        run.steps[1].state === "running"
      )
        saved.resolve();
    };
    const executor = new RuntimeExecutor(store, async (_tool, input) => {
      if (input.tag === "slow") {
        started.resolve();
        return slow.promise;
      }
      return { written: true };
    });
    const run = executor.createRun(
      "s1",
      parsePlan({
        concurrency: 2,
        steps: [step("fast", "write"), step("slow")],
      }),
    );
    const execution = executor.execute(run);
    await promptly(started.promise);
    await promptly(saved.promise);
    const checkpoint = store.load(run.runId);
    assert.equal(checkpoint.steps[0].state, "succeeded");
    assert.equal(checkpoint.steps[1].state, "running");
    assert.deepEqual(checkpoint.results.fast.value, { written: true });
    slow.resolve({ read: true });
    await execution;
    assert.equal(run.state, "succeeded");
  } finally {
    slow.resolve(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("直接 cancel 非合作调用及时结束，真正 pending 不执行，晚 resolve 不回写", async () => {
  const dir = tmp();
  const host = deferred();
  const entered = deferred();
  try {
    const store = new RunStore(dir);
    const calls = [];
    let hostSignal;
    const executor = new RuntimeExecutor(
      store,
      async (_tool, input, signal) => {
        calls.push(input.tag);
        hostSignal = signal;
        entered.resolve();
        return host.promise;
      },
    );
    const run = executor.createRun(
      "s1",
      parsePlan({
        concurrency: 1,
        steps: [step("active", "write"), step("waiting", "write")],
      }),
    );
    const execution = executor.execute(run);
    await promptly(entered.promise);
    executor.cancel(run, "manual-stop");
    await promptly(execution);
    assert.equal(hostSignal.aborted, true);
    assert.equal(run.state, "cancelled");
    assert.equal(run.error, "manual-stop");
    assert.deepEqual(
      run.steps.map((s) => s.state),
      ["unknown", "cancelled"],
    );
    assert.equal(run.steps[1].attempts, 0);
    assert.deepEqual(calls, ["active"]);
    const before = JSON.stringify(store.load(run.runId));
    host.resolve({ tooLate: true });
    await sleep(0);
    assert.equal(JSON.stringify(store.load(run.runId)), before);
    assert.equal(run.results.active, undefined);
    assert.equal(run.steps[0].state, "unknown");
  } finally {
    host.resolve(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("外层 signal 中止不合作 read：及时 cancelled，取消前未完成结果不能发布", async () => {
  const dir = tmp();
  const host = deferred();
  const entered = deferred();
  try {
    const store = new RunStore(dir);
    const executor = new RuntimeExecutor(store, async () => {
      entered.resolve();
      return host.promise;
    });
    const run = executor.createRun("s1", parsePlan({ steps: [step("a")] }));
    const controller = new AbortController();
    const execution = executor.execute(run, controller.signal);
    await promptly(entered.promise);
    controller.abort();
    await promptly(execution);
    assert.equal(run.state, "cancelled");
    assert.equal(run.steps[0].state, "cancelled");
    host.resolve("late");
    await sleep(0);
    assert.deepEqual(run.results, {});
    assert.equal(store.load(run.runId).state, "cancelled");
  } finally {
    host.resolve(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("完成检查点写盘失败不被 allSettled 吞掉，停止在途 retry 和后续写", async () => {
  const dir = tmp();
  const slow = deferred();
  try {
    const store = new RunStore(dir);
    const calls = [];
    const save = store.save.bind(store);
    let broken = false;
    store.save = (run) => {
      if (run.steps[0].state === "succeeded") broken = true;
      if (broken) throw Error("disk full");
      save(run);
    };
    const executor = new RuntimeExecutor(store, async (_tool, input) => {
      calls.push(input.tag);
      if (input.tag === "slow") return slow.promise;
      return { ok: true };
    });
    const run = executor.createRun(
      "s1",
      parsePlan({
        concurrency: 2,
        steps: [
          step("fast", "write"),
          step("slow", "read", { retry: 2 }),
          step("later", "write"),
        ],
      }),
    );
    await assert.rejects(
      promptly(executor.execute(run)),
      /RUNTIME_STORAGE_FAILED/,
    );
    assert.equal(run.state, "failed");
    assert.equal(run.error, "RUNTIME_STORAGE_FAILED");
    assert.deepEqual(calls, ["fast", "slow"]);
    assert.equal(run.steps[1].attempts, 1);
    slow.resolve("late");
    await sleep(0);
    assert.equal(run.results.slow, undefined);
    assert.equal(run.steps[2].attempts, 0);
  } finally {
    slow.resolve(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("调用前 checkpoint 失败不启动同批其他步骤", async () => {
  const dir = tmp();
  try {
    const store = new RunStore(dir);
    let calls = 0;
    const executor = new RuntimeExecutor(store, async () => {
      calls++;
      return true;
    });
    const run = executor.createRun(
      "s1",
      parsePlan({ steps: [step("a"), step("b", "write")] }),
    );
    const save = store.save.bind(store);
    store.save = (record) => {
      if (record.steps.some((s) => s.state === "running")) throw Error("EIO");
      save(record);
    };
    await assert.rejects(executor.execute(run), /RUNTIME_STORAGE_FAILED/);
    assert.equal(calls, 0);
    assert.equal(run.error, "RUNTIME_STORAGE_FAILED");
    assert.equal(run.steps[1].attempts, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("重试失败和下一次调用分别 checkpoint，普通失败仍 retry", async () => {
  const dir = tmp();
  try {
    const store = new RunStore(dir);
    const snapshots = [];
    const save = store.save.bind(store);
    store.save = (run) => {
      save(run);
      snapshots.push(structuredClone(run));
    };
    let calls = 0;
    const executor = new RuntimeExecutor(store, async () => {
      if (++calls === 1) throw Error("transient");
      return true;
    });
    const run = executor.createRun(
      "s1",
      parsePlan({ steps: [step("a", "read", { retry: 1 })] }),
    );
    await executor.execute(run);
    assert.equal(run.state, "succeeded");
    assert.equal(calls, 2);
    assert.ok(
      snapshots.some(
        (r) =>
          r.steps[0].state === "pending" &&
          r.steps[0].attempts === 1 &&
          r.steps[0].error === "RUNTIME_STEP_FAILED",
      ),
    );
    assert.ok(
      snapshots.some(
        (r) => r.steps[0].state === "running" && r.steps[0].attempts === 2,
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("重试检查点失败不能作为普通异常触发第二次调用", async () => {
  const dir = tmp();
  try {
    const store = new RunStore(dir);
    const save = store.save.bind(store);
    store.save = (run) => {
      if (run.steps[0].state === "pending" && run.steps[0].attempts === 1)
        throw Error("EIO");
      save(run);
    };
    let calls = 0;
    const executor = new RuntimeExecutor(store, async () => {
      calls++;
      throw Error("transient");
    });
    const run = executor.createRun(
      "s1",
      parsePlan({ steps: [step("a", "read", { retry: 2 })] }),
    );
    await assert.rejects(executor.execute(run), /RUNTIME_STORAGE_FAILED/);
    assert.equal(calls, 1);
    assert.equal(run.error, "RUNTIME_STORAGE_FAILED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("非合作只读超时保守不 retry，晚到结果不写回", async () => {
  const dir = tmp();
  const host = deferred();
  try {
    const store = new RunStore(dir);
    let calls = 0;
    const executor = new RuntimeExecutor(store, async () => {
      calls++;
      return host.promise;
    });
    const run = executor.createRun(
      "s1",
      parsePlan({ steps: [step("a", "read", { retry: 3, timeout_ms: 1000 })] }),
    );
    await executor.execute(run);
    assert.equal(run.state, "failed");
    assert.equal(run.steps[0].state, "failed");
    assert.equal(run.error, "RUNTIME_STEP_TIMEOUT");
    assert.equal(calls, 1);
    assert.equal(run.steps[0].attempts, 1);
    host.resolve("late");
    await sleep(0);
    assert.equal(run.results.a, undefined);
    assert.equal(store.load(run.runId).state, "failed");
  } finally {
    host.resolve(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("非幂等超时为 unknown/run failed，不重新发送也不启动下一 write", async () => {
  const dir = tmp();
  const host = deferred();
  try {
    const store = new RunStore(dir);
    const calls = [];
    const executor = new RuntimeExecutor(store, async (_tool, input) => {
      calls.push(input.tag);
      return host.promise;
    });
    const run = executor.createRun(
      "s1",
      parsePlan({
        concurrency: 1,
        steps: [step("a", "write", { timeout_ms: 1000 }), step("b", "write")],
      }),
    );
    await executor.execute(run);
    assert.equal(run.state, "failed");
    assert.equal(run.error, "RUNTIME_STEP_TIMEOUT");
    assert.equal(run.steps[0].state, "unknown");
    assert.equal(run.steps[0].attempts, 1);
    assert.equal(run.steps[1].state, "pending");
    assert.deepEqual(calls, ["a"]);
    host.resolve("late");
    await sleep(0);
    assert.equal(run.results.a, undefined);
    assert.equal(store.load(run.runId).steps[0].state, "unknown");
  } finally {
    host.resolve(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume unknown 副作用安全失败：无关 pending write/read 也不执行", async () => {
  const dir = tmp();
  try {
    const store = new RunStore(dir);
    const calls = [];
    const executor = new RuntimeExecutor(store, async (_tool, input) => {
      calls.push(input.tag);
      return true;
    });
    const run = executor.createRun(
      "s1",
      parsePlan({
        steps: [
          step("unknown", "write"),
          step("pending", "write"),
          step("read"),
        ],
      }),
    );
    const now = Date.now();
    run.state = "interrupted";
    run.updatedAt = now;
    run.finishedAt = now;
    Object.assign(run.steps[0], {
      state: "unknown",
      attempts: 1,
      startedAt: now,
      finishedAt: now,
    });
    store.save(run);
    const loaded = store.load(run.runId);
    await executor.resume(loaded);
    assert.equal(loaded.state, "failed");
    assert.equal(loaded.error, "RUNTIME_INTERRUPTED");
    assert.equal(loaded.steps[0].state, "failed");
    assert.equal(loaded.steps[1].attempts, 0);
    assert.equal(loaded.steps[2].attempts, 0);
    assert.deepEqual(calls, []);
    assert.equal(store.load(run.runId).state, "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume 纯幂等 interrupted 可重新执行，已完成副作用不重放", async () => {
  const dir = tmp();
  try {
    const store = new RunStore(dir);
    const calls = [];
    const executor = new RuntimeExecutor(store, async (_tool, input) => {
      calls.push(input.tag);
      return true;
    });
    const run = executor.createRun(
      "s1",
      parsePlan({ steps: [step("done", "write"), step("read")] }),
    );
    const now = Date.now();
    run.state = "interrupted";
    run.updatedAt = now;
    run.finishedAt = now;
    Object.assign(run.steps[0], {
      state: "succeeded",
      attempts: 1,
      startedAt: now,
      finishedAt: now,
    });
    Object.assign(run.steps[1], {
      state: "unknown",
      attempts: 1,
      startedAt: now,
      finishedAt: now,
    });
    run.results.done = { value: true, bytes: 4 };
    store.save(run);
    const loaded = store.load(run.runId);
    await executor.resume(loaded);
    assert.equal(loaded.state, "succeeded");
    assert.deepEqual(calls, ["read"]);
    assert.equal(loaded.steps[1].attempts, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("取消落盘失败同时对调用者和 execute 可观测，不等待非合作宿主", async () => {
  const dir = tmp();
  const host = deferred();
  const entered = deferred();
  try {
    const store = new RunStore(dir);
    const executor = new RuntimeExecutor(store, async () => {
      entered.resolve();
      return host.promise;
    });
    const run = executor.createRun(
      "s1",
      parsePlan({ steps: [step("a", "write")] }),
    );
    const execution = executor.execute(run);
    await promptly(entered.promise);
    store.save = () => {
      throw Error("EIO");
    };
    assert.throws(() => executor.cancel(run), /RUNTIME_STORAGE_FAILED/);
    await assert.rejects(promptly(execution), /RUNTIME_STORAGE_FAILED/);
    assert.equal(run.state, "failed");
    assert.equal(run.error, "RUNTIME_STORAGE_FAILED");
    host.resolve("late");
    await sleep(0);
    assert.equal(run.results.a, undefined);
  } finally {
    host.resolve(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("仅后台错误保留有界回执，命令失败保留稳定错误码", async () => {
  const dir = tmp();
  try {
    const store = new RunStore(dir);
    const result = { kind: "background", jobId: "job-123" };
    for (const code of [
      "RUNTIME_BACKGROUND_UNSUPPORTED",
      "RUNTIME_COMMAND_FAILED",
      "arbitrary",
    ]) {
      const executor = new RuntimeExecutor(store, async () => {
        throw Object.assign(Error(code), { result });
      });
      const run = executor.createRun(
        "s1",
        parsePlan({ steps: [step("a", "pwsh")] }),
      );
      await executor.execute(run);
      assert.equal(run.state, "failed");
      if (code === "RUNTIME_BACKGROUND_UNSUPPORTED") {
        assert.equal(run.steps[0].state, "unknown");
        assert.deepEqual(run.results.a.value, result);
        assert.equal(store.load(run.runId).results.a.value.jobId, "job-123");
      } else {
        assert.equal(run.steps[0].state, "failed");
        assert.equal(run.results.a, undefined);
      }
      assert.equal(
        run.error,
        code === "arbitrary" ? "RUNTIME_STEP_FAILED" : code,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("宿主明确超时保留 STEP_TIMEOUT、副作用 unknown；命令取消不确定性保留 unknown", async () => {
  const dir = tmp();
  try {
    const store = new RunStore(dir);
    for (const [code, flag] of [
      ["RUNTIME_STEP_TIMEOUT", false],
      ["RUNTIME_COMMAND_FAILED", true],
    ]) {
      const executor = new RuntimeExecutor(store, async () => {
        throw Object.assign(Error(code), { unknownSideEffect: flag });
      });
      const run = executor.createRun(
        "s1",
        parsePlan({ steps: [step("a", "pwsh")] }),
      );
      await executor.execute(run);
      assert.equal(run.state, "failed");
      assert.equal(run.steps[0].state, "unknown");
      assert.equal(run.error, code);
      assert.equal(store.load(run.runId).steps[0].state, "unknown");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

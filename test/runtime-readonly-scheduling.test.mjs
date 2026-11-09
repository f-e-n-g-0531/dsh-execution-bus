import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunStore } from "../dist/runtime/store.js";
import { RuntimeExecutor } from "../dist/runtime/executor.js";
import { parsePlan } from "../dist/runtime/plan.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const step = (id, tool = "read", depends_on = []) => ({
  id,
  tool,
  input: { id },
  depends_on,
});
async function fixture(work) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xiaohe-pipeline-"));
  try {
    await work(new RunStore(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("read-only completion refills slots and checkpoints dependencies before dispatch", async () => {
  await fixture(async (store) => {
    const slow = deferred();
    const calls = [];
    let active = 0,
      peak = 0;
    const executor = new RuntimeExecutor(store, async (_tool, { id }) => {
      calls.push(id);
      peak = Math.max(peak, ++active);
      try {
        if (id === "a") await slow.promise;
        if (id === "c") {
          const saved = store.load(run.runId);
          assert.equal(saved.steps[1].state, "succeeded");
          assert.equal(saved.results.b.value, "b");
        }
        return id;
      } finally {
        active--;
      }
    });
    const run = executor.createRun(
      "owner",
      parsePlan({
        concurrency: 2,
        steps: [
          step("a"),
          step("b", "glob"),
          step("c", "grep", ["b"]),
          step("d", "read", ["a", "c"]),
        ],
      }),
    );
    const execution = executor.execute(run);
    try {
      await tick();
      assert.deepEqual(calls, ["a", "b", "c"]);
      assert.equal(peak, 2);
      assert.equal(run.state, "running");
    } finally {
      slow.resolve();
      await execution;
    }
    assert.equal(run.state, "succeeded");
    assert.deepEqual(calls, ["a", "b", "c", "d"]);
  });
});

test("mixed plans retain their batch barrier even before a later write", async () => {
  await fixture(async (store) => {
    const slow = deferred(),
      calls = [];
    const executor = new RuntimeExecutor(store, async (_tool, { id }) => {
      calls.push(id);
      if (id === "a") await slow.promise;
      return id;
    });
    const run = executor.createRun(
      "owner",
      parsePlan({
        concurrency: 2,
        steps: [
          step("a"),
          step("b"),
          step("c", "read", ["b"]),
          step("write", "write", ["c"]),
        ],
      }),
    );
    const execution = executor.execute(run);
    try {
      await tick();
      assert.deepEqual(calls, ["a", "b"]);
    } finally {
      slow.resolve();
      await execution;
    }
    assert.equal(run.state, "succeeded");
  });
});

test("failed read stops refill while already-started siblings drain", async () => {
  await fixture(async (store) => {
    const slow = deferred(),
      calls = [];
    const executor = new RuntimeExecutor(store, async (_tool, { id }) => {
      calls.push(id);
      if (id === "a") await slow.promise;
      if (id === "b") throw Object.assign(Error("bad"), { code: "EINVAL" });
      return id;
    });
    const run = executor.createRun(
      "owner",
      parsePlan({ concurrency: 2, steps: [step("a"), step("b"), step("c")] }),
    );
    const execution = executor.execute(run);
    try {
      await tick();
      assert.deepEqual(calls, ["a", "b"]);
    } finally {
      slow.resolve();
      await execution;
    }
    assert.equal(run.state, "failed");
    assert.equal(run.steps[0].state, "succeeded");
    assert.equal(run.steps[2].attempts, 0);
  });
});

test("cancelled pipeline never refills and ignores late results", async () => {
  await fixture(async (store) => {
    const slow = deferred(),
      calls = [];
    const controller = new AbortController();
    const executor = new RuntimeExecutor(store, async (_tool, { id }) => {
      calls.push(id);
      await slow.promise;
      return id;
    });
    const run = executor.createRun(
      "owner",
      parsePlan({ concurrency: 2, steps: [step("a"), step("b"), step("c")] }),
    );
    const execution = executor.execute(run, controller.signal);
    await tick();
    controller.abort();
    await execution;
    slow.resolve();
    await tick();
    assert.equal(run.state, "cancelled");
    assert.deepEqual(calls, ["a", "b"]);
    assert.deepEqual(run.results, {});
  });
});

test("backoff retains one slot without duplicate dispatch while other slots refill", async () => {
  await fixture(async (store) => {
    const calls = [];
    let attempts = 0;
    const executor = new RuntimeExecutor(store, async (_tool, { id }) => {
      calls.push(id);
      if (id === "a" && ++attempts === 1)
        throw Object.assign(Error("busy"), { code: "EAGAIN" });
      return id;
    });
    const run = executor.createRun(
      "owner",
      parsePlan({
        concurrency: 2,
        steps: [
          { ...step("a"), retry: 1 },
          step("b"),
          step("c", "glob", ["b"]),
          step("d", "grep", ["c"]),
        ],
      }),
    );
    const execution = executor.execute(run);
    await tick();
    assert.deepEqual(calls, ["a", "b", "c", "d"]);
    assert.equal(run.steps[0].state, "pending");
    await execution;
    assert.deepEqual(calls, ["a", "b", "c", "d", "a"]);
    assert.equal(run.steps[0].attempts, 2);
    assert.equal(run.state, "succeeded");
  });
});

test("dependency checkpoint failure prevents refill and rejects execution", async () => {
  await fixture(async (store) => {
    const slow = deferred(),
      calls = [];
    const save = store.save.bind(store);
    store.save = (run) => {
      if (run.steps[1].state === "succeeded")
        throw Error("RUNTIME_STORAGE_FAILED");
      return save(run);
    };
    const executor = new RuntimeExecutor(store, async (_tool, { id }) => {
      calls.push(id);
      if (id === "a") await slow.promise;
      return id;
    });
    const run = executor.createRun(
      "owner",
      parsePlan({
        concurrency: 2,
        steps: [step("a"), step("b"), step("c", "read", ["b"])],
      }),
    );
    await assert.rejects(executor.execute(run), /RUNTIME_STORAGE_FAILED/);
    slow.resolve();
    await tick();
    assert.deepEqual(calls, ["a", "b"]);
    assert.equal(run.steps[2].attempts, 0);
  });
});

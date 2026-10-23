import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { RuntimeService } from "../dist/runtime/service.js";
import { RuntimeExecutor } from "../dist/runtime/executor.js";
import { RunStore } from "../dist/runtime/store.js";
import { parsePlan } from "../dist/runtime/plan.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function bounded(promise, label, ms = 3000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("Timed out: " + label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const exec = (id = "owner", signal = new AbortController().signal) => ({
  agent: { id },
  callId: "service-test",
  signal,
});
const plan = (tag = "work") => ({
  steps: [{ id: tag, tool: "read", input: { tag } }],
});
const context = (invoke) => ({
  tools: {
    execute: async (call) => ({ isError: false, value: await invoke(call) }),
  },
});

class ObservedStore extends RunStore {
  watchers = [];
  fail = false;
  save(run) {
    if (this.fail) throw Error("RUNTIME_STORAGE_FAILED");
    super.save(run);
    for (const watcher of [...this.watchers]) {
      if (watcher.predicate(run)) {
        this.watchers.splice(this.watchers.indexOf(watcher), 1);
        watcher.resolve(structuredClone(run));
      }
    }
  }
  observe(predicate) {
    const event = deferred();
    this.watchers.push({ predicate, resolve: event.resolve });
    return event.promise;
  }
}
function fixture(invoke = async () => ({ ok: true })) {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-service-"));
  const store = new ObservedStore(root);
  const services = [];
  const create = (handler = invoke, persistence = store) => {
    const service = new RuntimeService(context(handler), persistence);
    services.push(service);
    return service;
  };
  return {
    root,
    store,
    create,
    async close() {
      await bounded(
        Promise.all(services.map((service) => service.dispose())),
        "fixture disposal",
      );
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function interrupted(store, owner = "owner", tag = "recover") {
  const executor = new RuntimeExecutor(store, async () => ({}));
  const run = executor.createRun(owner, parsePlan(plan(tag)));
  run.state = "interrupted";
  run.error = "RUNTIME_INTERRUPTED";
  run.finishedAt = run.updatedAt;
  store.save(run);
  return run;
}
async function terminal(store, runId, operation) {
  const saved = store.observe(
    (run) =>
      run.runId === runId &&
      ["succeeded", "failed", "cancelled"].includes(run.state),
  );
  operation();
  await bounded(saved, "terminal checkpoint");
  // Checkpoint happens before the service finally removes its registry entry/prunes.
  await nextTurn();
}

test(
  "same-root service scopes share active registry without interrupting or resuming live work",
  { timeout: 10000 },
  async () => {
    const entered = deferred();
    const gate = deferred();
    let calls = 0;
    const f = fixture(async () => {
      calls++;
      entered.resolve();
      return gate.promise;
    });
    try {
      const first = f.create();
      const started = await first.run({ plan: plan(), async: true }, exec());
      await bounded(entered.promise, "tool entry");
      const second = f.create(undefined, new RunStore(f.root));
      assert.equal(
        second.status({ runId: started.runId }, exec()).state,
        "running",
      );
      assert.equal(f.store.load(started.runId).state, "running");
      await assert.rejects(
        second.resume({ runId: started.runId }, exec()),
        /RUNTIME_INVALID_STATE/,
      );
      await second.dispose();
      assert.equal(
        first.status({ runId: started.runId }, exec()).state,
        "running",
        "disposing a sibling must not cancel its owner",
      );
      await terminal(f.store, started.runId, () =>
        gate.resolve({ preserved: true }),
      );
      assert.equal(
        first.result({ runId: started.runId }, exec()).state,
        "succeeded",
      );
      assert.equal(calls, 1);
    } finally {
      gate.resolve({});
      await f.close();
    }
  },
);

test("status/result/cancel/resume reject another owner for active, interrupted and completed runs", async () => {
  const entered = deferred();
  const gate = deferred();
  const f = fixture(async () => {
    entered.resolve();
    return gate.promise;
  });
  try {
    const service = f.create();
    const active = await service.run({ plan: plan(), async: true }, exec());
    await bounded(entered.promise, "tool entry");
    const recovery = interrupted(f.store);
    const deny = async (runId) => {
      for (const method of ["status", "result", "cancel", "resume"]) {
        await assert.rejects(
          async () => service[method]({ runId }, exec("intruder")),
          /RUNTIME_NOT_FOUND/,
          method,
        );
      }
    };
    await deny(active.runId);
    await deny(recovery.runId);
    assert.deepEqual(service.status({}, exec("intruder")).runs, []);
    assert.equal(
      service.status({ runId: active.runId }, exec()).state,
      "running",
    );
    await terminal(f.store, active.runId, () => gate.resolve({ ok: true }));
    await deny(active.runId);
    await assert.rejects(
      service.run({ plan: plan() }, { callId: "anonymous" }),
      /OWNING_SESSION_REQUIRED/,
    );
  } finally {
    gate.resolve({});
    await f.close();
  }
});

test("synchronous outer exec.signal abort reaches the tool and promptly cancels non-cooperative work", async () => {
  const entered = deferred();
  const gate = deferred();
  let innerSignal;
  const f = fixture(async ({ signal }) => {
    innerSignal = signal;
    entered.resolve();
    return gate.promise;
  });
  try {
    const service = f.create();
    const outer = new AbortController();
    const pending = service.run({ plan: plan() }, exec("owner", outer.signal));
    await bounded(entered.promise, "tool entry");
    outer.abort();
    const result = await bounded(pending, "cancel completion");
    assert.equal(innerSignal.aborted, true);
    assert.equal(result.state, "cancelled");
    gate.resolve({ tooLate: true });
    await nextTurn();
    assert.equal(
      service.result({ runId: result.runId }, exec()).state,
      "cancelled",
    );
    assert.deepEqual(
      service.result({ runId: result.runId }, exec()).results,
      {},
    );
  } finally {
    gate.resolve({});
    await f.close();
  }
});

test("async true detaches after successful return so outer abort does not cancel running work", async () => {
  const entered = deferred();
  const gate = deferred();
  let innerSignal;
  const f = fixture(async ({ signal }) => {
    innerSignal = signal;
    entered.resolve();
    return gate.promise;
  });
  try {
    const service = f.create();
    const outer = new AbortController();
    const started = await service.run(
      { plan: plan(), async: true },
      exec("owner", outer.signal),
    );
    await bounded(entered.promise, "tool entry");
    outer.abort();
    assert.equal(innerSignal.aborted, false);
    assert.equal(
      service.status({ runId: started.runId }, exec()).state,
      "running",
    );
    await terminal(f.store, started.runId, () =>
      gate.resolve({ survived: true }),
    );
    const result = service.result({ runId: started.runId }, exec());
    assert.equal(result.state, "succeeded");
    assert.deepEqual(result.results.work.value, { survived: true });
  } finally {
    gate.resolve({});
    await f.close();
  }
});

test("dispose is idempotent, bounded for uncooperative tools and closes every public operation", async () => {
  const entered = deferred();
  const gate = deferred();
  const f = fixture(async () => {
    entered.resolve();
    return gate.promise;
  });
  try {
    const service = f.create();
    const started = await service.run({ plan: plan(), async: true }, exec());
    await bounded(entered.promise, "tool entry");
    const disposing = service.dispose();
    assert.equal(service.dispose(), disposing);
    await bounded(disposing, "uncooperative dispose");
    assert.equal(f.store.load(started.runId).state, "cancelled");
    for (const method of ["run", "status", "result", "cancel", "resume"]) {
      await assert.rejects(
        async () =>
          service[method](
            method === "run" ? { plan: plan() } : { runId: started.runId },
            exec(),
          ),
        /CLOSED/,
        method,
      );
    }
  } finally {
    gate.resolve({});
    await f.close();
  }
});

test("eight active runs consume shared admission quota for both run and resume", async () => {
  let calls = 0;
  const allEntered = deferred();
  const gate = deferred();
  const f = fixture(async () => {
    if (++calls === 8) allEntered.resolve();
    return gate.promise;
  });
  try {
    const first = f.create();
    const recovery = interrupted(f.store);
    const started = [];
    for (let i = 0; i < 8; i++)
      started.push(await first.run({ plan: plan(), async: true }, exec()));
    await bounded(allEntered.promise, "eight tools entered");
    const second = f.create(undefined, new RunStore(f.root));
    await assert.rejects(
      second.run({ plan: plan(), async: true }, exec()),
      /RUNTIME_BUSY/,
    );
    await assert.rejects(
      second.resume({ runId: recovery.runId }, exec()),
      /RUNTIME_BUSY/,
    );
    assert.equal(
      second.status({ runId: recovery.runId }, exec()).state,
      "interrupted",
    );
    assert.equal(calls, 8);
    for (const run of started) first.cancel({ runId: run.runId }, exec());
  } finally {
    gate.resolve({});
    await f.close();
  }
});

test("concurrent same-run resume across scopes invokes recovery at most once", async () => {
  const entered = deferred();
  const gate = deferred();
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    entered.resolve();
    return gate.promise;
  });
  try {
    const first = f.create();
    const second = f.create(undefined, new RunStore(f.root));
    const recovery = interrupted(f.store);
    const resumed = first.resume({ runId: recovery.runId }, exec());
    const duplicate = second.resume({ runId: recovery.runId }, exec());
    await assert.rejects(duplicate, /RUNTIME_INVALID_STATE/);
    await bounded(entered.promise, "recovery entry");
    gate.resolve({ recovered: true });
    assert.equal(
      (await bounded(resumed, "recovery completion")).state,
      "succeeded",
    );
    assert.equal(calls, 1);
    assert.equal(
      first.result({ runId: recovery.runId }, exec()).steps[0].attempts,
      1,
    );
  } finally {
    gate.resolve({});
    await f.close();
  }
});

test("cancel immediately after resume admission wins before the recovery microtask", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return { unexpected: true };
  });
  try {
    const service = f.create();
    const recovery = interrupted(f.store);
    const pending = service.resume({ runId: recovery.runId }, exec());
    assert.equal(
      service.cancel({ runId: recovery.runId }, exec()).state,
      "cancelled",
    );
    assert.equal(
      (await bounded(pending, "cancel/resume race")).state,
      "cancelled",
    );
    assert.equal(
      service.result({ runId: recovery.runId }, exec()).state,
      "cancelled",
    );
    assert.equal(f.store.load(recovery.runId).state, "cancelled");
    assert.equal(calls, 0);
  } finally {
    await f.close();
  }
});

test("status applies owner filtering before limit/offset pagination", async () => {
  const f = fixture();
  try {
    const service = f.create();
    const expected = [];
    const base = Date.now() - 100;
    for (let i = 0; i < 9; i++) {
      const owner = i % 2 ? "intruder" : "owner";
      const run = interrupted(f.store, owner);
      run.createdAt = run.updatedAt = run.finishedAt = base + i;
      f.store.save(run);
      if (owner === "owner") expected.unshift(run.runId);
    }
    assert.deepEqual(
      service
        .status({ limit: 2, offset: 1 }, exec())
        .runs.map((run) => run.runId),
      expected.slice(1, 3),
    );
    assert.deepEqual(
      service
        .status({ limit: 2, offset: 3 }, exec())
        .runs.map((run) => run.runId),
      expected.slice(3, 5),
    );
    assert.deepEqual(service.status({ limit: 2, offset: 5 }, exec()).runs, []);
  } finally {
    await f.close();
  }
});

test(
  "continuous completion retains only 100 terminal records without pruning active or interrupted runs",
  { timeout: 20000 },
  async () => {
    const entered = deferred();
    const gate = deferred();
    const f = fixture(async ({ arguments: input }) => {
      if (input.tag === "held") {
        entered.resolve();
        return gate.promise;
      }
      return { ok: true };
    });
    try {
      const service = f.create();
      const held = await service.run(
        { plan: plan("held"), async: true },
        exec(),
      );
      await bounded(entered.promise, "held tool entry");
      const recovery = interrupted(f.store);
      for (let i = 0; i < 105; i++) {
        await service.run({ plan: plan() }, exec());
        const records = f.store.list(1000);
        assert.equal(
          records.filter((run) =>
            ["succeeded", "failed", "cancelled"].includes(run.state),
          ).length,
          Math.min(i + 1, 100),
        );
        assert.equal(f.store.load(held.runId).state, "running");
        assert.equal(f.store.load(recovery.runId).state, "interrupted");
      }
      assert.equal(f.store.list(1000).length, 102);
    } finally {
      gate.resolve({});
      await f.close();
    }
  },
);

test(
  "offline cancellation continuously retains at most 100 terminal records without requiring a new scope or run completion",
  { timeout: 20000 },
  async () => {
    let calls = 0;
    const f = fixture(async () => {
      calls++;
      return { unexpected: true };
    });
    try {
      const service = f.create();
      const protectedRun = interrupted(f.store);
      const cancellations = [];
      for (let i = 0; i < 105; i++) {
        const recovery = interrupted(f.store);
        cancellations.push(recovery.runId);
        assert.equal(
          service.cancel({ runId: recovery.runId }, exec()).state,
          "cancelled",
        );
        const records = f.store.list(1000);
        const terminals = records.filter((run) =>
          ["succeeded", "failed", "cancelled"].includes(run.state),
        );
        assert.equal(
          terminals.length,
          Math.min(i + 1, 100),
          "retention must run on every offline cancel",
        );
        assert.equal(f.store.load(protectedRun.runId).state, "interrupted");
        assert.equal(records.length, Math.min(i + 1, 100) + 1);
      }
      assert.equal(
        f.store.list(1000).filter((run) => cancellations.includes(run.runId))
          .length,
        100,
      );
      assert.equal(calls, 0, "offline cancellation must not execute tools");
    } finally {
      await f.close();
    }
  },
);

test("offline interrupted cancellation save failure remains visible through volatile status and result", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return { unexpected: true };
  });
  try {
    const service = f.create();
    const recovery = interrupted(f.store);
    f.store.fail = true;
    assert.throws(
      () => service.cancel({ runId: recovery.runId }, exec()),
      /RUNTIME_STORAGE_FAILED/,
    );
    assert.equal(
      f.store.load(recovery.runId).state,
      "interrupted",
      "failed save leaves the old durable record intact",
    );
    const status = service.status({ runId: recovery.runId }, exec());
    assert.equal(status.state, "failed");
    assert.equal(status.error, "RUNTIME_STORAGE_FAILED");
    const result = service.result({ runId: recovery.runId }, exec());
    assert.equal(result.state, "failed");
    assert.equal(result.error, "RUNTIME_STORAGE_FAILED");
    assert.equal(result.finished, true);
    assert.deepEqual(result.results, {});
    const listed = service.status({}, exec()).runs;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].runId, recovery.runId);
    assert.equal(listed[0].state, "failed");
    assert.equal(listed[0].error, "RUNTIME_STORAGE_FAILED");
    assert.throws(
      () => service.status({ runId: recovery.runId }, exec("intruder")),
      /RUNTIME_NOT_FOUND/,
    );
    assert.deepEqual(service.status({}, exec("intruder")).runs, []);
    assert.equal(calls, 0);
  } finally {
    f.store.fail = false;
    await f.close();
  }
});

test("detached storage failure remains queryable as failed/error and never leaks an unhandled rejection", async () => {
  const entered = deferred();
  const gate = deferred();
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const f = fixture(async () => {
    entered.resolve();
    return gate.promise;
  });
  try {
    const service = f.create();
    const started = await service.run({ plan: plan(), async: true }, exec());
    await bounded(entered.promise, "tool entry");
    f.store.fail = true;
    gate.resolve({ cannotPersist: true });
    // Promise reactions drain before the next event-loop turn (not a timed sleep).
    await nextTurn();
    await nextTurn();
    const status = service.status({ runId: started.runId }, exec());
    const result = service.result({ runId: started.runId }, exec());
    assert.equal(status.state, "failed");
    assert.equal(status.error, "RUNTIME_STORAGE_FAILED");
    assert.equal(result.finished, true);
    assert.equal(result.error, "RUNTIME_STORAGE_FAILED");
    assert.equal(
      service.status({}, exec()).runs[0].error,
      "RUNTIME_STORAGE_FAILED",
    );
    assert.deepEqual(unhandled, []);
  } finally {
    f.store.fail = false;
    gate.resolve({});
    await f.close();
    process.off("unhandledRejection", onUnhandled);
  }
});

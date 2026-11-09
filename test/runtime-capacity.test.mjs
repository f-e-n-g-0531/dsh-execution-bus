import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { RuntimeService } from "../dist/runtime/service.js";
import { RunStore } from "../dist/runtime/store.js";
import {
  RUNTIME_OUTPUT_SCHEMAS,
  runtimePresentationMeta,
} from "../dist/presentation.js";
import { RUNTIME_CAPABILITIES_PARAMETERS } from "../dist/product.js";
import * as plugin from "../dist/plugin.js";
import { createServiceContext } from "./fixtures/service-context.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function bounded(promise, label, ms = 4000) {
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
const exec = (id = "owner", toolSet) => ({
  agent: { id },
  callId: "capacity-test",
  signal: new AbortController().signal,
  ...(toolSet === undefined ? {} : { toolSet }),
});
const request = () => ({
  plan: { steps: [{ id: "read", tool: "read", input: {} }] },
});
class CountedStore extends RunStore {
  saves = 0;
  save(run) {
    this.saves++;
    return super.save(run);
  }
}
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-capacity-"));
  const services = [];
  const stores = [];
  const gates = [];
  const pending = [];
  function create(handler = async () => ({}), adapter) {
    const store = new CountedStore(root);
    stores.push(store);
    const service = new RuntimeService(
      createServiceContext(handler),
      store,
      adapter,
    );
    services.push(service);
    return service;
  }
  function gate() {
    const value = deferred();
    gates.push(value);
    return value;
  }
  function start(service, owner = "owner") {
    const promise = service.run(request(), exec(owner));
    // Preserve the original rejection for assertions, but never leave a failed
    // start unobserved if a different assertion exits the test first.
    void promise.catch(() => {});
    pending.push(promise);
    return promise;
  }
  return {
    root,
    stores,
    create,
    gate,
    start,
    async close() {
      for (const gate of gates) gate.resolve({ released: true });
      await bounded(Promise.allSettled(pending), "run settlement");
      await bounded(
        Promise.all(services.map((service) => service.dispose())),
        "service disposal",
      );
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function hostSnapshot(service, expected = {}) {
  const before = Date.now();
  const value = service.capacity();
  const after = Date.now();
  assert.deepEqual(
    Object.keys(value).sort(),
    [
      "scope",
      "observedAt",
      "occupiedRuns",
      "executingRuns",
      "cleanupRuns",
      "runLimit",
      "workersInUse",
      "workerLimit",
    ].sort(),
  );
  assert.equal(value.scope, "module_process_root");
  assert.ok(Number.isSafeInteger(value.observedAt));
  assert.ok(value.observedAt >= before && value.observedAt <= after);
  assert.equal(value.runLimit, 8);
  assert.equal(value.workerLimit, 8);
  assert.equal(value.cleanupRuns, value.occupiedRuns - value.executingRuns);
  for (const [key, count] of Object.entries(expected))
    assert.equal(value[key], count, key);
  return value;
}
function modelSnapshot(service, busy, owner = "observer", toolSet) {
  const before = Date.now();
  const result = service.capabilities({}, exec(owner, toolSet));
  const value = result.capacity;
  assert.deepEqual(
    Object.keys(value).sort(),
    ["scope", "observedAt", "capacityBusy"].sort(),
  );
  assert.equal(value.scope, "module_process_root");
  assert.equal(value.capacityBusy, busy);
  assert.ok(Number.isSafeInteger(value.observedAt));
  assert.ok(value.observedAt >= before && value.observedAt <= Date.now());
  // Counts remain host-only, even at the top level of the model response.
  for (const key of [
    "occupiedRuns",
    "executingRuns",
    "cleanupRuns",
    "workersInUse",
  ]) {
    assert.equal(Object.hasOwn(result, key), false);
    assert.equal(Object.hasOwn(value, key), false);
  }
  return result;
}

test(
  "capacity snapshots are idle, active, completed and detached copies",
  { timeout: 12000 },
  async () => {
    const f = fixture();
    const entered = f.gate();
    const release = f.gate();
    const service = f.create(() => {
      entered.resolve();
      return release.promise;
    });
    try {
      const idle = hostSnapshot(service, {
        occupiedRuns: 0,
        executingRuns: 0,
        cleanupRuns: 0,
        workersInUse: 0,
      });
      modelSnapshot(service, false);
      const running = f.start(service);
      await bounded(entered.promise, "read entry");
      const active = hostSnapshot(service, {
        occupiedRuns: 1,
        executingRuns: 1,
        cleanupRuns: 0,
        workersInUse: 0,
      });
      const model = modelSnapshot(service, false);
      idle.occupiedRuns = 99;
      active.occupiedRuns = 99;
      active.executingRuns = -1;
      active.workerLimit = 99;
      model.capacity.capacityBusy = true;
      model.capacity.scope = "changed";
      hostSnapshot(service, {
        occupiedRuns: 1,
        executingRuns: 1,
        workerLimit: 8,
      });
      modelSnapshot(service, false);
      release.resolve({ ok: true });
      const completed = await bounded(running, "completion");
      assert.equal(completed.state, "succeeded");
      hostSnapshot(service, {
        occupiedRuns: 0,
        executingRuns: 0,
        cleanupRuns: 0,
        workersInUse: 0,
      });
      modelSnapshot(service, false);
      assert.equal(
        active.occupiedRuns,
        99,
        "future snapshots never mutate earlier copies",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "same canonical root shares capacity across services while another root is isolated",
  { timeout: 12000 },
  async () => {
    const f = fixture();
    const isolated = fixture();
    const entered = f.gate();
    const release = f.gate();
    const first = f.create(() => {
      entered.resolve();
      return release.promise;
    });
    try {
      const running = f.start(first, "private-owner");
      await bounded(entered.promise, "shared read entry");
      const peer = f.create();
      const otherRoot = isolated.create();
      for (const service of [first, peer]) {
        hostSnapshot(service, { occupiedRuns: 1, executingRuns: 1 });
        modelSnapshot(service, false);
      }
      hostSnapshot(otherRoot, {
        occupiedRuns: 0,
        executingRuns: 0,
        workersInUse: 0,
      });
      modelSnapshot(otherRoot, false);
      assert.deepEqual(peer.status({}, exec("observer")).runs, []);
      release.resolve({ ok: true });
      await bounded(running, "shared completion");
      hostSnapshot(peer, { occupiedRuns: 0, executingRuns: 0 });
    } finally {
      await f.close();
      await isolated.close();
    }
  },
);

test(
  "eight shared runs are busy to an otherwise blind owner; queries never reserve and ninth stays rejected",
  { timeout: 15000 },
  async () => {
    const f = fixture();
    const isolated = fixture();
    const allEntered = f.gate();
    const release = f.gate();
    let calls = 0;
    const owner = f.create(() => {
      if (++calls === 8) allEntered.resolve();
      return release.promise;
    });
    const peer = f.create();
    try {
      for (let i = 0; i < 12; i++) modelSnapshot(peer, false);
      const running = Array.from({ length: 8 }, () =>
        f.start(owner, "private-owner"),
      );
      await bounded(allEntered.promise, "eight read entries");
      hostSnapshot(peer, { occupiedRuns: 8, executingRuns: 8, cleanupRuns: 0 });
      assert.deepEqual(peer.status({}, exec("observer")).runs, []);
      const privateRuns = owner.status({}, exec("private-owner")).runs;
      assert.equal(privateRuns.length, 8);
      for (const run of privateRuns)
        assert.throws(
          () => peer.status({ runId: run.runId }, exec("observer")),
          /RUNTIME_NOT_FOUND/,
        );
      const saved = f.stores.map((store) => store.saves);
      for (let i = 0; i < 12; i++) {
        const value = modelSnapshot(peer, true);
        assert.equal(value.worker, "unavailable");
        assert.equal(value.workerReason, "trusted_adapter_missing");
        hostSnapshot(peer, {
          occupiedRuns: 8,
          executingRuns: 8,
          workersInUse: 0,
        });
        for (const run of privateRuns)
          assert.equal(JSON.stringify(value).includes(run.runId), false);
        assert.equal(JSON.stringify(value).includes(f.root), false);
      }
      assert.deepEqual(
        f.stores.map((store) => store.saves),
        saved,
      );
      await assert.rejects(
        peer.run(request(), exec("observer")),
        /^Error: RUNTIME_BUSY$/,
      );
      assert.deepEqual(
        f.stores.map((store) => store.saves),
        saved,
        "busy admission creates no checkpoint",
      );
      assert.equal(calls, 8);
      const otherRoot = isolated.create();
      hostSnapshot(otherRoot, { occupiedRuns: 0 });
      modelSnapshot(otherRoot, false);
      assert.equal(
        (await bounded(isolated.start(otherRoot), "isolated admission")).state,
        "succeeded",
      );
      release.resolve({ ok: true });
      assert.ok(
        (await bounded(Promise.all(running), "eight completions")).every(
          (run) => run.state === "succeeded",
        ),
      );
      modelSnapshot(peer, false);
      hostSnapshot(peer, { occupiedRuns: 0, cleanupRuns: 0 });
      assert.equal(
        (await bounded(f.start(peer, "observer"), "admission after release"))
          .state,
        "succeeded",
      );
    } finally {
      await f.close();
      await isolated.close();
    }
  },
);

test("capacity queries neither write the store nor dispatch tools or call parent policy", async () => {
  const f = fixture();
  let dispatches = 0;
  let policies = 0;
  const service = f.create(
    async () => {
      dispatches++;
      return {};
    },
    {
      checkParentPolicy() {
        policies++;
        throw Error("must not authorize during query");
      },
    },
  );
  try {
    const saved = f.stores[0].saves;
    for (let i = 0; i < 10; i++) {
      hostSnapshot(service, { occupiedRuns: 0, workersInUse: 0 });
      assert.equal(modelSnapshot(service, false).worker, "unavailable");
      const conditional = modelSnapshot(service, false, "observer", {});
      assert.equal(conditional.worker, "conditional");
      assert.equal(conditional.authorization, "checked_at_execution");
    }
    assert.equal(f.stores[0].saves, saved);
    assert.deepEqual(f.stores[0].list(), []);
    assert.equal(dispatches, 0);
    assert.equal(policies, 0);
  } finally {
    await f.close();
  }
});

test("terminal cleanup occupancy and worker quota are distinct from executing runs and model authorization", async () => {
  const f = fixture();
  const service = f.create();
  const peer = f.create();
  const releases = [];
  // Deliberate private-manager fixture: terminal-but-unsettled entries and Worker
  // reservations (and an admitted interrupted resume window) are held
  // synchronously without starting an unsupported rc.1
  // Worker. This verifies aggregate classification, not real Worker cleanup.
  const manager = service.manager;
  try {
    for (const state of ["succeeded", "failed", "cancelled", "interrupted"]) {
      manager.active.set("synthetic-" + state, { run: { state } });
    }
    for (let i = 0; i < 8; i++) releases.push(manager.workerQuota.reserve());
    hostSnapshot(peer, {
      occupiedRuns: 4,
      executingRuns: 1,
      cleanupRuns: 3,
      workersInUse: 8,
    });
    const value = modelSnapshot(peer, false);
    assert.equal(
      value.worker,
      "unavailable",
      "Worker quota availability does not authorize a Worker",
    );
    for (let i = 0; i < 4; i++)
      manager.active.set("synthetic-running-" + i, {
        run: { state: "running" },
      });
    hostSnapshot(service, {
      occupiedRuns: 8,
      executingRuns: 5,
      cleanupRuns: 3,
      workersInUse: 8,
    });
    modelSnapshot(peer, true);
    for (const release of releases) release();
    hostSnapshot(peer, { workersInUse: 0, occupiedRuns: 8 });
    modelSnapshot(peer, true, "different-owner");
  } finally {
    for (const release of releases) release();
    manager.active.clear();
    await f.close();
  }
});

test("admitted resume initialization is executing, not terminal cleanup", async () => {
  const f = fixture();
  const service = f.create();
  try {
    const completed = await f.start(service);
    const record = f.stores[0].load(completed.runId);
    record.state = "interrupted";
    f.stores[0].save(record);
    const resumed = service.resume({ runId: record.runId }, exec());
    // start registers synchronously, executor.resume runs in the next microtask.
    hostSnapshot(service, {
      occupiedRuns: 1,
      executingRuns: 1,
      cleanupRuns: 0,
    });
    assert.equal(
      (await bounded(resumed, "resume initialization")).state,
      "succeeded",
    );
    hostSnapshot(service, {
      occupiedRuns: 0,
      executingRuns: 0,
      cleanupRuns: 0,
    });
  } finally {
    await f.close();
  }
});

test("dispose closes both capacity entry points immediately and leaves a sibling usable", async () => {
  const f = fixture();
  const service = f.create();
  const peer = f.create();
  try {
    const disposing = service.dispose();
    assert.throws(() => service.capacity(), /CLOSED/);
    assert.throws(() => service.capabilities({}, exec()), /CLOSED/);
    await bounded(disposing, "closed facade disposal");
    assert.throws(() => service.capacity(), /CLOSED/);
    assert.throws(() => service.capabilities({}, exec()), /CLOSED/);
    hostSnapshot(peer, { occupiedRuns: 0 });
  } finally {
    await f.close();
  }
});

test("capacity schema and presentation expose only the coarse busy observation", async () => {
  const f = fixture();
  const service = f.create();
  try {
    const schema = RUNTIME_OUTPUT_SCHEMAS.runtime_capabilities;
    const value = modelSnapshot(service, false);
    assert.deepEqual(validateJsonSchemaValue(schema, value), []);
    assert.deepEqual(
      validateJsonSchemaValue(RUNTIME_CAPABILITIES_PARAMETERS, {}),
      [],
    );
    for (const input of [
      { capacity: {} },
      { occupiedRuns: true },
      { root: f.root },
    ]) {
      assert.ok(
        validateJsonSchemaValue(RUNTIME_CAPABILITIES_PARAMETERS, input).length >
          0,
      );
      assert.throws(() => service.capabilities(input, exec()), /INVALID_PLAN/);
    }
    for (const capacity of [
      undefined,
      { ...value.capacity, occupiedRuns: 0 },
      { ...value.capacity, capacityBusy: 0 },
      { ...value.capacity, scope: "account" },
      { scope: "module_process_root", capacityBusy: false },
    ]) {
      const invalid = { ...value };
      if (capacity === undefined) delete invalid.capacity;
      else invalid.capacity = capacity;
      assert.ok(validateJsonSchemaValue(schema, invalid).length > 0);
    }
    const legacy = { ...value };
    delete legacy.capacity;
    const legacyText = runtimePresentationMeta({}, legacy).text;
    assert.match(legacyText, /普通 DAG/);
    assert.doesNotMatch(legacyText, /共享运行准入/);
    const idleText = runtimePresentationMeta({}, value).text;
    const busyValue = {
      ...value,
      capacity: { ...value.capacity, capacityBusy: true },
    };
    assert.deepEqual(validateJsonSchemaValue(schema, busyValue), []);
    const busyText = runtimePresentationMeta({}, busyValue).text;
    assert.notEqual(idleText, busyText);
    assert.match(idleText, /未观察到满载|capacityBusy[^\n]*false/);
    assert.match(busyText, /繁忙|capacityBusy[^\n]*true/);
    for (const text of [idleText, busyText]) {
      assert.match(text, /不代表授权|不等于授权/);
      assert.match(text, /预留/);
      assert.match(text, /瞬时|观察/);
      assert.equal(text.includes(f.root), false);
      assert.doesNotMatch(
        text,
        /occupiedRuns|executingRuns|cleanupRuns|workersInUse/,
      );
    }
  } finally {
    await f.close();
  }
});

test("host capacity is not registered as a model tool", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-capacity-plugin-"));
  const previous = process.env.XIAOHE_RUNTIME_DIR;
  const tools = [];
  const disposers = [];
  process.env.XIAOHE_RUNTIME_DIR = root;
  try {
    plugin.apply({
      effect(fn) {
        disposers.push(fn());
      },
      tools: {
        register(tool) {
          tools.push(tool);
        },
      },
    });
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "runtime_acknowledge",
      "runtime_cancel",
      "runtime_capabilities",
      "runtime_decision",
      "runtime_handoff",
      "runtime_notification",
      "runtime_query",
      "runtime_result",
      "runtime_resume",
      "runtime_review",
      "runtime_run",
      "runtime_status",
      "runtime_task",
    ]);
    const query = tools.find((tool) => tool.name === "runtime_capabilities");
    assert.deepEqual(query.parameters, RUNTIME_CAPABILITIES_PARAMETERS);
    const value = await query.execute({}, exec());
    assert.deepEqual(
      Object.keys(value.capacity).sort(),
      ["scope", "observedAt", "capacityBusy"].sort(),
    );
    await assert.rejects(
      query.execute({ capacity: true }, exec()),
      /INVALID_PLAN/,
    );
  } finally {
    await bounded(
      Promise.all(disposers.map((dispose) => dispose())),
      "plugin disposal",
    );
    if (previous === undefined) delete process.env.XIAOHE_RUNTIME_DIR;
    else process.env.XIAOHE_RUNTIME_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { ExecutionBus } from "../dist/bus.js";
import { ExecutionOwner } from "../dist/execution.js";
import { setTimeout as delay } from "node:timers/promises";
const owner = { sessionId: "SECRET_SESSION", callId: "SECRET_CALL" },
  message = (id) => ({
    protocolVersion: 1,
    messageId: "m",
    requestId: id,
    type: "request",
    payload: { handler: "h", input: { secret: "PRIVATE_INPUT" } },
  });
test("dispatch batches exclude newly attached listeners and skip listeners removed before turn", async () => {
  const b = new ExecutionBus();
  let gate;
  const ready = new Promise((r) => (gate = r));
  b.register("h", {
    validate() {},
    async run(_, c) {
      await ready;
      c.progress(1, 50);
      c.progress(2, 100);
      return true;
    },
  });
  const late = [],
    removed = [];
  let attached, second;
  const first = b.submit(owner, message("r"), (e) => {
    if (e.type === "progress" && e.payload.percent === 50) {
      attached = b.submit(owner, message("r"), (e) => late.push(e));
      second.detach();
    }
  });
  second = b.submit(owner, message("r"), (e) => removed.push(e));
  gate();
  await first.done;
  assert.deepEqual(
    late.map((e) => e.type),
    ["progress", "succeeded"],
  );
  assert.equal(late[0].payload.percent, 100);
  assert.ok(!removed.some((e) => e.type === "progress"));
  attached.detach();
  await b.close();
});
test("nested cancel preserves event order and reentrant close is the same shutdown promise", async () => {
  const b = new ExecutionBus();
  b.register("h", {
    validate() {},
    async run(_, c) {
      await delay(1, undefined, { signal: c.signal });
      return true;
    },
  });
  let nested;
  const first = b.submit(owner, message("r"), (e) => {
    if (e.type === "started") nested = b.close();
  });
  const events = [];
  const other = b.submit(owner, message("r"), (e) => events.push(e));
  await first.done;
  assert.equal(nested, b.close());
  assert.equal(b.close(), b.close());
  await nested;
  assert.deepEqual(
    events.map((e) => e.type),
    ["started", "cancel_requested", "cancelled"],
  );
  assert.equal(b.diagnostics().phase, "closed");
  await other.done;
});
test("execution owner stops admission and waits both core drain and active delivery before releasing", async () => {
  const o = new ExecutionOwner();
  let coreDone, deliveryDone;
  const core = new Promise((r) => (coreDone = r)),
    delivery = new Promise((r) => (deliveryDone = r));
  o.track(delivery);
  let calls = 0;
  const close = o.close(() => {
    calls++;
    return core;
  });
  assert.equal(o.phase, "draining");
  assert.equal(
    close,
    o.close(() => {
      throw Error("must not call twice");
    }),
  );
  assert.throws(() => o.create("key", {}, "s", {}), /CLOSED/);
  coreDone();
  await Promise.resolve();
  assert.notEqual(o.phase, "closed");
  deliveryDone();
  await close;
  assert.equal(calls, 1);
  assert.equal(o.phase, "closed");
});
test("diagnostics are bounded detached numeric metadata with no private identifiers or results", async () => {
  const b = new ExecutionBus();
  b.register("h", {
    validate() {},
    async run() {
      return "PRIVATE_RESULT";
    },
  });
  for (let i = 0; i < 70; i++) {
    const a = b.submit(owner, message("SECRET_REQUEST_" + i));
    await a.done;
    a.returned();
  }
  const d = b.diagnostics();
  assert.equal(d.traces.length, 128);
  assert.equal(d.counts.accepted, 70);
  assert.ok(d.retainedResultBytes > 0);
  assert.ok(
    d.traces.every((e) => Number.isFinite(e.elapsedMs) && e.elapsedMs >= 0),
  );
  assert.ok(
    !JSON.stringify(d).includes("PRIVATE") &&
      !JSON.stringify(d).includes("SECRET"),
  );
  d.traces[0].stage = "bad";
  assert.notEqual(b.diagnostics().traces[0].stage, "bad");
  await b.close();
  assert.equal(b.diagnostics().retainedResultBytes, 0);
});

test("duplicate waiter projection capacity remains bounded during admission pressure", async () => {
  const b = new ExecutionBus();
  let release;
  const gate = new Promise((r) => (release = r));
  let count = 0;
  b.register("h", {
    validate() {},
    async run() {
      count++;
      await gate;
      return true;
    },
  });
  const calls = [];
  for (let i = 0; i < 32; i++)
    calls.push(
      b.submit(owner, { ...message("r"), messageId: "d" + i }, () => {}),
    );
  assert.throws(
    () => b.submit(owner, { ...message("r"), messageId: "over" }, () => {}),
    /WAITER_LIMIT/,
  );
  calls[0].detach();
  calls.push(
    b.submit(owner, { ...message("r"), messageId: "retry" }, () => {}),
  );
  release();
  await Promise.all(calls.map((c) => c.done));
  assert.equal(count, 1);
  assert.equal(b.diagnostics().counts.reused, 32);
  await b.close();
});

test("host projection diagnostics count cleanup failures without leaking error text", async () => {
  const { ExecutionHandle } = await import("../dist/execution.js");
  const { Diagnostics } = await import("../dist/diagnostics.js");
  const d = new Diagnostics();
  let finished;
  const done = new Promise((r) => (finished = r));
  const jobs = {
    start(spec) {
      spec.run({ updateProgress() {} });
      return "fixture-job";
    },
    async wait() {
      throw Error("PRIVATE_SERVICE_ERROR");
    },
    list() {
      return [{ id: "fixture-job", owner: "owner", status: "completed" }];
    },
    remove() {
      throw Error("PRIVATE_REMOVE_ERROR");
    },
  };
  const handle = new ExecutionHandle(jobs, "owner", { done, cancel() {} }, d);
  const outcome = assert.rejects(handle.settled, /PRIVATE_SERVICE_ERROR/);
  finished({
    requestId: "PRIVATE_ID",
    state: "succeeded",
    sequence: 1,
    cancelRequested: false,
    delivery: "pending",
  });
  await outcome;
  assert.equal(d.snapshot().counts.job_error, 1);
  assert.equal(d.snapshot().counts.job_created, 1);
  assert.ok(!JSON.stringify(d.snapshot()).includes("PRIVATE"));
  assert.equal(d.snapshot().counts.job_released, undefined);
});

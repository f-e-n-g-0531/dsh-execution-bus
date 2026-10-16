import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ExecutionBus } from "../dist/bus.js";
const owner = (s) => ({ sessionId: s, callId: "c" }),
  msg = (id) => ({
    protocolVersion: 1,
    messageId: "m",
    requestId: id,
    type: "request",
    payload: { handler: "h", input: { private: "SECRET" } },
  });
function fixture(policy = {}) {
  const b = new ExecutionBus(
    {
      concurrency: 1,
      queueLimit: 8,
      recordLimit: 64,
      resultBytes: 1024,
      retentionMs: 1000,
    },
    policy,
  );
  let release;
  const gate = new Promise((r) => (release = r));
  const calls = [];
  b.register("h", {
    validate() {},
    async run(_, ctx) {
      calls.push(ctx.requestId);
      if (ctx.requestId === "block") await gate;
      return { private: "RESULT_SECRET" };
    },
  });
  return { b, release, calls };
}
test("session admission bounds leave room for peer, reject without reserving identity and allow dedupe", async () => {
  const { b, release } = fixture({ sessionQueueLimit: 2 });
  const a = b.submit(owner("A"), msg("block"));
  await Promise.resolve();
  const q1 = b.submit(owner("A"), msg("q1")),
    q2 = b.submit(owner("A"), msg("q2"));
  assert.throws(() => b.submit(owner("A"), msg("q3")), /SESSION_BACKPRESSURE/);
  const duplicate = b.submit(owner("A"), msg("q1"));
  const peer = b.submit(owner("B"), msg("peer"));
  q2.cancel();
  const retry = b.submit(owner("A"), msg("q3"));
  release();
  await Promise.all([a, q1, q2, duplicate, peer, retry].map((a) => a.done));
  await b.close();
});
test("queued timeout never invokes handler, is reusable as terminal and does not cancel running work", async () => {
  const { b, release, calls } = fixture({ maxQueueWaitMs: 15 });
  const a = b.submit(owner("A"), msg("block"));
  await Promise.resolve();
  const queued = b.submit(owner("A"), msg("timeout"));
  const result = await queued.done;
  assert.equal(result.state, "failed");
  assert.equal(result.error, "QUEUE_WAIT_TIMEOUT");
  assert.equal(result.cancelRequested, false);
  assert.deepEqual(calls, ["block"]);
  assert.equal(
    (await b.submit(owner("A"), msg("timeout")).done).error,
    "QUEUE_WAIT_TIMEOUT",
  );
  await delay(20);
  assert.equal(b.inspect(owner("A")).counts.running, 1);
  release();
  assert.equal((await a.done).state, "succeeded");
  await b.close();
});
test("inspect is immutable, metadata-only and session-isolated, including history cap", async () => {
  const { b, release } = fixture();
  release();
  for (let i = 0; i < 55; i++) await b.submit(owner("A"), msg("a" + i)).done;
  await b.submit(owner("B"), msg("B_PRIVATE")).done;
  const s = b.inspect(owner("A"));
  assert.equal(s.tasks.length, 50);
  assert.equal(s.truncated, true);
  assert.equal(s.counts.terminal, 55);
  assert.ok(
    !JSON.stringify(s).includes("SECRET") &&
      !JSON.stringify(s).includes("B_PRIVATE"),
  );
  assert.throws(() => {
    s.tasks[0].state = "bad";
  }, TypeError);
  assert.throws(() => b.inspect({}), /OWNING_SESSION/);
  await b.close();
});
test("policy validation excludes accessors, invalid timers and mutable policy references", async () => {
  for (const p of [
    { maxQueueWaitMs: 0 },
    { maxQueueWaitMs: 2147483648 },
    { sessionQueueLimit: 1.2 },
    { unknown: 1 },
  ])
    assert.throws(() => new ExecutionBus(undefined, p), /INVALID_ADMISSION/);
  let called = false;
  assert.throws(
    () =>
      new ExecutionBus(undefined, {
        get maxQueueWaitMs() {
          called = true;
          return 1;
        },
      }),
    /INVALID_ADMISSION/,
  );
  assert.equal(called, false);
  const p = { sessionQueueLimit: 1 },
    b = new ExecutionBus(undefined, p);
  p.sessionQueueLimit = 100;
  assert.equal(b.admission.sessionQueueLimit, 1);
  await b.close();
});
test("cancel and close clear queue deadlines without delayed terminal changes", async () => {
  const { b, release, calls } = fixture({ maxQueueWaitMs: 20 });
  const a = b.submit(owner("A"), msg("block"));
  await Promise.resolve();
  const q = b.submit(owner("A"), msg("q"));
  q.cancel();
  const close = b.close();
  release();
  await close;
  assert.equal((await q.done).state, "cancelled");
  await delay(30);
  assert.equal(b.diagnostics().phase, "closed");
  assert.deepEqual(calls, ["block"]);
  await a.done;
});

test("expired queue deadline is checked before dispatch even when timers cannot run", async () => {
  const { b, release, calls } = fixture({ maxQueueWaitMs: 2 });
  const a = b.submit(owner("A"), msg("block"));
  await Promise.resolve();
  const q = b.submit(owner("A"), msg("expired"));
  const until = performance.now() + 5;
  while (performance.now() < until) {}
  release();
  await a.done;
  assert.equal((await q.done).error, "QUEUE_WAIT_TIMEOUT");
  assert.deepEqual(calls, ["block"]);
  await b.close();
});
test("active tasks take priority over recent history in bounded state snapshots", async () => {
  const b = new ExecutionBus({
    concurrency: 2,
    queueLimit: 8,
    recordLimit: 64,
    resultBytes: 1024,
    retentionMs: 1000,
  });
  let release;
  const gate = new Promise((r) => (release = r));
  b.register("h", {
    validate() {},
    async run(_, ctx) {
      if (ctx.requestId === "old-running") await gate;
      return true;
    },
  });
  const active = b.submit(owner("A"), msg("old-running"));
  for (let i = 0; i < 52; i++) await b.submit(owner("A"), msg("done" + i)).done;
  const s = b.inspect(owner("A"));
  assert.equal(s.tasks[0].requestId, "old-running");
  assert.equal(s.tasks[0].state, "running");
  assert.equal(s.tasks[1].requestId, "done51");
  assert.equal(s.tasks.length, 50);
  release();
  await active.done;
  await b.close();
});

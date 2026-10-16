import { test } from "node:test";
import assert from "node:assert/strict";
import { ExecutionBus } from "../dist/bus.js";
const options = {
  concurrency: 1,
  queueLimit: 32,
  recordLimit: 64,
  resultBytes: 1024,
  retentionMs: 1000,
};
const msg = (id) => ({
  protocolVersion: 1,
  messageId: "m",
  requestId: id,
  type: "request",
  payload: { handler: "h", input: { id } },
});
test("two-session pressure: a queued peer runs after at most one same-owner dispatch", async () => {
  const b = new ExecutionBus(options);
  let release;
  const gate = new Promise((r) => (release = r));
  const order = [];
  let active = 0,
    maxActive = 0;
  b.register("h", {
    validate() {},
    async run(input) {
      active++;
      maxActive = Math.max(maxActive, active);
      if (input.id === "A0") await gate;
      order.push(input.id);
      active--;
      return input.id;
    },
  });
  const a = { sessionId: "A", callId: "a" },
    peer = { sessionId: "B", callId: "b" };
  const requests = [b.submit(a, msg("A0"))];
  await Promise.resolve();
  for (let i = 1; i <= 12; i++) requests.push(b.submit(a, msg("A" + i)));
  requests.push(b.submit(peer, msg("B0")));
  release();
  await Promise.all(requests.map((r) => r.done));
  console.log("pressure dispatch order:", order.join(","));
  assert.ok(
    order.indexOf("B0") <= 2,
    "peer remained behind " + order.indexOf("B0") + " tasks",
  );
  assert.equal(maxActive, 1);
  assert.equal(new Set(order).size, 14);
  await b.close();
});

test("round robin preserves per-session FIFO under concurrency and cancellation", async () => {
  const b = new ExecutionBus({ ...options, concurrency: 2 });
  const started = [];
  let running = 0,
    peak = 0;
  b.register("h", {
    validate() {},
    async run(input) {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1));
      started.push(input.id);
      running--;
      return input.id;
    },
  });
  const calls = [];
  for (let round = 0; round < 8; round++)
    for (const owner of ["A", "B", "C"])
      calls.push(
        b.submit({ sessionId: owner, callId: "c" }, msg(owner + round)),
      );
  const cancel = calls[4];
  cancel.cancel();
  const results = await Promise.all(calls.map((c) => c.done));
  assert.equal(results.filter((r) => r.state === "cancelled").length, 1);
  for (const owner of ["A", "B", "C"]) {
    const numbers = started
      .filter((id) => id.startsWith(owner))
      .map((id) => Number(id.slice(1)));
    assert.deepEqual(
      numbers,
      [...numbers].sort((a, b) => a - b),
    );
  }
  assert.ok(peak <= 2);
  assert.equal(new Set(started).size, 23);
  await b.close();
});

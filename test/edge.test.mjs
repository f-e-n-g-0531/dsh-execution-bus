import { test } from "node:test";
import assert from "node:assert/strict";
import { ExecutionBus } from "../dist/bus.js";
const o = { sessionId: "s", callId: "c" },
  m = {
    protocolVersion: 1,
    messageId: "m",
    requestId: "r",
    type: "request",
    payload: { handler: "h", input: {} },
  };
test("unconfirmed running cancellation is unknown and never retried", async () => {
  const b = new ExecutionBus();
  let count = 0;
  b.register("h", {
    validate() {},
    async run(_, c) {
      count++;
      await new Promise((resolve) =>
        c.signal.addEventListener("abort", resolve, { once: true }),
      );
      throw Error("not a cancellation acknowledgement");
    },
  });
  const a = b.submit(o, m);
  await Promise.resolve();
  a.cancel();
  assert.equal((await a.done).state, "unknown");
  assert.equal((await b.submit(o, m).done).state, "unknown");
  assert.equal(count, 1);
  await b.close();
});
test("same parameters different request id are distinct operations", async () => {
  const b = new ExecutionBus();
  let count = 0;
  b.register("h", {
    validate() {},
    async run() {
      return ++count;
    },
  });
  await Promise.all([
    b.submit(o, m).done,
    b.submit(o, { ...m, requestId: "new" }).done,
  ]);
  assert.equal(count, 2);
  await b.close();
});
test("record backpressure, message cap and bounded duplicate waiters", async () => {
  const b = new ExecutionBus({
    concurrency: 1,
    queueLimit: 2,
    recordLimit: 1,
    resultBytes: 1024,
    retentionMs: 1000,
  });
  b.register("h", {
    validate() {},
    async run() {
      return true;
    },
  });
  await b.submit(o, m).done;
  assert.throws(() => b.submit(o, { ...m, requestId: "new" }), /BACKPRESSURE/);
  for (let i = 1; i < 128; i++)
    b.command(o, { ...m, type: "status", messageId: "s" + i, payload: {} });
  assert.throws(
    () =>
      b.command(o, { ...m, type: "cancel", messageId: "over", payload: {} }),
    /MESSAGE_LIMIT/,
  );
  await b.close();
});

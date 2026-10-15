import { test } from "node:test";
import assert from "node:assert/strict";
import { ExecutionBus } from "../dist/bus.js";
const owner = { sessionId: "s", callId: "c" },
  message = {
    protocolVersion: 1,
    messageId: "m",
    requestId: "r",
    type: "request",
    payload: { handler: "h", input: {} },
  };
test("rejected attachments do not consume message quota or reserve message IDs", async () => {
  const b = new ExecutionBus();
  let release;
  const gate = new Promise((r) => (release = r));
  b.register("h", {
    validate() {},
    async run() {
      await gate;
      return true;
    },
  });
  const a = [];
  for (let i = 0; i < 32; i++)
    a.push(b.submit(owner, { ...message, messageId: "ok" + i }, () => {}));
  try {
    for (let i = 0; i < 96; i++)
      assert.throws(
        () =>
          b.submit(owner, { ...message, messageId: "rejected" + i }, () => {}),
        /WAITER_LIMIT/,
      );
    a[0].detach();
    assert.equal(
      b.command(owner, {
        ...message,
        messageId: "rejected0",
        type: "status",
        payload: {},
      }).state,
      "queued",
    );
    release();
    assert.equal((await a[0].done).state, "succeeded");
    assert.equal(
      b.command(owner, {
        ...message,
        messageId: "fetch",
        type: "result",
        payload: {},
      }).result,
      true,
    );
  } finally {
    release();
    await b.close();
  }
});
test("capacity options are an immutable snapshot independent from caller object", async () => {
  const options = {
    concurrency: 1,
    queueLimit: 1,
    recordLimit: 1,
    resultBytes: 10,
    retentionMs: 1000,
  };
  const b = new ExecutionBus(options);
  options.resultBytes = 100000;
  options.recordLimit = 100;
  options.queueLimit = 100;
  assert.equal(b.options.resultBytes, 10);
  assert.ok(Object.isFrozen(b.options));
  assert.throws(() => {
    b.options.concurrency = 99;
  }, TypeError);
  b.register("h", {
    validate() {},
    async run() {
      return "x".repeat(100);
    },
  });
  try {
    assert.equal((await b.submit(owner, message).done).state, "unknown");
    assert.throws(
      () => b.submit(owner, { ...message, requestId: "next" }),
      /BACKPRESSURE/,
    );
  } finally {
    await b.close();
  }
});

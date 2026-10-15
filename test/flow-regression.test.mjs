import { test } from "node:test";
import assert from "node:assert/strict";
import { ExecutionBus } from "../dist/bus.js";
const owner = { sessionId: "flow", callId: "call" };
const request = (id = "r") => ({
  protocolVersion: 1,
  messageId: "m",
  requestId: id,
  type: "request",
  payload: { handler: "h", input: {} },
});
test("flow: one result consumer cannot corrupt a later duplicate result", async () => {
  const bus = new ExecutionBus();
  bus.register("h", {
    validate() {},
    async run() {
      return { ok: true };
    },
  });
  try {
    const first = await bus.submit(owner, request()).done;
    try {
      first.state = "failed";
      first.result.ok = false;
    } catch {}
    const again = await bus.submit(owner, request()).done;
    assert.equal(again.state, "succeeded");
    assert.equal(again.result.ok, true);
  } finally {
    await bus.close();
  }
});
test("flow: completed execution with nonserializable result is unknown, never executed twice", async () => {
  const bus = new ExecutionBus();
  let count = 0;
  bus.register("h", {
    validate() {},
    async run() {
      count++;
      return 1n;
    },
  });
  try {
    const value = await bus.submit(owner, request()).done;
    assert.equal(value.state, "unknown");
    assert.equal(value.error, "RESULT_NOT_RETAINED");
    await bus.submit(owner, request()).done;
    assert.equal(count, 1);
  } finally {
    await bus.close();
  }
});
test("flow: expired result is inaccessible without requiring another request", async () => {
  const bus = new ExecutionBus({
    concurrency: 1,
    queueLimit: 2,
    recordLimit: 2,
    resultBytes: 100,
    retentionMs: 1,
  });
  bus.register("h", {
    validate() {},
    async run() {
      return true;
    },
  });
  try {
    await bus.submit(owner, request()).done;
    await new Promise((r) => setTimeout(r, 10));
    assert.throws(
      () =>
        bus.command(owner, {
          ...request(),
          messageId: "status",
          type: "result",
          payload: {},
        }),
      /NOT_FOUND/,
    );
  } finally {
    await bus.close();
  }
});

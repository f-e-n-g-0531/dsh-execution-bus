import { test } from "node:test";
import assert from "node:assert/strict";
import { ExecutionBus } from "../dist/bus.js";
const owner = { sessionId: "s", callId: "c" },
  message = (id = "r") => ({
    protocolVersion: 1,
    messageId: "m",
    requestId: id,
    type: "request",
    payload: { handler: "h", input: {} },
  });
test("stale disposer is idempotent and cannot remove a same-object replacement", async () => {
  const b = new ExecutionBus();
  const h = {
    validate() {},
    async run() {
      return true;
    },
  };
  const old = b.register("h", h);
  old();
  const current = b.register("h", h);
  old();
  assert.equal((await b.submit(owner, message()).done).state, "succeeded");
  current();
  current();
  assert.throws(() => b.submit(owner, message("next")), /UNKNOWN_HANDLER/);
  await b.close();
});
test("unregister preserves already accepted handler while replacement serves new requests", async () => {
  const b = new ExecutionBus();
  const old = b.register("h", {
    validate() {},
    async run() {
      return "old";
    },
  });
  const a = b.submit(owner, message());
  old();
  b.register("h", {
    validate() {},
    async run() {
      return "new";
    },
  });
  old();
  const n = b.submit(owner, message("new"));
  assert.equal((await a.done).result, "old");
  assert.equal((await n.done).result, "new");
  await b.close();
});
test("observer mutation cannot corrupt later notifications or internal state", async () => {
  const b = new ExecutionBus();
  let release;
  const gate = new Promise((r) => (release = r));
  b.register("h", {
    validate() {},
    async run(_, c) {
      await gate;
      c.progress(1, 50);
      return true;
    },
  });
  const a = b.submit(owner, message(), (e) => {
    for (const mutate of [
      () => (e.requestId = "wrong"),
      () => (e.sequence = 999),
      () => (e.type = "failed"),
      () => (e.payload.percent = 999),
    ])
      try {
        mutate();
      } catch {}
  });
  const received = [];
  const n = b.submit(owner, message(), (e) => received.push(e));
  release();
  await Promise.all([a.done, n.done]);
  const progress = received.find((e) => e.type === "progress");
  assert.equal(progress.requestId, "r");
  assert.equal(progress.payload.percent, 50);
  assert.equal(progress.sequence, 2);
  assert.ok(Object.isFrozen(progress) && Object.isFrozen(progress.payload));
  assert.equal(received.at(-1).type, "succeeded");
  assert.equal((await a.done).state, "succeeded");
  await b.close();
});

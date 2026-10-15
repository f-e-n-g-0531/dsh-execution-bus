import { test } from "node:test";
import assert from "node:assert/strict";
import { ExecutionBus } from "../dist/bus.js";
const defaults = {
  concurrency: 2,
  queueLimit: 32,
  recordLimit: 256,
  resultBytes: 65536,
  retentionMs: 3600000,
};
const owner = { sessionId: "s", callId: "c" },
  message = {
    protocolVersion: 1,
    messageId: "m",
    requestId: "r",
    type: "request",
    payload: { handler: "h", input: {} },
  };
test("incomplete or malformed capacity configuration fails before task admission", () => {
  for (const key of Object.keys(defaults)) {
    const options = { ...defaults };
    delete options[key];
    assert.throws(() => new ExecutionBus(options), /INVALID_OPTIONS/);
  }
  for (const value of [
    {},
    null,
    [],
    true,
    1,
    "x",
    { ...defaults, extra: 1 },
    { ...defaults, concurrency: undefined },
  ])
    assert.throws(() => new ExecutionBus(value), /INVALID_OPTIONS/);
});
test("omitted configuration uses defaults and complete configuration dispatches", async () => {
  for (const b of [new ExecutionBus(), new ExecutionBus({ ...defaults })]) {
    b.register("h", {
      validate() {},
      async run() {
        return true;
      },
    });
    assert.equal((await b.submit(owner, message).done).state, "succeeded");
    await b.close();
  }
});
test("shared callback has per-attachment lifecycle and independent quota slots", async () => {
  const b = new ExecutionBus();
  let release;
  const gate = new Promise((r) => (release = r));
  b.register("h", {
    validate() {},
    async run(_, ctx) {
      await gate;
      ctx.progress(1, 50);
      return true;
    },
  });
  const events = [];
  const callback = (e) => events.push(e);
  const first = b.submit(owner, message, callback);
  const second = b.submit(owner, { ...message, messageId: "second" }, callback);
  first.detach();
  first.detach();
  release();
  await second.done;
  assert.equal(events.filter((e) => e.type === "progress").length, 1);
  assert.equal(events.filter((e) => e.type === "succeeded").length, 1);
  await b.close();
  const c = new ExecutionBus();
  c.register("h", {
    validate() {},
    async run() {
      return true;
    },
  });
  const handles = [];
  for (let i = 0; i < 32; i++)
    handles.push(c.submit(owner, { ...message, messageId: "m" + i }, callback));
  assert.throws(
    () => c.submit(owner, { ...message, messageId: "overflow" }, callback),
    /WAITER_LIMIT/,
  );
  handles[0].detach();
  handles.push(c.submit(owner, { ...message, messageId: "retry" }, callback));
  await handles[0].done;
  await c.close();
});

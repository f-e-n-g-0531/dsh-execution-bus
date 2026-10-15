import { test } from "node:test";
import assert from "node:assert/strict";
import { ExecutionBus, parse } from "../dist/bus.js";
import { setTimeout as delay } from "node:timers/promises";
const owner = { sessionId: "audit", callId: "call" },
  request = {
    protocolVersion: 1,
    messageId: "m",
    requestId: "r",
    type: "request",
    payload: { handler: "h", input: {} },
  };
async function bounded(p) {
  const controller = new AbortController();
  try {
    return await Promise.race([
      p,
      delay(500, undefined, { signal: controller.signal }).then(() => {
        throw Error("WAIT_NOT_SETTLED");
      }),
    ]);
  } finally {
    controller.abort();
  }
}
test("audit: deep result settles unknown; query, duplicate and close do not hang", async () => {
  const b = new ExecutionBus();
  let value = {};
  for (let i = 0; i < 1800; i++) value = { x: value };
  b.register("h", {
    validate() {},
    async run() {
      return value;
    },
  });
  const v = await bounded(b.submit(owner, request).done);
  assert.equal(v.state, "unknown");
  assert.equal(v.error, "RESULT_NOT_RETAINED");
  assert.equal(
    b.command(owner, {
      ...request,
      messageId: "s",
      type: "status",
      payload: {},
    }).state,
    "unknown",
  );
  assert.equal((await bounded(b.submit(owner, request).done)).state, "unknown");
  await bounded(b.close());
});
test("audit: snapshot clone failure still settles once and permits shutdown", async () => {
  const clone = globalThis.structuredClone;
  const c = new ExecutionBus();
  const events = [];
  c.register("h", {
    validate() {},
    async run() {
      globalThis.structuredClone = () => {
        throw Error("injected clone failure");
      };
      return true;
    },
  });
  try {
    const v = await bounded(
      c.submit(owner, request, (e) => events.push(e)).done,
    );
    assert.equal(v.state, "unknown");
    assert.equal(events.filter((e) => e.type === "unknown").length, 1);
    await bounded(c.close());
  } finally {
    globalThis.structuredClone = clone;
  }
});
test("audit: exhausted query quota preserves bounded, idempotent cancellation", async () => {
  const b = new ExecutionBus();
  b.register("h", {
    validate() {},
    async run(_, c) {
      await delay(10000, undefined, { signal: c.signal });
      return true;
    },
  });
  const a = b.submit(owner, request);
  await Promise.resolve();
  for (let i = 0; i < 127; i++)
    b.command(owner, {
      ...request,
      messageId: "s" + i,
      type: "status",
      payload: {},
    });
  assert.throws(
    () =>
      b.command(owner, {
        ...request,
        messageId: "full",
        type: "status",
        payload: {},
      }),
    /MESSAGE_LIMIT/,
  );
  const cancel = {
    ...request,
    messageId: "cancel",
    type: "cancel",
    payload: {},
  };
  assert.equal(b.command(owner, cancel).cancelRequested, true);
  const sequence = b.command(owner, cancel).sequence;
  assert.equal(
    b.command(owner, { ...cancel, messageId: "cancel2" }).sequence,
    sequence,
  );
  assert.throws(
    () => b.command(owner, { ...cancel, type: "status" }),
    /MESSAGE_CONFLICT/,
  );
  assert.equal((await bounded(a.done)).state, "cancelled");
  await b.close();
});
test("audit: lossy JSON results are unknown, valid JSON remains intact", async () => {
  const invalid = [
    NaN,
    Infinity,
    -Infinity,
    -0,
    { missing: undefined },
    [undefined],
    Array(1),
    new Date(),
    new Map(),
    { fn() {} },
  ];
  for (const value of invalid) {
    const b = new ExecutionBus();
    let count = 0;
    b.register("h", {
      validate() {},
      async run() {
        count++;
        return value;
      },
    });
    const v = await bounded(b.submit(owner, request).done);
    assert.equal(v.state, "unknown");
    assert.equal(count, 1);
    await b.close();
  }
  const b = new ExecutionBus();
  const good = { a: [null, true, 0, "文"], b: { ok: false } };
  b.register("h", {
    validate() {},
    async run() {
      return good;
    },
  });
  assert.deepEqual((await b.submit(owner, request).done).result, good);
  await b.close();
});
test("audit: invalid input fails before acceptance without invoking getters", () => {
  let invoked = false;
  const input = {};
  Object.defineProperty(input, "value", {
    enumerable: true,
    get() {
      invoked = true;
      return 1;
    },
  });
  assert.throws(
    () => parse({ ...request, payload: { handler: "h", input } }),
    /INVALID_JSON_PROPERTY/,
  );
  assert.equal(invoked, false);
  assert.throws(
    () => parse({ ...request, payload: { handler: "h", input: { n: NaN } } }),
    /INVALID_JSON/,
  );
});

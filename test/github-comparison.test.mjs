import { test } from "node:test";
import assert from "node:assert/strict";
import { Diagnostics } from "../dist/diagnostics.js";
import { ExecutionBus } from "../dist/bus.js";
const owner = { sessionId: "s", callId: "c" },
  msg = (id) => ({
    protocolVersion: 1,
    messageId: "m",
    requestId: id,
    type: "request",
    payload: { handler: "h", input: {} },
  });
test("diagnostic ring wraps repeatedly in chronological order without array shifts", () => {
  const d = new Diagnostics();
  const shift = Array.prototype.shift;
  let shifts = 0;
  Array.prototype.shift = function (...args) {
    shifts++;
    return shift.apply(this, args);
  };
  try {
    for (let i = 0; i < 1000; i++) d.record(d.begin(), "accepted");
  } finally {
    Array.prototype.shift = shift;
  }
  const snap = d.snapshot();
  assert.equal(shifts, 0);
  assert.equal(snap.traces.length, 128);
  assert.deepEqual(
    snap.traces.map((x) => x.operation),
    Array.from({ length: 128 }, (_, i) => 873 + i),
  );
  assert.equal(snap.counts.accepted, 1000);
  snap.traces[0].operation = -1;
  assert.equal(d.snapshot().traces[0].operation, 873);
});
test("diagnostic byte reads do not serialize stored results and remain exact after expiry", async () => {
  const b = new ExecutionBus({
    concurrency: 2,
    queueLimit: 32,
    recordLimit: 32,
    resultBytes: 65536,
    retentionMs: 1000,
  });
  b.register("h", {
    validate() {},
    async run() {
      return { text: "汉字", items: [1, true, null] };
    },
  });
  await b.submit(owner, msg("a")).done;
  await b.submit(owner, msg("b")).done;
  const expected =
    2 *
    Buffer.byteLength(JSON.stringify({ text: "汉字", items: [1, true, null] }));
  const stringify = JSON.stringify;
  let calls = 0;
  JSON.stringify = function (...args) {
    calls++;
    return stringify.apply(this, args);
  };
  try {
    for (let i = 0; i < 50; i++)
      assert.equal(b.diagnostics().retainedResultBytes, expected);
  } finally {
    JSON.stringify = stringify;
  }
  assert.equal(calls, 0);
  b.sweep(Date.now() + 2000);
  assert.equal(b.diagnostics().retainedResultBytes, 0);
  await b.close();
});
test("snapshot failure and unknown result cannot inflate cached bytes; close is truly idle", async () => {
  const b = new ExecutionBus();
  b.register("h", {
    validate() {},
    async run() {
      return "retained";
    },
  });
  const clone = globalThis.structuredClone;
  const a = b.submit(owner, msg("bad"));
  globalThis.structuredClone = () => {
    throw Error("injected clone failure");
  };
  try {
    assert.equal((await a.done).state, "unknown");
  } finally {
    globalThis.structuredClone = clone;
  }
  assert.equal(b.diagnostics().retainedResultBytes, 0);
  await b.close();
  assert.equal(b.diagnostics().running, 0);
  assert.equal(b.diagnostics().queued, 0);
  assert.equal(b.diagnostics().phase, "closed");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ExecutionBus, parse } from "../dist/bus.js";
import { testHandler, readHandler } from "../dist/handlers.js";
const owner = { sessionId: "one", callId: "call" };
const msg = (
  id = "r",
  type = "request",
  payload = { handler: "test", input: { delayMs: 20, fail: false } },
) => ({
  protocolVersion: 1,
  messageId: randomUUID(),
  requestId: id,
  type,
  payload,
});
const setup = (opts) => {
  const b = new ExecutionBus(opts);
  b.register("test", testHandler);
  return b;
};
test("acceptance is not completion; original promise waits without polling", async () => {
  const b = setup(),
    events = [];
  const a = b.submit(owner, msg(), (e) => events.push(e));
  assert.equal(a.accepted.payload.durable, false);
  assert.equal(a.accepted.correlationId.length, 36);
  assert.equal(
    await Promise.race([a.done.then(() => false), delay(1).then(() => true)]),
    true,
  );
  const v = await a.done;
  assert.equal(v.state, "succeeded");
  assert.equal(v.delivery, "pending");
  assert.equal(events.filter((e) => e.type === "succeeded").length, 1);
  assert.ok(events.every((e) => e.correlationId));
  a.returned();
  assert.equal(b.command(owner, msg("r", "status", {})).delivery, "returned");
  await b.close();
});
test("two sessions same request id remain isolated", async () => {
  const b = setup();
  const a = b.submit(owner, msg());
  const other = { sessionId: "two", callId: "b" };
  const c = b.submit(
    other,
    msg("r", "request", { handler: "test", input: { delayMs: 1, fail: true } }),
  );
  assert.equal((await a.done).state, "succeeded");
  assert.equal((await c.done).state, "failed");
  assert.throws(
    () =>
      b.command({ sessionId: "third", callId: "c" }, msg("r", "cancel", {})),
    /NOT_FOUND/,
  );
  await b.close();
});
test("deduplicated logical request and conflicting input", async () => {
  const b = setup();
  const m = msg();
  const a = b.submit(owner, m),
    c = b.submit(owner, { ...m, messageId: randomUUID() });
  assert.equal(a.done, c.done);
  assert.throws(
    () =>
      b.submit(
        owner,
        msg("r", "request", {
          handler: "test",
          input: { delayMs: 1, fail: false },
        }),
      ),
    /CONFLICT/,
  );
  await a.done;
  await b.close();
});
test("queued cancel, running cancel, completion wins late cancel", async () => {
  const b = setup({
    concurrency: 1,
    queueLimit: 2,
    recordLimit: 8,
    resultBytes: 1024,
    retentionMs: 1000,
  });
  const a = b.submit(owner, msg("a")),
    c = b.submit(owner, msg("c"));
  await delay(1);
  assert.equal(b.command(owner, msg("c", "cancel", {})).state, "cancelled");
  assert.equal((await c.done).state, "cancelled");
  assert.equal(b.command(owner, msg("a", "cancel", {})).cancelRequested, true);
  assert.equal((await a.done).state, "cancelled");
  const d = b.submit(owner, msg("d"));
  await d.done;
  assert.equal(b.command(owner, msg("d", "cancel", {})).state, "succeeded");
  await b.close();
});
test("bounded queue, record cap and concurrency", async () => {
  const b = setup({
    concurrency: 1,
    queueLimit: 1,
    recordLimit: 3,
    resultBytes: 1024,
    retentionMs: 1000,
  });
  const a = b.submit(owner, msg("a"));
  assert.throws(() => b.submit(owner, msg("b")), /BACKPRESSURE/);
  await delay(1);
  const c = b.submit(owner, msg("c"));
  assert.equal(b.command(owner, msg("c", "status", {})).state, "queued");
  assert.throws(() => b.submit(owner, msg("d")), /BACKPRESSURE/);
  await Promise.all([a.done, c.done]);
  await b.close();
});
test("duplicate, out of order and late progress dropped; observer exceptions contained", async () => {
  const b = setup(),
    events = [];
  let progress;
  b.register("order", {
    validate() {},
    async run(_, c) {
      progress = c.progress;
      c.progress(2, 50);
      c.progress(1, 10);
      c.progress(2, 50);
      return true;
    },
  });
  const a = b.submit(
    owner,
    msg("r", "request", { handler: "order", input: {} }),
    (e) => {
      events.push(e);
      throw Error("observer");
    },
  );
  await a.done;
  progress(3, 100);
  assert.equal(events.filter((e) => e.type === "progress").length, 1);
  assert.equal(events.filter((e) => e.type === "succeeded").length, 1);
  await b.close();
});
test("failure and oversized result do not leak exception contents", async () => {
  const b = setup({
    concurrency: 1,
    queueLimit: 4,
    recordLimit: 8,
    resultBytes: 8,
    retentionMs: 1000,
  });
  b.register("secret", {
    validate() {},
    async run() {
      throw Error("SECRET_TOKEN");
    },
  });
  b.register("big", {
    validate() {},
    async run() {
      return "x".repeat(10);
    },
  });
  const a = await b.submit(
    owner,
    msg("s", "request", { handler: "secret", input: {} }),
  ).done;
  assert.ok(!JSON.stringify(a).includes("SECRET_TOKEN"));
  const c = await b.submit(
    owner,
    msg("b", "request", { handler: "big", input: {} }),
  ).done;
  assert.equal(c.state, "unknown");
  await b.close();
});
test("strict version/type/identity/input validation", () => {
  assert.throws(() => parse({ ...msg(), type: "execute" }), /UNSUPPORTED_TYPE/);
  assert.throws(() => parse({ ...msg(), protocolVersion: 2 }), /VERSION/);
  assert.throws(() => parse({ ...msg(), sessionId: "spoof" }), /UNKNOWN_FIELD/);
  const b = setup();
  assert.throws(
    () =>
      b.submit(owner, msg("r", "request", { handler: "missing", input: {} })),
    /UNKNOWN_HANDLER/,
  );
  assert.throws(
    () =>
      b.submit(
        owner,
        msg("r", "request", {
          handler: "test",
          input: { delayMs: -1, fail: false },
        }),
      ),
    /INVALID_TEST/,
  );
  assert.throws(
    () => b.submit({ sessionId: "", callId: "" }, msg()),
    /CONTEXT/,
  );
  assert.throws(
    () => readHandler.validate({ file_path: "x", workdir: "spoof" }),
    /INVALID_READ/,
  );
});
test("close drains compliant handlers and rejects submissions", async () => {
  const b = setup();
  const a = b.submit(owner, msg());
  await delay(1);
  await b.close();
  assert.equal((await a.done).state, "cancelled");
  assert.throws(() => b.submit(owner, msg()), /CLOSED/);
});
test("control message id conflict and duplicate cancellation", async () => {
  const b = setup();
  const a = b.submit(owner, msg());
  const c = msg("r", "cancel", {});
  const v = b.command(owner, c);
  assert.equal(b.command(owner, c).sequence, v.sequence);
  assert.throws(
    () => b.command(owner, { ...c, type: "status" }),
    /MESSAGE_CONFLICT/,
  );
  await a.done;
  await b.close();
});
test("TTL cleanup only terminal; no cross-instance persistence claimed", async () => {
  const b = setup(),
    a = b.submit(owner, msg());
  b.sweep(Date.now() + 99999999);
  assert.equal(b.command(owner, msg("r", "status", {})).state, "queued");
  await a.done;
  b.sweep(Date.now() + 99999999);
  assert.throws(() => b.command(owner, msg("r", "result", {})), /NOT_FOUND/);
  await b.close();
  assert.throws(
    () => setup().command(owner, msg("r", "result", {})),
    /NOT_FOUND/,
  );
});
